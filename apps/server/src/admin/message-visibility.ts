export interface OwnerMessageVisibilityInput {
  actorId: string;
  actorType: 'owner_session';
  expectedUpdatedAt: string;
  messageId: string;
  reason: string;
}

export interface OwnerMessageVisibilityResult {
  actionId: string;
  changed: boolean;
  messageId: string;
  tombstoned: boolean;
  updatedAt: string;
}

export interface OwnerMessageVisibilityRepository {
  setVisibility(
    input: OwnerMessageVisibilityInput & { tombstoned: boolean },
  ): Promise<OwnerMessageVisibilityResult>;
}

export class OwnerMessageVisibilityNotFoundError extends Error {}
export class OwnerMessageVisibilityConflictError extends Error {}

export class OwnerMessageVisibilityService {
  constructor(private readonly repository: OwnerMessageVisibilityRepository) {}

  hide(input: OwnerMessageVisibilityInput): Promise<OwnerMessageVisibilityResult> {
    return this.apply(input, true);
  }

  unhide(input: OwnerMessageVisibilityInput): Promise<OwnerMessageVisibilityResult> {
    return this.apply(input, false);
  }

  private apply(
    input: OwnerMessageVisibilityInput,
    tombstoned: boolean,
  ): Promise<OwnerMessageVisibilityResult> {
    const actorId = input.actorId.trim();
    if (input.actorType !== 'owner_session' || actorId.length === 0) {
      throw new TypeError('Only an identified owner session can change message visibility');
    }
    const messageId = input.messageId.trim();
    if (messageId.length === 0) {
      throw new TypeError('messageId must not be empty');
    }
    const expectedUpdatedAt = input.expectedUpdatedAt.trim();
    const expectedDate = new Date(expectedUpdatedAt);
    if (expectedUpdatedAt.length === 0 || !Number.isFinite(expectedDate.getTime())) {
      throw new TypeError('expectedUpdatedAt must be a valid timestamp');
    }
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 500) {
      throw new RangeError('reason must contain between 1 and 500 characters');
    }

    return this.repository.setVisibility({
      actorId,
      actorType: 'owner_session',
      expectedUpdatedAt: expectedDate.toISOString(),
      messageId,
      reason,
      tombstoned,
    });
  }
}
