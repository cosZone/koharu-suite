export type DoctorCheckStatus = 'fail' | 'ok' | 'warn';

export type DoctorCheckId =
  | 'config'
  | 'postgres-version'
  | 'database-schema'
  | 'media-cache-ledger'
  | 'owner'
  | 'telegram-bot'
  | 'telegram-channels';

export interface DoctorCheckResult {
  details?: string[];
  id: DoctorCheckId;
  label: string;
  message: string;
  status: DoctorCheckStatus;
}

export interface DoctorReport {
  checks: DoctorCheckResult[];
}

export interface DoctorOwner {
  userId: string;
}

export interface DoctorTelegramChannel {
  telegramChatId: bigint;
  title: string;
  username: string | null;
}

export interface DoctorDatabaseDiagnostics {
  getBoundTelegramBotId(): Promise<bigint | null>;
  getMediaCacheLedgerSnapshot(): Promise<DoctorMediaCacheLedgerSnapshot>;
  getPostgresMajorVersion(): Promise<number>;
  listEnabledChannels(): Promise<DoctorTelegramChannel[]>;
  listMissingSchemaObjects(expectedObjects: readonly string[]): Promise<string[]>;
  listOwners(): Promise<DoctorOwner[]>;
}

export interface DoctorMediaCacheLedgerSnapshot {
  activeThumbnailReservationCount: bigint;
  activeThumbnailReservedBytes: bigint;
  cacheRowCount: bigint;
  originalReservationCount: bigint;
  originalReservedBytes: bigint;
  physicalBlobBytes: bigint;
  physicalBlobCount: bigint;
  runtimeMaxBytes: bigint | null;
  runtimeReadyBytes: bigint | null;
  runtimeReservedBytes: bigint | null;
  runtimeRowCount: bigint;
}

export interface DoctorTelegramBot {
  id: number;
  username?: string;
}

export interface DoctorTelegramChat {
  id: number;
  title?: string;
  type: string;
  username?: string;
}

export interface DoctorTelegramMembership {
  status: string;
}

/**
 * Deliberately narrower than the ingestion Telegram API. A doctor adapter cannot poll or
 * acknowledge updates because `getUpdates` is not part of this capability.
 */
