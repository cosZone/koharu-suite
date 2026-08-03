import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ArchiveValidationError, validateTarZstdArchive } from '../src/validator.js';
import { loadLogicalFixture, prepareFixtureArchive } from './archive-fixture.js';

async function reasonsFor(archive: Buffer): Promise<string[]> {
  try {
    await validateTarZstdArchive(Readable.from([archive]));
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveValidationError);
    return (error as ArchiveValidationError).report.issues.map((issue) => issue.sanitizedReason);
  }
  throw new Error('Expected validation failure');
}

describe('portable archive cross-record closure', () => {
  it('round-trips complete revision history and selects the declared current revision', async () => {
    const fixture = await loadLogicalFixture('minimal');
    const current = fixture.messages[0] as { currentRevisionNumber: number };
    const secondRevision = structuredClone(fixture.revisions[0]) as {
      revisionNumber: number;
      text: string;
    };
    current.currentRevisionNumber = 2;
    secondRevision.revisionNumber = 2;
    secondRevision.text = 'updated';
    fixture.revisions.splice(1, 0, secondRevision);
    const prepared = await prepareFixtureArchive(fixture);
    await expect(validateTarZstdArchive(Readable.from([prepared.archive]))).resolves.toMatchObject({
      report: { counts: { revisions: 3 }, status: 'clean' },
    });
  });

  it('rejects duplicate logical identities and revision sequence gaps', async () => {
    const duplicateFixture = await loadLogicalFixture('minimal');
    duplicateFixture.channels.push(structuredClone(duplicateFixture.channels[0]));
    const duplicate = await prepareFixtureArchive(duplicateFixture);
    expect(await reasonsFor(duplicate.archive)).toEqual(
      expect.arrayContaining(['record_order_or_identity_invalid', 'duplicate_channel']),
    );

    const duplicateMessageFixture = await loadLogicalFixture('minimal');
    duplicateMessageFixture.messages.splice(
      1,
      0,
      structuredClone(duplicateMessageFixture.messages[0]),
    );
    expect(
      await reasonsFor((await prepareFixtureArchive(duplicateMessageFixture)).archive),
    ).toContain('duplicate_message');

    const duplicateRevisionFixture = await loadLogicalFixture('minimal');
    duplicateRevisionFixture.revisions.splice(
      1,
      0,
      structuredClone(duplicateRevisionFixture.revisions[0]),
    );
    expect(
      await reasonsFor((await prepareFixtureArchive(duplicateRevisionFixture)).archive),
    ).toContain('duplicate_revision');

    const duplicateProvenanceFixture = await loadLogicalFixture('full');
    duplicateProvenanceFixture['provenance-observations'].push(
      structuredClone(duplicateProvenanceFixture['provenance-observations'][0]),
    );
    expect(
      await reasonsFor((await prepareFixtureArchive(duplicateProvenanceFixture)).archive),
    ).toEqual(
      expect.arrayContaining([
        'duplicate_provenance_observation',
        'duplicate_provenance_source_identity',
      ]),
    );

    const gapFixture = await loadLogicalFixture('minimal');
    const revision = gapFixture.revisions[0] as { revisionNumber: number };
    const message = gapFixture.messages[0] as { currentRevisionNumber: number };
    revision.revisionNumber = 2;
    message.currentRevisionNumber = 2;
    const gap = await prepareFixtureArchive(gapFixture);
    expect(await reasonsFor(gap.archive)).toContain('revision_sequence_invalid');
  });

  it('rejects invalid entity ranges, media positions, and bot locators', async () => {
    const entityFixture = await loadLogicalFixture('minimal');
    const entity = (
      entityFixture.revisions[0] as { entities: Array<{ length: number; offset: number }> }
    ).entities[0];
    if (entity === undefined) throw new Error('Missing fixture entity');
    entity.offset = 4;
    entity.length = 2;
    const entityArchive = await prepareFixtureArchive(entityFixture);
    expect(await reasonsFor(entityArchive.archive)).toContain('entity_range_invalid');

    const mediaFixture = await loadLogicalFixture('full');
    (mediaFixture['revision-media'][0] as { position: number }).position = 1;
    (mediaFixture['revision-media'][1] as { position: number }).position = 2;
    const mediaArchive = await prepareFixtureArchive(mediaFixture);
    expect(await reasonsFor(mediaArchive.archive)).toContain('media_position_invalid');

    const locatorFixture = await loadLogicalFixture('full');
    (
      locatorFixture['revision-media'][0] as {
        source: { telegramFileUniqueId: string | null };
      }
    ).source.telegramFileUniqueId = null;
    const locatorArchive = await prepareFixtureArchive(locatorFixture);
    expect(await reasonsFor(locatorArchive.archive)).toContain('media_source_locator_invalid');
  });

  it('rejects blob identity conflicts, missing included blobs, and orphan blobs', async () => {
    const conflictFixture = await loadLogicalFixture('full');
    const conflicting = conflictFixture['revision-media'][1] as {
      availability: string;
      original: { included: boolean };
    };
    conflicting.availability = 'not_included';
    conflicting.original.included = false;
    const conflict = await prepareFixtureArchive(conflictFixture);
    expect(await reasonsFor(conflict.archive)).toContain('blob_identity_conflict');

    const missingFixture = await loadLogicalFixture('full');
    missingFixture.blobs = [];
    const missing = await prepareFixtureArchive(missingFixture);
    expect(await reasonsFor(missing.archive)).toContain('included_blob_missing_or_length_mismatch');

    const orphanFixture = await loadLogicalFixture('minimal');
    orphanFixture.sections.media = true;
    orphanFixture.blobs.push({
      sha256: 'f9c233fc3e2f21acddfc25103f5877c75249b1242e27050809aeba8d8ca848b2',
      utf8: 'shared-media-bytes',
    });
    const orphan = await prepareFixtureArchive(orphanFixture);
    expect(await reasonsFor(orphan.archive)).toContain('orphan_blob');
  });

  it('requires provenance media to match an exact observation identity', async () => {
    const fixture = await loadLogicalFixture('full');
    (
      fixture['provenance-media'][0] as {
        source: { sourceFileSha256: string };
      }
    ).source.sourceFileSha256 = 'b'.repeat(64);
    const prepared = await prepareFixtureArchive(fixture);
    expect(await reasonsFor(prepared.archive)).toContain('dangling_provenance_media_observation');

    const botFixture = await loadLogicalFixture('full');
    (
      botFixture['provenance-observations'][0] as {
        source: unknown;
      }
    ).source = {
      kind: 'telegram_bot_update',
      telegramUpdateId: '42',
      updateType: 'channel_post',
    };
    const botMedia = botFixture['provenance-media'][0] as {
      source: unknown;
      telegramFileId: string | null;
      telegramFileUniqueId: string | null;
    };
    botMedia.source = {
      kind: 'telegram_bot_update',
      telegramUpdateId: '42',
      updateType: 'edited_channel_post',
    };
    botMedia.telegramFileId = 'file-id';
    botMedia.telegramFileUniqueId = 'unique-id';
    const botPrepared = await prepareFixtureArchive(botFixture);
    expect(await reasonsFor(botPrepared.archive)).toContain(
      'dangling_provenance_media_observation',
    );
  });

  it('rejects dangling message, revision, media, and provenance references', async () => {
    const messageFixture = await loadLogicalFixture('minimal');
    (messageFixture.messages[0] as { telegramChatId: string }).telegramChatId = '-42';
    expect(await reasonsFor((await prepareFixtureArchive(messageFixture)).archive)).toContain(
      'dangling_message_channel',
    );

    const revisionFixture = await loadLogicalFixture('minimal');
    (revisionFixture.revisions[0] as { telegramMessageId: string }).telegramMessageId = '42';
    expect(await reasonsFor((await prepareFixtureArchive(revisionFixture)).archive)).toContain(
      'dangling_revision_message',
    );

    const mediaFixture = await loadLogicalFixture('full');
    for (const media of mediaFixture['revision-media'] as Array<{ revisionNumber: number }>) {
      media.revisionNumber = 2;
    }
    expect(await reasonsFor((await prepareFixtureArchive(mediaFixture)).archive)).toContain(
      'dangling_revision_media',
    );

    const provenanceFixture = await loadLogicalFixture('full');
    for (const record of [
      provenanceFixture['provenance-observations'][0],
      provenanceFixture['provenance-media'][0],
    ] as Array<{ revisionNumber: number; telegramMessageId: string }>) {
      record.telegramMessageId = '42';
      record.revisionNumber = 2;
    }
    const provenanceReasons = await reasonsFor(
      (await prepareFixtureArchive(provenanceFixture)).archive,
    );
    expect(provenanceReasons).toEqual(
      expect.arrayContaining(['dangling_provenance_message', 'dangling_provenance_revision']),
    );
  });

  it('deduplicates known missing media and rejects aggregate drift', async () => {
    const fixture = await loadLogicalFixture('minimal');
    const first = fixture['revision-media'][0] as {
      original: unknown;
      position: number;
    };
    first.original = {
      byteLength: '123',
      detectedMimeType: 'image/jpeg',
      included: false,
      sha256: 'c'.repeat(64),
    };
    const second = structuredClone(first);
    second.position = 1;
    fixture['revision-media'].push(second);
    const clean = await prepareFixtureArchive(fixture);
    await expect(validateTarZstdArchive(Readable.from([clean.archive]))).resolves.toMatchObject({
      report: { counts: { mediaMissing: 2 }, status: 'clean' },
    });

    const drift = await prepareFixtureArchive(fixture, {
      mutateManifest: (manifest) => {
        manifest.missingMedia.knownBytes = '124';
      },
    });
    expect(await reasonsFor(drift.archive)).toContain('missing_media_summary_mismatch');
  });

  it('rejects a declared shard record count that differs from streamed JSONL', async () => {
    const fixture = await loadLogicalFixture('minimal');
    const prepared = await prepareFixtureArchive(fixture, {
      mutateManifest: (manifest) => {
        const channelFile = manifest.files.find((file) => file.family === 'channels');
        if (channelFile === undefined) throw new Error('Missing channel shard');
        channelFile.recordCount += 1;
        manifest.counts.channels += 1;
      },
    });
    expect(await reasonsFor(prepared.archive)).toContain('shard_record_count_mismatch');
  });

  it('rejects missing, extra, and corrupted inventory entries', async () => {
    const empty = await prepareFixtureArchive(
      {
        blobs: [],
        channels: [],
        messages: [],
        'provenance-media': [],
        'provenance-observations': [],
        'revision-media': [],
        revisions: [],
        sections: { media: false, provenance: false },
      },
      {
        reorderTarEntries: (entries) => {
          entries.pop();
        },
      },
    );
    expect(await reasonsFor(empty.archive)).toContain('checksum_missing');

    const fixture = await loadLogicalFixture('minimal');
    const missing = await prepareFixtureArchive(fixture, {
      reorderTarEntries: (entries) => {
        entries.pop();
      },
    });
    expect(await reasonsFor(missing.archive)).toContain('archive_entry_missing');

    const extra = await prepareFixtureArchive(fixture, {
      reorderTarEntries: (entries) => {
        entries.push({
          body: Buffer.from('extra'),
          path: 'blobs/sha256/aa/aa/'.concat('a'.repeat(64)),
        });
      },
    });
    expect(await reasonsFor(extra.archive)).toContain('extra_archive_entry');

    const checksum = await prepareFixtureArchive(fixture, {
      reorderTarEntries: (entries) => {
        const checksumEntry = entries.find((entry) => entry.path === 'checksums.sha256');
        if (checksumEntry !== undefined) checksumEntry.body[0] = (checksumEntry.body[0] ?? 0) ^ 1;
      },
    });
    expect(await reasonsFor(checksum.archive)).toContain('checksum_digest_mismatch');
  });
});
