import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes } from '../src/canonical-json.js';
import { type ChecksumEntry, renderChecksumFile, sha256Hex } from '../src/checksums.js';
import { type ArchiveWriteEntry, writeTarZstd } from '../src/container.js';
import { validateTarZstdArchive } from '../src/validator.js';
import { loadLogicalFixture, prepareFixtureArchive } from './archive-fixture.js';

// Keep the sample larger than the codec/stream fixed allocation overhead.
// The bound still catches any accidental whole-blob retention because that
// would add another full 64 MiB on top of the fixed pipeline cost.
const BLOB_BYTES = 64 * 1_024 * 1_024;
const CHUNK_BYTES = 64 * 1_024;

async function* deterministicBlob(): AsyncGenerator<Buffer> {
  let state = 0x6d2b79f5;
  for (let remaining = BLOB_BYTES; remaining > 0; remaining -= CHUNK_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining));
    for (let offset = 0; offset < chunk.byteLength; offset += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      chunk.writeUInt32LE(state >>> 0, offset);
    }
    yield chunk;
  }
}

async function deterministicBlobHash(): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of deterministicBlob()) hash.update(chunk);
  return hash.digest('hex');
}

describe('large archive streaming', () => {
  it('validates a large synthetic blob without retaining whole-blob copies', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'koharu-archive-large-'));
    try {
      const archivePath = path.join(workDir, 'large.tar.zst');
      const blobHash = await deterministicBlobHash();
      const fixture = await loadLogicalFixture('full');
      fixture.blobs = [];
      for (const media of fixture['revision-media'] as Array<{
        fileSize: string;
        original: { byteLength: string; sha256: string };
      }>) {
        media.fileSize = BLOB_BYTES.toString();
        media.original.byteLength = BLOB_BYTES.toString();
        media.original.sha256 = blobHash;
      }
      const prepared = await prepareFixtureArchive(fixture);
      const dataEntries = prepared.entries.slice(2);
      const blobPath = `blobs/sha256/${blobHash.slice(0, 2)}/${blobHash.slice(2, 4)}/${blobHash}`;
      const checksumEntries: ChecksumEntry[] = [
        ...dataEntries.map(({ body, path: entryPath }) => ({
          byteLength: body.byteLength.toString(),
          path: entryPath,
          sha256: sha256Hex(body),
        })),
        { byteLength: BLOB_BYTES.toString(), path: blobPath, sha256: blobHash },
      ];
      const checksumBody = Buffer.from(renderChecksumFile(checksumEntries));
      prepared.manifest.counts.blobs = 1;
      prepared.manifest.logicalBytes.blobs = BLOB_BYTES.toString();
      prepared.manifest.logicalBytes.total = (
        BigInt(prepared.manifest.logicalBytes.total) + BigInt(BLOB_BYTES)
      ).toString();
      prepared.manifest.checksumFile.byteLength = checksumBody.byteLength.toString();
      prepared.manifest.checksumFile.sha256 = sha256Hex(checksumBody);
      const manifestBody = Buffer.from(
        canonicalJsonBytes(prepared.manifest, { profile: 'manifest' }),
      );
      const entries: ArchiveWriteEntry[] = [
        {
          body: Readable.from([manifestBody]),
          byteLength: manifestBody.byteLength,
          path: 'manifest.json',
        },
        {
          body: Readable.from([checksumBody]),
          byteLength: checksumBody.byteLength,
          path: 'checksums.sha256',
        },
        ...dataEntries.map(({ body, path: entryPath }) => ({
          body: Readable.from([body]),
          byteLength: body.byteLength,
          path: entryPath,
        })),
        {
          body: Readable.from(deterministicBlob()),
          byteLength: BLOB_BYTES,
          path: blobPath,
        },
      ];
      await writeTarZstd(entries, createWriteStream(archivePath));

      const baseline = process.memoryUsage();
      const baselineTracked = baseline.heapUsed + baseline.external;
      let peakTracked = baselineTracked;
      const sample = setInterval(() => {
        const memory = process.memoryUsage();
        peakTracked = Math.max(peakTracked, memory.heapUsed + memory.external);
      }, 2);
      try {
        const result = await validateTarZstdArchive(createReadStream(archivePath));
        expect(result.report.status).toBe('clean');
        expect(result.report.counts).toMatchObject({ blobs: 1, mediaPresent: 2 });
      } finally {
        clearInterval(sample);
      }
      expect(peakTracked - baselineTracked).toBeLessThan(BLOB_BYTES);
    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  }, 60_000);
});
