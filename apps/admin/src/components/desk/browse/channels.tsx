import { useEffect, useRef, useState } from 'react';
import { LaneEmpty } from '@/components/desk/lane';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { formatChannelId, formatDate } from '@/lib/format';
import type { ConfiguredChannel } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface ChannelsCardProps {
  channels: ConfiguredChannel[];
  busyAction: string | null;
  onToggle(channel: ConfiguredChannel): void;
}

export interface ChannelIdClipboard {
  writeText(text: string): Promise<void>;
}

/* 复制完整频道 ID;失败原样抛出,由调用方落入反馈态 */
export async function writeChannelIdToClipboard(
  channelId: string,
  clipboard: ChannelIdClipboard = navigator.clipboard,
): Promise<void> {
  await clipboard.writeText(channelId);
}

type CopyState = 'copied' | 'failed' | 'idle';

/* 频道 ID 复制:截断显示 + 完整复制,反馈经 aria-live 播报,2 秒后复位 */
function ChannelIdCopy({ channelId, title }: { channelId: string; title: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  async function copy() {
    try {
      await writeChannelIdToClipboard(channelId);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setState('idle'), 2_000);
  }

  return (
    <span className="mt-0.5 flex items-center gap-1 text-xs text-faint">
      <code>ID {formatChannelId(channelId)}</code>
      <Button
        aria-label={`复制 ${title} 的完整频道 ID`}
        onClick={() => void copy()}
        size="xs"
        type="button"
        variant="ghost"
      >
        复制
      </Button>
      <span
        aria-atomic="true"
        aria-live="polite"
        className={state === 'failed' ? 'text-destructive' : undefined}
      >
        {state === 'copied' ? '已复制' : null}
        {state === 'failed' ? '复制失败' : null}
      </span>
    </span>
  );
}

/* 采集频道:启停 Switch,停用不删归档;busyAction 非空时整体禁用 */
export function ChannelsCard({ busyAction, channels, onToggle }: ChannelsCardProps) {
  const enabledCount = channels.filter((channel) => channel.enabled).length;
  return (
    <section aria-labelledby="channels-card-title" className="rounded-lg border bg-card">
      <div className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
        <h3 className="font-serif text-base font-semibold" id="channels-card-title">
          采集频道
        </h3>
        <span className="text-xs text-muted-foreground">{enabledCount} 启用</span>
      </div>
      {channels.length === 0 ? (
        <div className="p-4">
          <LaneEmpty>还没有配置 Telegram 频道。</LaneEmpty>
        </div>
      ) : (
        <div className="px-4">
          {channels.map((channel, index) => (
            <div
              className={cn(
                'flex items-center justify-between gap-4 py-3',
                index > 0 && 'border-t',
              )}
              key={channel.telegramChatId}
            >
              <div>
                <p
                  className={cn(
                    'text-sm',
                    channel.enabled ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {channel.title}{' '}
                  {channel.username ? (
                    <span className="text-xs text-faint">@{channel.username}</span>
                  ) : null}
                </p>
                <ChannelIdCopy channelId={channel.telegramChatId} title={channel.title} />
                {!channel.enabled && channel.disabledAt ? (
                  <small className="mt-0.5 block text-xs text-faint">
                    停用于 {formatDate(channel.disabledAt)}
                  </small>
                ) : null}
              </div>
              <Switch
                aria-label={`${channel.enabled ? '停用' : '启用'} ${channel.title}`}
                checked={channel.enabled}
                disabled={busyAction !== null}
                onCheckedChange={() => onToggle(channel)}
              />
            </div>
          ))}
        </div>
      )}
      <p className="border-t px-4 py-2.5 text-xs text-faint">
        停用只会停止后续采集，不会删除已经归档的消息。
      </p>
    </section>
  );
}
