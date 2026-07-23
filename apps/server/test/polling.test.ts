import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramApi } from '../src/telegram/api.js';
import { TELEGRAM_POLLING_OPTIONS, TelegramPoller } from '../src/telegram/polling.js';
import { channelPostFixture } from './fixtures/telegram.js';

function botFixture(): UserFromGetMe {
  return {
    allows_users_to_create_topics: false,
    can_join_groups: true,
    can_connect_to_business: false,
    can_manage_bots: false,
    can_read_all_group_messages: false,
    first_name: 'Kodama',
    has_main_web_app: false,
    has_topics_enabled: false,
    id: 123_456,
    is_bot: true,
    supports_inline_queries: false,
    supports_join_request_queries: false,
    username: 'kodama_test_bot',
  };
}

describe('Telegram long polling', () => {
  it('requests full batches including post edits', () => {
    expect(TELEGRAM_POLLING_OPTIONS).toEqual({
      allowed_updates: ['channel_post', 'edited_channel_post'],
      limit: 100,
      timeout: 30,
    });
    expect(TELEGRAM_POLLING_OPTIONS).not.toHaveProperty('drop_pending_updates');
  });

  it('uses the durable cursor and aborts the active request on stop', async () => {
    const requests: Array<{ offset?: number }> = [];
    const api: TelegramApi = {
      getChat: vi.fn(),
      getChatMember: vi.fn(),
      getMe: vi.fn(async () => botFixture()),
      getUpdates: vi.fn(async (options, signal) => {
        requests.push(options);
        if (requests.length === 1) {
          return [channelPostFixture({ updateId: 1_001 })];
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return [];
      }),
    };
    const checkpointBatch = vi
      .fn<(botId: bigint, updates: Update[]) => Promise<bigint | null>>()
      .mockResolvedValueOnce(1_002n)
      .mockResolvedValue(1_002n);
    const poller = new TelegramPoller({
      api,
      channels: { bootstrapLegacy: vi.fn(async () => null) },
      inbox: {
        acquirePollerLock: vi.fn(async () => {}),
        assertPollerLock: vi.fn(async () => {}),
        bindBot: vi.fn(async () => 900n),
        checkpointBatch,
      },
      legacyChannelId: undefined,
      retryDelay: vi.fn(async () => {}),
    });

    poller.start();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await poller.stop();

    expect(requests[0]).toMatchObject({ offset: 900 });
    expect(requests[1]).toMatchObject({ offset: 1_002 });
    expect(checkpointBatch).toHaveBeenCalledOnce();
  });

  it('retries Telegram failures without advancing the durable cursor', async () => {
    let calls = 0;
    const api: TelegramApi = {
      getChat: vi.fn(),
      getChatMember: vi.fn(),
      getMe: vi.fn(async () => botFixture()),
      getUpdates: vi.fn(async (_options, signal) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('Telegram unavailable');
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return [];
      }),
    };
    const checkpointBatch = vi.fn(async () => null);
    const retryDelay = vi.fn(async () => {});
    const poller = new TelegramPoller({
      api,
      channels: { bootstrapLegacy: vi.fn(async () => null) },
      inbox: {
        acquirePollerLock: vi.fn(async () => {}),
        assertPollerLock: vi.fn(async () => {}),
        bindBot: vi.fn(async () => null),
        checkpointBatch,
      },
      legacyChannelId: undefined,
      retryDelay,
    });

    poller.start();
    await vi.waitFor(() => expect(calls).toBe(2));
    await poller.stop();

    expect(retryDelay).toHaveBeenCalledOnce();
    expect(checkpointBatch).not.toHaveBeenCalled();
  });

  it('stops instead of requesting a higher offset when the inbox transaction fails', async () => {
    const api: TelegramApi = {
      getChat: vi.fn(),
      getChatMember: vi.fn(),
      getMe: vi.fn(async () => botFixture()),
      getUpdates: vi.fn(async () => [channelPostFixture({ updateId: 1_001 })]),
    };
    const databaseError = new Error('database unavailable');
    const poller = new TelegramPoller({
      api,
      channels: { bootstrapLegacy: vi.fn(async () => null) },
      inbox: {
        acquirePollerLock: vi.fn(async () => {}),
        assertPollerLock: vi.fn(async () => {}),
        bindBot: vi.fn(async () => 900n),
        checkpointBatch: vi.fn(async () => {
          throw databaseError;
        }),
      },
      legacyChannelId: undefined,
      retryDelay: vi.fn(async () => {}),
    });

    await expect(poller.start()).rejects.toBe(databaseError);
    expect(api.getUpdates).toHaveBeenCalledOnce();
  });
});
