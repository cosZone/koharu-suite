import { FindingItem } from '@/components/desk/finding-item';
import {
  Lane,
  LaneBody,
  LaneEmpty,
  LaneHeader,
  LaneItem,
  LaneSkeleton,
} from '@/components/desk/lane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/format';
import type {
  BlockedTask,
  MediaCacheObject,
  ReconciliationFinding,
  RerenderResult,
} from '@/lib/types';

export interface TriageLaneProps {
  blockedTasks: BlockedTask[];
  findings: ReconciliationFinding[];
  findingsNextCursor: string | null;
  cacheObjects: MediaCacheObject[];
  staleRendererRevisions: number;
  rerenderResult: RerenderResult | null;
  busyAction: string | null;
  loading: boolean;
  reasons: Record<string, string>;
  onReasonChange(key: string, reason: string): void;
  onTaskAction(task: BlockedTask, action: 'retry' | 'skip', reason: string): void;
  onFindingAction(
    finding: ReconciliationFinding,
    action: 'hide' | 'ignore' | 'repair' | 'unhide',
    reason: string,
  ): void;
  onCacheRetry(object: MediaCacheObject, reason: string): void;
  onLoadMoreFindings(): void;
  onRerender(): void;
}

/*
 * busyAction 键约定(与 App.tsx 现有处理器一致):
 * 任务 `task:{id}:retry|skip`;finding `{id}:hide|ignore|repair|unhide`;
 * 缓存 `{id}:retry`;重渲染 `rerender`。reasons 键分别为 task.id / finding.id / object.id。
 */
const RETRYABLE_CACHE_STATES = [
  'blocked',
  'evicted',
  'integrity_conflict',
  'missing',
  'retry_wait',
  'skipped',
];

