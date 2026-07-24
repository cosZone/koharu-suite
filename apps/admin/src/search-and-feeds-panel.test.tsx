import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SearchAndFeedsPanel, SearchResults, shortQueryGuard } from './SearchAndFeedsPanel';

const channel = {
  id: '10000000-0000-4000-8000-000000000001',
  title: 'cos test dev channel backup',
  username: null,
};

describe('SearchAndFeedsPanel', () => {
  it('renders independent discovery controls and global/per-channel RSS links', () => {
    const markup = renderToStaticMarkup(<SearchAndFeedsPanel channels={[channel]} />);

    expect(markup).toContain('aria-labelledby="search-and-feeds-title"');
    expect(markup).toContain('name="search-query"');
    expect(markup).toContain('name="search-channel"');
    expect(markup).toContain('name="search-from"');
    expect(markup).toContain('name="search-to"');
    expect(markup).toContain('name="search-sort"');
    expect(markup).toContain('href="/api/v1/rss.xml"');
    expect(markup).toContain(`href="/api/v1/channels/${channel.id}/rss.xml"`);
  });

  it('renders snippets as escaped text, optional scores, mode, and pagination', () => {
    const markup = renderToStaticMarkup(
      <SearchResults
        busy={false}
        items={[
          {
            match: {
              score: 0.81234,
              snippet: '<mark>plain text only</mark>',
            },
            message: {
              authorSignature: null,
              channel,
              content: {
                html: '<strong>stored safe html</strong>',
                kind: 'text',
                text: 'plain text only',
              },
              id: '20000000-0000-4000-8000-000000000001',
              media: [],
              publishedAt: '2026-07-24T08:00:00.000Z',
              revision: 1,
              sourceUrl: 'https://t.me/c/123/456',
            },
          },
        ]}
        mode="trigram"
        nextCursor="opaque-next-page"
        onLoadMore={vi.fn()}
        onSelectMessage={vi.fn()}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('pg_trgm 相关度');
    expect(markup).toContain('score 0.812');
    expect(markup).toContain('&lt;mark&gt;plain text only&lt;/mark&gt;');
    expect(markup).not.toContain('<mark>plain text only</mark>');
    expect(markup).toContain('加载更多结果');
    expect(markup).toContain('在消息详情中查看');
  });

  it('guards short queries with the same bounded-scope rules as the server', () => {
    expect(
      shortQueryGuard({
        channel: '',
        from: '',
        q: '春',
        sort: 'relevance',
        to: '',
      }),
    ).toContain('指定一个频道');

    expect(
      shortQueryGuard({
        channel: channel.id,
        from: '2026-07-01T00:00',
        q: '春',
        sort: 'newest',
        to: '2026-07-31T00:00',
      }),
    ).toBeNull();

    expect(
      shortQueryGuard({
        channel: channel.id,
        from: '2026-06-01T00:00',
        q: '春',
        sort: 'newest',
        to: '2026-07-31T00:00',
      }),
    ).toContain('不能超过 31 天');
  });
});
