import { ConfirmAction } from '@/components/desk/confirm-action';
import { LaneItem } from '@/components/desk/lane';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ReconciliationFinding } from '@/lib/types';

const REPAIRABLE_FINDING_KINDS = [
  'current_pointer_invalid',
  'derived_html_drift',
  'import_lineage_missing',
  'media_evidence_missing',
];

function findingConfirmText(verb: string): string {
  return `${verb}？来源证据会保留，此操作会写入审计记录。`;
}

/*
 * finding 条目:概览待办队列与对账页共用。
 * 操作按 state/kind 条件渲染,原因为空时全部 disabled(UI 层前置拦截)。
 */
export function FindingItem({
  busy,
  finding,
  onFindingAction,
  onReasonChange,
  reason,
}: {
  busy: boolean;
  finding: ReconciliationFinding;
  onFindingAction(
    finding: ReconciliationFinding,
    action: 'hide' | 'ignore' | 'repair' | 'unhide',
    reason: string,
  ): void;
  onReasonChange(key: string, reason: string): void;
  reason: string;
}) {
  const actionDisabled = busy || reason.trim().length === 0;
  const canRepair = finding.state === 'open' && REPAIRABLE_FINDING_KINDS.includes(finding.kind);
  const canHide =
    finding.kind === 'desktop_absence_candidate' &&
    finding.messageId !== null &&
    !finding.messageTombstoned;
  const canUnhide = finding.messageTombstoned;
  const canIgnore = finding.state === 'open';
  const hasActions = canRepair || canHide || canUnhide || canIgnore;
  return (
    <LaneItem>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <Badge variant="outline">FINDING</Badge>
          <Badge className="font-mono" variant="outline">
            {finding.kind}
          </Badge>
        </div>
        <span className="text-xs text-faint">
          {finding.state} · evidence v{finding.evidenceVersion}
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {finding.sanitizedDetails.reason ?? '需要 Owner 检查此 evidence。'}
      </p>
      {hasActions ? (
        <>
          <Field className="mt-3" label="审计原因">
            <Input
              disabled={busy}
              maxLength={500}
              onChange={(event) => onReasonChange(finding.id, event.target.value)}
              placeholder="说明为何修复或忽略"
              value={reason}
            />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            {canRepair ? (
              <ConfirmAction
                confirmText={findingConfirmText('执行确定性修复')}
                disabled={actionDisabled}
                label="确定性修复"
                onConfirm={() => onFindingAction(finding, 'repair', reason.trim())}
              />
            ) : null}
            {canHide ? (
              <ConfirmAction
                confirmText={findingConfirmText('隐藏消息并让公开 API 返回 404')}
                disabled={actionDisabled}
                label="隐藏并公开返回 404"
                onConfirm={() => onFindingAction(finding, 'hide', reason.trim())}
              />
            ) : null}
            {canUnhide ? (
              <ConfirmAction
                confirmText={findingConfirmText('恢复消息的公开访问')}
                disabled={actionDisabled}
                label="恢复公开访问"
                onConfirm={() => onFindingAction(finding, 'unhide', reason.trim())}
              />
            ) : null}
            {canIgnore ? (
              <ConfirmAction
                confirmText={findingConfirmText('忽略此 finding')}
                disabled={actionDisabled}
                label="Owner 忽略"
                onConfirm={() => onFindingAction(finding, 'ignore', reason.trim())}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </LaneItem>
  );
}
