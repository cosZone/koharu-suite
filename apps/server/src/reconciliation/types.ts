export const RECONCILIATION_EVIDENCE_KINDS = [
  'durable_pending',
  'durable_blocked',
  'operator_skipped',
  'disabled_window',
  'retention_risk',
  'transport_id_discontinuity',
  'message_id_candidate',
  'desktop_absence_candidate',
  'observation_stale',
  'observation_conflict',
  'media_evidence_missing',
  'derived_html_drift',
  'current_pointer_invalid',
] as const;

export type ReconciliationEvidenceKind = (typeof RECONCILIATION_EVIDENCE_KINDS)[number];

export type ReconciliationEvidenceConfidence =
  | 'certain'
  | 'certain_difference'
  | 'rebuildable_or_unknown'
  | 'risk'
  | 'weak_signal';

export const RECONCILIATION_EVIDENCE_CONFIDENCE = {
  current_pointer_invalid: 'certain',
  derived_html_drift: 'certain',
  desktop_absence_candidate: 'weak_signal',
  disabled_window: 'risk',
  durable_blocked: 'certain',
  durable_pending: 'certain',
  media_evidence_missing: 'rebuildable_or_unknown',
  message_id_candidate: 'weak_signal',
  observation_conflict: 'certain_difference',
  observation_stale: 'certain_difference',
  operator_skipped: 'certain',
  retention_risk: 'risk',
  transport_id_discontinuity: 'weak_signal',
} as const satisfies Record<ReconciliationEvidenceKind, ReconciliationEvidenceConfidence>;

export const GLOBAL_RECONCILIATION_EVIDENCE_KINDS = [
  'retention_risk',
  'transport_id_discontinuity',
] as const satisfies readonly ReconciliationEvidenceKind[];

export type ReconciliationFindingSeverity = 'error' | 'warning';
export type ReconciliationFindingState = 'ignored' | 'open' | 'resolved';
export type ReconciliationReportMode = 'apply' | 'dry-run' | 'persisted-scan' | 'scheduled-scan';
export type ReconciliationReportStatus = 'clean' | 'fatal' | 'interrupted' | 'partial' | 'repaired';

export interface ReconciliationFindingIdentity {
  channelId: string | null;
  evidenceIds?: readonly string[];
  kind: ReconciliationEvidenceKind;
  messageId?: string;
  observationId?: string;
  rangeEnd?: string;
  rangeStart?: string;
}

export interface ReconciliationFindingLifecycle {
  evidenceVersion: number;
  state: ReconciliationFindingState;
}

export function reconciliationFindingState(
  previous: ReconciliationFindingLifecycle | undefined,
  incomingEvidenceVersion: number,
): ReconciliationFindingState {
  assertEvidenceVersion(incomingEvidenceVersion);

  if (!previous) {
    return 'open';
  }

  assertEvidenceVersion(previous.evidenceVersion);
  if (incomingEvidenceVersion < previous.evidenceVersion) {
    throw new RangeError('Incoming evidence version cannot move backwards');
  }

  return incomingEvidenceVersion === previous.evidenceVersion ? previous.state : 'open';
}

export function isReconciliationEvidenceKind(value: string): value is ReconciliationEvidenceKind {
  return (RECONCILIATION_EVIDENCE_KINDS as readonly string[]).includes(value);
}

export function assertReconciliationFindingScope(
  kind: ReconciliationEvidenceKind,
  channelId: string | null,
): void {
  const global = (GLOBAL_RECONCILIATION_EVIDENCE_KINDS as readonly string[]).includes(kind);
  if (global !== (channelId === null)) {
    throw new TypeError(
      global
        ? `${kind} must use a global null channel scope`
        : `${kind} must use a non-null channel scope`,
    );
  }
}

function assertEvidenceVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Evidence version must be a positive safe integer');
  }
}
