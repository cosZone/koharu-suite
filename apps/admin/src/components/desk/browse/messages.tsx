import { ConfirmAction } from '@/components/desk/confirm-action';
import { LaneEmpty } from '@/components/desk/lane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import { SafeMessageContent } from '@/lib/safe-message';
import type { Message, MessageVisibilityFilter } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface MessageBrowserProps {
  busyAction: string | null;
  messageVisibilityFilter: MessageVisibilityFilter;
  messages: Message[];
  nextCursor: string | null;
  selectedMessage: Message | null;
  raw: unknown;
  rawLoading: boolean;
  loading: boolean; // 频道切换时的消息加载中
  onMessageVisibility(message: Message, action: 'hide' | 'unhide', reason: string): void;
  onMessageVisibilityFilterChange(filter: MessageVisibilityFilter): void;
  onLoadMore(): void;
  onReasonChange(key: string, reason: string): void;
  onSelectMessage(message: Message): void;
  onRevealRaw(): void;
  reason: string;
}

/* 消息浏览:左侧列表 + 右侧详情的主从双栏,纯受控 */
export function MessageBrowser({
  busyAction,
  loading,
  messageVisibilityFilter,
  messages,
  nextCursor,
  onLoadMore,
  onMessageVisibility,
  onMessageVisibilityFilterChange,
  onReasonChange,
  onRevealRaw,
  onSelectMessage,
  raw,
  rawLoading,
  reason,
  selectedMessage,
}: MessageBrowserProps) {
  return (
    <div className="grid overflow-hidden rounded-lg border md:grid-cols-2">
      <div className="border-b bg-inset md:border-r md:border-b-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <span className="mr-auto text-xs text-faint">可见性</span>
          {(
            [
              ['all', '全部'],
              ['hidden', '仅看已隐藏'],
              ['visible', '仅看公开'],
            ] as const
          ).map(([value, label]) => (
            <Button
              aria-pressed={messageVisibilityFilter === value}
              disabled={loading || busyAction !== null}
              key={value}
              onClick={() => onMessageVisibilityFilterChange(value)}
              size="sm"
              type="button"
              variant={messageVisibilityFilter === value ? 'secondary' : 'ghost'}
            >
              {label}
            </Button>
          ))}
        </div>
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
            <LaneEmpty>
              {messageVisibilityFilter === 'all'
                ? '这个频道还没有归档消息。'
                : messageVisibilityFilter === 'hidden'
                  ? '这个频道没有已隐藏的消息。'
                  : '这个频道没有公开消息。'}
            </LaneEmpty>
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
                    {message.tombstoned ? ' · 已隐藏' : ''}
                  </p>
                </button>
              );
            })}
            {nextCursor ? (
              <div className="border-t p-3 text-center">
                <Button
                  disabled={busyAction !== null}
                  onClick={onLoadMore}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {busyAction === 'more-messages' ? '正在加载…' : '加载更多消息'}
                </Button>
              </div>
            ) : null}
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
              {selectedMessage.tombstoned ? (
                <Badge className="mb-3" variant="destructive">
                  已隐藏 · 公开访问返回 404
                </Badge>
              ) : null}
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
              {selectedMessage.updatedAt ? (
                <div className="mt-4 rounded-lg border bg-inset p-4">
                  <p className="text-xs font-medium text-muted-foreground">公开可见性</p>
                  <p className="mt-1 text-xs leading-5 text-faint">
                    {selectedMessage.tombstoned
                      ? '恢复后会重新出现在公开页面、API、搜索与 RSS；不会回写 Telegram。'
                      : '隐藏后公开详情返回 404，但 revision、raw update 与来源证据都会保留；不会回写 Telegram。'}
                  </p>
                  <Field className="mt-3" label="审计原因">
                    <Input
                      disabled={loading || busyAction !== null}
                      maxLength={500}
                      onChange={(event) => onReasonChange(selectedMessage.id, event.target.value)}
                      placeholder={
                        selectedMessage.tombstoned ? '说明为何恢复公开' : '说明为何隐藏此消息'
                      }
                      value={reason}
                    />
                  </Field>
                  <div className="mt-3">
                    <ConfirmAction
                      busy={
                        busyAction ===
                        `message:${selectedMessage.id}:${selectedMessage.tombstoned ? 'unhide' : 'hide'}`
                      }
                      confirmText={
                        selectedMessage.tombstoned
                          ? '恢复这条消息的公开访问？操作会写入独立审计记录，不会回写 Telegram。'
                          : '隐藏这条消息并让公开访问返回 404？revision、raw update 与来源证据会保留，操作不会回写 Telegram。'
                      }
                      disabled={loading || busyAction !== null || reason.trim().length === 0}
                      label={selectedMessage.tombstoned ? '恢复公开访问' : '隐藏消息'}
                      onConfirm={() =>
                        onMessageVisibility(
                          selectedMessage,
                          selectedMessage.tombstoned ? 'unhide' : 'hide',
                          reason.trim(),
                        )
                      }
                      variant={selectedMessage.tombstoned ? 'outline' : 'destructive'}
                    />
                  </div>
                </div>
              ) : null}
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