export function TriageLane({
  blockedTasks,
  findings,
  findingsNextCursor,
  cacheObjects,
  staleRendererRevisions,
  rerenderResult,
  busyAction,
  loading,
  reasons,
  onReasonChange,
  onTaskAction,
  onFindingAction,
  onCacheRetry,
  onLoadMoreFindings,
  onRerender,
}: TriageLaneProps) {
  const openFindings = findings.filter((finding) => finding.state === 'open');
  const retryableObjects = cacheObjects.filter((object) =>
    RETRYABLE_CACHE_STATES.includes(object.state),
  );
  const showRender = staleRendererRevisions > 0;
  const totalCount =
    blockedTasks.length + openFindings.length + retryableObjects.length + (showRender ? 1 : 0);
  const busy = busyAction !== null;

  if (loading) {
    return (
      <Lane id="lane-triage" titleId="lane-triage-title">
        <LaneHeader title="需要处理" titleId="lane-triage-title" />
        <LaneBody>
          <LaneSkeleton rows={3} />
        </LaneBody>
      </Lane>
    );
  }

  return (
    <Lane id="lane-triage" titleId="lane-triage-title">
      <LaneHeader
        count={<span className="font-serif text-2xl font-semibold">{totalCount}</span>}
        description={
          <>
            <span className="block">
              这里汇总四类待人工处理的事项：处理失败的消息任务、对账发现的问题（finding）、异常的缓存对象、待重渲染的旧版内容。
            </span>
            <span className="block">
              处理任何一项前都要填写原因，原因和操作人会写入审计记录。finding 中的敏感信息已脱敏。
            </span>
            <span className="block">
              隐藏消息后公开 API 会返回 404，但 finding、来源证据与审计记录仍然保留。
            </span>
          </>
        }
        title="需要处理"
        titleId="lane-triage-title"
      />
      <LaneBody className="xl:grid-cols-2">
        {totalCount === 0 ? (
          <LaneEmpty className="xl:col-span-2">没有待处理的事项。</LaneEmpty>
        ) : null}

        {blockedTasks.map((task) => {
          const reason = reasons[task.id] ?? '';
          const actionDisabled = busy || reason.trim().length === 0;
          return (
            <LaneItem key={`task:${task.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <Badge variant="outline">QUEUE</Badge>
                  <h3 className="font-serif text-sm font-semibold">{task.channelTitle}</h3>
                </div>
                <time className="text-xs text-faint" dateTime={task.blockedAt}>
                  {formatDate(task.blockedAt)}
                </time>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Update {task.telegramUpdateId} · 已尝试 {task.attemptCount} 次
              </p>
              {task.lastError ? (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-inset p-3 font-mono text-xs text-destructive">
                  {task.lastError}
                </pre>
              ) : null}
              <Field className="mt-3" label="操作原因（必填，将写入审计记录）">
                <Input
                  disabled={busy}
                  maxLength={500}
                  onChange={(event) => onReasonChange(task.id, event.target.value)}
                  placeholder="例如：已修复解析器，重新处理"
                  value={reason}
                />
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={actionDisabled}
                  onClick={() => onTaskAction(task, 'retry', reason.trim())}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {busyAction === `task:${task.id}:retry` ? '正在重试…' : '重试任务'}
                </Button>
                <Button
                  disabled={actionDisabled}
                  onClick={() => onTaskAction(task, 'skip', reason.trim())}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  {busyAction === `task:${task.id}:skip` ? '正在跳过…' : '显式跳过'}
                </Button>
              </div>
            </LaneItem>
          );
        })}

        {openFindings.map((finding) => (
          <FindingItem
            busy={busy}
            finding={finding}
            key={`finding:${finding.id}`}
            onFindingAction={onFindingAction}
            onReasonChange={onReasonChange}
            reason={reasons[finding.id] ?? ''}
          />
        ))}

        {retryableObjects.map((object) => {
          const reason = reasons[object.id] ?? '';
          const actionDisabled = busy || reason.trim().length === 0;
          return (
            <LaneItem key={`cache:${object.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <Badge variant="outline">CACHE</Badge>
                  <h3 className="font-serif text-sm font-semibold">
                    {object.kind} · {object.variant}
                  </h3>
                </div>
                <span className="font-mono text-xs text-faint">{object.id.slice(0, 8)}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {object.state}
                {object.reasonCode ? ` · ${object.reasonCode}` : ''}
              </p>
              <Field className="mt-3" label="操作原因（必填，将写入审计记录）">
                <Input
                  disabled={busy}
                  maxLength={500}
                  onChange={(event) => onReasonChange(object.id, event.target.value)}
                  placeholder="例如：上游文件已恢复"
                  value={reason}
                />
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={actionDisabled}
                  onClick={() => onCacheRetry(object, reason.trim())}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {busyAction === `${object.id}:retry` ? '正在重试…' : '重试'}
                </Button>
              </div>
            </LaneItem>
          );
        })}

        {showRender ? (
          <LaneItem key="render">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <Badge variant="outline">RENDER</Badge>
                <h3 className="font-serif text-sm font-semibold">内容重渲染</h3>
              </div>
              <span className="text-xs text-faint">待重渲染 {staleRendererRevisions}</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              仅处理 renderer 版本落后的修订，每次最多一批；已经是当前版本的内容不会改写。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                disabled={busy}
                onClick={onRerender}
                size="sm"
                type="button"
                variant="outline"
              >
                {busyAction === 'rerender'
                  ? '正在重渲染…'
                  : rerenderResult?.hasMore
                    ? '继续处理下一批'
                    : '重渲染过期内容'}
              </Button>
              {rerenderResult ? (
                <p className="text-xs text-muted-foreground">
                  本批更新 {rerenderResult.updated} 条
                  {rerenderResult.hasMore ? '，仍有下一批待处理。' : '，已处理完毕。'}
                </p>
              ) : null}
            </div>
          </LaneItem>
        ) : null}

        {findingsNextCursor ? (
          <div className="flex justify-center xl:col-span-2">
            <Button disabled={busy} onClick={onLoadMoreFindings} type="button" variant="outline">
              {busyAction === 'more-findings'
                ? '加载更多 findings（加载中…）'
                : '加载更多 findings'}
            </Button>
          </div>
        ) : null}
      </LaneBody>
    </Lane>
  );
}
