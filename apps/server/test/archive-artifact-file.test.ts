import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ARCHIVE_FORMAT_NAME,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
  type ArchiveRecordFamily,
  canonicalJsonBytes,
  encodeJsonlShards,
  renderChecksumFile,
  sha256Hex,
  writeTarZstd,
} from '@koharu-suite/archive-format';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ArchiveArtifactOperations,
  prepareArchiveArtifact,
  validateArchiveArtifactFile,
  writeValidatedArchiveArtifact,
} from '../src/archive/artifact-file.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'koharu-archive-artifact-'));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function validArchive(): Promise<Buffer> {
  const records: Partial<Record<ArchiveRecordFamily, unknown[]>> = {
    channels: [
      {
        recordType: 'channel',
        telegramChatId: '-9007199254740994',
        title: 'Fixture channel',
        username: 'fixture_channel',
      },
    ],
    messages: [
      {
        recordType: 'message',
        telegramChatId: '-9007199254740994',
        telegramMessageId: '9007199254740993',
        publishedAt: '2026-08-03T00:00:00.000Z',
        currentRevisionNumber: 1,
        visibility: { state: 'public', changedAt: null },
      },
    ],
    revisions: [
      {
        recordType: 'revision',
        telegramChatId: '-9007199254740994',
        telegramMessageId: '9007199254740993',
        revisionNumber: 1,
        contentKind: 'text',
        text: 'hello',
        entities: [],
        authorSignature: null,
        mediaGroupId: null,
        editedAt: null,
      },
    ],
  };
  const families: ArchiveRecordFamily[] = [
    'channels',
    'messages',
    'revisions',
    'revision-media',
    'provenance-observations',
    'provenance-media',
  ];
  const dataEntries: Array<{
    body: Buffer;
    family: ArchiveRecordFamily;
    path: string;
    recordCount: number;
    shardIndex: number;
  }> = [];
  for (const family of families) {
    for await (const shard of encodeJsonlShards(records[family] ?? [], {
      family,
      maxLineBytes: 4 * 1_024 * 1_024,
      maxRecords: 1_000_000,
    })) {
      dataEntries.push({
        body: Buffer.from(shard.bytes),
        family,
        path: shard.path,
        recordCount: shard.recordCount,
        shardIndex: shard.shardIndex,
      });
    }
  }
  const checksums = dataEntries.map((entry) => ({
    byteLength: entry.body.byteLength.toString(),
    path: entry.path,
    sha256: sha256Hex(entry.body),
  }));
  const checksumBody = Buffer.from(renderChecksumFile(checksums));
  const dataBytes = dataEntries.reduce((sum, entry) => sum + BigInt(entry.body.byteLength), 0n);
  const manifest: ArchiveManifest = {
    checksumFile: {
      byteLength: checksumBody.byteLength.toString(),
      path: 'checksums.sha256',
      sha256: sha256Hex(checksumBody),
    },
    counts: {
      blobs: 0,
      channels: 1,
      hiddenMessages: 0,
      messages: 1,
      provenanceMedia: 0,
      provenanceObservations: 0,
      revisionMedia: 0,
      revisions: 1,
      visibleMessages: 1,
    },
    createdAt: '2026-08-03T00:00:00.000Z',
    exporter: { name: 'koharu-suite', version: '0.4.1' },
    files: dataEntries.map((entry) => ({
      byteLength: entry.body.byteLength.toString(),
      family: entry.family,
      path: entry.path,
      recordCount: entry.recordCount,
      shardIndex: entry.shardIndex,
    })),
    format: ARCHIVE_FORMAT_NAME,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    logicalBytes: {
      blobs: '0',
      data: dataBytes.toString(),
      provenance: '0',
      total: dataBytes.toString(),
    },
    missingMedia: { knownBytes: '0', references: 0, uniqueObjects: 0 },
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    sections: { media: false, provenance: false },
    selection: { mode: 'all' },
    snapshotAt: '2026-08-03T00:00:00.000Z',
  };
  const archiveEntries = [
    {
      body: Buffer.from(canonicalJsonBytes(manifest, { profile: 'manifest' })),
      path: 'manifest.json',
    },
    { body: checksumBody, path: 'checksums.sha256' },
    ...dataEntries,
  ];
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await writeTarZstd(
    archiveEntries.map((entry) => ({
      body: Readable.from([entry.body]),
      byteLength: entry.body.byteLength,
      path: entry.path,
    })),
    output,
  );
  return Buffer.concat(chunks);
}

