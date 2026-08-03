import {
  ARCHIVE_MANIFEST_JSON_LIMITS,
  BOUNDED_JSON_LIMITS,
  isJsonValueWithinLimits,
  type JsonValue,
} from './schemas.js';

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function serializeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('Canonical JSON does not support non-finite numbers');
    }
    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    throw new CanonicalJsonError(`Canonical JSON does not support ${typeof value} values`);
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError('Canonical JSON does not support cyclic values');
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalJsonError('Canonical JSON does not support sparse arrays');
        }
      }
      return `[${value.map((entry) => serializeValue(entry, ancestors)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('Canonical JSON only supports plain objects');
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError('Canonical JSON does not support symbol keys');
    }

    const entries = Object.entries(value).sort(([left], [right]) => compareKeys(left, right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${serializeValue(entry, ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export interface CanonicalJsonOptions {
  profile?: 'bounded' | 'manifest';
}

export function serializeCanonicalJson(value: JsonValue, options?: CanonicalJsonOptions): string;
export function serializeCanonicalJson(value: unknown, options?: CanonicalJsonOptions): string;
export function serializeCanonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const limits =
    options.profile === 'manifest' ? ARCHIVE_MANIFEST_JSON_LIMITS : BOUNDED_JSON_LIMITS;
  if (!isJsonValueWithinLimits(value, limits)) {
    throw new CanonicalJsonError('Canonical JSON input exceeds the bounded JSON contract');
  }
  return serializeValue(value, new Set());
}

export function canonicalJsonBytes(value: JsonValue, options?: CanonicalJsonOptions): Uint8Array;
export function canonicalJsonBytes(value: unknown, options?: CanonicalJsonOptions): Uint8Array;
export function canonicalJsonBytes(value: unknown, options: CanonicalJsonOptions = {}): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value, options));
}
