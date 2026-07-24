export type MessageTombstoneInitiatorKind =
  | 'local_operator'
  | 'owner_session'
  | 'service_token'
  | 'worker';

export interface MessageTombstoneInput {
  expectedEvidenceVersion: number;
  findingId: string;
  initiatorId: string | null;
  initiatorKind: MessageTombstoneInitiatorKind;
  messageId: string;
  reason: string;
}

export interface OwnerMessageTombstoneInput
  extends Omit<MessageTombstoneInput, 'initiatorId' | 'initiatorKind'> {
  initiatorId: string;
  initiatorKind: 'owner_session';
}

export interface MessageTombstoneResult {
  actionId: string;
  changed: boolean;
  findingId: string;
  messageId: string;
  replayed: boolean;
  tombstoned: boolean;
}

export interface MessageTombstoneRepository {
  setTombstoned(
    input: OwnerMessageTombstoneInput & { tombstoned: boolean },
  ): Promise<MessageTombstoneResult>;
}

export class MessageTombstoneService {
  constructor(private readonly repository: MessageTombstoneRepository) {}

  hide(input: MessageTombstoneInput): Promise<MessageTombstoneResult> {
    return this.apply(input, true);
  }

  unhide(input: MessageTombstoneInput): Promise<MessageTombstoneResult> {
    return this.apply(input, false);
  }

  private async apply(
    input: MessageTombstoneInput,
    tombstoned: boolean,
  ): Promise<MessageTombstoneResult> {
    if (!Number.isSafeInteger(input.expectedEvidenceVersion) || input.expectedEvidenceVersion < 1) {
      throw new RangeError('expectedEvidenceVersion must be a positive safe integer');
    }
    const findingId = input.findingId.trim();
    if (findingId.length === 0) {
      throw new TypeError('findingId must not be empty');
    }
    const messageId = input.messageId.trim();
    if (messageId.length === 0) {
      throw new TypeError('messageId must not be empty');
    }
    if (input.initiatorKind !== 'owner_session') {
      throw new TypeError('Only an owner session can change message tombstone state');
    }
    const initiatorId = input.initiatorId?.trim() ?? '';
    if (initiatorId.length === 0) {
      throw new TypeError('Owner session initiatorId must not be empty');
    }
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 500) {
      throw new RangeError('reason must contain between 1 and 500 characters');
    }

    return this.repository.setTombstoned({
      expectedEvidenceVersion: input.expectedEvidenceVersion,
      findingId,
      initiatorId,
      initiatorKind: 'owner_session',
      messageId,
      reason,
      tombstoned,
    });
  }
}
