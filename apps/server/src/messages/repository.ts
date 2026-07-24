import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheObjects,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  telegramChannels,
  telegramUpdates,
} from '../db/schema.js';
import type { NormalizedChannelPost } from '../telegram/types.js';
import { CURRENT_MESSAGE_FINGERPRINT_VERSION, fingerprintMessageSnapshot } from './fingerprint.js';
import { CURRENT_RENDERER_VERSION, renderTelegramMessage } from './renderer.js';
import { lockSourceEvidenceDiscovery } from './source-evidence-coordination.js';
import type {
  MessageListOptions,
  MessagePage,
  MessageReader,
  NormalizedMessageSnapshot,
  PublicMedia,
  PublicMessage,
  SourceNeutralMedia,
  SourceObservation,
  SourceResolution,
  SourceWriteDecision,
  SourceWriteResult,
} from './types.js';

export interface IngestResult {
  channelId: string;
  messageId: string;
  replayed: boolean;
}

export interface MessageWriter {
  ingest(post: NormalizedChannelPost): Promise<IngestResult>;
  ingestSnapshot(
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<SourceWriteResult>;
  previewSnapshot(
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<SourceWriteDecision>;
}

type MessageRow = Awaited<ReturnType<PostgresMessageRepository['selectMessages']>>[number];
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type SourceMediaAvailability = typeof messageSourceMediaObservations.$inferInsert.availability;
type PublicCacheObject = Pick<
  typeof mediaCacheObjects.$inferSelect,
  'canonicalMediaId' | 'id' | 'state' | 'variant'
>;

const PENDING_PUBLIC_CACHE_STATES = new Set<typeof mediaCacheObjects.$inferSelect.state>([
  'awaiting_local_source',
  'discovered',
  'downloading',
  'reserved',
  'retry_wait',
  'staging',
]);

function sourceMediaAvailability(media: SourceNeutralMedia): SourceMediaAvailability {
  switch (media.availabilityReason) {
    case null:
      return 'available';
    case 'exceeds_maximum_size':
    case 'not_included':
    case 'unavailable':
      return media.availabilityReason;
    default:
      throw new Error('Unsupported source media availability reason');
  }
}

function isSafeDesktopSourcePath(path: string): boolean {
  return (
    path.length >= 1 &&
    path.length <= 1_024 &&
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !/^[A-Za-z]:/.test(path) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) &&
    !/(^|\/)\.\.?($|\/)/.test(path) &&
    !path.includes('\\') &&
    !path.includes('\u0000')
  );
}

function sourceMediaObservation(
  media: SourceNeutralMedia,
  observation: SourceObservation,
  observationId: string,
  position: number,
): typeof messageSourceMediaObservations.$inferInsert {
  const availability = sourceMediaAvailability(media);
  if (observation.kind === 'telegram_bot_update') {
    if (
      availability !== 'available' ||
      media.sourcePath !== null ||
      !media.telegramFileId ||
      !media.telegramFileUniqueId
    ) {
      throw new Error('Bot source media must contain only available Telegram file locators');
    }
    return {
      availability,
      desktopSourcePath: null,
      mediaKind: media.kind,
      observationId,
      position,
      sourceKind: observation.kind,
      sourceMetadata: media.sourceMetadata,
      telegramFileId: media.telegramFileId,
      telegramFileUniqueId: media.telegramFileUniqueId,
    };
  }

  if (media.telegramFileId !== null || media.telegramFileUniqueId !== null) {
    throw new Error('Desktop source media cannot contain Telegram file locators');
  }
  if (
    (availability === 'available' &&
      (media.sourcePath === null || !isSafeDesktopSourcePath(media.sourcePath))) ||
    (availability !== 'available' && media.sourcePath !== null)
  ) {
    throw new Error('Desktop source media path does not match its availability');
  }
  return {
    availability,
    desktopSourcePath: media.sourcePath,
    mediaKind: media.kind,
    observationId,
    position,
    sourceKind: observation.kind,
    sourceMetadata: media.sourceMetadata,
    telegramFileId: null,
    telegramFileUniqueId: null,
  };
}

function sourceUrl(username: string | null, telegramMessageId: bigint): string | null {
  return username ? `https://t.me/${username}/${telegramMessageId}` : null;
}

function snapshotFromBotPost(post: NormalizedChannelPost): NormalizedMessageSnapshot {
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
      sourceMetadata: {},
      sourcePath: null,
      telegramFileId: media.fileId,
      telegramFileUniqueId: media.fileUniqueId,
      width: media.width,
    })),
    message: post.message,
  };
}

