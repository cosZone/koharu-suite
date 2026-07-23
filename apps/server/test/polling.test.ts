import { describe, expect, it } from 'vitest';
import { TELEGRAM_POLLING_OPTIONS } from '../src/telegram/polling.js';

describe('Telegram long polling configuration', () => {
  it('requests one channel post at a time without dropping pending updates', () => {
    expect(TELEGRAM_POLLING_OPTIONS).toEqual({
      allowed_updates: ['channel_post'],
      limit: 1,
      timeout: 30,
    });
    expect(TELEGRAM_POLLING_OPTIONS).not.toHaveProperty('drop_pending_updates');
  });
});
