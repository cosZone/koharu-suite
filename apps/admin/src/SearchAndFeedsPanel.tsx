import { Badge, Button, EmptyState, Input, Kicker } from '@koharu-suite/ui';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

export interface SearchChannel {
  id: string;
  title: string;
  username: string | null;
}

export interface SearchPublicMessage {
  authorSignature: string | null;
  channel: SearchChannel;
  content: {
    html: string | null;
    kind: 'caption' | 'none' | 'text';
    text: string | null;
  };
  id: string;
  media: Array<{ fileName: string | null; kind: string }>;
  publishedAt: string;
  revision: number;
  sourceUrl: string | null;
}

interface SearchMatch {
  score: number | null;
  snippet: string;
}

export interface SearchResult {
  match: SearchMatch;
  message: SearchPublicMessage;
}

interface SearchResponse {
  items: SearchResult[];
  mode: 'short_substring' | 'trigram';
  nextCursor: string | null;
}

interface SearchRequest {
  channel: string;
  from: string;
  q: string;
  sort: 'newest' | 'relevance';
  to: string;
}

interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

interface SearchAndFeedsPanelProps {
  channels: SearchChannel[];
  onSelectMessage?(message: SearchPublicMessage): void;
}

function queryLength(value: string): number {
  return Array.from(value.trim()).length;
}

function toUtcIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function shortQueryGuard(request: SearchRequest): string | null {
  const length = queryLength(request.q);
  if (length === 0 || length > 2) return null;
  if (!request.channel || !request.from || !request.to) {
    return '1–2 字符搜索需要指定一个频道和完整的起止时间。';
  }
  if (request.sort !== 'newest') {
    return '1–2 字符搜索只能按最新时间排序。';
  }

  const from = toUtcIso(request.from);
  const to = toUtcIso(request.to);
  if (!from || !to) {
    return '起止时间无效。';
  }
  const range = new Date(to).getTime() - new Date(from).getTime();
  if (range <= 0) {
    return '结束时间必须晚于开始时间。';
  }
  if (range > 31 * 24 * 60 * 60 * 1_000) {
    return '1–2 字符搜索的时间范围不能超过 31 天。';
  }
  return null;
}

function buildSearchUrl(request: SearchRequest, cursor?: string): string {
  const search = new URLSearchParams({
    limit: '20',
    q: request.q.trim(),
    sort: request.sort,
  });
  if (request.channel) search.set('channel', request.channel);
  const from = toUtcIso(request.from);
  const to = toUtcIso(request.to);
  if (from) search.set('from', from);
  if (to) search.set('to', to);
  if (cursor) search.set('cursor', cursor);
  return `/api/v1/search/messages?${search.toString()}`;
}

