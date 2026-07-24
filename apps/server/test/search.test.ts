import { describe, expect, it } from 'vitest';
import {
  decodeMessageSearchCursor,
  encodeMessageSearchCursor,
  escapeLikePattern,
  InvalidSearchCursorError,
  type MessageSearchCursor,
  type MessageSearchKey,
  messageSearchQueryHash,
  messageSearchSnippet,
  unicodeLength,
} from '../src/messages/search.js';

const KEY: MessageSearchKey = {
  channelId: null,
  from: null,
  query: 'koharu',
  sort: 'relevance',
  to: null,
};
const CURSOR: MessageSearchCursor = {
  messageId: '62868425-7dbd-44fe-9792-e1875199a026',
  publishedAt: '2026-07-24T00:00:00.000Z',
  queryHash: messageSearchQueryHash(KEY),
  score: 0.75,
  snapshotAt: '2026-07-24T01:00:00.000Z',
};

describe('message search helpers', () => {
  it('counts Unicode code points and escapes literal LIKE metacharacters', () => {
    expect(unicodeLength('爱🌸')).toBe(2);
    expect(escapeLikePattern(String.raw`100%_done\ok`)).toBe(String.raw`100\%\_done\\ok`);
  });

  it('round-trips a canonical cursor and binds it to the complete query key', () => {
    const encoded = encodeMessageSearchCursor(CURSOR);

    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodeMessageSearchCursor(encoded, KEY)).toEqual(CURSOR);
    expect(() => decodeMessageSearchCursor(encoded, { ...KEY, query: 'different' })).toThrow(
      InvalidSearchCursorError,
    );
    expect(() => decodeMessageSearchCursor(encoded, { ...KEY, sort: 'newest' })).toThrow(
      InvalidSearchCursorError,
    );
  });

  it('rejects malformed, non-canonical, and mode-mismatched cursors', () => {
    expect(() => decodeMessageSearchCursor('not+base64', KEY)).toThrow(InvalidSearchCursorError);
    const malformed = Buffer.from(JSON.stringify({ ...CURSOR, v: 1, extra: true })).toString(
      'base64url',
    );
    expect(() => decodeMessageSearchCursor(malformed, KEY)).toThrow(InvalidSearchCursorError);
    expect(() =>
      encodeMessageSearchCursor({
        ...CURSOR,
        score: null,
      }),
    ).not.toThrow();
    const newestCursor = encodeMessageSearchCursor({ ...CURSOR, score: null });
    expect(() => decodeMessageSearchCursor(newestCursor, KEY)).toThrow(InvalidSearchCursorError);
  });

  it('builds a bounded plain-text snippet around the first match', () => {
    const text = `${'前'.repeat(240)}Koharu & <script>${'后'.repeat(240)}`;
    const snippet = messageSearchSnippet(text, 'koharu');

    expect(Array.from(snippet).length).toBeLessThanOrEqual(280);
    expect(snippet).toContain('Koharu & <script>');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });
});
