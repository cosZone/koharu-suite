import { describe, expect, it } from 'vitest';
import {
  decodeMessageCursor,
  encodeMessageCursor,
  InvalidCursorError,
  type MessageCursor,
} from '../src/http/cursor.js';

const CHANNEL_ID = '70fb9e5c-b6e4-4c53-964b-dfb322b5a3b7';
const MESSAGE_ID = '62868425-7dbd-44fe-9792-e1875199a026';
const CURSOR: MessageCursor = {
  channelId: CHANNEL_ID,
  messageId: MESSAGE_ID,
  publishedAt: '2026-07-24T00:00:00.000Z',
};

function encodedJson(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url');
}

describe('message cursor', () => {
  it('round-trips a canonical v1 base64url payload', () => {
    const encoded = encodeMessageCursor(CURSOR);

    expect(encoded).not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(
      `{"v":1,"publishedAt":"2026-07-24T00:00:00.000Z","channelId":"${CHANNEL_ID}","messageId":"${MESSAGE_ID}"}`,
    );
    expect(decodeMessageCursor(encoded)).toEqual(CURSOR);
  });

  it('binds a cursor to the requested channel', () => {
    const encoded = encodeMessageCursor(CURSOR);

    expect(decodeMessageCursor(encoded, { channelId: CHANNEL_ID })).toEqual(CURSOR);
    expect(decodeMessageCursor(encoded, { channelId: CHANNEL_ID.toUpperCase() })).toEqual(CURSOR);
    expect(() =>
      decodeMessageCursor(encoded, {
        channelId: 'c78e9147-480f-4e63-941c-eefac29534d0',
      }),
    ).toThrow(InvalidCursorError);
  });

  it.each([
    '',
    'not+base64',
    `${encodeMessageCursor(CURSOR)}=`,
    encodedJson('not JSON'),
    encodedJson('{}'),
    encodedJson(
      `{"v":2,"publishedAt":"${CURSOR.publishedAt}","channelId":"${CHANNEL_ID}","messageId":"${MESSAGE_ID}"}`,
    ),
    encodedJson(
      `{"v":1,"publishedAt":"${CURSOR.publishedAt}","channelId":"${CHANNEL_ID}","messageId":"${MESSAGE_ID}","extra":true}`,
    ),
    encodedJson(
      `{"v":1,"publishedAt":"2026-07-24","channelId":"${CHANNEL_ID}","messageId":"${MESSAGE_ID}"}`,
    ),
    encodedJson(
      `{"v":1,"publishedAt":"${CURSOR.publishedAt}","channelId":"not-a-uuid","messageId":"${MESSAGE_ID}"}`,
    ),
  ])('rejects an invalid encoded cursor without leaking decoder details', (encoded) => {
    let failure: unknown;

    try {
      decodeMessageCursor(encoded);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InvalidCursorError);
    expect(failure).toMatchObject({
      code: 'invalid_cursor',
      message: 'Invalid cursor',
      name: 'InvalidCursorError',
    });
  });

  it('rejects non-canonical JSON, key ordering, and UUID casing', () => {
    expect(() =>
      decodeMessageCursor(
        encodedJson(
          `{"channelId":"${CHANNEL_ID}","messageId":"${MESSAGE_ID}","publishedAt":"${CURSOR.publishedAt}","v":1}`,
        ),
      ),
    ).toThrow(InvalidCursorError);
    expect(() =>
      decodeMessageCursor(
        encodedJson(
          `{ "v": 1, "publishedAt": "${CURSOR.publishedAt}", "channelId": "${CHANNEL_ID}", "messageId": "${MESSAGE_ID}" }`,
        ),
      ),
    ).toThrow(InvalidCursorError);
    expect(() =>
      decodeMessageCursor(
        encodedJson(
          `{"v":1,"publishedAt":"${CURSOR.publishedAt}","channelId":"${CHANNEL_ID.toUpperCase()}","messageId":"${MESSAGE_ID}"}`,
        ),
      ),
    ).toThrow(InvalidCursorError);
  });

  it('uses the same strict validation when encoding', () => {
    expect(() =>
      encodeMessageCursor({
        ...CURSOR,
        publishedAt: '2026-07-24T00:00:00Z',
      }),
    ).toThrow(InvalidCursorError);
    expect(() =>
      encodeMessageCursor({
        ...CURSOR,
        messageId: 'not-a-uuid',
      }),
    ).toThrow(InvalidCursorError);
  });
});
