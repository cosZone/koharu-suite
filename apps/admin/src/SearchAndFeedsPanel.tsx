import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LaneEmpty } from '@/components/desk/lane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/lib/format';
import type {
  ApiError,
  SearchChannel,
  SearchPublicMessage,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from '@/lib/types';
import { cn } from '@/lib/utils';

export type {
  SearchChannel,
  SearchPublicMessage,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from '@/lib/types';

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

/* 原生 select/datetime-local 控件的统一输入外观(token 色,无阴影) */
const nativeControlClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground outline-none transition-colors [color-scheme:dark] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

function SearchField({
  children,
  className,
  htmlFor,
  label,
}: {
  children: ReactNode;
  className?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/* 原生 <select> + appearance-none + CSS 三角箭头(测试契约要求保留原生 select) */
function NativeSelect({
  children,
  id,
  name,
  onChange,
  value,
}: {
  children: ReactNode;
  id: string;
  name: string;
  onChange(event: ChangeEvent<HTMLSelectElement>): void;
  value: string;
}) {
  return (
    <div className="relative">
      <select
        className={cn(nativeControlClass, 'appearance-none pr-8')}
        id={id}
        name={name}
        onChange={onChange}
        value={value}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 block size-0 -translate-y-1/2 border-x-4 border-t-4 border-x-transparent border-t-muted-foreground"
      />
    </div>
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
    <div className="mt-4">
      {mode ? (
        <div className="flex items-baseline gap-3 text-xs" role="status">
          <span className="text-faint">
            {mode === 'trigram' ? 'pg_trgm 相关度' : '短子串受限模式'}
          </span>
          <strong className="font-medium text-muted-foreground">{items.length} 条已加载</strong>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3">
        {items.map(({ match, message }) => (
          <article className="rounded-lg border bg-inset p-4" key={message.id}>
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-foreground">
                {message.channel.title}
                <span className="ml-2 text-xs font-normal text-faint">
                  <time dateTime={message.publishedAt}>{formatDate(message.publishedAt)}</time>
                </span>
              </p>
              {match.score !== null ? (
                <span className="text-xs text-faint">
                  score {Number.isFinite(match.score) ? match.score.toFixed(3) : '—'}
                </span>
              ) : null}
            </header>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{match.snippet}</p>
            <footer className="mt-3 flex gap-4">
              {onSelectMessage ? (
                <button
                  className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  onClick={() => onSelectMessage(message)}
                  type="button"
                >
                  在消息详情中查看
                </button>
              ) : null}
              {message.sourceUrl ? (
                <a
                  className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  href={message.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Telegram 原消息 ↗
                </a>
              ) : null}
            </footer>
          </article>
        ))}
        {mode && items.length === 0 ? <LaneEmpty>没有找到符合条件的公开消息。</LaneEmpty> : null}
      </div>
      {nextCursor ? (
        <Button
          className="mt-3"
          disabled={busy}
          onClick={onLoadMore}
          type="button"
          variant="outline"
        >
          {busy ? '正在加载…' : '加载更多结果'}
        </Button>
      ) : null}
    </div>
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
    <section aria-labelledby="search-and-feeds-title" className="grid gap-4">
      <div className="rounded-lg border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="font-serif text-lg font-semibold" id="search-and-feeds-title">
              搜索与订阅
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              搜索只读取公开的当前修订；RSS 提供全局和每频道各自的最新归档。
            </p>
          </div>
          {mode ? (
            <Badge variant="outline">{mode === 'trigram' ? 'TRIGRAM' : 'SHORT'}</Badge>
          ) : null}
        </div>

        <div className="px-4 py-4">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={submit}>
            <SearchField className="md:col-span-2" htmlFor="search-query" label="搜索文字">
              <Input
                id="search-query"
                name="search-query"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入文章正文中的文字"
                value={query}
              />
            </SearchField>
            <SearchField htmlFor="search-channel" label="频道">
              <NativeSelect
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
              </NativeSelect>
            </SearchField>
            <SearchField htmlFor="search-sort" label="排序">
              <NativeSelect
                id="search-sort"
                name="search-sort"
                onChange={(event) => setSort(event.target.value as 'newest' | 'relevance')}
                value={sort}
              >
                <option value="relevance">相关度</option>
                <option value="newest">最新时间</option>
              </NativeSelect>
            </SearchField>
            <SearchField htmlFor="search-from" label="开始时间">
              <input
                className={nativeControlClass}
                id="search-from"
                name="search-from"
                onChange={(event) => setFrom(event.target.value)}
                type="datetime-local"
                value={from}
              />
            </SearchField>
            <SearchField htmlFor="search-to" label="结束时间">
              <input
                className={nativeControlClass}
                id="search-to"
                name="search-to"
                onChange={(event) => setTo(event.target.value)}
                type="datetime-local"
                value={to}
              />
            </SearchField>
            <div className="flex md:col-span-2 md:justify-end">
              <Button
                disabled={busy || invalidLength || shortGuard !== null}
                type="submit"
                variant="outline"
              >
                {busy && !nextCursor ? '正在搜索…' : '搜索归档'}
              </Button>
            </div>
          </form>

          {trimmedLength > 0 && trimmedLength <= 2 ? (
            <p className={cn('mt-3 text-xs', shortGuard ? 'text-destructive' : 'text-faint')}>
              短查询会使用受限子串模式：单一频道、最长 31 天、按最新排序且最多 20 条。
              {shortGuard ? ` ${shortGuard}` : ''}
            </p>
          ) : null}
          {trimmedLength > 200 ? (
            <p className="mt-3 text-xs text-destructive">搜索文字最多 200 个 Unicode 字符。</p>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
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
        </div>
      </div>

      <section aria-labelledby="feed-shelf-title" className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h3 className="font-serif text-base font-semibold" id="feed-shelf-title">
            订阅出口
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            每个 Feed 最多返回 50 条当前可见消息。
          </p>
        </div>
        <div className="px-4">
          <a
            className="flex items-baseline justify-between gap-4 py-2.5"
            href="/api/v1/rss.xml"
            rel="noreferrer"
            target="_blank"
          >
            <strong className="text-sm font-medium text-foreground">全局归档</strong>
            <span className="font-mono text-xs text-muted-foreground">/api/v1/rss.xml ↗</span>
          </a>
          {channels.map((item) => (
            <a
              className="flex items-baseline justify-between gap-4 border-t py-2.5"
              href={`/api/v1/channels/${encodeURIComponent(item.id)}/rss.xml`}
              key={item.id}
              rel="noreferrer"
              target="_blank"
            >
              <strong className="text-sm font-medium text-muted-foreground">{item.title}</strong>
              <span className="font-mono text-xs text-faint">
                {item.username ? `@${item.username}` : '频道 Feed'} ↗
              </span>
            </a>
          ))}
        </div>
      </section>
    </section>
  );
}