function cacheObjectUrl(object: PublicCacheObject | undefined): string | null {
  return object?.state === 'ready' ? `/api/v1/media/${object.id}` : null;
}

function publicMedia(
  row: typeof messageMedia.$inferSelect,
  cacheObjects: PublicCacheObject[],
): PublicMedia {
  const original = cacheObjects.find((object) => object.variant === 'original');
  const thumbnail = cacheObjects.find((object) => object.variant === 'thumbnail');
  const cacheStatus =
    original?.state === 'ready'
      ? 'ready'
      : original && PENDING_PUBLIC_CACHE_STATES.has(original.state)
        ? 'pending'
        : 'unavailable';

  return {
    cacheStatus,
    duration: row.duration,
    fileName: row.fileName,
    fileSize: row.fileSize?.toString() ?? null,
    height: row.height,
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    originalUrl: cacheObjectUrl(original),
    thumbnailUrl: cacheObjectUrl(thumbnail),
    width: row.width,
  };
}

function publicMessage(row: MessageRow, media: PublicMedia[]): PublicMessage {
  return {
    authorSignature: row.authorSignature,
    channel: {
      id: row.channelId,
      title: row.channelTitle,
      username: row.channelUsername,
    },
    content: {
      entities: row.entities,
      html: row.html,
      kind: row.contentKind,
      text: row.text,
    },
    id: row.messageId,
    media,
    mediaGroupId: row.mediaGroupId,
    publishedAt: row.publishedAt.toISOString(),
    revision: row.revisionNumber,
    sourceUrl: sourceUrl(row.channelUsername, row.telegramMessageId),
  };
}

export class PostgresMessageRepository implements MessageReader, MessageWriter {
  constructor(private readonly database: Database) {}

  async ingest(post: NormalizedChannelPost): Promise<IngestResult> {
    return this.database.transaction((transaction) => this.ingestInTransaction(transaction, post));
  }

  async ingestInTransaction(
    transaction: DatabaseTransaction,
    post: NormalizedChannelPost,
  ): Promise<IngestResult> {
    const result = await this.ingestSnapshotInTransaction(transaction, snapshotFromBotPost(post), {
      importRunId: null,
      kind: 'telegram_bot_update',
      observedAt: null,
      raw: post.rawUpdate,
      sourceMetadata: {},
      sourceKey: post.telegramUpdateId.toString(),
      telegramUpdateId: post.telegramUpdateId,
      updateType: post.updateType,
    });
    return {
      channelId: result.channelId,
      messageId: result.messageId,
      replayed: result.replayed || (post.updateType === 'channel_post' && !result.createdRevision),
    };
  }

