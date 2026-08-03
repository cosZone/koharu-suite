import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJsonBytes } from '@koharu-suite/archive-format';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveSpool } from '../src/archive/spool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createSpool(): Promise<{ root: string; spool: ArchiveSpool }> {
  const root = await mkdtemp(join(tmpdir(), 'koharu-archive-spool-'));
  roots.push(root);
  return { root, spool: new ArchiveSpool({ directory: root }) };
}

describe('ArchiveSpool', () => {
  it('writes canonical family shards and derives counts without media bytes', async () => {
    const { root, spool } = await createSpool();
    await spool.write('channels', {
      recordType: 'channel',
      telegramChatId: '-1001',
      title: 'Channel',
      username: null,
    });
    await spool.write('messages', {
      currentRevisionNumber: 1,
      publishedAt: '2026-08-03T00:00:00.000Z',
      recordType: 'message',
      telegramChatId: '-1001',
      telegramMessageId: '1',
      visibility: { changedAt: '2026-08-03T01:00:00.000Z', state: 'hidden' },
    });
    await spool.write('revisions', {
      authorSignature: null,
      contentKind: 'text',
      editedAt: null,
      entities: [],
      mediaGroupId: null,
      recordType: 'revision',
      revisionNumber: 1,
      telegramChatId: '-1001',
      telegramMessageId: '1',
      text: 'hello',
    });
    await spool.write('revision-media', {
      availability: 'not_included',
      duration: null,
      fileName: null,
      fileSize: '10',
      height: null,
      kind: 'photo',
      mimeType: 'image/jpeg',
      original: {
        byteLength: '10',
        detectedMimeType: 'image/jpeg',
        included: false,
        sha256: 'a'.repeat(64),
      },
      position: 0,
      recordType: 'revision-media',
      revisionNumber: 1,
      source: {
        kind: 'telegram_desktop_json',
        mediaType: 'photo',
        metadata: {},
        telegramFileId: null,
        telegramFileUniqueId: null,
      },
      telegramChatId: '-1001',
      telegramMessageId: '1',
      width: null,
    });

    const summary = await spool.finish();
    expect(summary.counts).toEqual({
      blobs: 0,
      channels: 1,
      hiddenMessages: 1,
      messages: 1,
      provenanceMedia: 0,
      provenanceObservations: 0,
      revisionMedia: 1,
      revisions: 1,
      visibleMessages: 0,
    });
    expect(summary.logicalBytes.blobs).toBe('0');
    expect(summary.missingMedia).toEqual({ knownBytes: '10', references: 1, uniqueObjects: 1 });
    expect(summary.files.map((file) => file.path)).toEqual([
      'data/channels/000000.jsonl',
      'data/messages/000000.jsonl',
      'data/revisions/000000.jsonl',
      'data/revision-media/000000.jsonl',
    ]);
    expect(await readFile(join(root, 'data/channels/000000.jsonl'), 'utf8')).toBe(
      '{"recordType":"channel","telegramChatId":"-1001","title":"Channel","username":null}\n',
    );
  });

  it('fails closed on record/family mismatches and backwards family order', async () => {
    const { spool } = await createSpool();
    await expect(
      spool.write('messages', {
        recordType: 'channel',
        telegramChatId: '-1001',
        title: 'Channel',
        username: null,
      }),
    ).rejects.toThrow('archive_family_mismatch');

    await spool.write('messages', {
      currentRevisionNumber: 1,
      publishedAt: '2026-08-03T00:00:00.000Z',
      recordType: 'message',
      telegramChatId: '-1001',
      telegramMessageId: '1',
      visibility: { changedAt: null, state: 'public' },
    });
    await expect(
      spool.write('channels', {
        recordType: 'channel',
        telegramChatId: '-1001',
        title: 'Channel',
        username: null,
      }),
    ).rejects.toThrow('archive_family_order_invalid');
    await spool.closeAfterFailure();
  });

  it('rejects a line before writing when the cumulative JSONL budget would be exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-archive-spool-'));
    roots.push(root);
    const first = {
      recordType: 'channel' as const,
      telegramChatId: '-1001',
      title: 'First channel',
      username: null,
    };
    const second = {
      recordType: 'channel' as const,
      telegramChatId: '-1002',
      title: 'Second channel',
      username: null,
    };
    const firstLine = Buffer.concat([Buffer.from(canonicalJsonBytes(first)), Buffer.from('\n')]);
    const spool = new ArchiveSpool({ directory: root, maxJsonlBytes: firstLine.byteLength });

    await spool.write('channels', first);
    await expect(spool.write('channels', second)).rejects.toThrow(
      'archive_spool_byte_limit_exceeded',
    );
    await spool.closeAfterFailure();

    await expect(readFile(join(root, 'data/channels/000000.jsonl'))).resolves.toEqual(firstLine);
  });
});
