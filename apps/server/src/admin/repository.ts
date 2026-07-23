import { and, count, eq } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import type { Database } from '../db/client.js';
import { messageRevisions, messages, telegramChannels, telegramUpdates } from '../db/schema.js';

export interface AdminCounts {
  channels: number;
  messages: number;
  updates: number;
}

export interface AdminReader {
  getCounts(): Promise<AdminCounts>;
  getRawUpdate(messageId: string): Promise<Update | null>;
}

async function tableCount(database: Database, table: typeof messages): Promise<number>;
async function tableCount(
  database: Database,
  table: typeof telegramChannels | typeof telegramUpdates,
): Promise<number>;
async function tableCount(
  database: Database,
  table: typeof messages | typeof telegramChannels | typeof telegramUpdates,
): Promise<number> {
  const [result] = await database.select({ value: count() }).from(table);
  return result?.value ?? 0;
}

export class PostgresAdminRepository implements AdminReader {
  constructor(private readonly database: Database) {}

  async getCounts(): Promise<AdminCounts> {
    const [channels, messageCount, updates] = await Promise.all([
      tableCount(this.database, telegramChannels),
      tableCount(this.database, messages),
      tableCount(this.database, telegramUpdates),
    ]);

    return {
      channels,
      messages: messageCount,
      updates,
    };
  }

  async getRawUpdate(messageId: string): Promise<Update | null> {
    const [row] = await this.database
      .select({ update: telegramUpdates.rawJson })
      .from(messages)
      .innerJoin(
        messageRevisions,
        and(
          eq(messageRevisions.messageId, messages.id),
          eq(messageRevisions.revisionNumber, messages.currentRevisionNumber),
        ),
      )
      .innerJoin(
        telegramUpdates,
        eq(telegramUpdates.telegramUpdateId, messageRevisions.telegramUpdateId),
      )
      .where(eq(messages.id, messageId))
      .limit(1);

    return row?.update ?? null;
  }
}
