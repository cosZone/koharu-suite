import { suiteIdSchema } from './schemas.js';

export function canonicalSuiteOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('baseUrl must be a canonical HTTP(S) origin');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.origin !== value
  ) {
    throw new TypeError('baseUrl must be a canonical HTTP(S) origin');
  }
  return url.origin;
}

export function resolveSuiteUrl(baseUrl: string, path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  const origin = canonicalSuiteOrigin(baseUrl);
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('Suite URL must be an origin-relative path');
  }
  const resolved = new URL(path, `${origin}/`);
  if (resolved.origin !== origin) {
    throw new TypeError('Suite URL must remain on the configured origin');
  }
  return resolved.toString();
}

export function globalRssUrl(baseUrl: string): string {
  return resolveSuiteUrl(baseUrl, '/api/v1/rss.xml') as string;
}

export function channelRssUrl(baseUrl: string, channelId: string): string {
  const parsed = suiteIdSchema.safeParse(channelId);
  if (!parsed.success) {
    throw new TypeError('channelId must be a suite UUID');
  }
  return resolveSuiteUrl(
    baseUrl,
    `/api/v1/channels/${encodeURIComponent(parsed.data)}/rss.xml`,
  ) as string;
}
