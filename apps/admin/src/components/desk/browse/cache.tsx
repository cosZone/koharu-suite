import { ConfirmAction } from '@/components/desk/confirm-action';
import { LaneEmpty } from '@/components/desk/lane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatBytes, formatDate } from '@/lib/format';
import type { MediaCacheObject, MediaCachePolicy, MediaCacheStatus } from '@/lib/types';

export interface CacheObjectsCardProps {
  objects: MediaCacheObject[];
  status: MediaCacheStatus;
  busyAction: string | null;
  nextCursor: string | null;
  reasons: Record<string, string>;
  onReasonChange(key: string, reason: string): void;
  onAction(object: MediaCacheObject, action: 'evict' | 'retry', reason: string): void;
  onProtect(object: MediaCacheObject, action: 'protect' | 'unprotect', reason: string): void;
  onPolicy(object: MediaCacheObject, policy: MediaCachePolicy, reason: string): void;
  onCopy(
    object: MediaCacheObject,
    sourceBackendId: string,
    targetBackendId: string,
    reason: string,
  ): void;
  onRestore(object: MediaCacheObject, targetBackendId: string, reason: string): void;
  onLoadMore(): void;
}

const RETRYABLE_STATES = [
  'blocked',
  'evicted',
  'integrity_conflict',
  'missing',
  'retry_wait',
  'skipped',
];

const RESTORABLE_LOCATION_STATES = ['corrupt', 'evicted', 'missing'];

/*
 * 缓存对象卡。逻辑对齐 App.tsx MediaCachePanel 的对象卡:
 * 确认交互由 ConfirmAction(AlertDialog)承载,集成方 handler 里的原生确认需同步移除。
 */
