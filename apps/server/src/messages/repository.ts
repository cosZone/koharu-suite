import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
  telegramUpdates,
} from '../db/schema.js';
import type { NormalizedChannelPost } from '../telegram/types.js';
import type { MessageReader, PublicMedia, PublicMessage } from './types.js';

export interface IngestResult {
  channelId: string;
  messageId: string;
  replayed: boolean;
}

export interface MessageWriter {
  ingest(post: NormalizedChannelPost): Promise<IngestResult>;
}

type MessageRow = Awaited<ReturnType<PostgresMessageRepository['selectMessages']>>[number];

function sourceUrl(username: string | null, telegramMessageId: bigint): string | null {
  return username ? `https://t.me/${username}/${telegramMessageId}` : null;
}

function publicMedia(row: typeof messageMedia.$inferSelect): PublicMedia {
  return {
    duration: row.duration,
    fileName: row.fileName,
    fileSize: row.fileSize?.toString() ?? null,
    height: row.height,
    kind: row.kind,
    mimeType: row.mimeType,
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
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const [channel] = await transaction
        .insert(telegramChannels)
        .values({
          telegramChatId: post.channel.telegramChatId,
          title: post.channel.title,
          username: post.channel.username,
        })
        .onConflictDoUpdate({
          target: telegramChannels.telegramChatId,
          set: {
            title: post.channel.title,
            updatedAt: now,
            username: post.channel.username,
          },
        })
        .returning({ id: telegramChannels.id });

      if (!channel) {
        throw new Error('Failed to resolve Telegram channel');
      }

      const [insertedUpdate] = await transaction
        .insert(telegramUpdates)
        .values({
          channelId: channel.id,
          rawJson: post.rawUpdate,
          telegramUpdateId: post.telegramUpdateId,
          updateType: 'channel_post',
        })
        .onConflictDoNothing({ target: telegramUpdates.telegramUpdateId })
        .returning({ telegramUpdateId: telegramUpdates.telegramUpdateId });

      if (!insertedUpdate) {
        const existing = await this.selectIdentity(
          transaction,
          channel.id,
          post.message.telegramMessageId,
        );
        if (!existing) {
          throw new Error('Telegram update exists without its normalized message');
        }

        return {
          channelId: channel.id,
          messageId: existing.id,
          replayed: true,
        };
      }

      const [insertedMessage] = await transaction
        .insert(messages)
        .values({
          channelId: channel.id,
          publishedAt: post.message.publishedAt,
          telegramMessageId: post.message.telegramMessageId,
        })
        .onConflictDoNothing({
          target: [messages.channelId, messages.telegramMessageId],
        })
        .returning({ id: messages.id });

      if (!insertedMessage) {
        const existing = await this.selectIdentity(
          transaction,
          channel.id,
          post.message.telegramMessageId,
        );
        if (!existing) {
          throw new Error('Failed to resolve normalized Telegram message');
        }

        return {
          channelId: channel.id,
          messageId: existing.id,
          replayed: true,
        };
      }

      const [revision] = await transaction
        .insert(messageRevisions)
        .values({
          authorSignature: post.message.authorSignature,
          contentKind: post.message.contentKind,
          entities: post.message.entities,
          mediaGroupId: post.message.mediaGroupId,
          messageId: insertedMessage.id,
          revisionNumber: 1,
          telegramUpdateId: post.telegramUpdateId,
          text: post.message.text,
        })
        .returning({ id: messageRevisions.id });

      if (!revision) {
        throw new Error('Failed to create initial message revision');
      }

      if (post.media.length > 0) {
        await transaction.insert(messageMedia).values(
          post.media.map((media, position) => ({
            duration: media.duration,
            fileName: media.fileName,
            fileSize: media.fileSize,
            height: media.height,
            kind: media.kind,
            mimeType: media.mimeType,
            position,
            revisionId: revision.id,
            telegramFileId: media.fileId,
            telegramFileUniqueId: media.fileUniqueId,
            width: media.width,
          })),
        );
      }

      return {
        channelId: channel.id,
        messageId: insertedMessage.id,
        replayed: false,
      };
    });
  }

  async listMessages(channelId: string): Promise<PublicMessage[] | null> {
    const [channel] = await this.database
      .select({ id: telegramChannels.id })
      .from(telegramChannels)
      .where(eq(telegramChannels.id, channelId))
      .limit(1);

    if (!channel) {
      return null;
    }

    const rows = await this.selectMessages(eq(messages.channelId, channelId));
    return this.attachMedia(rows);
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
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    channelId: string,
    telegramMessageId: bigint,
  ) {
    const [message] = await transaction
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.channelId, channelId), eq(messages.telegramMessageId, telegramMessageId)),
      )
      .limit(1);

    return message;
  }

  private selectMessages(where: ReturnType<typeof eq>) {
    return this.database
      .select({
        authorSignature: messageRevisions.authorSignature,
        channelId: telegramChannels.id,
        channelTitle: telegramChannels.title,
        channelUsername: telegramChannels.username,
        contentKind: messageRevisions.contentKind,
        entities: messageRevisions.entities,
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
      .where(where)
      .orderBy(desc(messages.publishedAt), desc(messages.id))
      .limit(50);
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

    const mediaByRevision = new Map<string, PublicMedia[]>();
    for (const row of mediaRows) {
      const media = mediaByRevision.get(row.revisionId) ?? [];
      media.push(publicMedia(row));
      mediaByRevision.set(row.revisionId, media);
    }

    return rows.map((row) => publicMessage(row, mediaByRevision.get(row.revisionId) ?? []));
  }
}
