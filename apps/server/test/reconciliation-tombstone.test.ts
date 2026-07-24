import { describe, expect, it, vi } from 'vitest';
import {
  type MessageTombstoneInput,
  type MessageTombstoneRepository,
  MessageTombstoneService,
} from '../src/reconciliation/tombstone.js';

function repository() {
  return {
    setTombstoned: vi.fn<MessageTombstoneRepository['setTombstoned']>(async (input) => ({
      actionId: 'action-1',
      changed: true,
      findingId: input.findingId,
      messageId: input.messageId,
      replayed: false,
      tombstoned: input.tombstoned,
    })),
  };
}

const validInput: MessageTombstoneInput = {
  expectedEvidenceVersion: 2,
  findingId: 'finding-1',
  initiatorId: 'owner-1',
  initiatorKind: 'owner_session',
  messageId: 'message-1',
  reason: 'Owner confirmed the complete Desktop export',
};

describe('message tombstone service', () => {
  it('delegates hide and unhide with a trimmed identified owner reason', async () => {
    const target = repository();
    const service = new MessageTombstoneService(target);

    await expect(
      service.hide({
        ...validInput,
        findingId: ' finding-1 ',
        initiatorId: ' owner-1 ',
        messageId: ' message-1 ',
        reason: '  Owner confirmed the complete Desktop export  ',
      }),
    ).resolves.toMatchObject({ tombstoned: true });
    await expect(service.unhide(validInput)).resolves.toMatchObject({ tombstoned: false });

    expect(target.setTombstoned).toHaveBeenNthCalledWith(1, {
      ...validInput,
      tombstoned: true,
    });
    expect(target.setTombstoned).toHaveBeenNthCalledWith(2, {
      ...validInput,
      tombstoned: false,
    });
  });

  it.each([
    [{ initiatorKind: 'service_token' }, 'Only an owner session'],
    [{ initiatorKind: 'worker' }, 'Only an owner session'],
    [{ initiatorKind: 'local_operator' }, 'Only an owner session'],
    [{ initiatorId: null }, 'initiatorId'],
    [{ initiatorId: ' ' }, 'initiatorId'],
    [{ expectedEvidenceVersion: 0 }, 'expectedEvidenceVersion'],
    [{ expectedEvidenceVersion: Number.MAX_SAFE_INTEGER + 1 }, 'expectedEvidenceVersion'],
    [{ findingId: ' ' }, 'findingId'],
    [{ messageId: ' ' }, 'messageId'],
    [{ reason: ' ' }, 'reason'],
    [{ reason: 'x'.repeat(501) }, 'reason'],
  ] satisfies Array<[Partial<MessageTombstoneInput>, string]>)(
    'rejects unauthorized or invalid input %j',
    async (override, expectedMessage) => {
      const target = repository();
      const service = new MessageTombstoneService(target);

      await expect(service.hide({ ...validInput, ...override })).rejects.toThrow(expectedMessage);
      expect(target.setTombstoned).not.toHaveBeenCalled();
    },
  );
});
