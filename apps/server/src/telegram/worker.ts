import { eq, sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import type { Database } from '../db/client.js';
import { telegramIngestTasks } from '../db/schema.js';
import type { PostgresMessageRepository } from '../messages/repository.js';
import { normalizeChannelUpdate } from './normalize.js';

const MAX_ATTEMPTS = 10;
const IDLE_DELAY_MS = 100;

interface ClaimedTask extends Record<string, unknown> {
  attemptCount: number;
  id: string;
  rawJson: Update | null;
  telegramChatId: bigint | string;
}

function retryDelayMilliseconds(attemptCount: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}

function safeErrorMessage(reason: unknown): string {
  if (!(reason instanceof Error)) {
    return 'Telegram task processing failed';
  }

  const name = reason.name.replaceAll(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
  const code =
    'code' in reason && typeof reason.code === 'string'
      ? reason.code.replaceAll(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)
      : '';
  return code
    ? `${name || 'Error'} (${code}): task processing failed`
    : `${name || 'Error'}: task processing failed`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class TelegramWorkerPool {
  private readonly abortController = new AbortController();
  private lifetime: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly database: Database,
    private readonly writer: Pick<PostgresMessageRepository, 'ingestInTransaction'>,
    private readonly concurrency: number,
  ) {}

  get done(): Promise<void> {
    return this.lifetime ?? Promise.resolve();
  }

  start(): Promise<void> {
    if (this.lifetime) {
      throw new Error('Telegram worker pool can only be started once');
    }

    const loops = Array.from({ length: this.concurrency }, () =>
      this.runWorker().catch((error) => {
        this.abortController.abort(error);
        throw error;
      }),
    );
    this.lifetime = Promise.allSettled(loops).then((results) => {
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed) {
        throw failed.reason;
      }
    });
    return this.lifetime;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  async processOne(): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.execute<ClaimedTask>(sql`
        with candidate as (
          select task.id
          from ${telegramIngestTasks} task
          where task.processed_at is null
            and task.blocked_at is null
            and task.available_at <= now()
            and not exists (
              select 1
              from ${telegramIngestTasks} earlier
              where earlier.telegram_chat_id = task.telegram_chat_id
                and earlier.telegram_update_id < task.telegram_update_id
                and earlier.processed_at is null
            )
          order by task.telegram_update_id
          for update skip locked
          limit 1
        )
        select
          task.attempt_count as "attemptCount",
          task.id,
          task.raw_json as "rawJson",
          task.telegram_chat_id as "telegramChatId"
        from ${telegramIngestTasks} task
        inner join candidate on candidate.id = task.id
      `);
      const task = rows[0];
      if (!task) {
        return false;
      }

      try {
        await transaction.transaction(async (savepoint) => {
          if (!task.rawJson) {
            throw new Error('Pending Telegram task has no raw update');
          }
          const post = normalizeChannelUpdate(task.rawJson, BigInt(task.telegramChatId));
          if (!post) {
            throw new Error('Telegram task payload does not match its channel');
          }
          await this.writer.ingestInTransaction(savepoint, post);
        });
        await transaction
          .update(telegramIngestTasks)
          .set({
            lastError: null,
            processedAt: new Date(),
            rawJson: null,
            updatedAt: new Date(),
          })
          .where(eq(telegramIngestTasks.id, task.id));
      } catch (error) {
        const attemptCount = task.attemptCount + 1;
        const now = new Date();
        await transaction
          .update(telegramIngestTasks)
          .set({
            attemptCount,
            availableAt: new Date(now.getTime() + retryDelayMilliseconds(attemptCount)),
            blockedAt: attemptCount >= MAX_ATTEMPTS ? now : null,
            lastError: safeErrorMessage(error),
            updatedAt: now,
          })
          .where(eq(telegramIngestTasks.id, task.id));
      }

      return true;
    });
  }

  private async runWorker(): Promise<void> {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      const processed = await this.processOne();
      if (!processed) {
        await abortableDelay(IDLE_DELAY_MS, signal);
      }
    }
  }

  private async stopOnce(): Promise<void> {
    this.abortController.abort(new Error('Telegram workers stopped'));
    await this.done;
  }
}