  async ingestSnapshot(
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<SourceWriteResult> {
    return this.database.transaction((transaction) =>
      this.ingestSnapshotInTransaction(transaction, snapshot, observation),
    );
  }

  async previewSnapshot(
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<SourceWriteDecision> {
    return this.database.transaction(async (transaction) => {
      const [channel] = await transaction
        .select({ id: telegramChannels.id })
        .from(telegramChannels)
        .where(eq(telegramChannels.telegramChatId, snapshot.channel.telegramChatId))
        .limit(1);
      if (!channel) {
        return {
          createdMessage: true,
          createdRevision: true,
          replayed: false,
          resolution: 'created',
        };
      }

      const identity = await this.selectIdentity(
        transaction,
        channel.id,
        snapshot.message.telegramMessageId,
      );
      if (!identity) {
        return {
          createdMessage: true,
          createdRevision: true,
          replayed: false,
          resolution: 'created',
        };
      }

      const [existingObservation] = await transaction
        .select({
          channelId: messageSourceObservations.channelId,
          messageId: messageSourceObservations.messageId,
          resolution: messageSourceObservations.resolution,
          telegramMessageId: messageSourceObservations.telegramMessageId,
        })
        .from(messageSourceObservations)
        .where(
          and(
            eq(messageSourceObservations.sourceKind, observation.kind),
            eq(messageSourceObservations.sourceKey, observation.sourceKey),
          ),
        )
        .limit(1);
      if (existingObservation) {
        if (
          existingObservation.channelId !== channel.id ||
          existingObservation.messageId !== identity.id ||
          existingObservation.telegramMessageId !== snapshot.message.telegramMessageId
        ) {
          throw new Error('Source observation key is already associated with another message');
        }
        return {
          createdMessage: false,
          createdRevision: false,
          replayed: true,
          resolution: existingObservation.resolution,
        };
      }

      if (observation.kind === 'telegram_bot_update') {
        if (observation.updateType === 'edited_channel_post') {
          return {
            createdMessage: false,
            createdRevision: true,
            replayed: false,
            resolution: 'created',
          };
        }
        const fingerprint = fingerprintMessageSnapshot(snapshot);
        const matchingRevisionId = await this.selectMatchingRevisionId(
          transaction,
          identity.id,
          snapshot,
          fingerprint,
        );
        return {
          createdMessage: false,
          createdRevision: false,
          replayed: false,
          resolution: matchingRevisionId ? 'matched' : 'conflict',
        };
      }

      const fingerprint = fingerprintMessageSnapshot(snapshot);
      const matchingRevisionId = await this.selectMatchingRevisionId(
        transaction,
        identity.id,
        snapshot,
        fingerprint,
      );
      if (matchingRevisionId) {
        return {
          createdMessage: false,
          createdRevision: false,
          replayed: false,
          resolution: 'matched',
        };
      }

      const current = await this.selectCurrentRevision(
        transaction,
        identity.id,
        identity.currentRevisionNumber,
      );
      const candidateTime = snapshot.message.editedAt;
      const currentTime = current.editedAt ?? identity.publishedAt;
      if (candidateTime && candidateTime.getTime() > currentTime.getTime()) {
        return {
          createdMessage: false,
          createdRevision: true,
          replayed: false,
          resolution: 'created',
        };
      }
      return {
        createdMessage: false,
        createdRevision: false,
        replayed: false,
        resolution:
          candidateTime && candidateTime.getTime() < currentTime.getTime() ? 'stale' : 'conflict',
      };
    });
  }

  async ingestSnapshotInTransaction(
    transaction: DatabaseTransaction,
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<SourceWriteResult> {
    await lockSourceEvidenceDiscovery(transaction);
    const now = new Date();
    const [channel] = await transaction
      .insert(telegramChannels)
      .values({
        telegramChatId: snapshot.channel.telegramChatId,
        title: snapshot.channel.title,
        username: snapshot.channel.username,
      })
      .onConflictDoUpdate({
        target: telegramChannels.telegramChatId,
        set: {
          title: snapshot.channel.title,
          updatedAt: now,
          username:
            observation.kind === 'telegram_desktop_json' && snapshot.channel.username === null
              ? telegramChannels.username
              : snapshot.channel.username,
        },
      })
      .returning({ id: telegramChannels.id });

    if (!channel) {
      throw new Error('Failed to resolve Telegram channel');
    }

    if (observation.kind === 'telegram_bot_update') {
      await transaction
        .insert(telegramUpdates)
        .values({
          channelId: channel.id,
          rawJson: observation.raw,
          telegramUpdateId: observation.telegramUpdateId,
          updateType: observation.updateType,
        })
        .onConflictDoNothing({ target: telegramUpdates.telegramUpdateId });
    }

    const [insertedMessage] = await transaction
      .insert(messages)
      .values({
        channelId: channel.id,
        publishedAt: snapshot.message.publishedAt,
        telegramMessageId: snapshot.message.telegramMessageId,
      })
      .onConflictDoNothing({
        target: [messages.channelId, messages.telegramMessageId],
      })
      .returning({ id: messages.id });
    const identity = await this.selectIdentity(
      transaction,
      channel.id,
      snapshot.message.telegramMessageId,
      true,
    );
    if (!identity) {
      throw new Error('Failed to resolve normalized Telegram message');
    }

    const [replayedObservation] = await transaction
      .select({
        channelId: messageSourceObservations.channelId,
        id: messageSourceObservations.id,
        messageId: messageSourceObservations.messageId,
        resolution: messageSourceObservations.resolution,
        revisionId: messageSourceObservations.revisionId,
        telegramMessageId: messageSourceObservations.telegramMessageId,
      })
      .from(messageSourceObservations)
      .where(
        and(
          eq(messageSourceObservations.sourceKind, observation.kind),
          eq(messageSourceObservations.sourceKey, observation.sourceKey),
        ),
      )
      .limit(1);
    if (replayedObservation) {
      if (
        replayedObservation.channelId !== channel.id ||
        replayedObservation.messageId !== identity.id ||
        replayedObservation.telegramMessageId !== snapshot.message.telegramMessageId
      ) {
        throw new Error('Source observation key is already associated with another message');
      }
      return {
        channelId: channel.id,
        createdMessage: false,
        createdRevision: false,
        messageId: identity.id,
        observationId: replayedObservation.id,
        replayed: true,
        resolution: replayedObservation.resolution,
        revisionId: replayedObservation.revisionId,
      };
    }

    const fingerprint = fingerprintMessageSnapshot(snapshot);
    let createdRevision = false;
    let resolution: SourceResolution;
    let revisionId: string | null;

    if (insertedMessage) {
      revisionId = await this.insertRevision(transaction, identity.id, 1, snapshot, observation);
      createdRevision = true;
      resolution = 'created';
    } else if (observation.kind === 'telegram_bot_update') {
      if (observation.updateType === 'edited_channel_post') {
        const revisionNumber = identity.currentRevisionNumber + 1;
        revisionId = await this.insertRevision(
          transaction,
          identity.id,
          revisionNumber,
          snapshot,
          observation,
        );
        await transaction
          .update(messages)
          .set({
            currentRevisionNumber: revisionNumber,
            updatedAt: now,
          })
          .where(eq(messages.id, identity.id));
        createdRevision = true;
        resolution = 'created';
      } else {
        revisionId = await this.selectMatchingRevisionId(
          transaction,
          identity.id,
          snapshot,
          fingerprint,
        );
        resolution = revisionId ? 'matched' : 'conflict';
      }
    } else {
      const matchingRevisionId = await this.selectMatchingRevisionId(
        transaction,
        identity.id,
        snapshot,
        fingerprint,
      );
      if (matchingRevisionId) {
        revisionId = matchingRevisionId;
        resolution = 'matched';
      } else {
        const current = await this.selectCurrentRevision(
          transaction,
          identity.id,
          identity.currentRevisionNumber,
        );
        const candidateTime = snapshot.message.editedAt;
        const currentTime = current.editedAt ?? identity.publishedAt;
        if (candidateTime && candidateTime.getTime() > currentTime.getTime()) {
          const revisionNumber = identity.currentRevisionNumber + 1;
          revisionId = await this.insertRevision(
            transaction,
            identity.id,
            revisionNumber,
            snapshot,
            observation,
          );
          await transaction
            .update(messages)
            .set({
              currentRevisionNumber: revisionNumber,
              updatedAt: now,
            })
            .where(eq(messages.id, identity.id));
          createdRevision = true;
          resolution = 'created';
        } else {
          revisionId = null;
          resolution =
            candidateTime && candidateTime.getTime() < currentTime.getTime() ? 'stale' : 'conflict';
        }
      }
    }

    const [insertedObservation] = await transaction
      .insert(messageSourceObservations)
      .values({
        channelId: channel.id,
        contentFingerprint: fingerprint,
        contentFingerprintVersion: CURRENT_MESSAGE_FINGERPRINT_VERSION,
        importRunId: observation.kind === 'telegram_desktop_json' ? observation.importRunId : null,
        messageId: identity.id,
        observedAt: observation.observedAt,
        rawJson: observation.raw,
        resolution,
        revisionId,
        sourceMetadata: observation.sourceMetadata,
        sourceKey: observation.sourceKey,
        sourceKind: observation.kind,
        telegramMessageId: snapshot.message.telegramMessageId,
        telegramUpdateId:
          observation.kind === 'telegram_bot_update' ? observation.telegramUpdateId : null,
      })
      .returning({ id: messageSourceObservations.id });
    if (!insertedObservation) {
      throw new Error('Failed to create source observation');
    }
    await this.insertSourceMediaObservations(
      transaction,
      insertedObservation.id,
      snapshot.media,
      observation,
    );
    return {
      channelId: channel.id,
      createdMessage: insertedMessage !== undefined,
      createdRevision,
      messageId: identity.id,
      observationId: insertedObservation.id,
      replayed: false,
      resolution,
      revisionId,
    };
  }

  async listMessages(channelId: string, options: MessageListOptions): Promise<MessagePage | null> {
    const [channel] = await this.database
      .select({ id: telegramChannels.id })
      .from(telegramChannels)
      .where(eq(telegramChannels.id, channelId))
      .limit(1);

    if (!channel) {
      return null;
    }

    const cursor = options.cursor;
    const cursorWhere = cursor
      ? or(
          lt(messages.publishedAt, new Date(cursor.publishedAt)),
          and(
            eq(messages.publishedAt, new Date(cursor.publishedAt)),
            lt(messages.id, cursor.messageId),
          ),
        )
      : undefined;
    const rows = await this.selectMessages(
      and(eq(messages.channelId, channelId), cursorWhere),
      options.limit + 1,
    );
    const hasMore = rows.length > options.limit;
    const pageRows = rows.slice(0, options.limit);
    const items = await this.attachMedia(pageRows);
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? {
              channelId: last.channelId,
              messageId: last.messageId,
              publishedAt: last.publishedAt.toISOString(),
            }
          : null,
    };
  }

  async listChannels() {
    return this.database
      .select({
        id: telegramChannels.id,
        title: telegramChannels.title,
        username: telegramChannels.username,
      })
      .from(telegramChannels)
      .orderBy(asc(telegramChannels.title), asc(telegramChannels.id));
  }

  async getMessage(id: string): Promise<PublicMessage | null> {
    const rows = await this.selectMessages(eq(messages.id, id));
    const [message] = await this.attachMedia(rows);
    return message ?? null;
  }

  private async selectIdentity(
    transaction: DatabaseTransaction,
    channelId: string,
    telegramMessageId: bigint,
    lock = false,
  ) {
    const query = transaction
      .select({
        currentRevisionNumber: messages.currentRevisionNumber,
        id: messages.id,
        publishedAt: messages.publishedAt,
      })
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), eq(messages.telegramMessageId, telegramMessageId)),
      )
      .limit(1);
    const [message] = lock ? await query.for('update') : await query;

