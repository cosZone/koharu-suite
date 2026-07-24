import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners, telegramChannelAllowlist, telegramPollingState } from '../db/schema.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from '../media-cache/ledger-repository.js';
import type { TelegramApi } from '../telegram/api.js';
import type {
  DoctorDatabaseDiagnostics,
  DoctorMediaCacheLedgerSnapshot,
  DoctorOwner,
  DoctorTelegramBot,
  DoctorTelegramChannel,
  DoctorTelegramChat,
  DoctorTelegramDiagnostics,
  DoctorTelegramMembership,
} from './doctor.js';

interface PostgresVersionRow extends Record<string, unknown> {
  serverVersionNum: string;
}

interface SchemaColumnRow extends Record<string, unknown> {
  columnName: string;
  schemaName: string;
  tableName: string;
}

interface SchemaTableRow extends Record<string, unknown> {
  schemaName: string;
  tableName: string;
}

interface SchemaConstraintRow extends Record<string, unknown> {
  constraintName: string;
  schemaName: string;
}

interface SchemaIndexRow extends Record<string, unknown> {
  indexName: string;
  schemaName: string;
}

interface MediaCacheLedgerRow extends Record<string, unknown> {
  activeThumbnailReservationCount: string;
  activeThumbnailReservedBytes: string;
  cacheRowCount: string;
  originalReservationCount: string;
  originalReservedBytes: string;
  physicalBlobBytes: string;
  physicalBlobCount: string;
  runtimeMaxBytes: string | null;
  runtimeReadyBytes: string | null;
  runtimeReservedBytes: string | null;
  runtimeRowCount: string;
}

function expectedSchemaObject(value: string): string {
  if (value.startsWith('constraint:') || value.startsWith('index:')) {
    return value;
  }
  return value.includes('.') ? value : `public.${value}`;
}

function parseLedgerInteger(value: string | null, label: string): bigint | null {
  if (value === null) {
    return null;
  }
  if (!/^-?\d+$/u.test(value)) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return BigInt(value);
}

export class PostgresDoctorDiagnostics implements DoctorDatabaseDiagnostics {
  constructor(private readonly database: Database) {}

  async getBoundTelegramBotId(): Promise<bigint | null> {
    const [state] = await this.database
      .select({ botId: telegramPollingState.botId })
      .from(telegramPollingState)
      .where(eq(telegramPollingState.singleton, 1))
      .limit(1);
    return state?.botId ?? null;
  }

  async getPostgresMajorVersion(): Promise<number> {
    const result = await this.database.execute<PostgresVersionRow>(
      sql`select current_setting('server_version_num') as "serverVersionNum"`,
    );
    const serverVersionNum = result[0]?.serverVersionNum;
    if (!serverVersionNum || !/^\d+$/.test(serverVersionNum)) {
      throw new Error('PostgreSQL did not return a valid server_version_num');
    }
    return Math.floor(Number(serverVersionNum) / 10_000);
  }

