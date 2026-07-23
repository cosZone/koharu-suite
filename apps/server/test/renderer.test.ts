import { describe, expect, it } from 'vitest';
import { CURRENT_RENDERER_VERSION, renderTelegramMessage } from '../src/messages/renderer.js';

describe('Telegram entity renderer', () => {
  it('exports a positive renderer version and escapes plain text', () => {
    expect(CURRENT_RENDERER_VERSION).toBe(1);
    expect(renderTelegramMessage(`<Koharu> & "friends'`, [])).toBe(
      '&lt;Koharu&gt; &amp; &quot;friends&#39;',
    );
  });

  it('renders nested and adjacent entities in deterministic order', () => {
    const text = 'bold inner next';
    const entities = [
      { type: 'italic', offset: 5, length: 5 },
      { type: 'bold', offset: 0, length: 10 },
      { type: 'underline', offset: 10, length: 5 },
      { type: 'strikethrough', offset: 0, length: 10 },
    ];

    expect(renderTelegramMessage(text, entities)).toBe(
      '<strong><s>bold <em>inner</em></s></strong><u> next</u>',
    );
    expect(renderTelegramMessage(text, [...entities].reverse())).toBe(
      '<strong><s>bold <em>inner</em></s></strong><u> next</u>',
    );
  });

  it('uses Telegram UTF-16 offsets and rejects split surrogate ranges', () => {
    const text = 'A😀B';

    expect(
      renderTelegramMessage(text, [
        { type: 'bold', offset: 1, length: 2 },
        { type: 'italic', offset: 2, length: 1 },
      ]),
    ).toBe('A<strong>😀</strong>B');
  });

  it('degrades invalid, crossing, custom emoji, and unknown entities to visible text', () => {
    expect(
      renderTelegramMessage('abcdef <x>', [
        { type: 'bold', offset: 0, length: 4 },
        { type: 'italic', offset: 2, length: 4 },
        { type: 'underline', offset: -1, length: 2 },
        { type: 'custom_emoji', offset: 7, length: 3, customEmojiId: 'emoji-1' },
        { type: 'future_entity', offset: 0, length: 6 },
      ]),
    ).toBe('abcdef &lt;x&gt;');
  });

  it('renders safe links with escaped attributes and rejects unsafe schemes', () => {
    expect(
      renderTelegramMessage('safe unsafe', [
        {
          type: 'text_link',
          offset: 0,
          length: 4,
          url: 'https://example.com/?a=1&label="koharu"',
        },
        { type: 'text_link', offset: 5, length: 6, url: 'javascript:alert(1)' },
      ]),
    ).toBe(
      '<a href="https://example.com/?a=1&amp;label=&quot;koharu&quot;" rel="nofollow noopener noreferrer">safe</a> unsafe',
    );
  });

  it('creates restricted links from visible URLs, email addresses, and phone numbers', () => {
    const text = 'https://example.com a@b.dev +86 123-456';

    expect(
      renderTelegramMessage(text, [
        { type: 'url', offset: 0, length: 19 },
        { type: 'email', offset: 20, length: 7 },
        { type: 'phone_number', offset: 28, length: 11 },
      ]),
    ).toBe(
      '<a href="https://example.com" rel="nofollow noopener noreferrer">https://example.com</a> ' +
        '<a href="mailto:a@b.dev" rel="nofollow noopener noreferrer">a@b.dev</a> ' +
        '<a href="tg://resolve?phone=%2B86123456" rel="nofollow noopener noreferrer">+86 123-456</a>',
    );
  });

  it('renders code, pre language classes, blockquotes, and spoilers from fixed tags', () => {
    expect(
      renderTelegramMessage('x<y\nsecret\nmore', [
        { type: 'pre', offset: 0, length: 3, language: 'ts' },
        { type: 'spoiler', offset: 4, length: 6 },
        { type: 'blockquote', offset: 11, length: 4 },
      ]),
    ).toBe(
      '<pre><code class="language-ts">x&lt;y</code></pre>\n' +
        '<span class="tg-spoiler">secret</span>\n' +
        '<blockquote>more</blockquote>',
    );

    expect(
      renderTelegramMessage('expand unsafe', [
        { type: 'expandable_blockquote', offset: 0, length: 6 },
        { type: 'pre', offset: 7, length: 6, language: 'ts" onclick="alert(1)' },
      ]),
    ).toBe(
      '<blockquote class="tg-expandable-blockquote">expand</blockquote> ' +
        '<pre><code>unsafe</code></pre>',
    );
  });
});
