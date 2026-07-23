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

export const authApiKeys = pgTable(
  'auth_api_keys',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    prefix: text('prefix'),
    key: text('key').notNull(),
    referenceId: text('reference_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').notNull().default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').notNull().default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    uniqueIndex('auth_api_keys_key_unique').on(table.key),
    index('auth_api_keys_config_id_idx').on(table.configId),
    index('auth_api_keys_reference_id_idx').on(table.referenceId),
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

export const telegramChannelAllowlist = pgTable(
  'telegram_channel_allowlist',
  {
    telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }).primaryKey(),
    title: text('title').notNull(),
    username: varchar('username', { length: 64 }),
    enabled: boolean('enabled').notNull().default(true),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'telegram_channel_allowlist_enabled_check',
      sql`(${table.enabled} and ${table.disabledAt} is null)
        or (not ${table.enabled} and ${table.disabledAt} is not null)`,
    ),
  ],
);

export const telegramPollingState = pgTable(
  'telegram_polling_state',
  {
    singleton: integer('singleton').primaryKey().default(1),
    botId: bigint('bot_id', { mode: 'bigint' }).notNull(),
    nextUpdateId: bigint('next_update_id', { mode: 'bigint' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('telegram_polling_state_singleton_check', sql`${table.singleton} = 1`),
    uniqueIndex('telegram_polling_state_bot_id_unique').on(table.botId),
  ],
);

export const workerRuntime = pgTable(
  'worker_runtime',
  {
    singletonKey: text('singleton_key').primaryKey().default('telegram'),
    instanceId: text('instance_id').notNull(),
    state: varchar('state', { length: 16 }).$type<'running' | 'starting' | 'stopping'>().notNull(),
    version: text('version').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
    lastTelegramSuccessAt: timestamp('last_telegram_success_at', { withTimezone: true }),
  },
  (table) => [
    check('worker_runtime_singleton_key_check', sql`${table.singletonKey} = 'telegram'`),
    check('worker_runtime_state_check', sql`${table.state} in ('starting', 'running', 'stopping')`),
  ],
);

export const telegramIngestTasks = pgTable(
  'telegram_ingest_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    botId: bigint('bot_id', { mode: 'bigint' }).notNull(),
    telegramUpdateId: bigint('telegram_update_id', { mode: 'bigint' }).notNull(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' })
      .notNull()
      .references(() => telegramChannelAllowlist.telegramChatId, { onDelete: 'restrict' }),
    updateType: varchar('update_type', { length: 32 })
      .$type<'channel_post' | 'edited_channel_post'>()
      .notNull(),
    rawJson: jsonb('raw_json').$type<Update>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    skippedAt: timestamp('skipped_at', { withTimezone: true }),
    skipReason: text('skip_reason'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('telegram_ingest_tasks_update_id_unique').on(table.telegramUpdateId),
    index('telegram_ingest_tasks_channel_head_idx')
      .on(table.telegramChatId, table.telegramUpdateId)
      .where(sql`${table.processedAt} is null and ${table.skippedAt} is null`),
    index('telegram_ingest_tasks_runnable_idx')
      .on(table.availableAt, table.telegramUpdateId)
      .where(
        sql`${table.processedAt} is null and ${table.skippedAt} is null and ${table.blockedAt} is null`,
      ),
    check(
      'telegram_ingest_tasks_terminal_check',
      sql`not (${table.processedAt} is not null and ${table.skippedAt} is not null)`,
    ),
    check(
      'telegram_ingest_tasks_skip_reason_check',
      sql`(${table.skippedAt} is null and ${table.skipReason} is null)
        or (${table.skippedAt} is not null and length(${table.skipReason}) between 1 and 500)`,
    ),
  ],
);

export const operationAuditEvents = pgTable(
  'operation_audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorType: varchar('actor_type', { length: 32 })
      .$type<'owner_session' | 'service_token'>()
      .notNull(),
    actorId: text('actor_id').notNull(),
    action: varchar('action', { length: 64 })
      .$type<
        'channel.disable' | 'channel.enable' | 'content.rerender' | 'task.retry' | 'task.skip'
      >()
      .notNull(),
    targetType: varchar('target_type', { length: 32 })
      .$type<'channel' | 'renderer' | 'task'>()
      .notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('operation_audit_events_actor_idx').on(table.actorType, table.actorId, table.createdAt),
    index('operation_audit_events_target_idx').on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
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

export const importRuns = pgTable(
  'import_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceKind: varchar('source_kind', { length: 32 }).$type<'telegram_desktop_json'>().notNull(),
    sourceFileSha256: text('source_file_sha256').notNull(),
    parserVersion: integer('parser_version').notNull(),
    status: varchar('status', { length: 16 })
      .$type<'completed' | 'interrupted' | 'partial' | 'running'>()
      .notNull(),
    selectedChannels: jsonb('selected_channels').$type<string[]>().notNull(),
    report: jsonb('report').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('import_runs_source_file_idx').on(table.sourceFileSha256, table.startedAt),
    check('import_runs_source_kind_check', sql`${table.sourceKind} = 'telegram_desktop_json'`),
    check('import_runs_parser_version_check', sql`${table.parserVersion} > 0`),
    check(
      'import_runs_status_check',
      sql`${table.status} in ('running', 'completed', 'partial', 'interrupted')`,
    ),
    check(
      'import_runs_completed_at_check',
      sql`(${table.status} = 'running' and ${table.completedAt} is null)
        or (${table.status} <> 'running' and ${table.completedAt} is not null)`,
    ),
  ],
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
    telegramUpdateId: bigint('telegram_update_id', { mode: 'bigint' }).references(
      () => telegramUpdates.telegramUpdateId,
      { onDelete: 'restrict' },
    ),
    revisionNumber: integer('revision_number').notNull(),
    contentKind: varchar('content_kind', { length: 16 })
      .$type<'caption' | 'none' | 'text'>()
      .notNull(),
    text: text('text'),
    entities: jsonb('entities').$type<NormalizedMessageEntity[]>().notNull(),
    html: text('html'),
    rendererVersion: integer('renderer_version').notNull().default(0),
    authorSignature: text('author_signature'),
    mediaGroupId: text('media_group_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
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
    sourceKind: varchar('source_kind', { length: 32 })
      .$type<'telegram_bot_update' | 'telegram_desktop_json'>()
      .default('telegram_bot_update')
      .notNull(),
    sourcePath: text('source_path'),
    sourceMediaType: text('source_media_type'),
    availabilityReason: text('availability_reason'),
    sourceMetadata: jsonb('source_metadata').$type<Record<string, unknown>>().notNull().default({}),
    telegramFileId: text('telegram_file_id'),
    telegramFileUniqueId: text('telegram_file_unique_id'),
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
    check(
      'message_media_source_check',
      sql`(${table.sourceKind} = 'telegram_bot_update'
          and ${table.telegramFileId} is not null
          and ${table.telegramFileUniqueId} is not null
          and ${table.sourcePath} is null)
        or (${table.sourceKind} = 'telegram_desktop_json'
          and ${table.telegramFileId} is null
          and ${table.telegramFileUniqueId} is null)`,
    ),
  ],
);

export const messageSourceObservations = pgTable(
  'message_source_observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceKind: varchar('source_kind', { length: 32 })
      .$type<'telegram_bot_update' | 'telegram_desktop_json'>()
      .notNull(),
    sourceKey: text('source_key').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => telegramChannels.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id').references(() => messageRevisions.id, {
      onDelete: 'set null',
    }),
    importRunId: uuid('import_run_id').references(() => importRuns.id, {
      onDelete: 'restrict',
    }),
    telegramUpdateId: bigint('telegram_update_id', { mode: 'bigint' }).references(
      () => telegramUpdates.telegramUpdateId,
      { onDelete: 'restrict' },
    ),
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }).notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    contentFingerprintVersion: integer('content_fingerprint_version').notNull(),
    resolution: varchar('resolution', { length: 16 })
      .$type<'conflict' | 'created' | 'matched' | 'stale'>()
      .notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    sourceMetadata: jsonb('source_metadata').$type<Record<string, unknown>>().notNull().default({}),
    rawJson: jsonb('raw_json').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('message_source_observations_source_key_unique').on(
      table.sourceKind,
      table.sourceKey,
    ),
    index('message_source_observations_message_idx').on(table.messageId, table.createdAt),
    index('message_source_observations_revision_idx').on(table.revisionId),
    index('message_source_observations_import_run_idx').on(table.importRunId),
    check(
      'message_source_observations_source_check',
      sql`(${table.sourceKind} = 'telegram_bot_update'
          and ${table.telegramUpdateId} is not null
          and ${table.importRunId} is null)
        or (${table.sourceKind} = 'telegram_desktop_json'
          and ${table.telegramUpdateId} is null)`,
    ),
    check(
      'message_source_observations_resolution_check',
      sql`${table.resolution} in ('created', 'matched', 'stale', 'conflict')`,
    ),
    check(
      'message_source_observations_fingerprint_version_check',
      sql`${table.contentFingerprintVersion} >= 0`,
    ),
  ],
);
