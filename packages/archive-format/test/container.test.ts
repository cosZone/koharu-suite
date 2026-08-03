import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, constants as zstdConstants } from 'node:zlib';
import { pack as createTarPack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import {
  type ArchiveWriteEntry,
  assertZstdRuntimeSupport,
  readTarZstd,
  type WriteTarZstdOptions,
  writeTarZstd,
} from '../src/container.js';
import { ArchiveContainerError, type ArchiveContainerLimits } from '../src/entry-policy.js';

interface RawEntry {
  name: string;
  body?: Buffer;
  type?: 'file' | 'symlink';
  linkname?: string;
}

function collectingWritable(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function createRawTar(entries: readonly RawEntry[]): Promise<Buffer> {
  const tarPack = createTarPack();
  const output = collect(tarPack as unknown as Readable);
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    tarPack.entry(
      {
        name: entry.name,
        type: entry.type ?? 'file',
        size: body.byteLength,
        linkname: entry.linkname,
        mode: 0o644,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
      },
      body,
    );
  }
  tarPack.finalize();
  return output;
}

async function compress(rawTar: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(Readable.from([rawTar]), createZstdCompress(), collectingWritable(chunks));
  return Buffer.concat(chunks);
}

async function compressWithWindow(rawTar: Buffer, windowLog: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([rawTar]),
    createZstdCompress({ params: { [zstdConstants.ZSTD_c_windowLog]: windowLog } }),
    collectingWritable(chunks),
  );
  return Buffer.concat(chunks);
}

async function createTarZstd(entries: readonly RawEntry[]): Promise<Buffer> {
  return compress(await createRawTar(entries));
}

async function createTarZstdWithTypeFlag(typeFlag: string): Promise<Buffer> {
  const rawTar = await createRawTar([{ name: 'manifest.json', body: Buffer.from('{}') }]);
  rawTar[156] = typeFlag.charCodeAt(0);
  return compress(rawTar);
}

function rewriteTarHeaderChecksum(rawTar: Buffer): void {
  rawTar.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of rawTar.subarray(0, 512)) sum += byte;
  rawTar.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  rawTar[154] = 0;
  rawTar[155] = 0x20;
}

async function consumeEntries(
  archive: Buffer,
  options: {
    allow?: (entryPath: string) => boolean;
    limits?: Partial<ArchiveContainerLimits>;
    signal?: AbortSignal;
  } = {},
) {
  const contents = new Map<string, Buffer>();
  const summary = await readTarZstd(Readable.from([archive]), {
    isAllowedPath: options.allow ?? (() => true),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onEntry: async ({ path, stream }) => {
      contents.set(path, await collect(stream));
    },
  });
  return { contents, summary };
}

