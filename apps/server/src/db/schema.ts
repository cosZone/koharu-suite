import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Update } from 'grammy/types';
import type { NormalizedMessageEntity } from '../telegram/types.js';

export const appMetadata = pgTable('app_metadata', {
  key: varchar('key', { length: 128 }).primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const telegramChannels = pgTable(
  'telegram_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    username: varchar('username', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('telegram_channels_chat_id_unique').on(table.telegramChatId)],
);

export const telegramUpdates = pgTable(
  'telegram_updates',
  {
    telegramUpdateId: bigint('telegram_update_id', { mode: 'bigint' }).primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => telegramChannels.id, { onDelete: 'cascade' }),
    updateType: varchar('update_type', { length: 32 }).notNull(),
    rawJson: jsonb('raw_json').$type<Update>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('telegram_updates_channel_received_idx').on(table.channelId, table.receivedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => telegramChannels.id, { onDelete: 'cascade' }),
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    currentRevisionNumber: integer('current_revision_number').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('messages_channel_message_unique').on(table.channelId, table.telegramMessageId),
    index('messages_channel_published_idx').on(table.channelId, table.publishedAt, table.id),
  ],
);

export const messageRevisions = pgTable(
  'message_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    telegramUpdateId: bigint('telegram_update_id', { mode: 'bigint' })
      .notNull()
      .references(() => telegramUpdates.telegramUpdateId, { onDelete: 'restrict' }),
    revisionNumber: integer('revision_number').notNull(),
    contentKind: varchar('content_kind', { length: 16 })
      .$type<'caption' | 'none' | 'text'>()
      .notNull(),
    text: text('text'),
    entities: jsonb('entities').$type<NormalizedMessageEntity[]>().notNull(),
    authorSignature: text('author_signature'),
    mediaGroupId: text('media_group_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('message_revisions_message_number_unique').on(
      table.messageId,
      table.revisionNumber,
    ),
    uniqueIndex('message_revisions_update_unique').on(table.telegramUpdateId),
  ],
);

export const messageMedia = pgTable(
  'message_media',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => messageRevisions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: varchar('kind', { length: 32 })
      .$type<'animation' | 'audio' | 'document' | 'photo' | 'video' | 'voice'>()
      .notNull(),
    telegramFileId: text('telegram_file_id').notNull(),
    telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
    mimeType: text('mime_type'),
    fileName: text('file_name'),
    fileSize: bigint('file_size', { mode: 'bigint' }),
    width: integer('width'),
    height: integer('height'),
    duration: integer('duration'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('message_media_revision_position_unique').on(table.revisionId, table.position),
    index('message_media_revision_idx').on(table.revisionId),
  ],
);