async function fetchSearch(request: SearchRequest, signal: AbortSignal, cursor?: string) {
  const response = await fetch(buildSearchUrl(request, cursor), {
    cache: 'no-store',
    signal,
  });
  const body = (await response.json()) as SearchResponse | ApiError;
  if (!response.ok) {
    const message = 'error' in body ? body.error.message : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body as SearchResponse;
}

function formatSearchDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function SearchField({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <label className="search-field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SearchResults({
  busy,
  items,
  mode,
  nextCursor,
  onLoadMore,
  onSelectMessage,
}: {
  busy: boolean;
  items: SearchResult[];
  mode: SearchResponse['mode'] | null;
  nextCursor: string | null;
  onLoadMore(): void;
  onSelectMessage: ((message: SearchPublicMessage) => void) | undefined;
}) {
  return (
    <>
      {mode ? (
        <div className="search-results__summary" role="status">
          <span>{mode === 'trigram' ? 'pg_trgm 相关度' : '短子串受限模式'}</span>
          <strong>{items.length} 条已加载</strong>
        </div>
      ) : null}

      <div className="search-results">
        {items.map(({ match, message }) => (
          <article className="search-result-card" key={message.id}>
            <header>
              <div>
                <strong>{message.channel.title}</strong>
                <time dateTime={message.publishedAt}>{formatSearchDate(message.publishedAt)}</time>
              </div>
              {match.score !== null ? (
                <span className="search-score">
                  score {Number.isFinite(match.score) ? match.score.toFixed(3) : '—'}
                </span>
              ) : null}
            </header>
            <p className="search-snippet">{match.snippet}</p>
            <footer>
              {onSelectMessage ? (
                <button
                  className="text-button"
                  onClick={() => onSelectMessage(message)}
                  type="button"
                >
                  在消息详情中查看
                </button>
              ) : null}
              {message.sourceUrl ? (
                <a href={message.sourceUrl} rel="noreferrer" target="_blank">
                  Telegram 原消息 ↗
                </a>
              ) : null}
            </footer>
          </article>
        ))}
        {mode && items.length === 0 ? <EmptyState>没有找到符合条件的公开消息。</EmptyState> : null}
        {nextCursor ? (
          <Button disabled={busy} onClick={onLoadMore} type="button" variant="quiet">
            {busy ? '正在加载…' : '加载更多结果'}
          </Button>
        ) : null}
      </div>
    </>
  );
}

export function SearchAndFeedsPanel({ channels, onSelectMessage }: SearchAndFeedsPanelProps) {
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<'newest' | 'relevance'>('relevance');
  const [activeRequest, setActiveRequest] = useState<SearchRequest | null>(null);
  const [items, setItems] = useState<SearchResult[]>([]);
  const [mode, setMode] = useState<SearchResponse['mode'] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const draftRequest = useMemo(
    () => ({ channel, from, q: query, sort, to }),
    [channel, from, query, sort, to],
  );
  const shortGuard = shortQueryGuard(draftRequest);
  const trimmedLength = queryLength(query);
  const invalidLength = trimmedLength === 0 || trimmedLength > 200;

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  async function runSearch(request: SearchRequest, cursor?: string) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    if (!cursor) {
      setItems([]);
      setMode(null);
      setNextCursor(null);
    }
    try {
      const result = await fetchSearch(request, controller.signal, cursor);
      if (controllerRef.current !== controller) return;
      if (cursor) {
        setItems((current) => [...current, ...result.items]);
      } else {
        setItems(result.items);
        setActiveRequest(request);
      }
      setMode(result.mode);
      setNextCursor(result.nextCursor);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(reason instanceof Error ? reason.message : '搜索失败');
    } finally {
      if (controllerRef.current === controller) {
        setBusy(false);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalidLength || shortGuard) return;
    void runSearch(draftRequest);
  }

  function loadMore() {
    if (!activeRequest || !nextCursor || busy) return;
    void runSearch(activeRequest, nextCursor);
  }

  return (
    <section className="search-and-feeds" aria-labelledby="search-and-feeds-title">
      <div className="search-and-feeds__heading">
        <div>
          <Kicker>DISCOVERY</Kicker>
          <h2 id="search-and-feeds-title">搜索与订阅</h2>
          <p>搜索只读取公开的当前修订；RSS 提供全局和每频道各自的最新归档。</p>
        </div>
        {mode ? (
          <Badge tone={mode === 'trigram' ? 'success' : 'neutral'}>
            {mode === 'trigram' ? 'TRIGRAM' : 'SHORT'}
          </Badge>
        ) : null}
      </div>

      <form className="search-form" onSubmit={submit}>
        <SearchField htmlFor="search-query" label="搜索文字">
          <Input
            id="search-query"
            name="search-query"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入文章正文中的文字"
            value={query}
          />
        </SearchField>
        <SearchField htmlFor="search-channel" label="频道">
          <select
            id="search-channel"
            name="search-channel"
            onChange={(event) => setChannel(event.target.value)}
            value={channel}
          >
            <option value="">全部频道</option>
            {channels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </SearchField>
        <SearchField htmlFor="search-from" label="开始时间">
          <input
            id="search-from"
            name="search-from"
            onChange={(event) => setFrom(event.target.value)}
            type="datetime-local"
            value={from}
          />
        </SearchField>
        <SearchField htmlFor="search-to" label="结束时间">
          <input
            id="search-to"
            name="search-to"
            onChange={(event) => setTo(event.target.value)}
            type="datetime-local"
            value={to}
          />
        </SearchField>
        <SearchField htmlFor="search-sort" label="排序">
          <select
            id="search-sort"
            name="search-sort"
            onChange={(event) => setSort(event.target.value as 'newest' | 'relevance')}
            value={sort}
          >
            <option value="relevance">相关度</option>
            <option value="newest">最新时间</option>
          </select>
        </SearchField>
        <Button disabled={busy || invalidLength || shortGuard !== null} type="submit">
          {busy && !nextCursor ? '正在搜索…' : '搜索归档'}
        </Button>
      </form>

      {trimmedLength > 0 && trimmedLength <= 2 ? (
        <p className={`search-hint ${shortGuard ? 'is-warning' : ''}`}>
          短查询会使用受限子串模式：单一频道、最长 31 天、按最新排序且最多 20 条。
          {shortGuard ? ` ${shortGuard}` : ''}
        </p>
      ) : null}
      {trimmedLength > 200 ? (
        <p className="search-hint is-warning">搜索文字最多 200 个 Unicode 字符。</p>
      ) : null}
      {error ? (
        <p className="search-error" role="alert">
          {error}
        </p>
      ) : null}

      <SearchResults
        busy={busy}
        items={items}
        mode={mode}
        nextCursor={nextCursor}
        onLoadMore={loadMore}
        onSelectMessage={onSelectMessage}
      />

      <section className="feed-shelf" aria-labelledby="feed-shelf-title">
        <div>
          <Kicker>RSS 2.0</Kicker>
          <h3 id="feed-shelf-title">订阅出口</h3>
          <p>每个 Feed 最多返回 50 条当前可见消息。</p>
        </div>
        <div className="feed-shelf__links">
          <a href="/api/v1/rss.xml" rel="noreferrer" target="_blank">
            <strong>全局归档</strong>
            <span>/api/v1/rss.xml ↗</span>
          </a>
          {channels.map((item) => (
            <a
              href={`/api/v1/channels/${encodeURIComponent(item.id)}/rss.xml`}
              key={item.id}
              rel="noreferrer"
              target="_blank"
            >
              <strong>{item.title}</strong>
              <span>{item.username ? `@${item.username}` : '频道 Feed'} ↗</span>
            </a>
          ))}
        </div>
      </section>
    </section>
  );
}
