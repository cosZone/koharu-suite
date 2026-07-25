import { Lane, LaneBody, LaneHeader, LaneItem, LaneSkeleton } from '@/components/desk/lane';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, formatDate } from '@/lib/format';
import type {
  AdminStatus,
  MediaCacheStatus,
  ReconciliationFinding,
  ReconciliationRun,
} from '@/lib/types';

export interface PulseLaneProps {
  status: AdminStatus | null;
  mediaCacheStatus: MediaCacheStatus | null;
  runs: ReconciliationRun[];
  findings: ReconciliationFinding[];
  loading: boolean;
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-sm font-medium">{children}</h3>;
}

function FieldLabel({ children }: { children: string }) {
  return <span className="text-xs text-faint">{children}</span>;
}

/*
 * shadcn Progress 的指示条把 value 当作 0-100 的百分比渲染,
 * 因此这里先把字节换算成百分比;max 固定为 100 保持 aria 一致。
 */
function capacityPercent(usedBytes: number, maxBytes: number): number {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0;
  return Math.min(100, Math.max(0, (usedBytes / maxBytes) * 100));
}

function statEntries(status: AdminStatus | null): Array<[string, string | number]> {
  return [
    ['配置频道', status?.counts.configuredChannels ?? '—'],
    ['活跃频道', status?.counts.activeChannels ?? '—'],
    ['消息', status?.counts.messages ?? '—'],
    ['Updates', status?.counts.updates ?? '—'],
    ['待处理', status?.counts.pendingTasks ?? '—'],
    ['重试中', status?.counts.retryingTasks ?? '—'],
    ['已阻塞', status?.counts.blockedTasks ?? '—'],
    ['已跳过', status?.counts.skippedTasks ?? '—'],
    ['待重渲染', status?.counts.staleRendererRevisions ?? '—'],
    ['Checkpoint', status?.lastCheckpoint ? formatDate(status.lastCheckpoint) : '—'],
  ];
}

