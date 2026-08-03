import { TextEncoder } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  archiveDataShardPath,
  decodeJsonl,
  encodeJsonl,
  encodeJsonlShards,
  JsonlError,
  type JsonlOptions,
} from '../src/jsonl.js';

const encoder = new TextEncoder();
const limits: JsonlOptions = {
  maxLineBytes: 1024,
  maxRecords: 100,
};

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

function chunks(...values: string[]): Uint8Array[] {
  return values.map((value) => encoder.encode(value));
}

describe('JSONL codec', () => {
  it('encodes one compact UTF-8 object per line with a final LF', async () => {
    const encoded = await collect(
      encodeJsonl([{ id: 1, text: '小春' }, { nested: { ok: true } }], limits),
    );

    expect(Buffer.concat(encoded).toString('utf8')).toBe(
      '{"id":1,"text":"小春"}\n{"nested":{"ok":true}}\n',
    );
    expect(encoded).toHaveLength(2);
    expect(encoded.every((line) => line.at(-1) === 0x0a)).toBe(true);
  });

  it('sorts object keys canonically instead of preserving insertion order', async () => {
    const encoded = await collect(
      encodeJsonl([{ z: 1, nested: { z: true, a: false }, a: 2 }], limits),
    );

    expect(Buffer.concat(encoded).toString('utf8')).toBe(
      '{"a":2,"nested":{"a":false,"z":true},"z":1}\n',
    );
  });

  it('rejects non-canonical key order and duplicate JSON keys', async () => {
    await expect(collect(decodeJsonl(chunks('{"z":1,"a":2}\n'), limits))).rejects.toMatchObject({
      code: 'non_canonical_json',
      lineNo: 1,
    });
    await expect(collect(decodeJsonl(chunks('{"a":1,"a":2}\n'), limits))).rejects.toMatchObject({
      code: 'non_canonical_json',
      lineNo: 1,
    });
  });

  it('decodes chunk boundaries inside syntax and multibyte UTF-8 code points', async () => {
    const input = encoder.encode('{"text":"小春🌸"}\n{"id":2}\n');
    const splitPoints = [1, 8, 9, 10, 12, 15, input.byteLength - 2];
    const split: Uint8Array[] = [];
    let start = 0;
    for (const end of splitPoints) {
      split.push(input.subarray(start, end));
      start = end;
    }
    split.push(input.subarray(start));

    await expect(collect(decodeJsonl(split, limits))).resolves.toEqual([
      { text: '小春🌸' },
      { id: 2 },
    ]);
  });

  it('accepts an empty file but requires a trailing LF for non-empty input', async () => {
    await expect(collect(decodeJsonl([], limits))).resolves.toEqual([]);
    await expect(collect(decodeJsonl(chunks('{"id":1}'), limits))).rejects.toMatchObject({
      byteOffset: 0,
      code: 'missing_trailing_lf',
      lineNo: 1,
    });
  });

  it.each([
    ['leading', '\n{"id":1}\n', 1, 0],
    ['interior', '{"id":1}\n\n{"id":2}\n', 2, 9],
    ['whitespace-only', '{"id":1}\n  \t\n', 2, 9],
  ])('rejects a %s blank line with its position', async (_name, input, lineNo, byteOffset) => {
    await expect(collect(decodeJsonl(chunks(input), limits))).rejects.toMatchObject({
      byteOffset,
      code: 'blank_line',
      lineNo,
    });
  });

  it('rejects CRLF rather than silently accepting a non-LF line ending', async () => {
    await expect(collect(decodeJsonl(chunks('{"id":1}\r\n'), limits))).rejects.toMatchObject({
      byteOffset: 0,
      code: 'invalid_line_ending',
      lineNo: 1,
    });
    await expect(collect(decodeJsonl(chunks('{"id":1}\r \n'), limits))).rejects.toMatchObject({
      code: 'invalid_line_ending',
    });
  });

  it.each([
    ['invalid_json', '{"secret":"do-not-echo"\n'],
    ['invalid_record', '["do-not-echo"]\n'],
  ])('reports sanitized %s without echoing source text', async (code, input) => {
    let failure: unknown;
    try {
      await collect(decodeJsonl(chunks(input), limits));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(JsonlError);
    expect(failure).toMatchObject({ byteOffset: 0, code, lineNo: 1 });
    expect(String(failure)).not.toContain('do-not-echo');
  });

  it('reports byte offsets rather than UTF-16 character offsets', async () => {
    const firstLine = '{"text":"小春"}\n';

    await expect(
      collect(decodeJsonl(chunks(firstLine, '{"invalid"\n'), limits)),
    ).rejects.toMatchObject({
      byteOffset: Buffer.byteLength(firstLine),
      code: 'invalid_json',
      lineNo: 2,
    });
  });

  it('rejects malformed UTF-8 without echoing decoded replacement text', async () => {
    const invalid = Uint8Array.from([
      0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a,
    ]);

    await expect(collect(decodeJsonl([invalid], limits))).rejects.toMatchObject({
      byteOffset: 0,
      code: 'invalid_utf8',
      lineNo: 1,
    });
  });

  it('rejects a UTF-8 BOM instead of silently stripping it', async () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
    await expect(
      collect(decodeJsonl([bom, ...chunks('{"id":1}\n')], limits)),
    ).rejects.toMatchObject({
      code: 'invalid_json',
      lineNo: 1,
    });
  });

  it('enforces maxLineBytes across chunks and reports the line start', async () => {
    const input = chunks('{"id":1}\n{"text":"', 'too large', '"}\n');

    await expect(
      collect(decodeJsonl(input, { maxLineBytes: 16, maxRecords: 10 })),
    ).rejects.toMatchObject({
      byteOffset: 9,
      code: 'line_too_large',
      lineNo: 2,
    });
    await expect(
      collect(encodeJsonl([{ text: 'too large' }], { maxLineBytes: 8, maxRecords: 10 })),
    ).rejects.toMatchObject({
      byteOffset: 0,
      code: 'line_too_large',
      lineNo: 1,
    });
  });

  it('enforces maxRecords before parsing or encoding the next record', async () => {
    await expect(
      collect(
        decodeJsonl(chunks('{"id":1}\n{"secret":"not parsed"}\n'), {
          maxLineBytes: 1024,
          maxRecords: 1,
        }),
      ),
    ).rejects.toMatchObject({
      byteOffset: 9,
      code: 'record_limit_exceeded',
      lineNo: 2,
    });
    await expect(
      collect(
        encodeJsonl([{ id: 1 }, { secret: 'not serialized' }], {
          maxLineBytes: 1024,
          maxRecords: 1,
        }),
      ),
    ).rejects.toMatchObject({
      byteOffset: 9,
      code: 'record_limit_exceeded',
      lineNo: 2,
    });
  });

  it.each([null, [], 'value', 1])('refuses to encode a non-object record %j', async (record) => {
    await expect(collect(encodeJsonl([record], limits))).rejects.toMatchObject({
      byteOffset: 0,
      code: 'invalid_record',
      lineNo: 1,
    });
  });

  it('sanitizes serialization failures and object hooks that produce scalars', async () => {
    const throwing = {
      toJSON() {
        throw new Error('do-not-echo');
      },
    };
    const scalar = {
      toJSON() {
        return 'do-not-echo';
      },
    };

    for (const record of [throwing, scalar]) {
      let failure: unknown;
      try {
        await collect(encodeJsonl([record], limits));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'invalid_record', lineNo: 1 });
      expect(String(failure)).not.toContain('do-not-echo');
    }
  });

  it('propagates an AbortSignal while waiting for the next chunk and closes the source', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stop archive inspection', 'AbortError');
    let closed = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const decoding = collect(decodeJsonl(source, { ...limits, signal: controller.signal }));

    controller.abort(reason);

    await expect(decoding).rejects.toBe(reason);
    expect(closed).toBe(true);
  });

  it('streams 100k records with bounded heap growth', { timeout: 30_000 }, async () => {
    const count = 100_000;
    async function* input(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < count; index += 1) {
        yield encoder.encode(`{"id":${index},"text":"小春"}\n`);
      }
    }

    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    let decoded = 0;
    for await (const record of decodeJsonl<{ id: number; text: string }>(input(), {
      maxLineBytes: 128,
      maxRecords: count,
    })) {
      expect(record.id).toBe(decoded);
      decoded += 1;
      if (decoded % 10_000 === 0) {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }
    }

    expect(decoded).toBe(count);
    expect(peak - baseline).toBeLessThan(256 * 1024 * 1024);
  });
});

