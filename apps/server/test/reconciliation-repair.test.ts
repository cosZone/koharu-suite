import { describe, expect, it, vi } from 'vitest';
import {
  type DeterministicRepairRepository,
  DeterministicRepairService,
  type ReconciliationRepairInput,
} from '../src/reconciliation/repair.js';

function repository(): DeterministicRepairRepository {
  return {
    apply: vi.fn<DeterministicRepairRepository['apply']>(async (input) => ({
      actionKind: 'derived_html.rerender',
      changed: true,
      findingId: input.findingId,
      replayed: false,
      runId: 'run-1',
    })),
  };
}

describe('deterministic reconciliation repair service', () => {
  it('requires explicit evidence, reason, and initiator metadata before delegating', async () => {
    const repairs = repository();
    const service = new DeterministicRepairService(repairs);

    await expect(
      service.apply({
        expectedEvidenceVersion: 3,
        findingId: 'finding-1',
        initiatorId: 'owner-1',
        initiatorKind: 'owner_session',
        reason: '  restore derived state  ',
      }),
    ).resolves.toMatchObject({
      actionKind: 'derived_html.rerender',
      findingId: 'finding-1',
    });
    expect(repairs.apply).toHaveBeenCalledWith({
      expectedEvidenceVersion: 3,
      findingId: 'finding-1',
      initiatorId: 'owner-1',
      initiatorKind: 'owner_session',
      reason: 'restore derived state',
    });
  });

  it.each([
    [{ expectedEvidenceVersion: 0 }, 'expectedEvidenceVersion'],
    [{ expectedEvidenceVersion: Number.MAX_SAFE_INTEGER + 1 }, 'expectedEvidenceVersion'],
    [{ findingId: ' ' }, 'findingId'],
    [{ initiatorId: ' ' }, 'initiatorId'],
    [{ reason: ' ' }, 'reason'],
    [{ reason: 'x'.repeat(501) }, 'reason'],
  ])('rejects invalid repair input %j', async (override, expectedMessage) => {
    const repairs = repository();
    const service = new DeterministicRepairService(repairs);

    await expect(
      service.apply({
        expectedEvidenceVersion: 1,
        findingId: 'finding-1',
        initiatorId: null,
        initiatorKind: 'local_operator',
        reason: 'repair',
        ...override,
      }),
    ).rejects.toThrow(expectedMessage);
    expect(repairs.apply).not.toHaveBeenCalled();
  });

  it('rejects worker-initiated automatic repair at runtime', async () => {
    const repairs = repository();
    const service = new DeterministicRepairService(repairs);
    const input = {
      expectedEvidenceVersion: 1,
      findingId: 'finding-1',
      initiatorId: 'worker-1',
      initiatorKind: 'worker',
      reason: 'automatic repair',
    } as unknown as ReconciliationRepairInput;

    await expect(service.apply(input)).rejects.toThrow(
      'initiatorKind cannot perform deterministic repair',
    );
    expect(repairs.apply).not.toHaveBeenCalled();
  });
});