/* 统计条:10 格,概览页顶部使用 */
export function StatsStrip({ status, loading }: { status: AdminStatus | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="px-3 py-2" role="status">
        <span className="sr-only">正在加载</span>
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-2 divide-x sm:grid-cols-5 xl:grid-cols-10">
      {statEntries(status).map(([label, value]) => (
        <div className="px-3 py-2" key={label}>
          <dt>
            <FieldLabel>{label}</FieldLabel>
          </dt>
          <dd className="mt-0.5 truncate text-base font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* Collector 运行时(只读) */
export function CollectorStatus({ status }: { status: AdminStatus | null }) {
  const collector = status?.collector;
  return (
    <LaneItem>
      <SectionTitle>Collector</SectionTitle>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <div>
          <dt>
            <FieldLabel>Worker</FieldLabel>
          </dt>
          <dd className="mt-0.5 text-sm">
            {collector?.state === 'running'
              ? '运行中'
              : collector?.state === 'stale'
                ? '心跳过期'
                : '未运行'}
          </dd>
        </div>
        <div>
          <dt>
            <FieldLabel>版本</FieldLabel>
          </dt>
          <dd className="mt-0.5 text-sm">{collector?.version ?? '—'}</dd>
        </div>
        <div>
          <dt>
            <FieldLabel>心跳</FieldLabel>
          </dt>
          <dd className="mt-0.5 text-sm">
            {collector?.heartbeatAt ? formatDate(collector.heartbeatAt) : '—'}
          </dd>
        </div>
      </dl>
    </LaneItem>
  );
}

/* 媒体缓存读数(只读):用量、状态计数、后端、最近失败、维护命令 */
export function MediaCacheReadouts({
  mediaCacheStatus,
}: {
  mediaCacheStatus: MediaCacheStatus | null;
}) {
  if (!mediaCacheStatus) {
    return null;
  }
  const backends = mediaCacheStatus.backends ?? [];
  return (
    <LaneItem>
      <SectionTitle>媒体缓存</SectionTitle>
      <dl className="mt-2 grid gap-1.5">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-muted-foreground">已使用</dt>
          <dd className="text-sm font-medium">{formatBytes(mediaCacheStatus.usage.readyBytes)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-muted-foreground">已预留</dt>
          <dd className="text-sm font-medium">
            {formatBytes(mediaCacheStatus.usage.reservedBytes)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-muted-foreground">上限</dt>
          <dd className="text-sm font-medium">{formatBytes(mediaCacheStatus.usage.maxBytes)}</dd>
        </div>
      </dl>
      <Progress
        aria-label="媒体缓存容量"
        className="mt-2 h-1.5 rounded-[2px] bg-inset"
        max={100}
        value={capacityPercent(
          Number(mediaCacheStatus.usage.readyBytes) + Number(mediaCacheStatus.usage.reservedBytes),
          Number(mediaCacheStatus.usage.maxBytes),
        )}
      />
      <ul aria-label="媒体缓存状态计数" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {mediaCacheStatus.stateCounts.objects.map((entry) => (
          <li className="text-sm text-muted-foreground" key={entry.state}>
            {entry.count} {entry.state}
          </li>
        ))}
        {mediaCacheStatus.stateCounts.objects.length === 0 ? (
          <li className="text-sm text-muted-foreground">暂无缓存对象</li>
        ) : null}
      </ul>

      {backends.length > 0 ? (
        <>
          <Separator className="my-3" />
          <SectionTitle>存储后端</SectionTitle>
          <div className="mt-2 grid gap-2 xl:grid-cols-2">
            {backends.map((backend) => (
              <div className="rounded-lg border bg-inset p-2.5" key={backend.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{backend.label}</p>
                    <p className="mt-0.5 text-xs text-faint">
                      {backend.kind} · {backend.id}
                    </p>
                  </div>
                  <Badge variant="outline">{backend.enabled ? '在线' : '停用'}</Badge>
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-4">
                  <span className="text-xs text-faint">
                    {formatBytes(backend.readyBytes)} / {formatBytes(backend.maxBytes)}
                  </span>
                </div>
                <Progress
                  aria-label={`${backend.label} 容量`}
                  className="mt-1.5 h-1.5 rounded-[2px] bg-background"
                  max={100}
                  value={capacityPercent(Number(backend.readyBytes), Number(backend.maxBytes))}
                />
                <ul
                  aria-label={`${backend.label} 位置状态`}
                  className="mt-2 flex flex-wrap gap-x-3 gap-y-1"
                >
                  {backend.locationStateCounts.map((entry) => (
                    <li className="text-xs text-muted-foreground" key={entry.state}>
                      {entry.count} {entry.state}
                    </li>
                  ))}
                  <li className="text-xs text-muted-foreground">
                    {backend.readable ? '可读' : '不可读'}
                  </li>
                  <li className="text-xs text-muted-foreground">
                    {backend.writable ? '可写' : '只读'}
                  </li>
                </ul>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {mediaCacheStatus.failures.length > 0 ? (
        <>
          <Separator className="my-3" />
          <SectionTitle>最近失败</SectionTitle>
          <ul className="mt-2 grid gap-1.5">
            {mediaCacheStatus.failures.map((failure) => (
              <li
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
                key={failure.objectId}
              >
                <code className="text-xs text-faint">{failure.objectId.slice(0, 8)}</code>
                <span className="text-sm">
                  {failure.variant} · {failure.state} ·{' '}
                  {failure.reasonCode ??
                    failure.lastErrorCode ??
                    failure.lastErrorClass ??
                    'unknown'}
                </span>
                <time className="text-xs text-faint" dateTime={failure.updatedAt}>
                  {formatDate(failure.updatedAt)}
                </time>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {mediaCacheStatus.commands.length > 0 ? (
        <>
          <Separator className="my-3" />
          <SectionTitle>最近的维护命令</SectionTitle>
          <ul className="mt-2 grid gap-1.5">
            {mediaCacheStatus.commands.map((command) => (
              <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5" key={command.id}>
                <code className="text-xs text-faint">{command.id.slice(0, 8)}</code>
                <span className="text-sm">
                  {command.operation} · {command.state}
                  {command.sourceBackendId ? ` · ${command.sourceBackendId}` : ''}
                  {command.targetBackendId ? ` → ${command.targetBackendId}` : ''}
                  {command.errorCode ? ` · ${command.errorCode}` : ''}
                </span>
                <time className="text-xs text-faint" dateTime={command.updatedAt}>
                  {formatDate(command.updatedAt)}
                </time>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </LaneItem>
  );
}

/* 对账基线(只读):类别统计、已加载/Open、最近运行 */
export function ReconciliationBaseline({
  findings,
  runs,
}: {
  findings: ReconciliationFinding[];
  runs: ReconciliationRun[];
}) {
  const openFindingCount = findings.filter((finding) => finding.state === 'open').length;
  const findingCategories = Object.entries(
    findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
      return counts;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));
  return (
    <LaneItem>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>对账基线</SectionTitle>
        <span className="text-xs text-muted-foreground">
          已加载 {findings.length} 条 · Open {openFindingCount}
        </span>
      </div>
      <ul aria-label="已加载 Finding 类别统计" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {findingCategories.map(([kind, count]) => (
          <li className="text-sm text-muted-foreground" key={kind}>
            <strong className="font-medium text-foreground">{count}</strong> {kind}
          </li>
        ))}
        {findingCategories.length === 0 ? (
          <li className="text-sm text-muted-foreground">当前无类别数据</li>
        ) : null}
      </ul>
      <Separator className="my-3" />
      <p className="text-sm text-muted-foreground">
        最近运行 {runs[0] ? `${runs[0].status} · ${formatDate(runs[0].startedAt)}` : '—'}
      </p>
    </LaneItem>
  );
}

/* 系统状态(只读)= Collector + 媒体缓存 + 对账基线 */
export function SystemStatus({
  status,
  mediaCacheStatus,
  runs,
  findings,
}: {
  status: AdminStatus | null;
  mediaCacheStatus: MediaCacheStatus | null;
  runs: ReconciliationRun[];
  findings: ReconciliationFinding[];
}) {
  return (
    <div className="grid gap-2">
      <CollectorStatus status={status} />
      <MediaCacheReadouts mediaCacheStatus={mediaCacheStatus} />
      <ReconciliationBaseline findings={findings} runs={runs} />
    </div>
  );
}

/* 兼容组合:统计 + 系统状态收在一个 Lane 里(测试与外部引用用) */
export function PulseLane({ status, mediaCacheStatus, runs, findings, loading }: PulseLaneProps) {
  if (loading) {
    return (
      <Lane id="lane-pulse" titleId="lane-pulse-title">
        <LaneHeader title="系统脉搏" titleId="lane-pulse-title" />
        <LaneBody>
          <LaneSkeleton rows={4} />
        </LaneBody>
      </Lane>
    );
  }

  return (
    <Lane id="lane-pulse" titleId="lane-pulse-title">
      <LaneHeader title="系统脉搏" titleId="lane-pulse-title" />
      <LaneBody>
        <LaneItem>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5 xl:grid-cols-10">
            {statEntries(status).map(([label, value]) => (
              <div key={label}>
                <dt>
                  <FieldLabel>{label}</FieldLabel>
                </dt>
                <dd className="mt-0.5 text-base font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </LaneItem>
        <SystemStatus
          findings={findings}
          mediaCacheStatus={mediaCacheStatus}
          runs={runs}
          status={status}
        />
      </LaneBody>
    </Lane>
  );
}