describe('JSONL shard encoder', () => {
  it('creates deterministic non-empty shards and carries ordering across shard boundaries', async () => {
    const shards = await collect(
      encodeJsonlShards([{ z: 1, a: 1 }, { id: 2 }, { id: 3 }], {
        family: 'messages',
        maxLineBytes: 128,
        maxRecords: 3,
        maxShardBytes: 128,
        maxShardRecords: 2,
      }),
    );

    expect(
      shards.map(({ byteLength, family, path, recordCount, shardIndex }) => ({
        byteLength,
        family,
        path,
        recordCount,
        shardIndex,
      })),
    ).toEqual([
      {
        byteLength: 23,
        family: 'messages',
        path: 'data/messages/000000.jsonl',
        recordCount: 2,
        shardIndex: 0,
      },
      {
        byteLength: 9,
        family: 'messages',
        path: 'data/messages/000001.jsonl',
        recordCount: 1,
        shardIndex: 1,
      },
    ]);
    expect(Buffer.from(shards[0]?.bytes ?? []).toString('utf8')).toBe('{"a":1,"z":1}\n{"id":2}\n');
    expect(Buffer.from(shards[1]?.bytes ?? []).toString('utf8')).toBe('{"id":3}\n');
  });

  it('emits no shard for an empty record stream', async () => {
    await expect(
      collect(
        encodeJsonlShards([], {
          family: 'channels',
          maxLineBytes: 128,
          maxRecords: 0,
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('validates shard paths and finite shard bounds', async () => {
    expect(archiveDataShardPath('revisions', 12)).toBe('data/revisions/000012.jsonl');
    expect(() => archiveDataShardPath('messages', 1_000_000)).toThrow(TypeError);
    await expect(
      collect(
        encodeJsonlShards([{ id: 1 }], {
          family: 'messages',
          maxLineBytes: 128,
          maxRecords: 1,
          maxShardBytes: 64,
        }),
      ),
    ).rejects.toThrow(TypeError);
  });
});
