import { useState } from 'react';
import { ConfirmAction } from '@/components/desk/confirm-action';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatBytes } from '@/lib/format';
import type { MediaCachePrunePreview, MediaCacheStatus } from '@/lib/types';

export interface StorageToolsCardProps {
  status: MediaCacheStatus;
  busyAction: string | null;
  prunePreview: MediaCachePrunePreview | null;
  reasons: Record<string, string>;
  onReasonChange(key: string, reason: string): void;
  onCopy(sourceBackendId: string, targetBackendId: string, reason: string): void;
  onPrune(
    action: 'apply' | 'preview',
    targetBackendId: string,
    targetBytes: string,
    reason: string,
  ): void;
  onPrunePreviewClear(): void;
  onReconcile(reason: string): void;
}

/* 预览只在后端与目标字节数都未改动时才允许应用(与 App.tsx 契约一致) */
export function mediaCachePrunePreviewMatches(
  preview: MediaCachePrunePreview | null,
  targetBackendId: string,
  targetBytes: string,
): boolean {
  return (
    preview !== null &&
    preview.targetBackendId === targetBackendId &&
    preview.targetBytes === targetBytes
  );
}

const selectClassName =
  'h-9 w-full rounded-md border border-input bg-inset px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

/*
 * 写工具:批量复制 / 按 LRU 整理空间 / 媒体缓存对账。
 * 选择器保持原生 <select>;破坏性或账本写操作走 ConfirmAction。
 */
