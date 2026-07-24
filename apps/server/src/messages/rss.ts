import { createHash } from 'node:crypto';
import type { PublicChannel, PublicMessage } from './types.js';

const XML_REPLACEMENT = '\uFFFD';
const EMPTY_LAST_MODIFIED = 'Thu, 01 Jan 1970 00:00:00 GMT';

export interface MessageFeed {
  channel: (PublicChannel & { updatedAt: string }) | null;
  items: PublicMessage[];
  updatedAt: string | null;
}

export interface RssDocument {
  body: string;
  byteLength: number;
  etag: string;
  lastModified: string;
}

export interface BuildRssDocumentOptions {
  canonicalOrigin: string;
  feed: MessageFeed;
  selfPath: string;
}

export function sanitizeXmlText(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      result += character;
    } else {
      result += XML_REPLACEMENT;
    }
  }
  return result;
}

export function escapeXml(value: string): string {
  return sanitizeXmlText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function absoluteUrl(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

function itemTitle(message: PublicMessage): string {
  const text = message.content.text?.trim();
  if (!text) {
    return `Media post from ${message.channel.title}`;
  }
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? text;
  const points = Array.from(firstLine);
  return points.length <= 80 ? firstLine : `${points.slice(0, 79).join('')}…`;
}

function itemDescription(message: PublicMessage): string {
  return message.content.html ?? message.content.text ?? `Media post from ${message.channel.title}`;
}

function itemLink(message: PublicMessage, canonicalOrigin: string): string {
  return (
    message.sourceUrl ??
    absoluteUrl(canonicalOrigin, `/api/v1/messages/${encodeURIComponent(message.id)}`)
  );
}

function rfc822(value: string): string {
  return new Date(value).toUTCString();
}

export function buildRssDocument(options: BuildRssDocumentOptions): RssDocument {
  const origin = new URL(options.canonicalOrigin).origin;
  const selfUrl = absoluteUrl(origin, options.selfPath);
  const channelTitle = options.feed.channel
    ? `${options.feed.channel.title} — Koharu Suite Archive`
    : 'Koharu Suite Archive';
  const channelLink = options.feed.channel?.username
    ? `https://t.me/${options.feed.channel.username}`
    : absoluteUrl(origin, '/api/v1/channels');
  const channelDescription = options.feed.channel
    ? `Latest public messages archived from ${options.feed.channel.title}.`
    : 'Latest public messages archived by Koharu Suite.';
  const items = options.feed.items
    .map((message) => {
      const link = itemLink(message, origin);
      return [
        '    <item>',
        `      <title>${escapeXml(itemTitle(message))}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="false">urn:uuid:${escapeXml(message.id)}</guid>`,
        `      <pubDate>${escapeXml(rfc822(message.publishedAt))}</pubDate>`,
        `      <description>${escapeXml(itemDescription(message))}</description>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(channelLink)}</link>`,
    `    <description>${escapeXml(channelDescription)}</description>`,
    `    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>`,
    ...(options.feed.updatedAt
      ? [`    <lastBuildDate>${escapeXml(rfc822(options.feed.updatedAt))}</lastBuildDate>`]
      : []),
    '    <ttl>5</ttl>',
    ...(items ? [items] : []),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
  const bytes = Buffer.byteLength(body, 'utf8');
  const etag = `"${createHash('sha256').update(body, 'utf8').digest('hex')}"`;
  return {
    body,
    byteLength: bytes,
    etag,
    lastModified: options.feed.updatedAt
      ? new Date(options.feed.updatedAt).toUTCString()
      : EMPTY_LAST_MODIFIED,
  };
}