async function expectRejectsCode(
  run: () => Promise<unknown>,
  code: ArchiveContainerError['code'],
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveContainerError);
    expect((error as ArchiveContainerError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('streaming tar.zst reader', () => {
  it('asserts the required Node.js Zstd stream capability with a stable error', () => {
    expect(() => assertZstdRuntimeSupport()).not.toThrow();
    try {
      assertZstdRuntimeSupport({});
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveContainerError);
      expect((error as ArchiveContainerError).code).toBe('ZSTD_RUNTIME_UNSUPPORTED');
      expect((error as Error).message).toBe(
        'Node.js runtime does not provide the required Zstd stream support',
      );
      return;
    }
    throw new Error('Expected ZSTD_RUNTIME_UNSUPPORTED');
  });

  it('streams regular entries and reports compressed, expanded, and entry counts', async () => {
    const archive = await createTarZstd([
      { name: 'manifest.json', body: Buffer.from('{}') },
      { name: 'data/messages.jsonl', body: Buffer.from('{"id":1}\n') },
    ]);
    const { contents, summary } = await consumeEntries(archive);

    expect(contents.get('manifest.json')?.toString()).toBe('{}');
    expect(contents.get('data/messages.jsonl')?.toString()).toBe('{"id":1}\n');
    expect(summary).toMatchObject({ entries: 2, entryBytes: 11 });
    expect(summary.compressedBytes).toBe(archive.byteLength);
    expect(summary.expandedBytes).toBeGreaterThan(summary.entryBytes);
  });

  it('rejects traversal, links, duplicate names, and schema-extra entries', async () => {
    await expectRejectsCode(
      async () =>
        consumeEntries(await createTarZstd([{ name: '../escape', body: Buffer.from('x') }])),
      'INVALID_ARCHIVE_PATH',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(
          await createTarZstd([{ name: 'link', type: 'symlink', linkname: '../target' }]),
        ),
      'UNSUPPORTED_ARCHIVE_ENTRY_TYPE',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(
          await createTarZstd([
            { name: 'same', body: Buffer.from('1') },
            { name: 'same', body: Buffer.from('2') },
          ]),
        ),
      'DUPLICATE_ARCHIVE_PATH',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(await createTarZstd([{ name: 'extra', body: Buffer.from('x') }]), {
          allow: () => false,
        }),
      'EXTRA_ARCHIVE_ENTRY',
    );
  });

  it('rejects bytes after the exact tar terminator and truncated tar streams', async () => {
    const raw = await createRawTar([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    await expectRejectsCode(
      async () => consumeEntries(await compress(Buffer.concat([raw, Buffer.alloc(512)]))),
      'TRAILING_ARCHIVE_DATA',
    );
    await expectRejectsCode(
      async () => consumeEntries(await compress(raw.subarray(0, raw.byteLength - 512))),
      'TRUNCATED_ARCHIVE',
    );
  });

  it('rejects truncated and corrupt Zstd frames', async () => {
    const archive = await createTarZstd([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    const corrupt = Buffer.from(archive);
    corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;

    await expectRejectsCode(
      () => consumeEntries(archive.subarray(0, archive.byteLength - 1)),
      'TRUNCATED_ARCHIVE',
    );
    await expectRejectsCode(() => consumeEntries(corrupt), 'INVALID_ARCHIVE_CONTAINER');
  });

  it('rejects a tar header with an invalid checksum', async () => {
    const rawTar = await createRawTar([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    rawTar[0] = (rawTar[0] ?? 0) ^ 1;

    await expectRejectsCode(
      async () => consumeEntries(await compress(rawTar)),
      'INVALID_ARCHIVE_CONTAINER',
    );
  });

  it('rejects invalid UTF-8 names, base-256 sizes, and non-zero entry padding', async () => {
    const invalidName = await createRawTar([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    invalidName[0] = 0xff;
    rewriteTarHeaderChecksum(invalidName);
    await expectRejectsCode(
      async () => consumeEntries(await compress(invalidName)),
      'INVALID_ARCHIVE_PATH',
    );

    const base256 = await createRawTar([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    base256[124] = 0x80;
    await expectRejectsCode(
      async () => consumeEntries(await compress(base256)),
      'UNSUPPORTED_TAR_EXTENSION',
    );

    const nonZeroPadding = await createRawTar([{ name: 'manifest.json', body: Buffer.from('x') }]);
    nonZeroPadding[513] = 1;
    await expectRejectsCode(
      async () => consumeEntries(await compress(nonZeroPadding)),
      'INVALID_ARCHIVE_CONTAINER',
    );
  });

  it.each([
    ['PAX local header', 'x', 'UNSUPPORTED_TAR_EXTENSION'],
    ['PAX global header', 'g', 'UNSUPPORTED_TAR_EXTENSION'],
    ['GNU long path', 'L', 'UNSUPPORTED_TAR_EXTENSION'],
    ['GNU long link', 'K', 'UNSUPPORTED_TAR_EXTENSION'],
    ['hardlink', '1', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['directory', '5', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['FIFO', '6', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['character device', '3', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['block device', '4', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['contiguous file', '7', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['sparse file', 'S', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['socket', 's', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
    ['unknown type', 'Z', 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'],
  ] as const)('rejects %s entries before dispatch', async (_label, typeFlag, expectedCode) => {
    await expectRejectsCode(
      async () => consumeEntries(await createTarZstdWithTypeFlag(typeFlag)),
      expectedCode,
    );
  });

  it('rejects ASCII-case-fold path collisions', async () => {
    await expectRejectsCode(
      async () =>
        consumeEntries(
          await createTarZstd([
            { name: 'data/messages/000001.jsonl', body: Buffer.from('1') },
            { name: 'DATA/MESSAGES/000001.JSONL', body: Buffer.from('2') },
          ]),
        ),
      'DUPLICATE_ARCHIVE_PATH',
    );
  });

  it.each([
    ['https:payload', undefined],
    ['data/messages/000001.jsonl', { maxPathSegments: 2 }],
  ] as const)('rejects unsafe path %s through the streaming reader', async (entryPath, limits) => {
    await expectRejectsCode(
      async () =>
        consumeEntries(await createTarZstd([{ name: entryPath, body: Buffer.from('x') }]), {
          ...(limits ? { limits } : {}),
        }),
      'INVALID_ARCHIVE_PATH',
    );
  });

  it('enforces compressed, expanded, ratio, count, and entry-size limits', async () => {
    const smallArchive = await createTarZstd([{ name: 'one', body: Buffer.from('12345') }]);
    await expectRejectsCode(
      () => consumeEntries(smallArchive, { limits: { maxCompressedBytes: 1 } }),
      'COMPRESSED_SIZE_LIMIT_EXCEEDED',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(smallArchive, {
          limits: { maxExpandedBytes: 1024, maxEntryBytes: 512, maxTotalEntryBytes: 512 },
        }),
      'EXPANDED_SIZE_LIMIT_EXCEEDED',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(
          await createTarZstd([{ name: 'zeros', body: Buffer.alloc(2 * 1024 * 1024) }]),
          {
            limits: { compressionRatioFloorBytes: 1, maxCompressionRatio: 2 },
          },
        ),
      'COMPRESSION_RATIO_LIMIT_EXCEEDED',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(await createTarZstd([{ name: 'zeros', body: Buffer.alloc(8 * 1024) }]), {
          limits: { compressionRatioFloorBytes: 1024, maxCompressionRatio: 2 },
        }),
      'COMPRESSION_RATIO_LIMIT_EXCEEDED',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(
          await createTarZstd([
            { name: 'one', body: Buffer.from('1') },
            { name: 'two', body: Buffer.from('2') },
          ]),
          { limits: { maxEntries: 1 } },
        ),
      'ENTRY_COUNT_LIMIT_EXCEEDED',
    );
    await expectRejectsCode(
      () =>
        consumeEntries(smallArchive, {
          limits: { maxEntryBytes: 4, maxTotalEntryBytes: 8 },
        }),
      'ENTRY_SIZE_LIMIT_EXCEEDED',
    );
    await expectRejectsCode(
      async () =>
        consumeEntries(
          await createTarZstd([
            { name: 'one', body: Buffer.from('1234') },
            { name: 'two', body: Buffer.from('5678') },
          ]),
          { limits: { maxEntryBytes: 4, maxTotalEntryBytes: 7 } },
        ),
      'TOTAL_ENTRY_SIZE_LIMIT_EXCEEDED',
    );
  });

  it('enforces the configured Zstd window limit while decoding', async () => {
    const raw = await createRawTar([
      { name: 'manifest.json', body: randomBytes(2 * 1_024 * 1_024) },
    ]);
    const archive = await compressWithWindow(raw, 20);
    await expectRejectsCode(
      () => consumeEntries(archive, { limits: { zstdWindowLogMax: 19 } }),
      'INVALID_ARCHIVE_CONTAINER',
    );
    await expect(
      consumeEntries(archive, { limits: { zstdWindowLogMax: 20 } }),
    ).resolves.toBeDefined();
  });

  it('requires callbacks to consume each stream and obeys AbortSignal', async () => {
    const archive = await createTarZstd([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    await expectRejectsCode(
      () =>
        readTarZstd(Readable.from([archive]), {
          isAllowedPath: () => true,
          onEntry: () => undefined,
        }),
      'ENTRY_NOT_CONSUMED',
    );

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expectRejectsCode(
      () =>
        readTarZstd(Readable.from([archive]), {
          isAllowedPath: () => true,
          onEntry: async ({ stream }) => void (await collect(stream)),
          signal: controller.signal,
        }),
      'ARCHIVE_ABORTED',
    );

    const forgedTimeout = new AbortController();
    forgedTimeout.abort(
      new ArchiveContainerError(
        'NO_PROGRESS_TIMEOUT',
        'caller-controlled abort reason must not impersonate the internal timeout',
      ),
    );
    await expectRejectsCode(
      () =>
        readTarZstd(Readable.from([archive]), {
          isAllowedPath: () => true,
          onEntry: async ({ stream }) => void (await collect(stream)),
          signal: forgedTimeout.signal,
        }),
      'ARCHIVE_ABORTED',
    );
  });

  it('aborts a stalled input after the finite no-progress timeout', async () => {
    const stalled = new Readable({ read() {} });
    await expectRejectsCode(
      () =>
        readTarZstd(stalled, {
          isAllowedPath: () => true,
          onEntry: async ({ stream }) => void (await collect(stream)),
          limits: { noProgressTimeoutMs: 20 },
        }),
      'NO_PROGRESS_TIMEOUT',
    );
  });

  it('does not wait forever for an entry consumer that makes no progress', async () => {
    const archive = await createTarZstd([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    await expectRejectsCode(
      () =>
        readTarZstd(Readable.from([archive]), {
          isAllowedPath: () => true,
          onEntry: () => new Promise(() => undefined),
          limits: { noProgressTimeoutMs: 20 },
        }),
      'NO_PROGRESS_TIMEOUT',
    );
  });

  it('cleans up the pipeline when the consumer throws', async () => {
    const archive = await createTarZstd([{ name: 'manifest.json', body: Buffer.from('{}') }]);
    const input = Readable.from([archive]);

    await expectRejectsCode(
      () =>
        readTarZstd(input, {
          isAllowedPath: () => true,
          onEntry: () => {
            throw new Error('consumer failed');
          },
        }),
      'INVALID_ARCHIVE_CONTAINER',
    );
    expect(input.destroyed).toBe(true);
  });

  it('cleans up entry and container streams after a mid-entry abort', async () => {
    const archive = await createTarZstd([
      { name: 'manifest.json', body: Buffer.alloc(64 * 1024, 1) },
    ]);
    const input = Readable.from([archive]);
    const controller = new AbortController();
    let entryStream: Readable | undefined;

    await expectRejectsCode(
      () =>
        readTarZstd(input, {
          isAllowedPath: () => true,
          signal: controller.signal,
          onEntry: async ({ stream }) => {
            entryStream = stream;
            for await (const _chunk of stream) {
              controller.abort(new Error('stop during entry'));
            }
          },
        }),
      'ARCHIVE_ABORTED',
    );
    expect(input.destroyed).toBe(true);
    expect(entryStream?.destroyed).toBe(true);
  });
});

function writeEntries(order: readonly [string, string][]): ArchiveWriteEntry[] {
  return order.map(([entryPath, body]) => ({
    path: entryPath,
    byteLength: Buffer.byteLength(body),
    body: Readable.from([Buffer.from(body)]),
  }));
}

async function write(
  entries: readonly ArchiveWriteEntry[],
  options: WriteTarZstdOptions = {},
): Promise<{ archive: Buffer; summary: unknown }> {
  const chunks: Buffer[] = [];
  const summary = await writeTarZstd(entries, collectingWritable(chunks), options);
  return { archive: Buffer.concat(chunks), summary };
}

describe('deterministic tar.zst writer', () => {
  it('preserves caller-provided canonical order, fixes metadata, and round-trips through the safe reader', async () => {
    const first = await write(
      writeEntries([
        ['manifest.json', '{}'],
        ['checksums.sha256', 'hash  data/messages/000001.jsonl\n'],
        ['data/messages/000001.jsonl', '{"id":1}\n'],
      ]),
    );
    const second = await write(
      writeEntries([
        ['manifest.json', '{}'],
        ['checksums.sha256', 'hash  data/messages/000001.jsonl\n'],
        ['data/messages/000001.jsonl', '{"id":1}\n'],
      ]),
    );

    expect(first.archive).toEqual(second.archive);
    expect(first.summary).toMatchObject({ entries: 3, entryBytes: 44 });
    const { contents } = await consumeEntries(first.archive);
    expect([...contents.keys()]).toEqual([
      'manifest.json',
      'checksums.sha256',
      'data/messages/000001.jsonl',
    ]);
  });

  it('rejects duplicate paths and bodies that do not match their declared length', async () => {
    await expectRejectsCode(
      () =>
        write(
          writeEntries([
            ['same', '1'],
            ['same', '2'],
          ]),
        ),
      'DUPLICATE_ARCHIVE_PATH',
    );
    await expectRejectsCode(
      () =>
        write(
          writeEntries([
            ['data/messages/000001.jsonl', '1'],
            ['DATA/MESSAGES/000001.JSONL', '2'],
          ]),
        ),
      'DUPLICATE_ARCHIVE_PATH',
    );
    await expectRejectsCode(
      () =>
        write([
          {
            path: 'manifest.json',
            byteLength: 3,
            body: Readable.from([Buffer.from('no')]),
          },
        ]),
      'ENTRY_SIZE_MISMATCH',
    );
  });

  it('aborts a stalled body after the finite no-progress timeout', async () => {
    await expectRejectsCode(
      () =>
        write(
          [
            {
              path: 'manifest.json',
              byteLength: 1,
              body: new Readable({ read() {} }),
            },
          ],
          { limits: { noProgressTimeoutMs: 20 } },
        ),
      'NO_PROGRESS_TIMEOUT',
    );
  });

  it('aborts and destroys a stalled output after the finite no-progress timeout', async () => {
    const stalledOutput = new Writable({ write() {} });
    await expectRejectsCode(
      () =>
        writeTarZstd(writeEntries([['manifest.json', '{}']]), stalledOutput, {
          limits: { noProgressTimeoutMs: 20 },
        }),
      'NO_PROGRESS_TIMEOUT',
    );
    expect(stalledOutput.destroyed).toBe(true);
  });

  it('keeps an earlier caller abort classified as cancellation while cleanup is delayed', async () => {
    const controller = new AbortController();
    const delayedDestroyOutput = new Writable({
      write() {},
      destroy(error, callback) {
        setTimeout(() => callback(error), 50);
      },
    });
    const abortTimer = setTimeout(() => controller.abort(new Error('caller cancelled')), 5);

    try {
      await expectRejectsCode(
        () =>
          writeTarZstd(writeEntries([['manifest.json', '{}']]), delayedDestroyOutput, {
            signal: controller.signal,
            limits: { noProgressTimeoutMs: 20 },
          }),
        'ARCHIVE_ABORTED',
      );
    } finally {
      clearTimeout(abortTimer);
    }
  });
});
