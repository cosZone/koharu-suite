import { describe, expect, it, vi } from 'vitest';
import {
  type OwnerMessageVisibilityInput,
  type OwnerMessageVisibilityRepository,
  OwnerMessageVisibilityService,
} from '../src/admin/message-visibility.js';

const validInput: OwnerMessageVisibilityInput = {
  actorId: ' owner-id ',
  actorType: 'owner_session',
  expectedUpdatedAt: '2026-08-02T00:20:00+00:00',
  messageId: ' message-id ',
  reason: ' remove from public archive ',
};

function createRepository(): OwnerMessageVisibilityRepository {
  return {
    setVisibility: vi.fn(async (input) => ({
      actionId: 'action-id',
      changed: true,
      messageId: input.messageId,
      tombstoned: input.tombstoned,
      updatedAt: '2026-08-02T00:21:00.000Z',
    })),
  };
}

describe('OwnerMessageVisibilityService', () => {
  it('normalizes owner-only hide and unhide requests independently of findings', async () => {
    const repository = createRepository();
    const service = new OwnerMessageVisibilityService(repository);

    await expect(service.hide(validInput)).resolves.toMatchObject({ tombstoned: true });
    await expect(service.unhide(validInput)).resolves.toMatchObject({ tombstoned: false });
    expect(repository.setVisibility).toHaveBeenNthCalledWith(1, {
      actorId: 'owner-id',
      actorType: 'owner_session',
      expectedUpdatedAt: '2026-08-02T00:20:00.000Z',
      messageId: 'message-id',
      reason: 'remove from public archive',
      tombstoned: true,
    });
    expect(repository.setVisibility).toHaveBeenNthCalledWith(2, {
      actorId: 'owner-id',
      actorType: 'owner_session',
      expectedUpdatedAt: '2026-08-02T00:20:00.000Z',
      messageId: 'message-id',
      reason: 'remove from public archive',
      tombstoned: false,
    });
  });

  it.each([
    [{ ...validInput, actorId: '' }, 'Only an identified owner session'],
    [{ ...validInput, expectedUpdatedAt: 'not-a-date' }, 'expectedUpdatedAt'],
    [{ ...validInput, messageId: '' }, 'messageId'],
    [{ ...validInput, reason: '' }, 'reason'],
    [{ ...validInput, reason: 'x'.repeat(501) }, 'reason'],
  ] satisfies Array<[OwnerMessageVisibilityInput, string]>)(
    'rejects invalid input',
    (input, message) => {
      const service = new OwnerMessageVisibilityService(createRepository());
      expect(() => service.hide(input)).toThrow(message);
    },
  );
});
