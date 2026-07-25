import { describe, expect, it } from 'vitest';
import {
  apiErrorResponseSchema,
  channelListResponseSchema,
  messagePageSchema,
  publicMessageSchema,
  searchMessagePageSchema,
} from '../src/schemas.js';
import { channel, message } from './fixtures.js';

describe('public response schemas', () => {
  it('parses the complete public message contract without narrowing open entity types', () => {
    const parsed = publicMessageSchema.parse(message);

    expect(parsed).toEqual(message);
    expect(parsed.content.entities[0]?.type).toBe('future_entity');
    expect(parsed.media[0]?.fileSize).toBe('9007199254740993');
  });

  it('accepts additive fields while retaining the known contract', () => {
    const parsed = publicMessageSchema.parse({
      ...message,
      futureMessageField: true,
      content: { ...message.content, futureContentField: 'value' },
    });

    expect(parsed.futureMessageField).toBe(true);
    expect(parsed.content.futureContentField).toBe('value');
  });

  it.each([
    { input: { ...message, id: undefined }, name: 'missing message id' },
    {
      input: { ...message, publishedAt: '2026-07-24T00:00:00+00:00' },
      name: 'noncanonical timestamp',
    },
    {
      input: { ...message, media: [{ ...message.media[0], fileSize: 42 }] },
      name: 'numeric file size',
    },
    {
      input: {
        ...message,
        media: [{ ...message.media[0], originalUrl: 'https://suite.example/media' }],
      },
      name: 'absolute media URL',
    },
  ])('rejects $name', ({ input }) => {
    expect(publicMessageSchema.safeParse(input).success).toBe(false);
  });

  it('parses channel, message page, and search page envelopes', () => {
    expect(channelListResponseSchema.parse({ items: [channel] })).toEqual({ items: [channel] });
    expect(messagePageSchema.parse({ items: [message], nextCursor: 'opaque' })).toMatchObject({
      nextCursor: 'opaque',
    });
    expect(
      searchMessagePageSchema.parse({
        items: [{ match: { score: 0.75, snippet: 'Koharu' }, message }],
        mode: 'trigram',
        nextCursor: null,
      }),
    ).toMatchObject({ mode: 'trigram', nextCursor: null });
  });

  it('keeps API error codes open for forward-compatible server additions', () => {
    expect(
      apiErrorResponseSchema.parse({
        error: { code: 'future_server_code', message: 'Safe server message' },
      }).error.code,
    ).toBe('future_server_code');
  });

  it('rejects missing and mistyped required fields', () => {
    expect(channelListResponseSchema.safeParse({}).success).toBe(false);
    expect(messagePageSchema.safeParse({ items: [], nextCursor: 42 }).success).toBe(false);
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: '', message: 'empty code' } }).success,
    ).toBe(false);
  });
});
