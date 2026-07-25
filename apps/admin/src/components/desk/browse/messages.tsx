import { LaneEmpty } from '@/components/desk/lane';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import { SafeMessageContent } from '@/lib/safe-message';
import type { Message } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface MessageBrowserProps {
  messages: Message[];
  selectedMessage: Message | null;
  raw: unknown;
  rawLoading: boolean;
  loading: boolean; // 频道切换时的消息加载中
  onSelectMessage(message: Message): void;
  onRevealRaw(): void;
}

/* 消息浏览:左侧列表 + 右侧详情的主从双栏,纯受控 */
export function MessageBrowser({
  loading,
  messages,
  onRevealRaw,
  onSelectMessage,
  raw,
  rawLoading,
  selectedMessage,
}: MessageBrowserProps) {
  return (
    <div className="grid overflow-hidden rounded-lg border md:grid-cols-2">
      <div className="border-b bg-inset md:border-r md:border-b-0">
        {loading ? (
          <div role="status">
            <span className="sr-only">正在加载</span>
            {Array.from({ length: 4 }, (_, index) => (
              <div className="border-t px-4 py-3 first:border-t-0" key={index}>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-2 h-4 w-full" />
                <Skeleton className="mt-2 h-3 w-20" />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="p-4">
            <LaneEmpty>这个频道还没有归档消息。</LaneEmpty>
          </div>
        ) : (
          <div>
            {messages.map((message, index) => {
              const selected = selectedMessage?.id === message.id;
              return (
                <button
                  aria-current={selected ? true : undefined}
                  className={cn(
                    'block w-full px-4 py-3 text-left transition-colors',
                    index > 0 && 'border-t',
                    selected ? 'bg-card' : 'hover:bg-card/60',
                  )}
                  key={message.id}
                  onClick={() => onSelectMessage(message)}
                  type="button"
                >
                  <time className="text-xs text-faint" dateTime={message.publishedAt}>
                    {formatDate(message.publishedAt)}
                  </time>
                  <p
                    className={cn(
                      'mt-1 text-sm leading-6',
                      selected ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {message.content.text?.slice(0, 72) || '［无文字内容］'}
                  </p>
                  <p className="mt-1 text-xs text-faint">
                    rev.{message.revision} · {message.media.length} 个媒体
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-card">
        {selectedMessage ? (
          <div>
            <div className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
              <h3 className="font-serif text-base font-semibold">
                {selectedMessage.channel.title}
              </h3>
              {selectedMessage.sourceUrl ? (
                <a
                  className="shrink-0 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  href={selectedMessage.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  原消息 ↗
                </a>
              ) : null}
            </div>
            <div className="px-4 py-4">
              <div className="text-sm leading-6">
                <SafeMessageContent
                  html={selectedMessage.content.html}
                  text={selectedMessage.content.text}
                />
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-3 border-y py-3 text-xs">
                <div>
                  <dt className="text-faint">发布时间</dt>
                  <dd className="mt-1 text-muted-foreground">
                    {formatDate(selectedMessage.publishedAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-faint">署名</dt>
                  <dd className="mt-1 text-muted-foreground">
                    {selectedMessage.authorSignature ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-faint">内容类型</dt>
                  <dd className="mt-1 text-muted-foreground">{selectedMessage.content.kind}</dd>
                </div>
              </dl>
              <div className="mt-4 rounded-lg border bg-inset p-4">
                <p className="text-xs font-medium text-muted-foreground">Telegram raw update</p>
                <p className="mt-1 text-xs text-faint">仅在主动点击后读取；响应不会被缓存。</p>
                <Button
                  className="mt-3"
                  disabled={rawLoading}
                  onClick={onRevealRaw}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {rawLoading ? '正在读取…' : raw === null ? '揭示原始数据' : '重新读取'}
                </Button>
              </div>
              {raw !== null ? (
                <pre className="mt-3 max-h-80 overflow-auto rounded-lg border bg-inset p-3 text-xs leading-5 text-muted-foreground">
                  {JSON.stringify(raw, null, 2)}
                </pre>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="p-4">
            <LaneEmpty>选择一条消息查看详情。</LaneEmpty>
          </div>
        )}
      </div>
    </div>
  );
}