export interface DoctorTelegramDiagnostics {
  getChat(chatId: number | string, signal?: AbortSignal): Promise<DoctorTelegramChat>;
  getChatMember(
    chatId: number | string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<DoctorTelegramMembership>;
  getMe(signal?: AbortSignal): Promise<DoctorTelegramBot>;
}

export interface DoctorDependencies {
  database: DoctorDatabaseDiagnostics;
  sensitiveValues?: readonly string[];
  telegram: DoctorTelegramDiagnostics;
  validateConfig(): Promise<void> | void;
}

export const EXPECTED_DATABASE_OBJECTS = [
  'drizzle.__drizzle_migrations',
  'app_metadata',
  'auth_accounts',
  'auth_api_keys',
  'auth_api_keys.enabled',
  'auth_api_keys.expires_at',
  'auth_api_keys.key',
  'auth_api_keys.permissions',
  'auth_api_keys.reference_id',
  'auth_sessions',
  'auth_two_factors',
  'auth_users',
  'auth_verifications',
  'import_run_observations',
  'import_run_observations.observation_id',
  'import_run_observations.replayed',
  'import_run_observations.resolution_at_run',
  'import_run_observations.run_id',
  'import_run_coverages',
  'import_run_coverages.end_message_id',
  'import_run_coverages.explicitly_complete',
  'import_run_coverages.run_id',
  'import_run_coverages.start_message_id',
  'import_run_coverages.telegram_chat_id',
  'import_runs',
  'import_runs.report',
  'import_runs.status',
  'message_media',
  'message_media.source_kind',
  'message_media.source_path',
  'message_revisions',
  'message_revisions.html',
  'message_revisions.renderer_version',
  'message_revisions.telegram_update_id',
  'message_source_observations',
  'message_source_observations.content_fingerprint_version',
  'message_source_observations.id',
  'message_source_observations.raw_json',
  'message_source_observations.revision_id',
  'message_source_observations.source_kind',
  'message_source_media_observations',
  'message_source_media_observations.availability',
  'message_source_media_observations.desktop_source_path',
  'message_source_media_observations.observation_id',
  'message_source_media_observations.source_kind',
  'message_source_media_observations.telegram_file_id',
  'message_source_media_observations.telegram_file_unique_id',
  'messages',
  'messages.tombstoned_at',
  'operation_audit_events',
  'operation_audit_events.reason',
  'owners',
  'reconciliation_actions',
  'reconciliation_actions.reason',
  'reconciliation_findings',
  'reconciliation_findings.evidence_version',
  'reconciliation_findings.sanitized_details',
  'reconciliation_findings.telegram_chat_id',
  'reconciliation_runs',
  'reconciliation_runs.report',
  'reconciliation_schedule',
  'reconciliation_schedule.claimed_run_id',
  'reconciliation_schedule.lease_expires_at',
  'reconciliation_schedule.lease_owner',
  'reconciliation_schedule.lease_token',
  'reconciliation_schedule.next_run_at',
  'telegram_channel_allowlist',
  'telegram_channel_allowlist.disabled_at',
  'telegram_channel_allowlist.enabled',
  'telegram_channels',
  'telegram_ingest_tasks',
  'telegram_ingest_tasks.skip_reason',
  'telegram_ingest_tasks.skipped_at',
  'telegram_poll_receipts',
  'telegram_poll_receipts.checkpoint_offset',
  'telegram_poll_receipts.requested_offset',
  'telegram_polling_state',
  'telegram_updates',
  'worker_runtime',
  'worker_runtime.heartbeat_at',
  'worker_runtime.instance_id',
  'worker_runtime.last_telegram_success_at',
  'worker_runtime.state',
  'media_cache_runtime',
  'media_cache_runtime.singleton_key',
  'media_cache_runtime.discovery_cursor_created_at',
  'media_cache_runtime.discovery_cursor_id',
  'media_cache_runtime.ready_bytes',
  'media_cache_runtime.reserved_bytes',
  'media_cache_runtime.max_bytes',
  'media_cache_runtime.last_reconciled_at',
  'media_cache_runtime.updated_at',
  'media_cache_post_plans',
  'media_cache_post_plans.id',
  'media_cache_post_plans.message_id',
  'media_cache_post_plans.revision_id',
  'media_cache_post_plans.state',
  'media_cache_post_plans.ready_original_bytes',
  'media_cache_post_plans.reserved_original_bytes',
  'media_cache_post_plans.reason_code',
  'media_cache_post_plans.last_error_class',
  'media_cache_post_plans.last_error_code',
  'media_cache_post_plans.attempt_count',
  'media_cache_post_plans.available_at',
  'media_cache_post_plans.lease_owner',
  'media_cache_post_plans.lease_token',
  'media_cache_post_plans.lease_expires_at',
  'media_cache_post_plans.created_at',
  'media_cache_post_plans.updated_at',
  'media_cache_blobs',
  'media_cache_blobs.sha256',
  'media_cache_blobs.byte_length',
  'media_cache_blobs.detected_mime',
  'media_cache_blobs.relative_key',
  'media_cache_blobs.state',
  'media_cache_blobs.eviction_owner',
  'media_cache_blobs.eviction_token',
  'media_cache_blobs.eviction_expires_at',
  'media_cache_blobs.last_accessed_at',
  'media_cache_blobs.created_at',
  'media_cache_blobs.updated_at',
  'media_cache_objects',
  'media_cache_objects.id',
  'media_cache_objects.post_plan_id',
  'media_cache_objects.revision_id',
  'media_cache_objects.canonical_media_id',
  'media_cache_objects.variant',
  'media_cache_objects.recipe_version',
  'media_cache_objects.state',
  'media_cache_objects.blob_sha256',
  'media_cache_objects.declared_bytes',
  'media_cache_objects.reserved_bytes',
  'media_cache_objects.actual_bytes',
  'media_cache_objects.reason_code',
  'media_cache_objects.last_error_class',
  'media_cache_objects.last_error_code',
  'media_cache_objects.attempt_count',
  'media_cache_objects.available_at',
  'media_cache_objects.lease_owner',
  'media_cache_objects.lease_token',
  'media_cache_objects.lease_expires_at',
  'media_cache_objects.last_accessed_at',
  'media_cache_objects.created_at',
  'media_cache_objects.updated_at',
  'media_cache_object_sources',
  'media_cache_object_sources.object_id',
  'media_cache_object_sources.source_media_observation_id',
  'media_cache_object_sources.source_priority',
  'media_cache_actions',
  'media_cache_actions.id',
  'media_cache_actions.object_id',
  'media_cache_actions.blob_sha256',
  'media_cache_actions.action_kind',
  'media_cache_actions.initiator_kind',
  'media_cache_actions.initiator_id',
  'media_cache_actions.reason',
  'media_cache_actions.before_state',
  'media_cache_actions.after_state',
  'media_cache_actions.created_at',
  'media_cache_commands',
  'media_cache_commands.id',
  'media_cache_commands.operation',
  'media_cache_commands.state',
  'media_cache_commands.object_id',
  'media_cache_commands.initiator_id',
  'media_cache_commands.reason',
  'media_cache_commands.attempt_count',
  'media_cache_commands.lease_owner',
  'media_cache_commands.lease_token',
  'media_cache_commands.lease_expires_at',
  'media_cache_commands.result',
  'media_cache_commands.error_code',
  'media_cache_commands.created_at',
  'media_cache_commands.updated_at',
  'media_cache_commands.completed_at',
  'constraint:public.media_cache_runtime_pkey',
  'constraint:public.media_cache_runtime_singleton_check',
  'constraint:public.media_cache_runtime_cursor_check',
  'constraint:public.media_cache_runtime_ledger_check',
  'constraint:public.media_cache_post_plans_revision_message_fk',
  'constraint:public.media_cache_post_plans_pkey',
  'constraint:public.media_cache_post_plans_id_revision_unique',
  'constraint:public.media_cache_post_plans_revision_unique',
  'constraint:public.media_cache_post_plans_state_check',
  'constraint:public.media_cache_post_plans_budget_check',
  'constraint:public.media_cache_post_plans_attempt_check',
  'constraint:public.media_cache_post_plans_lease_check',
  'constraint:public.media_cache_blobs_sha256_check',
  'constraint:public.media_cache_blobs_pkey',
  'constraint:public.media_cache_blobs_byte_length_check',
  'constraint:public.media_cache_blobs_mime_check',
  'constraint:public.media_cache_blobs_relative_key_check',
  'constraint:public.media_cache_blobs_state_check',
  'constraint:public.media_cache_blobs_eviction_lease_check',
  'constraint:public.media_cache_objects_media_variant_recipe_unique',
  'constraint:public.media_cache_objects_pkey',
  'constraint:public.media_cache_objects_plan_revision_fk',
  'constraint:public.media_cache_objects_media_revision_fk',
  'constraint:public.media_cache_objects_blob_sha256_media_cache_blobs_sha256_fk',
  'constraint:public.media_cache_objects_variant_check',
  'constraint:public.media_cache_objects_recipe_check',
  'constraint:public.media_cache_objects_state_check',
  'constraint:public.media_cache_objects_bytes_check',
  'constraint:public.media_cache_objects_ready_check',
  'constraint:public.media_cache_objects_attempt_check',
  'constraint:public.media_cache_objects_lease_check',
  'constraint:public.media_cache_object_sources_pk',
  'constraint:public.media_cache_object_sources_object_id_media_cache_objects_id_fk',
  'constraint:public.media_cache_object_sources_source_media_observation_id_message_',
  'constraint:public.media_cache_object_sources_priority_check',
  'constraint:public.media_cache_actions_object_id_media_cache_objects_id_fk',
  'constraint:public.media_cache_actions_blob_sha256_media_cache_blobs_sha256_fk',
  'constraint:public.media_cache_actions_pkey',
  'constraint:public.media_cache_actions_kind_check',
  'constraint:public.media_cache_actions_initiator_check',
  'constraint:public.media_cache_actions_reason_check',
  'constraint:public.media_cache_actions_state_check',
  'constraint:public.media_cache_commands_pkey',
  'constraint:public.media_cache_commands_object_id_media_cache_objects_id_fk',
  'constraint:public.media_cache_commands_operation_check',
  'constraint:public.media_cache_commands_target_check',
  'constraint:public.media_cache_commands_initiator_check',
  'constraint:public.media_cache_commands_attempt_check',
  'constraint:public.media_cache_commands_lease_check',
  'constraint:public.media_cache_commands_terminal_check',
  'index:public.media_cache_post_plans_runnable_idx',
  'index:public.media_cache_post_plans_state_idx',
  'index:public.media_cache_post_plans_lease_expiry_idx',
  'index:public.media_cache_blobs_lru_idx',
  'index:public.media_cache_blobs_state_idx',
  'index:public.media_cache_blobs_eviction_expiry_idx',
  'index:public.media_cache_objects_plan_state_idx',
  'index:public.media_cache_objects_blob_state_idx',
  'index:public.media_cache_objects_state_updated_idx',
  'index:public.media_cache_objects_blob_plan_idx',
  'index:public.media_cache_objects_runnable_idx',
  'index:public.media_cache_objects_lease_expiry_idx',
  'index:public.media_cache_object_sources_resolver_idx',
  'index:public.media_cache_object_sources_observation_idx',
  'index:public.media_cache_actions_created_idx',
  'index:public.media_cache_actions_object_created_idx',
  'index:public.media_cache_actions_blob_created_idx',
  'index:public.media_cache_commands_claim_idx',
  'index:public.media_cache_commands_object_idx',
  'constraint:public.message_source_media_observations_observation_source_fk',
  'constraint:public.message_source_media_observations_source_check',
  'constraint:public.message_source_observations_id_source_kind_unique',
  'constraint:public.import_run_observations_observation_source_fk',
  'constraint:public.import_run_observations_pk',
  'constraint:public.import_run_observations_resolution_check',
  'constraint:public.import_run_observations_source_kind_check',
  'constraint:public.import_run_coverages_explicit_check',
  'constraint:public.import_run_coverages_pk',
  'constraint:public.import_run_coverages_range_check',
  'constraint:public.reconciliation_findings_channel_scope_check',
  'constraint:public.reconciliation_schedule_lease_check',
  'constraint:public.telegram_poll_receipts_counts_check',
  'constraint:public.telegram_poll_receipts_range_check',
] as const;

const EXPECTED_POSTGRES_MAJOR = 18;
const MEDIA_CACHE_MAX_BYTES = 5n * 1024n * 1024n * 1024n;
const REDACTED = '[redacted]';
const REDACTED_DATABASE_URL = '[redacted database URL]';
const SECRET_ASSIGNMENT =
  /(\b(?:authorization|better_auth_secret|database_url|password|postgres_password|secret|telegram_bot_token|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const DATABASE_URL = /\bpostgres(?:ql)?:\/\/[^\s'"<>]+/gi;
const TELEGRAM_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g;
const BEARER_TOKEN = /\bBearer\s+\S+/gi;
const URL_SECRET = /([?&](?:key|password|secret|token)=)[^&\s]+/gi;

function replaceKnownValues(text: string, sensitiveValues: readonly string[]): string {
  return [...sensitiveValues]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((sanitized, value) => sanitized.split(value).join(REDACTED), text);
}

export function sanitizeDiagnosticText(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): string {
  const text =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : (() => {
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          })();

  return replaceKnownValues(text ?? String(value), sensitiveValues)
    .replace(DATABASE_URL, REDACTED_DATABASE_URL)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(TELEGRAM_TOKEN, REDACTED)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(URL_SECRET, `$1${REDACTED}`);
}

function result(
  id: DoctorCheckId,
  label: string,
  status: DoctorCheckStatus,
  message: string,
  sensitiveValues: readonly string[],
  details?: string[],
): DoctorCheckResult {
  return {
    id,
    label,
    status,
    message: sanitizeDiagnosticText(message, sensitiveValues),
    ...(details
      ? { details: details.map((detail) => sanitizeDiagnosticText(detail, sensitiveValues)) }
      : {}),
  };
}

function failure(
  id: DoctorCheckId,
  label: string,
  error: unknown,
  sensitiveValues: readonly string[],
): DoctorCheckResult {
  return result(
    id,
    label,
    'fail',
    `Check failed: ${sanitizeDiagnosticText(error, sensitiveValues)}`,
    sensitiveValues,
  );
}

function telegramIdAsNumber(id: bigint): number {
  const value = Number(id);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Telegram channel ID is outside the JavaScript safe integer range');
  }
  return value;
}

async function checkConfig(
  dependencies: DoctorDependencies,
  sensitiveValues: readonly string[],
): Promise<DoctorCheckResult> {
  try {
    await dependencies.validateConfig();
    return result('config', 'Configuration', 'ok', 'Configuration is valid', sensitiveValues);
  } catch (error) {
    return failure('config', 'Configuration', error, sensitiveValues);
  }
}

async function checkPostgresVersion(
  database: DoctorDatabaseDiagnostics,
  sensitiveValues: readonly string[],
): Promise<DoctorCheckResult> {
  try {
    const major = await database.getPostgresMajorVersion();
    if (major !== EXPECTED_POSTGRES_MAJOR) {
      return result(
        'postgres-version',
        'PostgreSQL',
        'fail',
        `PostgreSQL ${EXPECTED_POSTGRES_MAJOR} is required; found major ${major}`,
        sensitiveValues,
      );
    }
    return result(
      'postgres-version',
      'PostgreSQL',
      'ok',
      `PostgreSQL major ${major}`,
      sensitiveValues,
    );
  } catch (error) {
    return failure('postgres-version', 'PostgreSQL', error, sensitiveValues);
  }
}

async function checkDatabaseSchema(
  database: DoctorDatabaseDiagnostics,
  sensitiveValues: readonly string[],
): Promise<DoctorCheckResult> {
  try {
    const missing = await database.listMissingSchemaObjects(EXPECTED_DATABASE_OBJECTS);
    if (missing.length > 0) {
      return result(
        'database-schema',
        'Database schema',
        'fail',
        `${missing.length} expected schema object(s) are missing`,
        sensitiveValues,
        [...missing.map((object) => `Missing: ${object}`), 'Fix: run kodama migrate'],
      );
    }
    return result(
      'database-schema',
      'Database schema',
      'ok',
      `${EXPECTED_DATABASE_OBJECTS.length} expected objects found`,
      sensitiveValues,
    );
  } catch (error) {
    return failure('database-schema', 'Database schema', error, sensitiveValues);
  }
}

async function checkMediaCacheLedger(
  database: DoctorDatabaseDiagnostics,
  sensitiveValues: readonly string[],
): Promise<DoctorCheckResult> {
  try {
    const snapshot = await database.getMediaCacheLedgerSnapshot();
    if (snapshot.cacheRowCount === 0n) {
      return result(
        'media-cache-ledger',
        'Media cache ledger',
        'ok',
        'No media cache rows to verify',
        sensitiveValues,
      );
    }

    const details = [
      `Cache rows: ${snapshot.cacheRowCount}`,
      `Runtime rows: ${snapshot.runtimeRowCount}`,
      `Physical blob rows: ${snapshot.physicalBlobCount}`,
      `Original reservation rows: ${snapshot.originalReservationCount}`,
      `Active thumbnail reservation rows: ${snapshot.activeThumbnailReservationCount}`,
    ];
    if (
      snapshot.runtimeRowCount !== 1n ||
      snapshot.runtimeReadyBytes === null ||
      snapshot.runtimeReservedBytes === null ||
      snapshot.runtimeMaxBytes === null
    ) {
      return result(
        'media-cache-ledger',
        'Media cache ledger',
        'fail',
        'Expected exactly one complete media cache runtime row',
        sensitiveValues,
        details,
      );
    }

    const expectedReservedBytes =
      snapshot.originalReservedBytes + snapshot.activeThumbnailReservedBytes;
    details.push(
      `Ready bytes: runtime=${snapshot.runtimeReadyBytes}, ledger=${snapshot.physicalBlobBytes}`,
      `Reserved bytes: runtime=${snapshot.runtimeReservedBytes}, ledger=${expectedReservedBytes}`,
      `Maximum bytes: ${snapshot.runtimeMaxBytes}`,
    );
    const countersAreNonnegative =
      snapshot.runtimeReadyBytes >= 0n &&
      snapshot.runtimeReservedBytes >= 0n &&
      snapshot.physicalBlobBytes >= 0n &&
      snapshot.originalReservedBytes >= 0n &&
      snapshot.activeThumbnailReservedBytes >= 0n;
    const maximumIsValid =
      snapshot.runtimeMaxBytes > 0n && snapshot.runtimeMaxBytes <= MEDIA_CACHE_MAX_BYTES;
    const countersMatch =
      snapshot.runtimeReadyBytes === snapshot.physicalBlobBytes &&
      snapshot.runtimeReservedBytes === expectedReservedBytes;

    if (!countersAreNonnegative || !maximumIsValid || !countersMatch) {
      return result(
        'media-cache-ledger',
        'Media cache ledger',
        'fail',
        'Media cache counters do not match the read-only ledger recomputation',
        sensitiveValues,
        details,
      );
    }
    return result(
      'media-cache-ledger',
      'Media cache ledger',
      'ok',
      'Media cache counters match the ledger',
      sensitiveValues,
      details,
    );
  } catch (error) {
    return failure('media-cache-ledger', 'Media cache ledger', error, sensitiveValues);
  }
}

async function checkOwner(
  database: DoctorDatabaseDiagnostics,
  sensitiveValues: readonly string[],
): Promise<DoctorCheckResult> {
  try {
    const owners = await database.listOwners();
    if (owners.length === 0) {
      return result(
        'owner',
        'Owner',
        'warn',
        'No owner is configured; run kodama owner create',
        sensitiveValues,
      );
    }
    if (owners.length > 1) {
      return result(
        'owner',
        'Owner',
        'fail',
        `Expected one owner; found ${owners.length}`,
        sensitiveValues,
      );
    }
    return result('owner', 'Owner', 'ok', 'Singleton owner is configured', sensitiveValues);
  } catch (error) {
    return failure('owner', 'Owner', error, sensitiveValues);
  }
}

interface TelegramIdentity {
  bot: DoctorTelegramBot | null;
  result: DoctorCheckResult;
}

async function checkTelegramBot(
  dependencies: DoctorDependencies,
  sensitiveValues: readonly string[],
): Promise<TelegramIdentity> {
  let bot: DoctorTelegramBot;
  try {
    bot = await dependencies.telegram.getMe();
  } catch (error) {
    return {
      bot: null,
      result: failure('telegram-bot', 'Telegram Bot', error, sensitiveValues),
    };
  }

  try {
    const boundBotId = await dependencies.database.getBoundTelegramBotId();
    if (boundBotId === null) {
      return {
        bot,
        result: result(
          'telegram-bot',
          'Telegram Bot',
          'warn',
          `Bot @${bot.username ?? bot.id} is reachable but the database is not bound`,
          sensitiveValues,
        ),
      };
    }
    if (boundBotId !== BigInt(bot.id)) {
      return {
        bot,
        result: result(
          'telegram-bot',
          'Telegram Bot',
          'fail',
          'Configured Bot does not match the Bot bound to this database',
          sensitiveValues,
        ),
      };
    }
    return {
      bot,
      result: result(
        'telegram-bot',
        'Telegram Bot',
        'ok',
        `Bot @${bot.username ?? bot.id} matches the database binding`,
        sensitiveValues,
      ),
    };
  } catch (error) {
    return {
      bot,
      result: failure('telegram-bot', 'Telegram Bot binding', error, sensitiveValues),
    };
  }
}

async function inspectChannel(
  channel: DoctorTelegramChannel,
  bot: DoctorTelegramBot | null,
  telegram: DoctorTelegramDiagnostics,
): Promise<string[]> {
  const failures: string[] = [];
  const chatId = telegramIdAsNumber(channel.telegramChatId);
  let chat: DoctorTelegramChat | null = null;

  try {
    chat = await telegram.getChat(chatId);
  } catch (error) {
    failures.push(`Telegram lookup failed: ${sanitizeDiagnosticText(error)}`);
  }

  if (chat && chat.type !== 'channel') {
    failures.push(`Expected a channel; Telegram reports ${chat.type}`);
  }
  if (chat && !chat.username) {
    failures.push('Channel is not public');
  }
  if (!bot) {
    failures.push('Bot administrator status could not be verified');
  } else {
    try {
      const membership = await telegram.getChatMember(chatId, bot.id);
      if (membership.status !== 'administrator' && membership.status !== 'creator') {
        failures.push(`Bot is not an administrator (status: ${membership.status})`);
      }
    } catch (error) {
      failures.push(`Administrator lookup failed: ${sanitizeDiagnosticText(error)}`);
    }
  }

  return failures;
}

async function checkTelegramChannels(
  dependencies: DoctorDependencies,
  bot: DoctorTelegramBot | null,
  sensitiveValues: readonly string[],
): Promise<DoctorCheckResult> {
  let channels: DoctorTelegramChannel[];
  try {
    channels = await dependencies.database.listEnabledChannels();
  } catch (error) {
    return failure('telegram-channels', 'Telegram channels', error, sensitiveValues);
  }

  if (channels.length === 0) {
    return result(
      'telegram-channels',
      'Telegram channels',
      'warn',
      'No channels are enabled; run kodama channel add or kodama channel enable',
      sensitiveValues,
    );
  }

  const details: string[] = [];
  let failureCount = 0;
  for (const channel of channels) {
    const failures = await inspectChannel(channel, bot, dependencies.telegram);
    const name = channel.username ? `@${channel.username}` : channel.telegramChatId.toString();
    if (failures.length === 0) {
      details.push(`${name}: public and Bot administrator verified`);
      continue;
    }
    failureCount += 1;
    details.push(`${name}: ${failures.join('; ')}`);
  }

  if (failureCount > 0) {
    return result(
      'telegram-channels',
      'Telegram channels',
      'fail',
      `${failureCount} of ${channels.length} enabled channel(s) failed verification`,
      sensitiveValues,
      details,
    );
  }
  return result(
    'telegram-channels',
    'Telegram channels',
    'ok',
    `${channels.length} enabled channel(s) verified`,
    sensitiveValues,
    details,
  );
}

export async function runDoctor(dependencies: DoctorDependencies): Promise<DoctorReport> {
  const sensitiveValues = dependencies.sensitiveValues ?? [];
  const checks: DoctorCheckResult[] = [];

  checks.push(await checkConfig(dependencies, sensitiveValues));
  checks.push(await checkPostgresVersion(dependencies.database, sensitiveValues));
  checks.push(await checkDatabaseSchema(dependencies.database, sensitiveValues));
  checks.push(await checkMediaCacheLedger(dependencies.database, sensitiveValues));
  checks.push(await checkOwner(dependencies.database, sensitiveValues));
  const telegramIdentity = await checkTelegramBot(dependencies, sensitiveValues);
  checks.push(telegramIdentity.result);
  checks.push(await checkTelegramChannels(dependencies, telegramIdentity.bot, sensitiveValues));

  return { checks };
}

export function doctorHasFailures(report: DoctorReport): boolean {
  return report.checks.some((check) => check.status === 'fail');
}

export function renderDoctorReport(report: DoctorReport): string {
  const statusLabels: Record<DoctorCheckStatus, string> = {
    fail: 'fail',
    ok: 'ok',
    warn: 'warn',
  };
  const lines = ['Koharu Suite doctor'];

  for (const check of report.checks) {
    lines.push(`[${statusLabels[check.status]}] ${check.label}: ${check.message}`);
    for (const detail of check.details ?? []) {
      lines.push(`  - ${detail}`);
    }
  }

  const counts = report.checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { fail: 0, ok: 0, warn: 0 },
  );
  lines.push(`Summary: ${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} failure(s)`);
  return lines.join('\n');
}
