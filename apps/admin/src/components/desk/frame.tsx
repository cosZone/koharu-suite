import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

export function TopBar({
  blockedCount,
  collectorState,
  email,
  onSignOut,
  version,
}: {
  blockedCount: number | null;
  collectorState: 'running' | 'stale' | 'stopped' | null;
  email: string | undefined;
  onSignOut(): void;
  version: string | undefined;
}) {
  const collectorText =
    collectorState === 'running'
      ? 'Collector 运行中'
      : collectorState === 'stale'
        ? 'Collector 心跳过期'
        : 'Collector 未运行';
  return (
    <header className="border-b">
      <div className="flex h-11 items-center justify-between gap-4 px-3">
        <div className="flex items-baseline gap-3">
          <span className="font-serif text-base font-semibold">Owner Desk</span>
          <span className="hidden text-xs text-faint sm:inline">KOHARU SUITE</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn(
                'block size-1.5',
                collectorState === 'running' ? 'bg-foreground' : 'bg-faint',
              )}
            />
            {collectorText}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {blockedCount !== null ? (
            <span className="font-medium text-primary">已阻塞 {blockedCount}</span>
          ) : null}
          <span className="hidden sm:inline">{email ?? '正在读取 owner…'}</span>
          <span className="hidden sm:inline">Server v{version ?? '—'}</span>
          <button
            className="underline-offset-4 hover:text-foreground hover:underline"
            onClick={onSignOut}
            type="button"
          >
            退出
          </button>
        </div>
      </div>
    </header>
  );
}

export interface SidebarRoute {
  title: string;
  to: string;
}

export interface StripChannel {
  id: string;
  title: string;
  username: string | null;
}

export function Sidebar({
  channels,
  onSelect,
  routes,
  selectedId,
}: {
  channels: StripChannel[];
  onSelect(id: string): void;
  routes: SidebarRoute[];
  selectedId: string | null;
}) {
  return (
    <aside className="hidden w-44 shrink-0 overflow-y-auto border-r lg:block">
      <nav aria-label="面板" className="grid gap-0.5 p-2">
        {routes.map((route) => (
          <NavLink
            className={({ isActive }) =>
              cn(
                'rounded-sm px-2 py-1 text-xs transition-colors',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )
            }
            end={route.to === '/'}
            key={route.to}
            to={route.to}
          >
            {route.title}
          </NavLink>
        ))}
      </nav>
      <div className="border-t p-2">
        <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-faint">频道</p>
        <nav aria-label="归档频道" className="grid gap-0.5">
          {channels.map((channel) => (
            <button
              className={cn(
                'rounded-sm border-l-2 px-2 py-1 text-left transition-colors',
                selectedId === channel.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              key={channel.id}
              onClick={() => onSelect(channel.id)}
              type="button"
            >
              <span className="block text-xs">{channel.title}</span>
              <span className="block text-[10px] text-faint">
                {channel.username ? `@${channel.username}` : '私有链接不可用'}
              </span>
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}

export function RouteStrip({ routes }: { routes: SidebarRoute[] }) {
  return (
    <nav aria-label="面板" className="border-b lg:hidden">
      <div className="flex gap-1 overflow-x-auto px-3">
        {routes.map((route) => (
          <NavLink
            className={({ isActive }) =>
              cn(
                'whitespace-nowrap border-b-2 px-2 py-2 text-xs transition-colors',
                isActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )
            }
            end={route.to === '/'}
            key={route.to}
            to={route.to}
          >
            {route.title}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function ChannelStrip({
  channels,
  onSelect,
  selectedId,
}: {
  channels: StripChannel[];
  onSelect(id: string): void;
  selectedId: string | null;
}) {
  return (
    <nav aria-label="归档频道" className="border-b lg:hidden">
      <div className="flex gap-1 overflow-x-auto px-3">
        {channels.map((channel) => (
          <button
            className={cn(
              'whitespace-nowrap border-b-2 px-2 py-2 text-xs transition-colors',
              selectedId === channel.id
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            key={channel.id}
            onClick={() => onSelect(channel.id)}
            type="button"
          >
            {channel.title}
          </button>
        ))}
      </div>
    </nav>
  );
}
