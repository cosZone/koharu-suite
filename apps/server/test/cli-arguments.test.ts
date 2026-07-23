import { describe, expect, it } from 'vitest';
import { normalizeCliArguments } from '../src/cli-arguments.js';

describe('CLI arguments', () => {
  it('keeps documented negative Telegram IDs as string option values', () => {
    expect(
      normalizeCliArguments([
        'import',
        'telegram-desktop',
        '--channel',
        '-1001234567890',
        '--channel=-1009876543210',
        '--apply',
      ]),
    ).toEqual([
      'import',
      'telegram-desktop',
      '--channel=-1001234567890',
      '--channel=-1009876543210',
      '--apply',
    ]);

    expect(normalizeCliArguments(['channel', 'add', '--telegram-id', '-1001234567890'])).toEqual([
      'channel',
      'add',
      '--telegram-id=-1001234567890',
    ]);
  });

  it('does not consume missing, positive, or non-numeric option values', () => {
    expect(normalizeCliArguments(['import', '--channel', '--json'])).toEqual([
      'import',
      '--channel',
      '--json',
    ]);
    expect(normalizeCliArguments(['import', '--channel', '123'])).toEqual([
      'import',
      '--channel',
      '123',
    ]);
  });
});