export function StorageToolsCard({
  busyAction,
  onCopy,
  onPrune,
  onPrunePreviewClear,
  onReasonChange,
  onReconcile,
  prunePreview,
  reasons,
  status,
}: StorageToolsCardProps) {
  const backends = status.backends ?? [];
  const readableBackends = backends.filter((backend) => backend.enabled && backend.readable);
  const writableBackends = backends.filter((backend) => backend.enabled && backend.writable);
  const defaultSource = readableBackends[0]?.id ?? '';
  const defaultTarget =
    writableBackends.find((backend) => backend.id !== defaultSource)?.id ??
    writableBackends[0]?.id ??
    '';
  const [copySource, setCopySource] = useState(defaultSource);
  const [copyTarget, setCopyTarget] = useState(defaultTarget);
  const [pruneBackend, setPruneBackend] = useState(writableBackends[0]?.id ?? '');
  const [pruneTargetBytes, setPruneTargetBytes] = useState(writableBackends[0]?.readyBytes ?? '0');
  const copyReason = reasons['storage-copy']?.trim() ?? '';
  const pruneReason = reasons['storage-prune']?.trim() ?? '';
  const reconcileReason = reasons.reconcile?.trim() ?? '';
  const prunePreviewMatches = mediaCachePrunePreviewMatches(
    prunePreview,
    pruneBackend,
    pruneTargetBytes,
  );
  const busy = busyAction !== null;

  return (
    <Card aria-labelledby="storage-tools-title">
      <CardHeader>
        <h3 className="font-serif text-base font-semibold" id="storage-tools-title">
          写工具
        </h3>
      </CardHeader>
      <CardContent className="grid gap-5">
        <section aria-labelledby="storage-copy-title" className="grid gap-3">
          <div className="grid gap-1">
            <h4 className="text-sm font-medium" id="storage-copy-title">
              批量复制
            </h4>
            <p className="text-xs text-muted-foreground">
              按账本顺序复制一个有界批次；源位置会保留。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="源后端">
              <select
                className={selectClassName}
                disabled={busy}
                onChange={(event) => setCopySource(event.target.value)}
                value={copySource}
              >
                {readableBackends.map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="目标后端">
              <select
                className={selectClassName}
                disabled={busy}
                onChange={(event) => setCopyTarget(event.target.value)}
                value={copyTarget}
              >
                {writableBackends.map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="复制原因（必填）">
            <Input
              disabled={busy}
              maxLength={500}
              onChange={(event) => onReasonChange('storage-copy', event.target.value)}
              placeholder="例如：建立 S3 耐久副本"
              value={reasons['storage-copy'] ?? ''}
            />
          </Field>
          <div>
            <Button
              disabled={
                busy ||
                copyReason.length === 0 ||
                copySource.length === 0 ||
                copyTarget.length === 0 ||
                copySource === copyTarget
              }
              onClick={() => onCopy(copySource, copyTarget, copyReason)}
              type="button"
              variant="outline"
            >
              {busyAction === 'storage-copy' ? '正在入队…' : '复制一个批次'}
            </Button>
          </div>
        </section>

        <section aria-labelledby="storage-prune-title" className="grid gap-3 border-t pt-5">
          <div className="grid gap-1">
            <h4 className="text-sm font-medium" id="storage-prune-title">
              按 LRU 整理空间
            </h4>
            <p className="text-xs text-muted-foreground">
              预览严格零写；应用时会基于最新账本重新规划，结果可能变化。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="后端">
              <select
                className={selectClassName}
                disabled={busy}
                onChange={(event) => {
                  setPruneBackend(event.target.value);
                  onPrunePreviewClear();
                  const backend = writableBackends.find(
                    (candidate) => candidate.id === event.target.value,
                  );
                  setPruneTargetBytes(backend?.readyBytes ?? '0');
                }}
                value={pruneBackend}
              >
                {writableBackends.map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="目标字节数">
              <Input
                disabled={busy}
                inputMode="numeric"
                min={0}
                onChange={(event) => {
                  setPruneTargetBytes(event.target.value);
                  onPrunePreviewClear();
                }}
                pattern="[0-9]+"
                value={pruneTargetBytes}
              />
            </Field>
          </div>
          {prunePreview ? (
            <dl
              aria-label="整理预览"
              className="grid grid-cols-2 gap-3 rounded-lg border bg-inset p-3 text-xs sm:grid-cols-3"
            >
              <div>
                <dt className="text-faint">后端</dt>
                <dd className="mt-0.5 font-mono">{prunePreview.targetBackendId}</dd>
              </div>
              <div>
                <dt className="text-faint">目标</dt>
                <dd className="mt-0.5">{formatBytes(prunePreview.targetBytes)}</dd>
              </div>
              <div>
                <dt className="text-faint">候选</dt>
                <dd className="mt-0.5">{prunePreview.candidates}</dd>
              </div>
              <div>
                <dt className="text-faint">可释放</dt>
                <dd className="mt-0.5">{formatBytes(prunePreview.removableBytes)}</dd>
              </div>
              <div>
                <dt className="text-faint">预计剩余</dt>
                <dd className="mt-0.5">{formatBytes(prunePreview.projectedReadyBytes)}</dd>
              </div>
              <div>
                <dt className="text-faint">更多批次</dt>
                <dd className="mt-0.5">{prunePreview.hasMore ? '是' : '否'}</dd>
              </div>
            </dl>
          ) : null}
          <Field label="应用原因（必填）">
            <Input
              disabled={busy}
              maxLength={500}
              onChange={(event) => onReasonChange('storage-prune', event.target.value)}
              placeholder="例如：将热层收缩到 4 GiB"
              value={reasons['storage-prune'] ?? ''}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || pruneBackend.length === 0 || !/^\d+$/.test(pruneTargetBytes)}
              onClick={() => onPrune('preview', pruneBackend, pruneTargetBytes, '')}
              type="button"
              variant="outline"
            >
              {busyAction === 'storage-prune-preview' ? '正在预览…' : '预览整理'}
            </Button>
            <ConfirmAction
              busy={busyAction === 'storage-prune-apply'}
              busyLabel="正在入队…"
              confirmText="应用空间整理？系统会基于当前账本重新规划，并跳过受保护的对象。"
              disabled={
                busy ||
                pruneReason.length === 0 ||
                pruneBackend.length === 0 ||
                !/^\d+$/.test(pruneTargetBytes) ||
                !prunePreviewMatches
              }
              label="应用重新规划"
              onConfirm={() => onPrune('apply', pruneBackend, pruneTargetBytes, pruneReason)}
              variant="destructive"
            />
          </div>
        </section>

        <section aria-labelledby="storage-reconcile-title" className="grid gap-3 border-t pt-5">
          <h4 className="text-sm font-medium" id="storage-reconcile-title">
            媒体缓存对账
          </h4>
          <Field label="对账原因（必填，将写入审计记录）">
            <Input
              disabled={busy}
              maxLength={500}
              onChange={(event) => onReasonChange('reconcile', event.target.value)}
              placeholder="例如：卷已恢复，需要核对 DB 与文件系统"
              value={reasons.reconcile ?? ''}
            />
          </Field>
          <div>
            <ConfirmAction
              busy={busyAction === 'reconcile'}
              busyLabel="正在对账…"
              confirmText="运行媒体缓存对账？只会修复缓存账本与可丢弃的本地副本。"
              disabled={busy || reconcileReason.length === 0}
              label="运行媒体缓存对账"
              onConfirm={() => onReconcile(reconcileReason)}
            />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
