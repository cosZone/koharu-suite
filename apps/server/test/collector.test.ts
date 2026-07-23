import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import type { MessageWriter } from '../src/messages/repository.js';
import { TelegramCollector } from '../src/telegram/collector.js';
import type { TelegramPolling, TelegramUpdateHandler } from '../src/telegram/polling.js';
import { channelPostFixture } from './fixtures/telegram.js';

const ALLOWED_CHANNEL_ID = -1_001_234_567_890n;

class FakePolling implements TelegramPolling {
  private active = false;
  private handler: TelegramUpdateHandler | undefined;
  private rejectLifetime: ((error: unknown) => void) | undefined;
  private resolveLifetime: (() => void) | undefined;
  private running = false;
  private stopRequested = false;

  readonly lifetime = new Promise<void>((resolve, reject) => {
    this.resolveLifetime = resolve;
    this.rejectLifetime = reject;
  });
  readonly stopCalls = vi.fn();

  isRunning(): boolean {
    return this.running;
  }

  start(handler: TelegramUpdateHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
    return this.lifetime;
  }

  async stop(): Promise<void> {
    this.stopCalls();
    this.running = false;
    this.stopRequested = true;
    if (!this.active) {
      this.resolveLifetime?.();
    }
  }

  async deliver(update: Update): Promise<void> {
    if (!this.handler) {
      throw new Error('Polling was not started');
    }

    this.active = true;
    try {
      await this.handler(update);
    } catch (error) {
      this.running = false;
      this.rejectLifetime?.(error);
      throw error;
    } finally {
      this.active = false;
      if (this.stopRequested) {
        this.resolveLifetime?.();
      }
    }
  }
}

describe('Telegram collector', () => {
  it('writes only posts from the explicitly allowed channel', async () => {
    const polling = new FakePolling();
    const writer: MessageWriter = {
      ingest: vi.fn(async () => ({
        channelId: 'channel-id',
        messageId: 'message-id',
        replayed: false,
      })),
    };
    const collector = new TelegramCollector({
      allowedChannelId: ALLOWED_CHANNEL_ID,
      polling,
      writer,
    });
    collector.start();

    await polling.deliver(channelPostFixture({ channelId: -1_009_999_999_999 }));
    await polling.deliver(channelPostFixture());
    await collector.stop();

    expect(writer.ingest).toHaveBeenCalledOnce();
    expect(writer.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({ telegramChatId: ALLOWED_CHANNEL_ID }),
      }),
    );
  });

  it('waits for an active write before stopping polling', async () => {
    const polling = new FakePolling();
    let finishWrite: (() => void) | undefined;
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const writer: MessageWriter = {
      ingest: vi.fn(async () => {
        await writeFinished;
        return {
          channelId: 'channel-id',
          messageId: 'message-id',
          replayed: false,
        };
      }),
    };
    const collector = new TelegramCollector({
      allowedChannelId: ALLOWED_CHANNEL_ID,
      polling,
      writer,
    });
    collector.start();

    const delivery = polling.deliver(channelPostFixture());
    await vi.waitFor(() => expect(writer.ingest).toHaveBeenCalledOnce());
    const stopping = collector.stop();

    expect(polling.stopCalls).not.toHaveBeenCalled();
    finishWrite?.();
    await delivery;
    await stopping;

    expect(polling.stopCalls).toHaveBeenCalledOnce();
  });

  it('does not confirm polling when the database write fails', async () => {
    const polling = new FakePolling();
    const writeError = new Error('database unavailable');
    const collector = new TelegramCollector({
      allowedChannelId: ALLOWED_CHANNEL_ID,
      polling,
      writer: {
        ingest: async () => {
          throw writeError;
        },
      },
    });
    const done = collector.start();
    const doneAssertion = expect(done).rejects.toBe(writeError);

    await expect(polling.deliver(channelPostFixture())).rejects.toBe(writeError);
    await doneAssertion;

    expect(polling.stopCalls).not.toHaveBeenCalled();
  });
});