export function CacheObjectsCard({
  busyAction,
  nextCursor,
  objects,
  onAction,
  onCopy,
  onLoadMore,
  onPolicy,
  onProtect,
  onReasonChange,
  onRestore,
  reasons,
  status,
}: CacheObjectsCardProps) {
  const busy = busyAction !== null;
  const backends = status.backends ?? [];
  const readableBackends = backends.filter((backend) => backend.enabled && backend.readable);
  const writableBackends = backends.filter((backend) => backend.enabled && backend.writable);
  const hasStorageActions = status.backends !== undefined;

  return (
    <Card aria-labelledby="cache-objects-title">
      <CardHeader>
        <h3 className="font-serif text-base font-semibold" id="cache-objects-title">
          缓存对象
        </h3>
      </CardHeader>
      <CardContent className="grid gap-3">
        {objects.length === 0 ? (
          <LaneEmpty>
            {status.enabled
              ? '尚未发现可缓存媒体。'
              : '启用 MEDIA_CACHE_ENABLED 后才会建立本地副本。'}
          </LaneEmpty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {objects.map((object) => {
              const reason = reasons[object.id]?.trim() ?? '';
              const canEvict = object.state === 'ready';
              const isProtected = object.protection?.active === true;
              const canRetry = RETRYABLE_STATES.includes(object.state);
              const locations = object.locations ?? [];
              const readyLocation = locations.find(
                (location) =>
                  location.state === 'ready' &&
                  readableBackends.some((backend) => backend.id === location.backendId),
              );
              const copyTargets = readyLocation
                ? writableBackends.filter(
                    (backend) =>
                      backend.id !== readyLocation.backendId &&
                      !locations.some((location) => location.backendId === backend.id),
                  )
                : [];
              const restoreTargets = writableBackends.filter((backend) =>
                locations.some(
                  (location) =>
                    location.backendId === backend.id &&
                    RESTORABLE_LOCATION_STATES.includes(location.state),
                ),
              );
              return (
                <article className="rounded-lg border bg-inset p-4" key={object.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {object.kind} · {object.variant}
                      </p>
                      <code className="mt-1 block break-all font-mono text-xs text-faint">
                        {object.id}
                      </code>
                    </div>
                    <Badge variant="outline">{object.state}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Post {object.planState} ·{' '}
                    {object.actualBytes
                      ? formatBytes(object.actualBytes)
                      : object.declaredBytes
                        ? `声明 ${formatBytes(object.declaredBytes)}`
                        : '大小未知'}
                    {object.reasonCode ? ` · ${object.reasonCode}` : ''}
                  </p>
                  {hasStorageActions ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge variant="outline">
                        {isProtected
                          ? object.protection?.expiresAt
                            ? `保护至 ${formatDate(object.protection.expiresAt)}`
                            : '长期保护'
                          : object.protection?.expired
                            ? '保护已过期'
                            : '未保护'}
                      </Badge>
                      <Badge variant="outline">
                        {object.evictedPolicy === 'stay_evicted' ? '保持驱逐' : '按访问回填'}
                      </Badge>
                      {locations.map((location) => (
                        <span
                          className="rounded-sm border px-1.5 py-0.5 text-muted-foreground"
                          key={location.backendId}
                        >
                          {location.backendId}: {location.state}
                        </span>
                      ))}
                      {locations.length === 0 ? (
                        <span className="text-faint">尚无物理位置</span>
                      ) : null}
                    </div>
                  ) : null}
                  {canEvict || canRetry || hasStorageActions ? (
                    <div className="mt-3 grid gap-3">
                      <Field label="操作原因（必填，将写入审计记录）">
                        <Input
                          disabled={busy}
                          maxLength={500}
                          onChange={(event) => onReasonChange(object.id, event.target.value)}
                          placeholder={canEvict ? '例如：主动释放本地空间' : '例如：上游文件已恢复'}
                          value={reasons[object.id] ?? ''}
                        />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        {canRetry ? (
                          <Button
                            disabled={busy || reason.length === 0}
                            onClick={() => onAction(object, 'retry', reason)}
                            type="button"
                            variant="outline"
                          >
                            {busyAction === `${object.id}:retry` ? '正在重试…' : '重试'}
                          </Button>
                        ) : null}
                        {canEvict && !isProtected ? (
                          <ConfirmAction
                            busy={busyAction === `${object.id}:evict`}
                            busyLabel="正在驱逐…"
                            confirmText="驱逐这份本地副本？文章、媒体 metadata 与 Telegram 来源证据会保留。"
                            disabled={busy || reason.length === 0}
                            label="驱逐本地副本"
                            onConfirm={() => onAction(object, 'evict', reason)}
                            variant="destructive"
                          />
                        ) : null}
                        {hasStorageActions && !isProtected ? (
                          <Button
                            disabled={busy || reason.length === 0}
                            onClick={() => onProtect(object, 'protect', reason)}
                            type="button"
                            variant="outline"
                          >
                            {busyAction === `${object.id}:protect` ? '正在保护…' : '保护对象'}
                          </Button>
                        ) : null}
                        {hasStorageActions && isProtected ? (
                          <ConfirmAction
                            busy={busyAction === `${object.id}:unprotect`}
                            busyLabel="正在移除…"
                            confirmText="移除对象保护？之后显式驱逐与空间整理都可能删除它的缓存位置。"
                            disabled={busy || reason.length === 0}
                            label="移除保护"
                            onConfirm={() => onProtect(object, 'unprotect', reason)}
                            variant="destructive"
                          />
                        ) : null}
                        {hasStorageActions ? (
                          object.evictedPolicy === 'stay_evicted' ? (
                            <Button
                              disabled={busy || reason.length === 0}
                              onClick={() => onPolicy(object, 'recache_on_access', reason)}
                              type="button"
                              variant="outline"
                            >
                              恢复按访问回填
                            </Button>
                          ) : (
                            <ConfirmAction
                              confirmText="改为保持驱逐？访问这个对象时将不再自动重建缓存副本。"
                              disabled={busy || reason.length === 0}
                              label="驱逐后保持缺席"
                              onConfirm={() => onPolicy(object, 'stay_evicted', reason)}
                            />
                          )
                        ) : null}
                        {copyTargets.map((target) => (
                          <Button
                            disabled={busy || reason.length === 0}
                            key={`copy:${target.id}`}
                            onClick={() =>
                              onCopy(object, readyLocation?.backendId ?? '', target.id, reason)
                            }
                            type="button"
                            variant="outline"
                          >
                            复制到 {target.label}
                          </Button>
                        ))}
                        {restoreTargets.map((target) => (
                          <Button
                            disabled={busy || reason.length === 0 || !readyLocation}
                            key={`restore:${target.id}`}
                            onClick={() => onRestore(object, target.id, reason)}
                            type="button"
                            variant="outline"
                          >
                            恢复到 {target.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        {nextCursor ? (
          <div>
            <Button disabled={busy} onClick={onLoadMore} type="button" variant="outline">
              加载更多缓存对象
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
