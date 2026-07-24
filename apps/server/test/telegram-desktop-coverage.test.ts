import { describe, expect, it } from 'vitest';
import {
  parseTelegramDesktopCompleteRange,
  validateTelegramDesktopCompleteRanges,
} from '../src/imports/coverage.js';

const CHANNEL_ID = -1_002_234_260_754n;

describe('Telegram Desktop explicit complete coverage', () => {
  it('parses canonical bounded ranges and merges overlapping declarations', () => {
    const ranges = [
      parseTelegramDesktopCompleteRange(`${CHANNEL_ID}:1:10`),
      parseTelegramDesktopCompleteRange(`${CHANNEL_ID}:8:20`),
      parseTelegramDesktopCompleteRange(`${CHANNEL_ID}:21:25`),
    ];

    expect(validateTelegramDesktopCompleteRanges(ranges, [CHANNEL_ID], true)).toEqual([
      {
        endMessageId: 25n,
        startMessageId: 1n,
        telegramChatId: CHANNEL_ID,
      },
    ]);
  });

  it.each([
    ['-1001:0:2', 'positive-start-id'],
    ['-1001:3:2', 'must not exceed'],
    ['1001:1:2', 'negative-channel-id'],
    ['-01001:1:2', 'negative-channel-id'],
    ['-1001:1', 'negative-channel-id'],
  ])('rejects invalid declaration %s', (value, message) => {
    expect(() => parseTelegramDesktopCompleteRange(value)).toThrow(message);
  });

  it('requires apply mode and a selected channel', () => {
    const range = parseTelegramDesktopCompleteRange(`${CHANNEL_ID}:1:20`);
    expect(() => validateTelegramDesktopCompleteRanges([range], [CHANNEL_ID], false)).toThrow(
      'only be declared for an applied import',
    );
    expect(() => validateTelegramDesktopCompleteRanges([range], [-1_001n], true)).toThrow(
      'must also be selected',
    );
  });
});
