import { asc, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '../db/client.js';
import { importRuns, telegramChannelAllowlist } from '../db/schema.js';
import type { TelegramDesktopImportReport } from './report.js';

const TELEGRAM_DESKTOP_IMPORT_ADVISORY_LOCK = 6_309_648_946_926_689;

export type ImportTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ImportConfiguredChannel {
  enabled: boolean;
  telegramChatId: bigint;
  title: string;
  username: string | null;
}

function reportJson(report: TelegramDesktopImportReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

export class PostgresTelegramDesktopImportRepository {
  private readonly lockClient;
  private lockBackendPid: number | undefined;
  private lockSession: postgres.ReservedSql | undefined;
  private lockSessionLost = false;

  constructor(
    databaseUrl: string,
    private readonly database: Database,
  ) {
    this.lockClient = postgres(databaseUrl, {
      max: 1,
      max_lifetime: null,
      onclose: () => {
        this.lockSessionLost = true;
      },
    });
  }

  async configuredChannels(channelIds: bigint[]): Promise<ImportConfiguredChannel[]> {
    if (channelIds.length === 0) {
      return [];
    }

    return this.database
      .select({
        enabled: telegramChannelAllowlist.enabled,
        telegramChatId: telegramChannelAllowlist.telegramChatId,
        title: telegramChannelAllowlist.title,
        username: telegramChannelAllowlist.username,
      })
      .from(telegramChannelAllowlist)
      .where(inArray(telegramChannelAllowlist.telegramChatId, channelIds))
      .orderBy(asc(telegramChannelAllowlist.telegramChatId));
  }

  async acquireApplyLock(): Promise<void> {
    if (this.lockSession) {
      throw new Error('Telegram Desktop import lock was already acquired');
    }

    this.lockSessionLost = false;
    const session = await this.lockClient.reserve();
    try {
      const [result] = await session<{ acquired: boolean; backendPid: number }[]>`
        select
          pg_try_advisory_lock(${TELEGRAM_DESKTOP_IMPORT_ADVISORY_LOCK}) as acquired,
          pg_backend_pid() as "backendPid"
      `;
      if (!result?.acquired) {
        throw new Error('Another Telegram Desktop import is already running');
      }
      this.lockBackendPid = result.backendPid;
    } catch (error) {
      session.release();
      throw error;
    }
    this.lockSession = session;
  }

  async assertApplyLock(): Promise<void> {
    const session = this.lockSession;
    const backendPid = this.lockBackendPid;
    if (!session || backendPid === undefined || this.lockSessionLost) {
      throw new Error('Telegram Desktop import lost its database lock');
    }

    try {
      const [result] = await session<{ backendPid: number }[]>`
        select pg_backend_pid() as "backendPid"
      `;
      if (this.lockSessionLost || result?.backendPid !== backendPid) {
        throw new Error('Telegram Desktop import database session changed');
      }
    } catch (error) {
      this.lockSessionLost = true;
      throw new Error('Telegram Desktop import lost its database lock', { cause: error });
    }
  }

  async createRun(report: TelegramDesktopImportReport): Promise<string> {
    const [run] = await this.database
      .insert(importRuns)
      .values({
        parserVersion: report.parserVersion,
        report: reportJson(report),
        selectedChannels: report.selectedChats.map((chat) => chat.canonicalChannelId),
        sourceFileSha256: report.fileSha256,
        sourceKind: 'telegram_desktop_json',
        startedAt: new Date(report.startedAt),
        status: 'running',
      })
      .returning({ id: importRuns.id });
    if (!run) {
      throw new Error('Failed to create Telegram Desktop import run');
    }
    return run.id;
  }

  async updateRun(
    id: string,
    report: TelegramDesktopImportReport,
    status: 'completed' | 'interrupted' | 'partial' | 'running',
  ): Promise<void> {
    const now = new Date();
    await this.database
      .update(importRuns)
      .set({
        completedAt: status === 'running' ? null : now,
        report: reportJson(report),
        status,
        updatedAt: now,
      })
      .where(inArray(importRuns.id, [id]));
  }

  transaction<T>(callback: (transaction: ImportTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(callback);
  }

  async close(): Promise<void> {
    try {
      if (this.lockSession && this.lockBackendPid !== undefined && !this.lockSessionLost) {
        await this.lockSession`
          select pg_advisory_unlock(${TELEGRAM_DESKTOP_IMPORT_ADVISORY_LOCK})
        `;
      }
    } catch {
      // Closing the pinned connection releases the session lock after a database failure.
    }
    this.lockBackendPid = undefined;
    this.lockSessionLost = true;
    this.lockSession?.release();
    this.lockSession = undefined;
    await this.lockClient.end({ timeout: 1 });
  }
}
