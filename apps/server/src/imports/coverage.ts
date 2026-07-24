const COMPLETE_RANGE = /^(-[1-9]\d*):([1-9]\d*):([1-9]\d*)$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;
export const TELEGRAM_DESKTOP_COMPLETE_RANGE_LIMIT = 100;

export interface TelegramDesktopCompleteRange {
  endMessageId: bigint;
  startMessageId: bigint;
  telegramChatId: bigint;
}

export function parseTelegramDesktopCompleteRange(value: string): TelegramDesktopCompleteRange {
  const match = COMPLETE_RANGE.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new TypeError(
      'Complete range must use <negative-channel-id>:<positive-start-id>:<positive-end-id>',
    );
  }
  const telegramChatId = BigInt(match[1]);
  const startMessageId = BigInt(match[2]);
  const endMessageId = BigInt(match[3]);
  if (
    telegramChatId < POSTGRES_BIGINT_MIN ||
    startMessageId > POSTGRES_BIGINT_MAX ||
    endMessageId > POSTGRES_BIGINT_MAX
  ) {
    throw new RangeError('Complete range is outside the PostgreSQL bigint range');
  }
  if (startMessageId > endMessageId) {
    throw new RangeError('Complete range start message ID must not exceed its end message ID');
  }
  return { endMessageId, startMessageId, telegramChatId };
}

export function validateTelegramDesktopCompleteRanges(
  ranges: readonly TelegramDesktopCompleteRange[],
  selectedChannelIds: readonly bigint[],
  apply: boolean,
): TelegramDesktopCompleteRange[] {
  if (ranges.length > TELEGRAM_DESKTOP_COMPLETE_RANGE_LIMIT) {
    throw new RangeError(
      `At most ${TELEGRAM_DESKTOP_COMPLETE_RANGE_LIMIT} complete ranges may be declared`,
    );
  }
  if (!apply && ranges.length > 0) {
    throw new TypeError('Complete ranges may only be declared for an applied import');
  }
  const selected = new Set(selectedChannelIds);
  const unique = new Map<string, TelegramDesktopCompleteRange>();
  for (const range of ranges) {
    if (
      range.telegramChatId >= 0n ||
      range.telegramChatId < POSTGRES_BIGINT_MIN ||
      range.startMessageId <= 0n ||
      range.endMessageId < range.startMessageId ||
      range.endMessageId > POSTGRES_BIGINT_MAX
    ) {
      throw new RangeError('Complete range contains an invalid channel or message bound');
    }
    if (!selected.has(range.telegramChatId)) {
      throw new TypeError('Every complete range channel must also be selected with --channel');
    }
    unique.set(
      [
        range.telegramChatId.toString(),
        range.startMessageId.toString(),
        range.endMessageId.toString(),
      ].join(':'),
      range,
    );
  }
  const sorted = [...unique.values()].sort((left, right) => {
    if (left.telegramChatId !== right.telegramChatId) {
      return left.telegramChatId < right.telegramChatId ? -1 : 1;
    }
    if (left.startMessageId !== right.startMessageId) {
      return left.startMessageId < right.startMessageId ? -1 : 1;
    }
    return left.endMessageId < right.endMessageId
      ? -1
      : left.endMessageId > right.endMessageId
        ? 1
        : 0;
  });
  const merged: TelegramDesktopCompleteRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous?.telegramChatId === range.telegramChatId &&
      range.startMessageId <= previous.endMessageId + 1n
    ) {
      if (range.endMessageId > previous.endMessageId) {
        previous.endMessageId = range.endMessageId;
      }
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}
