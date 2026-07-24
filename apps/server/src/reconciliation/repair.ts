export type ReconciliationRepairInitiatorKind =
  | 'local_operator'
  | 'owner_session'
  | 'service_token';

export interface ReconciliationRepairInput {
  expectedEvidenceVersion: number;
  findingId: string;
  initiatorId: string | null;
  initiatorKind: ReconciliationRepairInitiatorKind;
  reason: string;
}

export type DeterministicRepairActionKind =
  | 'current_pointer.repair'
  | 'derived_html.rerender'
  | 'import_lineage.restore'
  | 'source_media.restore';

export interface ReconciliationRepairResult {
  actionKind: DeterministicRepairActionKind;
  changed: boolean;
  findingId: string;
  replayed: boolean;
  runId: string | null;
}

export interface DeterministicRepairRepository {
  apply(input: ReconciliationRepairInput): Promise<ReconciliationRepairResult>;
}

export class DeterministicRepairService {
  constructor(private readonly repository: DeterministicRepairRepository) {}

  async apply(input: ReconciliationRepairInput): Promise<ReconciliationRepairResult> {
    return this.repository.apply(validateReconciliationRepairInput(input));
  }
}

export function validateReconciliationRepairInput(
  input: ReconciliationRepairInput,
): ReconciliationRepairInput {
  if (!Number.isSafeInteger(input.expectedEvidenceVersion) || input.expectedEvidenceVersion < 1) {
    throw new RangeError('expectedEvidenceVersion must be a positive safe integer');
  }
  if (input.findingId.trim().length === 0) {
    throw new TypeError('findingId must not be empty');
  }
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new RangeError('reason must contain between 1 and 500 characters');
  }
  if (input.initiatorId !== null && input.initiatorId.trim().length === 0) {
    throw new TypeError('initiatorId must be null or non-empty');
  }
  if (
    input.initiatorKind !== 'local_operator' &&
    input.initiatorKind !== 'owner_session' &&
    input.initiatorKind !== 'service_token'
  ) {
    throw new TypeError('initiatorKind cannot perform deterministic repair');
  }
  return { ...input, reason };
}