  async getMediaCacheLedgerSnapshot(): Promise<DoctorMediaCacheLedgerSnapshot> {
    return this.database.transaction(
      async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
        const result = await transaction.execute<MediaCacheLedgerRow>(sql`
          select
            (
              (select count(*) from media_cache_runtime)
              + (select count(*) from media_cache_post_plans)
              + (select count(*) from media_cache_blobs)
              + (select count(*) from media_cache_objects)
              + (select count(*) from media_cache_object_sources)
              + (select count(*) from media_cache_actions)
            )::text as "cacheRowCount",
            (select count(*)::text from media_cache_runtime) as "runtimeRowCount",
            (select ready_bytes::text from media_cache_runtime limit 1) as "runtimeReadyBytes",
            (select reserved_bytes::text from media_cache_runtime limit 1)
              as "runtimeReservedBytes",
            (select max_bytes::text from media_cache_runtime limit 1) as "runtimeMaxBytes",
            (
              select count(*)::text
              from media_cache_blobs
              where state in ('ready', 'deleting')
            ) as "physicalBlobCount",
            (
              select coalesce(sum(byte_length), 0)::text
              from media_cache_blobs
              where state in ('ready', 'deleting')
            ) as "physicalBlobBytes",
            (
              select count(*)::text
              from media_cache_post_plans
              where reserved_original_bytes <> 0
            ) as "originalReservationCount",
            (
              select coalesce(sum(reserved_original_bytes), 0)::text
              from media_cache_post_plans
            ) as "originalReservedBytes",
            (
              select count(*)::text
              from media_cache_objects
              where variant = 'thumbnail'
                and state in ('reserved', 'downloading', 'staging')
                and reserved_bytes <> 0
            ) as "activeThumbnailReservationCount",
            (
              select coalesce(sum(reserved_bytes), 0)::text
              from media_cache_objects
              where variant = 'thumbnail'
                and state in ('reserved', 'downloading', 'staging')
            ) as "activeThumbnailReservedBytes"
        `);
        const row = result[0];
        if (!row) {
          throw new Error('PostgreSQL did not return a media cache ledger snapshot');
        }
        return {
          activeThumbnailReservationCount:
            parseLedgerInteger(
              row.activeThumbnailReservationCount,
              'active thumbnail reservation count',
            ) ?? 0n,
          activeThumbnailReservedBytes:
            parseLedgerInteger(
              row.activeThumbnailReservedBytes,
              'active thumbnail reservation bytes',
            ) ?? 0n,
          cacheRowCount: parseLedgerInteger(row.cacheRowCount, 'cache row count') ?? 0n,
          originalReservationCount:
            parseLedgerInteger(row.originalReservationCount, 'original reservation count') ?? 0n,
          originalReservedBytes:
            parseLedgerInteger(row.originalReservedBytes, 'original reservation bytes') ?? 0n,
          physicalBlobBytes: parseLedgerInteger(row.physicalBlobBytes, 'physical blob bytes') ?? 0n,
          physicalBlobCount: parseLedgerInteger(row.physicalBlobCount, 'physical blob count') ?? 0n,
          runtimeMaxBytes: parseLedgerInteger(row.runtimeMaxBytes, 'runtime maximum bytes'),
          runtimeReadyBytes: parseLedgerInteger(row.runtimeReadyBytes, 'runtime ready bytes'),
          runtimeReservedBytes: parseLedgerInteger(
            row.runtimeReservedBytes,
            'runtime reserved bytes',
          ),
          runtimeRowCount: parseLedgerInteger(row.runtimeRowCount, 'runtime row count') ?? 0n,
        };
      },
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    );
  }

  async listEnabledChannels(): Promise<DoctorTelegramChannel[]> {
    return this.database
      .select({
        telegramChatId: telegramChannelAllowlist.telegramChatId,
        title: telegramChannelAllowlist.title,
        username: telegramChannelAllowlist.username,
      })
      .from(telegramChannelAllowlist)
      .where(eq(telegramChannelAllowlist.enabled, true))
      .orderBy(asc(telegramChannelAllowlist.title), asc(telegramChannelAllowlist.telegramChatId));
  }

  async listMissingSchemaObjects(expectedObjects: readonly string[]): Promise<string[]> {
    const [tables, columns, constraints, indexes] = await Promise.all([
      this.database.execute<SchemaTableRow>(sql`
        select
          table_schema as "schemaName",
          table_name as "tableName"
        from information_schema.tables
        where table_schema in ('public', 'drizzle')
      `),
      this.database.execute<SchemaColumnRow>(sql`
        select
          table_schema as "schemaName",
          table_name as "tableName",
          column_name as "columnName"
        from information_schema.columns
        where table_schema in ('public', 'drizzle')
      `),
      this.database.execute<SchemaConstraintRow>(sql`
        select
          constraint_schema as "schemaName",
          constraint_name as "constraintName"
        from information_schema.table_constraints
        where constraint_schema in ('public', 'drizzle')
      `),
      this.database.execute<SchemaIndexRow>(sql`
        select
          schemaname as "schemaName",
          indexname as "indexName"
        from pg_indexes
        where schemaname in ('public', 'drizzle')
      `),
    ]);
    const found = new Set<string>();
    for (const table of tables) {
      found.add(`${table.schemaName}.${table.tableName}`);
    }
    for (const column of columns) {
      found.add(`${column.schemaName}.${column.tableName}.${column.columnName}`);
      if (column.schemaName === 'public') {
        found.add(`${column.tableName}.${column.columnName}`);
      }
    }
    for (const constraint of constraints) {
      found.add(`constraint:${constraint.schemaName}.${constraint.constraintName}`);
    }
    for (const index of indexes) {
      found.add(`index:${index.schemaName}.${index.indexName}`);
    }

    return expectedObjects.filter((object) => !found.has(expectedSchemaObject(object)));
  }

  async listOwners(): Promise<DoctorOwner[]> {
    return this.database
      .select({ userId: owners.userId })
      .from(owners)
      .orderBy(asc(owners.createdAt), asc(owners.userId));
  }
}

/**
 * Keeps the doctor on a deliberately read-only Telegram capability. In particular,
 * this adapter does not expose the ingestion API's getUpdates method.
 */
export class TelegramDoctorDiagnostics implements DoctorTelegramDiagnostics {
  constructor(private readonly api: TelegramApi) {}

  async getChat(chatId: number | string, signal?: AbortSignal): Promise<DoctorTelegramChat> {
    const chat = await this.api.getChat(chatId, signal);
    return {
      id: chat.id,
      ...(chat.title === undefined ? {} : { title: chat.title }),
      type: chat.type,
      ...(chat.username === undefined ? {} : { username: chat.username }),
    };
  }

  async getChatMember(
    chatId: number | string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<DoctorTelegramMembership> {
    const membership = await this.api.getChatMember(chatId, userId, signal);
    return { status: membership.status };
  }

  async getMe(signal?: AbortSignal): Promise<DoctorTelegramBot> {
    const bot = await this.api.getMe(signal);
    return {
      id: bot.id,
      ...(bot.username === undefined ? {} : { username: bot.username }),
    };
  }
}
