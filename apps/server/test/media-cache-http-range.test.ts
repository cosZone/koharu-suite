import { describe, expect, it } from 'vitest';
import { resolveMediaByteRange } from '../src/media-cache/http-range.js';

describe('resolveMediaByteRange', () => {
  it.each([
    ['bytes=0-3', { end: 3, length: 4, start: 0 }],
    ['bytes=4-', { end: 9, length: 6, start: 4 }],
    ['bytes=-3', { end: 9, length: 3, start: 7 }],
    ['bytes=-99', { end: 9, length: 10, start: 0 }],
    [' bytes = 2-99 ', { end: 9, length: 8, start: 2 }],
  ])('resolves %j against a ten-byte original', (header, expected) => {
    expect(resolveMediaByteRange(header, 10)).toEqual(expected);
  });

  it.each([
    'items=0-1',
    'bytes=',
    'bytes=0-1,3-4',
    'bytes=10-',
    'bytes=9-2',
    'bytes=-0',
    'bytes=--',
    'bytes=1.5-2',
    `bytes=${'9'.repeat(128)}-`,
  ])('rejects invalid, multiple, or unsatisfiable range %j', (header) => {
    expect(resolveMediaByteRange(header, 10)).toBe('unsatisfiable');
  });

  it('returns null when no Range header was supplied', () => {
    expect(resolveMediaByteRange(undefined, 10)).toBeNull();
  });

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid verified blob length %s',
    (size) => {
      expect(() => resolveMediaByteRange('bytes=0-', size)).toThrow(TypeError);
    },
  );
});
