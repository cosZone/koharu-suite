import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  telegramChannels,
  telegramUpdates,
} from '../../src/db/schema.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';
import type { NormalizedMessageSnapshot, SourceObservation } from '../../src/messages/types.js';
import { normalizeChannelPost } from '../../src/telegram/normalize.js';
import type { NormalizedChannelPost } from '../../src/telegram/types.js';
import { channelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_ID = -1_001_234_567_890n;

function botPost(messageId: number, updateId: number): NormalizedChannelPost {
  const post = normalizeChannelPost(
    channelPostFixture({ channelId: Number(CHANNEL_ID), messageId, updateId }),
    CHANNEL_ID,
  );
  if (!post) {
    throw new Error('Bot fixture did not normalize');
  }
  return post;
}

function botSnapshot(post: NormalizedChannelPost): NormalizedMessageSnapshot {
  return {
    channel: post.channel,
    media: post.media.map((media) => ({
      availabilityReason: null,
      duration: media.duration,
      fileName: media.fileName,
      fileSize: media.fileSize,
      height: media.height,
      kind: media.kind,
      mimeType: media.mimeType,
      sourceMediaType: media.kind,
      sourceMetadata: { locatorOrigin: 'bot' },
      sourcePath: null,
      telegramFileId: media.fileId,
      telegramFileUniqueId: media.fileUniqueId,
      width: media.width,
    })),
    message: post.message,
  };
}

function desktopSnapshot(post: NormalizedChannelPost): NormalizedMessageSnapshot {
  return {
    channel: post.channel,
    media: post.media.map((media) => ({
      availabilityReason: null,
      duration: media.duration,
      fileName: media.fileName,
      fileSize: media.fileSize,
      height: media.height,
      kind: media.kind,
      mimeType: media.mimeType,
      sourceMediaType: media.kind,
      sourceMetadata: { locatorOrigin: 'desktop' },
      sourcePath: 'photos/photo_1.jpg',
      telegramFileId: null,
      telegramFileUniqueId: null,
      width: media.width,
    })),
    message: post.message,
  };
}

function botObservation(
  post: NormalizedChannelPost,
): Extract<SourceObservation, { kind: 'telegram_bot_update' }> {
  return {
    importRunId: null,
    kind: 'telegram_bot_update',
    observedAt: null,
    raw: post.rawUpdate,
    sourceMetadata: {},
    sourceKey: post.telegramUpdateId.toString(),
    telegramUpdateId: post.telegramUpdateId,
    updateType: post.updateType,
  };
}

function desktopObservation(
  sourceKey: string,
  snapshot: NormalizedMessageSnapshot,
): Extract<SourceObservation, { kind: 'telegram_desktop_json' }> {
  return {
    importRunId: null,
    kind: 'telegram_desktop_json',
    observedAt: snapshot.message.publishedAt,
    raw: { id: snapshot.message.telegramMessageId.toString(), type: 'message' },
    sourceChatId: 1_234_567_890n,
    sourceMetadata: {},
    sourceKey,
    sourceMessageId: snapshot.message.telegramMessageId,
  };
}

describe('source media observation writer', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connection: DatabaseConnection | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  }, 30_000);

  beforeEach(async () => {
    await connection?.db.execute(sql`truncate table ${telegramChannels} cascade`);
  });

  it.each([
    ['Bot first', 'bot'],
    ['Desktop first', 'desktop'],
  ] as const)(
    '%s preserves both locator sets without another revision',
    async (_label, firstKind) => {
      if (!connection) {
        throw new Error('Database connection was not created');
      }

      const database = connection.db;
      const repository = new PostgresMessageRepository(database);
      const post = botPost(firstKind === 'bot' ? 101 : 102, firstKind === 'bot' ? 9_101 : 9_102);
      const bot = botSnapshot(post);
      const desktop = desktopSnapshot(post);
      const botEvidence = botObservation(post);
      const desktopEvidence = desktopObservation(`desktop:${firstKind}`, desktop);

      const first =
        firstKind === 'bot'
          ? await repository.ingestSnapshot(bot, botEvidence)
          : await repository.ingestSnapshot(desktop, desktopEvidence);
      const second =
        firstKind === 'bot'
          ? await repository.ingestSnapshot(desktop, desktopEvidence)
          : await repository.ingestSnapshot(bot, botEvidence);

      expect(first).toMatchObject({
        createdMessage: true,
        createdRevision: true,
        resolution: 'created',
      });
      expect(second).toMatchObject({
        createdMessage: false,
        createdRevision: false,
        messageId: first.messageId,
        resolution: 'matched',
        revisionId: first.revisionId,
      });
      expect(first.observationId).not.toBe(second.observationId);

      const replayedFirst =
        firstKind === 'bot'
          ? await repository.ingestSnapshot(bot, botEvidence)
          : await repository.ingestSnapshot(desktop, desktopEvidence);
      const replayedSecond =
        firstKind === 'bot'
          ? await repository.ingestSnapshot(desktop, desktopEvidence)
          : await repository.ingestSnapshot(bot, botEvidence);
      expect(replayedFirst).toMatchObject({
        observationId: first.observationId,
        replayed: true,
      });
      expect(replayedSecond).toMatchObject({
        observationId: second.observationId,
        replayed: true,
      });

      const [revisionCount, observationCount, mediaObservationCount] = await Promise.all(
        [messageRevisions, messageSourceObservations, messageSourceMediaObservations].map(
          async (table) => {
            const [row] = await database.select({ value: count() }).from(table);
            return row?.value;
          },
        ),
      );
      expect([revisionCount, observationCount, mediaObservationCount]).toEqual([1, 2, 2]);

      const mediaEvidence = await database
        .select()
        .from(messageSourceMediaObservations)
        .orderBy(asc(messageSourceMediaObservations.sourceKind));
      expect(mediaEvidence).toMatchObject([
        {
          availability: 'available',
          desktopSourcePath: null,
          sourceKind: 'telegram_bot_update',
          sourceMetadata: { locatorOrigin: 'bot' },
          telegramFileId: post.media[0]?.fileId,
          telegramFileUniqueId: post.media[0]?.fileUniqueId,
        },
        {
          availability: 'available',
          desktopSourcePath: 'photos/photo_1.jpg',
          sourceKind: 'telegram_desktop_json',
          sourceMetadata: { locatorOrigin: 'desktop' },
          telegramFileId: null,
          telegramFileUniqueId: null,
        },
      ]);
    },
    30_000,
  );

  it('applies placeholder, relative-path, and Bot file-ID constraints atomically', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const database = connection.db;
    const repository = new PostgresMessageRepository(database);
    const placeholderPost = botPost(110, 9_110);
    const placeholder = desktopSnapshot(placeholderPost);
    const [placeholderMedia] = placeholder.media;
    if (!placeholderMedia) {
      throw new Error('Desktop fixture has no media');
    }
    placeholder.media = [
      {
        ...placeholderMedia,
        availabilityReason: 'not_included',
        sourcePath: null,
      },
    ];
    const placeholderResult = await repository.ingestSnapshot(
      placeholder,
      desktopObservation('desktop:placeholder', placeholder),
    );
    await expect(
      database
        .select({
          availability: messageSourceMediaObservations.availability,
          desktopSourcePath: messageSourceMediaObservations.desktopSourcePath,
        })
        .from(messageSourceMediaObservations)
        .where(eq(messageSourceMediaObservations.observationId, placeholderResult.observationId)),
    ).resolves.toEqual([{ availability: 'not_included', desktopSourcePath: null }]);

    const invalidPath = desktopSnapshot(placeholderPost);
    const invalidPathMedia = invalidPath.media[0];
    if (!invalidPathMedia) {
      throw new Error('Desktop fixture has no media');
    }
    invalidPath.media = [
      {
        ...invalidPathMedia,
        sourcePath: '/Users/operator/private/photo.jpg',
      },
    ];
    await expect(
      repository.ingestSnapshot(
        invalidPath,
        desktopObservation('desktop:absolute-path', invalidPath),
      ),
    ).rejects.toThrow('path does not match its availability');

    for (const [sourceKey, sourcePath] of [
      ['desktop:https-uri', 'https://example.test/private.jpg'],
      ['desktop:file-uri', 'file:photos/private.jpg'],
      ['desktop:nul-path', 'photos/private\u0000.jpg'],
    ] as const) {
      invalidPath.media = [{ ...invalidPathMedia, sourcePath }];
      await expect(
        repository.ingestSnapshot(invalidPath, desktopObservation(sourceKey, invalidPath)),
      ).rejects.toThrow('path does not match its availability');
    }

    const pollutedDesktop = desktopSnapshot(placeholderPost);
    const pollutedDesktopMedia = pollutedDesktop.media[0];
    if (!pollutedDesktopMedia) {
      throw new Error('Desktop fixture has no media');
    }
    pollutedDesktop.media = [
      {
        ...pollutedDesktopMedia,
        telegramFileId: 'must-not-be-copied',
      },
    ];
    await expect(
      repository.ingestSnapshot(
        pollutedDesktop,
        desktopObservation('desktop:telegram-file-id', pollutedDesktop),
      ),
    ).rejects.toThrow('cannot contain Telegram file locators');

    const invalidBot = botSnapshot(placeholderPost);
    const invalidBotMedia = invalidBot.media[0];
    if (!invalidBotMedia) {
      throw new Error('Bot fixture has no media');
    }
    invalidBot.media = [
      {
        ...invalidBotMedia,
        sourcePath: 'photos/photo_1.jpg',
      },
    ];
    await expect(
      repository.ingestSnapshot(invalidBot, botObservation(placeholderPost)),
    ).rejects.toThrow('must contain only available Telegram file locators');

    invalidBot.media = [
      {
        ...invalidBotMedia,
        telegramFileId: null,
      },
    ];
    await expect(
      repository.ingestSnapshot(invalidBot, botObservation(placeholderPost)),
    ).rejects.toThrow('must contain only available Telegram file locators');

    const [revisionCount, observationCount, mediaObservationCount, updateCount] = await Promise.all(
      [
        messageRevisions,
        messageSourceObservations,
        messageSourceMediaObservations,
        telegramUpdates,
      ].map(async (table) => {
        const [row] = await database.select({ value: count() }).from(table);
        return row?.value;
      }),
    );
    expect([revisionCount, observationCount, mediaObservationCount, updateCount]).toEqual([
      1, 1, 1, 0,
    ]);
  }, 30_000);
});
