import { describe, expect, it } from 'vitest';
import { buildRssDocument, escapeXml, sanitizeXmlText } from '../src/messages/rss.js';
import type { PublicMessage } from '../src/messages/types.js';

const message: PublicMessage = {
  authorSignature: null,
  channel: {
    id: '019bf894-2b6c-7b18-bd70-0ad6349a4af1',
    title: 'Koharu & Friends',
    username: null,
  },
  content: {
    entities: [],
    html: '<p>Safe &amp; lovely</p>',
    kind: 'text',
    text: 'Safe & lovely',
  },
  id: '019bf895-0e70-7881-83b3-471b8dbb1b33',
  media: [],
  mediaGroupId: null,
  publishedAt: '2026-07-24T00:00:00.000Z',
  revision: 1,
  sourceUrl: null,
};

describe('RSS 2.0 serializer', () => {
  it('sanitizes XML 1.0-invalid input and escapes every dynamic field', () => {
    expect(sanitizeXmlText(`ok\u0000\uD800end`)).toBe('ok��end');
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');

    const document = buildRssDocument({
      canonicalOrigin: 'https://suite.example',
      feed: {
        channel: null,
        items: [message],
        updatedAt: '2026-07-24T01:00:00.000Z',
      },
      selfPath: '/api/v1/rss.xml',
    });

    expect(document.body).toContain(
      '<atom:link href="https://suite.example/api/v1/rss.xml" rel="self"',
    );
    expect(document.body).toContain(
      '<link>https://suite.example/api/v1/messages/019bf895-0e70-7881-83b3-471b8dbb1b33</link>',
    );
    expect(document.body).toContain(
      '<description>&lt;p&gt;Safe &amp;amp; lovely&lt;/p&gt;</description>',
    );
    expect(document.body).not.toContain('<description><p>');
    expect(document.body).not.toContain('<enclosure');
    expect(document.byteLength).toBe(Buffer.byteLength(document.body, 'utf8'));
    expect(document.etag).toMatch(/^"[0-9a-f]{64}"$/u);
  });

  it('is byte-for-byte deterministic and uses a stable empty-feed timestamp', () => {
    const input = {
      canonicalOrigin: 'https://suite.example',
      feed: { channel: null, items: [], updatedAt: null },
      selfPath: '/api/v1/rss.xml',
    };

    expect(buildRssDocument(input)).toEqual(buildRssDocument(input));
    expect(buildRssDocument(input).lastModified).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
  });
});