describe('portable archive artifact filesystem boundary', () => {
  it('publishes only a complete validated 0600 artifact and cleans its random workspace', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'backup.tar.zst');
    const archive = await validArchive();
    let stagingPath = '';
    let workDirectory = '';
    const workspace = await prepareArchiveArtifact({ outputPath });
    stagingPath = workspace.stagingPath;
    workDirectory = workspace.workDirectory;
    try {
      await pipeline(Readable.from([archive]), workspace.createArchiveWriteStream());
      const result = await workspace.validateAndPublish();
      expect(result.report.status).toBe('clean');
    } finally {
      await workspace.cleanup();
    }

    expect(await readFile(outputPath)).toEqual(archive);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(workDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses hard-link no-clobber semantics and preserves an existing target', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'backup.tar.zst');
    await writeFile(outputPath, 'existing', { mode: 0o600 });
    const workspace = await prepareArchiveArtifact({ outputPath });
    try {
      await pipeline(Readable.from([await validArchive()]), workspace.createArchiveWriteStream());
      await expect(workspace.validateAndPublish()).rejects.toMatchObject({ code: 'output_exists' });
    } finally {
      await workspace.cleanup();
    }
    expect(await readFile(outputPath, 'utf8')).toBe('existing');
  });

  it('rejects overwrite of a symlink without changing its referent', async () => {
    const root = await privateRoot();
    const referent = join(root, 'referent.tar.zst');
    const outputPath = join(root, 'backup.tar.zst');
    await writeFile(referent, 'existing', { mode: 0o600 });
    await symlink(referent, outputPath);
    const workspace = await prepareArchiveArtifact({ outputPath, overwrite: true });
    try {
      await pipeline(Readable.from([await validArchive()]), workspace.createArchiveWriteStream());
      await expect(workspace.validateAndPublish()).rejects.toMatchObject({
        code: 'output_not_regular',
      });
    } finally {
      await workspace.cleanup();
    }
    expect(await readFile(referent, 'utf8')).toBe('existing');
    expect((await lstat(outputPath)).isSymbolicLink()).toBe(true);
  });

  it('fails closed for group/world-writable output parents', async () => {
    const root = await privateRoot();
    await chmod(root, 0o777);
    await expect(
      prepareArchiveArtifact({ outputPath: join(root, 'backup.tar.zst') }),
    ).rejects.toMatchObject({
      code: 'output_parent_untrusted',
    });
  });

  it('rejects a private parent beneath a non-sticky writable ancestor', async () => {
    const root = await privateRoot();
    const privateChild = join(root, 'private-child');
    await mkdir(privateChild, { mode: 0o700 });
    await chmod(root, 0o777);

    await expect(
      prepareArchiveArtifact({ outputPath: join(privateChild, 'backup.tar.zst') }),
    ).rejects.toMatchObject({ code: 'output_parent_untrusted' });
  });

  it('fails closed when the opened output parent is replaced before publication', async () => {
    const root = await privateRoot();
    const parent = join(root, 'trusted-parent');
    const movedParent = join(root, 'moved-parent');
    await mkdir(parent, { mode: 0o700 });
    const outputPath = join(parent, 'backup.tar.zst');
    const workspace = await prepareArchiveArtifact({ outputPath });

    try {
      await pipeline(Readable.from([await validArchive()]), workspace.createArchiveWriteStream());
      await rename(parent, movedParent);
      await mkdir(parent, { mode: 0o700 });
      await writeFile(join(parent, 'sentinel'), 'replacement', { mode: 0o600 });

      await expect(workspace.validateAndPublish()).rejects.toMatchObject({
        code: 'output_parent_untrusted',
      });
    } finally {
      await workspace.cleanup();
    }

    expect(await readFile(join(parent, 'sentinel'), 'utf8')).toBe('replacement');
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports durability as unknown without deleting an already published artifact', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'backup.tar.zst');
    const operations: ArchiveArtifactOperations = {
      async syncParentDirectory() {
        throw new Error('injected fsync failure with /private/host/path');
      },
    };
    const workspace = await prepareArchiveArtifact({ outputPath }, operations);
    try {
      await pipeline(Readable.from([await validArchive()]), workspace.createArchiveWriteStream());
      await expect(workspace.validateAndPublish()).rejects.toMatchObject({
        artifactPublished: true,
        code: 'finalization_durability_unknown',
        message: 'Archive artifact operation failed: finalization_durability_unknown',
      });
    } finally {
      await workspace.cleanup();
    }
    await expect(validateArchiveArtifactFile(outputPath)).resolves.toMatchObject({
      report: { status: 'clean' },
    });
  });

  it('removes only random staging resources after cancellation', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'backup.tar.zst');
    const controller = new AbortController();
    const workspace = await prepareArchiveArtifact({ outputPath, signal: controller.signal });
    await pipeline(Readable.from([await validArchive()]), workspace.createArchiveWriteStream());
    controller.abort(new Error('/private/cancellation/reason'));
    await expect(workspace.validateAndPublish()).rejects.toMatchObject({ code: 'archive_aborted' });
    await workspace.cleanup();
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(workspace.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(workspace.workDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('offers a callback convenience API for export services', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'backup.tar.zst');
    const archive = await validArchive();
    await expect(
      writeValidatedArchiveArtifact({
        outputPath,
        write: (output) => pipeline(Readable.from([archive]), output),
      }),
    ).resolves.toMatchObject({ report: { status: 'clean' } });
  });
});
