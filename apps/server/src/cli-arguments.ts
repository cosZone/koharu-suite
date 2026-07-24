const NEGATIVE_INTEGER_OPTIONS = new Set(['--channel', '--telegram-id']);
const NEGATIVE_INTEGER = /^-\d+$/u;
const NEGATIVE_COMPLETE_RANGE = /^-\d+:\d+:\d+$/u;

export function normalizeCliArguments(args: readonly string[]): string[] {
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (
      argument !== undefined &&
      value !== undefined &&
      ((NEGATIVE_INTEGER_OPTIONS.has(argument) && NEGATIVE_INTEGER.test(value)) ||
        (argument === '--complete-range' && NEGATIVE_COMPLETE_RANGE.test(value)))
    ) {
      normalized.push(`${argument}=${value}`);
      index += 1;
      continue;
    }
    if (argument !== undefined) {
      normalized.push(argument);
    }
  }

  return normalized;
}
