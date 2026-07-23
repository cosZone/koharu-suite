import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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

export const authUsers = pgTable(
  'auth_users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  },
  (table) => [uniqueIndex('auth_users_email_unique').on(table.email)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_unique').on(table.token),
    index('auth_sessions_user_id_idx').on(table.userId),
  ],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('auth_accounts_provider_account_unique').on(table.providerId, table.accountId),
    index('auth_accounts_user_id_idx').on(table.userId),
  ],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('auth_verifications_identifier_idx').on(table.identifier)],
);

export const authTwoFactors = pgTable(
  'auth_two_factors',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (table) => [
    index('auth_two_factors_secret_idx').on(table.secret),
    uniqueIndex('auth_two_factors_user_id_unique').on(table.userId),
  ],
);

export const owners = pgTable(
  'owners',
  {
    singleton: integer('singleton').primaryKey().default(1),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('owners_singleton_check', sql`${table.singleton} = 1`),
    uniqueIndex('owners_user_id_unique').on(table.userId),
  ],
);

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
