export interface MediaByteRange {
  end: number;
  length: number;
  start: number;
}

export function resolveMediaByteRange(
  header: string | undefined,
  size: number,
): MediaByteRange | 'unsatisfiable' | null {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError('Verified media blob length must be a positive safe integer');
  }
  if (header === undefined) {
    return null;
  }

  const match = /^\s*bytes\s*=\s*(\d*)-(\d*)\s*$/iu.exec(header);
  if (!match || header.includes(',')) {
    return 'unsatisfiable';
  }
  const [, startText = '', endText = ''] = match;
  if (startText.length === 0 && endText.length === 0) {
    return 'unsatisfiable';
  }

  const verifiedSize = BigInt(size);
  if (startText.length === 0) {
    const suffixLength = parseBound(endText);
    if (suffixLength === null || suffixLength <= 0n) {
      return 'unsatisfiable';
    }
    const start = suffixLength >= verifiedSize ? 0n : verifiedSize - suffixLength;
    return byteRange(start, verifiedSize - 1n);
  }

  const start = parseBound(startText);
  if (start === null || start >= verifiedSize) {
    return 'unsatisfiable';
  }
  if (endText.length === 0) {
    return byteRange(start, verifiedSize - 1n);
  }

  const requestedEnd = parseBound(endText);
  if (requestedEnd === null || requestedEnd < start) {
    return 'unsatisfiable';
  }
  const end = requestedEnd >= verifiedSize ? verifiedSize - 1n : requestedEnd;
  return byteRange(start, end);
}

function parseBound(value: string): bigint | null {
  if (value.length === 0 || value.length > 16) {
    return null;
  }
  return BigInt(value);
}

function byteRange(start: bigint, end: bigint): MediaByteRange {
  const numericStart = Number(start);
  const numericEnd = Number(end);
  return {
    end: numericEnd,
    length: numericEnd - numericStart + 1,
    start: numericStart,
  };
}