    return message;
  }

  private async insertRevision(
    transaction: DatabaseTransaction,
    messageId: string,
    revisionNumber: number,
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<string> {
    const [revision] = await transaction
      .insert(messageRevisions)
      .values({
        authorSignature: snapshot.message.authorSignature,
        contentKind: snapshot.message.contentKind,
        editedAt: snapshot.message.editedAt,
        entities: snapshot.message.entities,
        html:
          snapshot.message.text === null
            ? null
            : renderTelegramMessage(snapshot.message.text, snapshot.message.entities),
        mediaGroupId: snapshot.message.mediaGroupId,
        messageId,
        rendererVersion: CURRENT_RENDERER_VERSION,
        revisionNumber,
        telegramUpdateId:
          observation.kind === 'telegram_bot_update' ? observation.telegramUpdateId : null,
        text: snapshot.message.text,
      })
      .returning({ id: messageRevisions.id });

    if (!revision) {
      throw new Error('Failed to create message revision');
    }

    if (snapshot.media.length > 0) {
      await transaction.insert(messageMedia).values(
        snapshot.media.map((media, position) => ({
          availabilityReason: media.availabilityReason,
          duration: media.duration,
          fileName: media.fileName,
          fileSize: media.fileSize,
          height: media.height,
          kind: media.kind,
          mimeType: media.mimeType,
          position,
          revisionId: revision.id,
          sourceKind: observation.kind,
          sourceMediaType: media.sourceMediaType,
          sourceMetadata: media.sourceMetadata,
          sourcePath: media.sourcePath,
          telegramFileId: media.telegramFileId,
          telegramFileUniqueId: media.telegramFileUniqueId,
          width: media.width,
        })),
      );
    }

    return revision.id;
  }

  private async insertSourceMediaObservations(
    transaction: DatabaseTransaction,
    observationId: string,
    mediaItems: SourceNeutralMedia[],
    observation: SourceObservation,
  ): Promise<void> {
    if (mediaItems.length === 0) {
      return;
    }

    await transaction.insert(messageSourceMediaObservations).values(
      mediaItems.map((media, position) => ({
        ...sourceMediaObservation(media, observation, observationId, position),
        createdAt: sql`clock_timestamp()`,
      })),
    );
  }

  private async selectCurrentRevision(
    transaction: DatabaseTransaction,
    messageId: string,
    revisionNumber: number,
  ) {
    const [revision] = await transaction
      .select({
        editedAt: messageRevisions.editedAt,
        id: messageRevisions.id,
      })
      .from(messageRevisions)
      .where(
        and(
          eq(messageRevisions.messageId, messageId),
          eq(messageRevisions.revisionNumber, revisionNumber),
        ),
      )
      .limit(1);
    if (!revision) {
      throw new Error('Current message revision was not found');
    }
    return revision;
  }

  private async selectMatchingRevisionId(
    transaction: DatabaseTransaction,
    messageId: string,
    candidate: NormalizedMessageSnapshot,
    candidateFingerprint: string,
  ): Promise<string | null> {
    const revisions = await transaction
      .select({
        authorSignature: messageRevisions.authorSignature,
        contentKind: messageRevisions.contentKind,
        editedAt: messageRevisions.editedAt,
        entities: messageRevisions.entities,
        id: messageRevisions.id,
        mediaGroupId: messageRevisions.mediaGroupId,
        publishedAt: messages.publishedAt,
        telegramMessageId: messages.telegramMessageId,
        text: messageRevisions.text,
      })
      .from(messageRevisions)
      .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
      .where(eq(messageRevisions.messageId, messageId))
      .orderBy(asc(messageRevisions.revisionNumber));
    const mediaRows = await transaction
      .select()
      .from(messageMedia)
      .where(
        inArray(
          messageMedia.revisionId,
          revisions.map((revision) => revision.id),
        ),
      )
      .orderBy(asc(messageMedia.position));
    const mediaByRevision = new Map<string, SourceNeutralMedia[]>();
    for (const media of mediaRows) {
      const revisionMedia = mediaByRevision.get(media.revisionId) ?? [];
      revisionMedia.push({
        availabilityReason: media.availabilityReason,
        duration: media.duration,
        fileName: media.fileName,
        fileSize: media.fileSize,
        height: media.height,
        kind: media.kind,
        mimeType: media.mimeType,
        sourceMediaType: media.sourceMediaType,
        sourceMetadata: media.sourceMetadata,
        sourcePath: media.sourcePath,
        telegramFileId: media.telegramFileId,
        telegramFileUniqueId: media.telegramFileUniqueId,
        width: media.width,
      });
      mediaByRevision.set(media.revisionId, revisionMedia);
    }
    for (const revision of revisions) {
      const fingerprint = fingerprintMessageSnapshot({
        channel: candidate.channel,
        media: mediaByRevision.get(revision.id) ?? [],
        message: {
          authorSignature: revision.authorSignature,
          contentKind: revision.contentKind,
          editedAt: revision.editedAt,
          entities: revision.entities,
          mediaGroupId: revision.mediaGroupId,
          publishedAt: revision.publishedAt,
          telegramMessageId: revision.telegramMessageId,
          text: revision.text,
        },
      });
      if (fingerprint === candidateFingerprint) {
        return revision.id;
      }
    }
    return null;
  }

  private selectMessages(where: SQL | undefined, limit = 50) {
    return this.database
      .select({
        authorSignature: messageRevisions.authorSignature,
        channelId: telegramChannels.id,
        channelTitle: telegramChannels.title,
        channelUsername: telegramChannels.username,
        contentKind: messageRevisions.contentKind,
        entities: messageRevisions.entities,
        html: messageRevisions.html,
        mediaGroupId: messageRevisions.mediaGroupId,
        messageId: messages.id,
        publishedAt: messages.publishedAt,
        revisionId: messageRevisions.id,
        revisionNumber: messageRevisions.revisionNumber,
        telegramMessageId: messages.telegramMessageId,
        text: messageRevisions.text,
      })
      .from(messages)
      .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
      .innerJoin(
        messageRevisions,
        and(
          eq(messageRevisions.messageId, messages.id),
          eq(messageRevisions.revisionNumber, messages.currentRevisionNumber),
        ),
      )
      .where(and(where, isNull(messages.tombstonedAt)))
      .orderBy(desc(messages.publishedAt), desc(messages.id))
      .limit(limit);
  }

  private async attachMedia(rows: MessageRow[]): Promise<PublicMessage[]> {
    if (rows.length === 0) {
      return [];
    }

    const mediaRows = await this.database
      .select()
      .from(messageMedia)
      .where(
        inArray(
          messageMedia.revisionId,
          rows.map((row) => row.revisionId),
        ),
      )
      .orderBy(messageMedia.position);

    const cacheRows =
      mediaRows.length === 0
        ? []
        : await this.database
            .select({
              canonicalMediaId: mediaCacheObjects.canonicalMediaId,
              id: mediaCacheObjects.id,
              state: mediaCacheObjects.state,
              variant: mediaCacheObjects.variant,
            })
            .from(mediaCacheObjects)
            .where(
              and(
                inArray(
                  mediaCacheObjects.canonicalMediaId,
                  mediaRows.map((row) => row.id),
                ),
                eq(mediaCacheObjects.recipeVersion, 1),
                inArray(mediaCacheObjects.variant, ['original', 'thumbnail']),
              ),
            );

    const cacheByMedia = new Map<string, PublicCacheObject[]>();
    for (const row of cacheRows) {
      const objects = cacheByMedia.get(row.canonicalMediaId) ?? [];
      objects.push(row);
      cacheByMedia.set(row.canonicalMediaId, objects);
    }

    const mediaByRevision = new Map<string, PublicMedia[]>();
    for (const row of mediaRows) {
      const media = mediaByRevision.get(row.revisionId) ?? [];
      media.push(publicMedia(row, cacheByMedia.get(row.id) ?? []));
      mediaByRevision.set(row.revisionId, media);
    }

    return rows.map((row) => publicMessage(row, mediaByRevision.get(row.revisionId) ?? []));
  }
}
