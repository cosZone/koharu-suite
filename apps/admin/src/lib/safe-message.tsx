import { createElement, Fragment, type ReactNode } from 'react';

const SAFE_MESSAGE_TAGS = new Set([
  'a',
  'blockquote',
  'code',
  'em',
  'pre',
  's',
  'span',
  'strong',
  'u',
]);
const SAFE_MESSAGE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tg:']);
const SAFE_LANGUAGE_CLASS = /^language-[a-zA-Z0-9_+-]{1,64}$/;

function safeMessageHref(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return SAFE_MESSAGE_PROTOCOLS.has(url.protocol.toLowerCase()) ? value : null;
  } catch {
    return null;
  }
}

function safeMessageClass(element: Element): string | undefined {
  const value = element.getAttribute('class');
  if (
    value === 'tg-spoiler' ||
    value === 'tg-expandable-blockquote' ||
    (value !== null && SAFE_LANGUAGE_CLASS.test(value))
  ) {
    return value;
  }
  return undefined;
}

function renderSafeMessageNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  const children = [...element.childNodes].map((child, index) =>
    renderSafeMessageNode(child, `${key}.${index}`),
  );
  if (!SAFE_MESSAGE_TAGS.has(tagName)) {
    return createElement(Fragment, { key }, children);
  }

  const properties: Record<string, unknown> = { key };
  if (tagName === 'a') {
    const href = safeMessageHref(element.getAttribute('href'));
    if (href === null) {
      return createElement(Fragment, { key }, children);
    }
    properties.href = href;
    properties.rel = 'nofollow noopener noreferrer';
  }
  const className = safeMessageClass(element);
  if (className !== undefined) {
    properties.className = className;
  }
  if (className === 'tg-spoiler') {
    properties.tabIndex = 0;
    properties.title = '聚焦或悬停以显示剧透内容';
  }
  return createElement(tagName, properties, children);
}

export function SafeMessageContent({ html, text }: { html: string | null; text: string | null }) {
  if (html === null) {
    return <p>{text || '这条消息没有文字内容。'}</p>;
  }

  const document = new DOMParser().parseFromString(html, 'text/html');
  return (
    <div className="rendered-message">
      {[...document.body.childNodes].map((node, index) =>
        renderSafeMessageNode(node, String(index)),
      )}
    </div>
  );
}
