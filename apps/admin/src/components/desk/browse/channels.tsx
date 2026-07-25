import { LaneEmpty } from '@/components/desk/lane';
import { Switch } from '@/components/ui/switch';
import { formatDate } from '@/lib/format';
import type { ConfiguredChannel } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface ChannelsCardProps {
  channels: ConfiguredChannel[];
  busyAction: string | null;
  onToggle(channel: ConfiguredChannel): void;
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
                  <span className="text-xs text-faint">
                    {channel.username ? `@${channel.username}` : channel.telegramChatId}
                  </span>
                </p>
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
