export type DoctorCheckStatus = 'fail' | 'ok' | 'warn';

export type DoctorCheckId =
  | 'config'
  | 'postgres-version'
  | 'database-schema'
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
  getPostgresMajorVersion(): Promise<number>;
  listEnabledChannels(): Promise<DoctorTelegramChannel[]>;
  listMissingSchemaObjects(expectedObjects: readonly string[]): Promise<string[]>;
  listOwners(): Promise<DoctorOwner[]>;
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
  'message_media',
  'message_revisions',
  'message_revisions.html',
  'message_revisions.renderer_version',
  'messages',
  'operation_audit_events',
  'operation_audit_events.reason',
  'owners',
  'telegram_channel_allowlist',
  'telegram_channel_allowlist.disabled_at',
  'telegram_channel_allowlist.enabled',
  'telegram_channels',
  'telegram_ingest_tasks',
  'telegram_ingest_tasks.skip_reason',
  'telegram_ingest_tasks.skipped_at',
  'telegram_polling_state',
  'telegram_updates',
] as const;

const EXPECTED_POSTGRES_MAJOR = 18;
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
