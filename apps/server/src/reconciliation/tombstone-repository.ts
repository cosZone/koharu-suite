import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  messages,
  reconciliationActions,
  reconciliationFindings,
  telegramChannels,
} from '../db/schema.js';
import { RECONCILIATION_ADVISORY_LOCK } from './repository.js';
import type {
  MessageTombstoneRepository,
  MessageTombstoneResult,
  OwnerMessageTombstoneInput,
} from './tombstone.js';

export class PostgresMessageTombstoneRepository implements MessageTombstoneRepository {
  constructor(private readonly database: Database) {}

  async setTombstoned(
    input: OwnerMessageTombstoneInput & { tombstoned: boolean },
  ): Promise<MessageTombstoneResult> {
    if (input.initiatorKind !== 'owner_session' || input.initiatorId.trim().length === 0) {
      throw new TypeError('Only an identified owner session can change message tombstone state');
    }
    if (!Number.isSafeInteger(input.expectedEvidenceVersion) || input.expectedEvidenceVersion < 1) {
      throw new RangeError('expectedEvidenceVersion must be a positive safe integer');
    }
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 500) {
      throw new RangeError('reason must contain between 1 and 500 characters');
    }
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${RECONCILIATION_ADVISORY_LOCK})`);
      const [message] = await transaction
        .select()
        .from(messages)
        .where(eq(messages.id, input.messageId))
        .limit(1)
        .for('update');
      if (!message) {
        throw new Error('Message was not found');
      }
      const [finding] = await transaction
        .select()
        .from(reconciliationFindings)
        .where(eq(reconciliationFindings.id, input.findingId))
        .limit(1)
        .for('update');
      if (!finding) {
        throw new Error('Reconciliation finding was not found');
      }
      if (finding.kind !== 'desktop_absence_candidate') {
        throw new Error('Only a Desktop absence candidate can change message tombstone state');
      }
      if (input.tombstoned && finding.state !== 'open') {
        throw new Error('Only an open Desktop absence candidate can hide a message');
      }
      if (finding.evidenceVersion !== input.expectedEvidenceVersion) {
        throw new Error('Reconciliation finding evidence version changed');
      }
      if (finding.messageId !== message.id || finding.telegramChatId === null) {
        throw new Error('Reconciliation finding does not match the selected message');
      }
      const [channel] = await transaction
        .select({ telegramChatId: telegramChannels.telegramChatId })
        .from(telegramChannels)
        .where(eq(telegramChannels.id, message.channelId))
        .limit(1);
      if (!channel || channel.telegramChatId !== finding.telegramChatId) {
        throw new Error('Reconciliation finding is outside the selected message channel');
      }

      const beforeTombstoned = message.tombstonedAt !== null;
      const changed = beforeTombstoned !== input.tombstoned;
      if (changed) {
        const condition = input.tombstoned
          ? isNull(messages.tombstonedAt)
          : isNotNull(messages.tombstonedAt);
        const [updated] = await transaction
          .update(messages)
          .set({
            tombstonedAt: input.tombstoned ? sql`clock_timestamp()` : null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(messages.id, message.id), condition))
          .returning({ id: messages.id });
        if (!updated) {
          throw new Error('Message tombstone state changed concurrently');
        }
      }

      const [action] = await transaction
        .insert(reconciliationActions)
        .values({
          actionKind: input.tombstoned ? 'message.hide' : 'message.unhide',
          afterState: {
            evidenceVersion: finding.evidenceVersion,
            messageId: message.id,
            tombstoned: input.tombstoned,
          },
          beforeState: {
            evidenceVersion: finding.evidenceVersion,
            messageId: message.id,
            tombstoned: beforeTombstoned,
          },
          findingId: finding.id,
          initiatorId: input.initiatorId,
          initiatorKind: input.initiatorKind,
          reason,
        })
        .returning({ id: reconciliationActions.id });
      if (!action) {
        throw new Error('Failed to audit message tombstone state');
      }

      return {
        actionId: action.id,
        changed,
        findingId: finding.id,
        messageId: message.id,
        replayed: !changed,
        tombstoned: input.tombstoned,
      };
    });
  }
}
