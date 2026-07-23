import type { NormalizedMessageEntity } from '../telegram/types.js';

export const CURRENT_RENDERER_VERSION = 1;

const LINK_REL = 'nofollow noopener noreferrer';
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tg:']);
const SAFE_LANGUAGE = /^[a-zA-Z0-9_+-]{1,64}$/;

interface RenderableEntity {
  close: string;
  end: number;
  index: number;
  open: string;
  order: number;
  start: number;
}

const ENTITY_ORDER: Record<string, number> = {
  blockquote: 0,
  expandable_blockquote: 1,
  bold: 2,
  italic: 3,
  underline: 4,
  strikethrough: 5,
  spoiler: 6,
  code: 7,
  pre: 8,
  text_link: 9,
  url: 10,
  email: 11,
  phone_number: 12,
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isSurrogateBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return true;
  }

  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function safeLink(rawHref: string): string | null {
  if (rawHref.length === 0 || rawHref.trim() !== rawHref || hasAsciiControlCharacter(rawHref)) {
    return null;
  }

  try {
    const url = new URL(rawHref);
    return SAFE_LINK_PROTOCOLS.has(url.protocol.toLowerCase()) ? rawHref : null;
  } catch {
    return null;
  }
}

function anchor(href: string): Pick<RenderableEntity, 'open' | 'close'> {
  return {
    open: `<a href="${escapeHtml(href)}" rel="${LINK_REL}">`,
    close: '</a>',
  };
}

function emailLink(visibleText: string): Pick<RenderableEntity, 'open' | 'close'> | null {
  if (visibleText.length === 0 || /\s/u.test(visibleText) || !/^[^@]+@[^@]+$/u.test(visibleText)) {
    return null;
  }

  return anchor(`mailto:${visibleText}`);
}

function phoneLink(visibleText: string): Pick<RenderableEntity, 'open' | 'close'> | null {
  const phone = visibleText.replaceAll(/[\s().-]/g, '');
  if (!/^\+?[0-9]+$/u.test(phone)) {
    return null;
  }

  return anchor(`tg://resolve?phone=${encodeURIComponent(phone)}`);
}

function tagsFor(
  entity: NormalizedMessageEntity,
  visibleText: string,
): Pick<RenderableEntity, 'open' | 'close'> | null {
  switch (entity.type) {
    case 'bold':
      return { open: '<strong>', close: '</strong>' };
    case 'italic':
      return { open: '<em>', close: '</em>' };
    case 'underline':
      return { open: '<u>', close: '</u>' };
    case 'strikethrough':
      return { open: '<s>', close: '</s>' };
    case 'spoiler':
      return { open: '<span class="tg-spoiler">', close: '</span>' };
    case 'blockquote':
      return { open: '<blockquote>', close: '</blockquote>' };
    case 'expandable_blockquote':
      return {
        open: '<blockquote class="tg-expandable-blockquote">',
        close: '</blockquote>',
      };
    case 'code':
      return { open: '<code>', close: '</code>' };
    case 'pre': {
      const languageClass =
        entity.language !== undefined && SAFE_LANGUAGE.test(entity.language)
          ? ` class="language-${escapeHtml(entity.language)}"`
          : '';
      return { open: `<pre><code${languageClass}>`, close: '</code></pre>' };
    }
    case 'text_link': {
      if (entity.url === undefined) {
        return null;
      }
      const href = safeLink(entity.url);
      return href === null ? null : anchor(href);
    }
    case 'url': {
      const href = safeLink(visibleText);
      return href === null ? null : anchor(href);
    }
    case 'email':
      return emailLink(visibleText);
    case 'phone_number':
      return phoneLink(visibleText);
    default:
      return null;
  }
}

function isCrossing(left: RenderableEntity, right: RenderableEntity): boolean {
  return (
    (left.start < right.start && right.start < left.end && left.end < right.end) ||
    (right.start < left.start && left.start < right.end && right.end < left.end)
  );
}

function toRenderableEntity(
  text: string,
  entity: NormalizedMessageEntity,
  index: number,
): RenderableEntity | null {
  if (
    !Number.isInteger(entity.offset) ||
    !Number.isInteger(entity.length) ||
    entity.offset < 0 ||
    entity.length <= 0
  ) {
    return null;
  }

  const end = entity.offset + entity.length;
  if (
    !Number.isSafeInteger(end) ||
    end > text.length ||
    !isSurrogateBoundary(text, entity.offset) ||
    !isSurrogateBoundary(text, end)
  ) {
    return null;
  }

  const tags = tagsFor(entity, text.slice(entity.offset, end));
  if (tags === null) {
    return null;
  }

  return {
    ...tags,
    start: entity.offset,
    end,
    index,
    order: ENTITY_ORDER[entity.type] ?? Number.MAX_SAFE_INTEGER,
  };
}

function compareOpen(left: RenderableEntity, right: RenderableEntity): number {
  return (
    left.start - right.start ||
    right.end - left.end ||
    left.order - right.order ||
    left.index - right.index
  );
}

function compareClose(left: RenderableEntity, right: RenderableEntity): number {
  return (
    left.end - right.end ||
    right.start - left.start ||
    right.order - left.order ||
    right.index - left.index
  );
}

export function renderTelegramMessage(
  text: string,
  entities: readonly NormalizedMessageEntity[],
): string {
  const candidates = entities
    .map((entity, index) => toRenderableEntity(text, entity, index))
    .filter((entity): entity is RenderableEntity => entity !== null);
  const crossing = new Set<RenderableEntity>();

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (right !== undefined && isCrossing(left, right)) {
        crossing.add(left);
        crossing.add(right);
      }
    }
  }

  const rendered = candidates.filter((entity) => !crossing.has(entity));
  const boundaries = new Set([0, text.length]);
  const opening = new Map<number, RenderableEntity[]>();
  const closing = new Map<number, RenderableEntity[]>();

  for (const entity of rendered) {
    boundaries.add(entity.start);
    boundaries.add(entity.end);
    opening.set(entity.start, [...(opening.get(entity.start) ?? []), entity]);
    closing.set(entity.end, [...(closing.get(entity.end) ?? []), entity]);
  }

  const positions = [...boundaries].sort((left, right) => left - right);
  let html = '';
  let previous = 0;

  for (const position of positions) {
    html += escapeHtml(text.slice(previous, position));

    for (const entity of (closing.get(position) ?? []).sort(compareClose)) {
      html += entity.close;
    }
    for (const entity of (opening.get(position) ?? []).sort(compareOpen)) {
      html += entity.open;
    }

    previous = position;
  }

  return html;
}
