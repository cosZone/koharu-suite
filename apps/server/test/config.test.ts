import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl, resolvePort, resolveTelegramConfig } from '../src/config.js';

describe('configuration', () => {
  it('accepts a valid port', () => {
    expect(resolvePort('4321')).toBe(4321);
  });

  it('rejects an invalid port', () => {
    expect(() => resolvePort('70000')).toThrow();
  });

  it('accepts PostgreSQL URLs only', () => {
    expect(resolveDatabaseUrl('postgresql://localhost/koharu')).toBe(
      'postgresql://localhost/koharu',
    );
    expect(() => resolveDatabaseUrl('https://example.com')).toThrow();
  });

  it('encodes discrete PostgreSQL settings without corrupting reserved password characters', () => {
    expect(
      resolveDatabaseUrl(undefined, {
        POSTGRES_DB: 'koharu',
        POSTGRES_HOST: 'db',
        POSTGRES_PASSWORD: 'slash/pass#word',
        POSTGRES_PORT: '5432',
        POSTGRES_USER: 'koharu',
      }),
    ).toBe('postgresql://koharu:slash%2Fpass%23word@db:5432/koharu');
  });

  it('parses a Telegram token and 64-bit-safe negative channel ID', () => {
    expect(
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: '123456:test-token',
        TELEGRAM_CHANNEL_ID: '-1001234567890',
      }),
    ).toEqual({
      botToken: '123456:test-token',
      channelId: -1_001_234_567_890n,
    });
  });

  it('rejects missing secrets, non-channel IDs, and unsafe Telegram IDs', () => {
    expect(() => resolveTelegramConfig({})).toThrow();
    expect(() =>
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHANNEL_ID: '1234',
      }),
    ).toThrow();
    expect(() =>
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHANNEL_ID: '-9007199254740992',
      }),
    ).toThrow();
  });

  it('does not echo the bot token when another Telegram setting is invalid', () => {
    const token = '123456:super-secret-token';
    let configurationError: unknown;

    try {
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_CHANNEL_ID: 'not-a-channel',
      });
    } catch (error) {
      configurationError = error;
    }

    expect(configurationError).toBeDefined();
    expect(String(configurationError)).not.toContain(token);
  });
});
