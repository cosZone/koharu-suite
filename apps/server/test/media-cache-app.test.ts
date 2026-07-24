import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { OpenedPublicMedia, PublicMediaReader } from '../src/media-cache/public-reader.js';

const OBJECT_ID = randomUUID();

function body(value: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    },
  });
}

function reader(variant: 'original' | 'thumbnail' = 'original'): {
  close: ReturnType<typeof vi.fn>;
  media: PublicMediaReader;
  stream: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => undefined);
  const stream = vi.fn((range?: { end: number; start: number }) =>
    body(range ? '3456' : '0123456789'),
  );
  const opened: OpenedPublicMedia = {
    byteLength: 10,
    close,
    contentType: 'image/jpeg',
    etag: `"${'a'.repeat(64)}"`,
    stream,
    variant,
  };
  return {
    close,
    media: {
      open: vi.fn(async (id) => (id === OBJECT_ID ? opened : null)),
    },
    stream,
  };
}

describe('public media API', () => {
  it('streams an opaque original with immutable and security headers', async () => {
    const fixture = reader();

    const response = await createApp({ media: fixture.media }).request(
      `/api/v1/media/${OBJECT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('ETag')).toBe(`"${'a'.repeat(64)}"`);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.text()).resolves.toBe('0123456789');
  });

  it('serves one original byte range and rejects multiple or unsatisfiable ranges', async () => {
    const partialFixture = reader();
    const partial = await createApp({ media: partialFixture.media }).request(
      `/api/v1/media/${OBJECT_ID}`,
      { headers: { Range: 'bytes=3-6' } },
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 3-6/10');
    expect(partial.headers.get('Content-Length')).toBe('4');
    await expect(partial.text()).resolves.toBe('3456');
    expect(partialFixture.stream).toHaveBeenCalledWith({
      end: 6,
      length: 4,
      start: 3,
    });

    for (const range of ['bytes=20-', 'bytes=0-1,3-4']) {
      const invalidFixture = reader();
      const invalid = await createApp({ media: invalidFixture.media }).request(
        `/api/v1/media/${OBJECT_ID}`,
        { headers: { Range: range } },
      );
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get('Content-Range')).toBe('bytes */10');
      expect(invalid.headers.get('Cache-Control')).toBe('private, no-store');
      expect(invalidFixture.close).toHaveBeenCalledOnce();
      expect(invalidFixture.stream).not.toHaveBeenCalled();
    }
  });

  it('ignores Range for a mismatched If-Range and for thumbnails', async () => {
    for (const [variant, headers] of [
      ['original', { 'If-Range': '"stale"', Range: 'bytes=3-6' }],
      ['thumbnail', { Range: 'bytes=3-6' }],
    ] as const) {
      const fixture = reader(variant);
      const response = await createApp({ media: fixture.media }).request(
        `/api/v1/media/${OBJECT_ID}`,
        { headers },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(response.headers.get('Accept-Ranges')).toBe(variant === 'original' ? 'bytes' : null);
      await expect(response.text()).resolves.toBe('0123456789');
    }
  });

  it('handles HEAD without starting a file stream and keeps ordinary 404 fallback', async () => {
    const fixture = reader();
    const head = await createApp({ media: fixture.media }).request(`/api/v1/media/${OBJECT_ID}`, {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('10');
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.stream).not.toHaveBeenCalled();

    const missing = await createApp({ media: fixture.media }).request(
      `/api/v1/media/${randomUUID()}`,
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'media_not_found' },
    });
  });

  it('varies every public response by Origin when a CORS allowlist is configured', async () => {
    const fixture = reader();
    const app = createApp({
      media: fixture.media,
      publicApi: {
        corsOrigins: new Set(['https://blog.example.com']),
        rateLimitMax: 10,
        rateLimitWindowMs: 60_000,
        trustProxy: false,
      },
      publicClientAddress: () => '203.0.113.20',
    });

    const noOrigin = await app.request(`/api/v1/media/${OBJECT_ID}`, { method: 'HEAD' });
    expect(noOrigin.headers.get('Vary')).toBe('Origin');
    expect(noOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const allowed = await app.request(`/api/v1/media/${OBJECT_ID}`, {
      headers: { Origin: 'https://blog.example.com' },
      method: 'HEAD',
    });
    expect(allowed.headers.get('Vary')).toBe('Origin');
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://blog.example.com');
    expect(allowed.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
  });
});
