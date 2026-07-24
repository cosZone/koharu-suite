import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { owners, telegramChannelAllowlist, telegramPollingState } from '../db/schema.js';
import type { TelegramApi } from '../telegram/api.js';
import type {
  DoctorDatabaseDiagnostics,
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

function expectedSchemaObject(value: string): string {
  if (value.startsWith('constraint:')) {
    return value;
  }
  return value.includes('.') ? value : `public.${value}`;
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
    const [tables, columns, constraints] = await Promise.all([
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
