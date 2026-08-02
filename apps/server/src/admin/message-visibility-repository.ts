import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { appMetadata, messages, operationAuditEvents } from '../db/schema.js';
import { PUBLIC_READER_COMPATIBILITY_FLOOR_KEY } from '../reconciliation/tombstone-repository.js';
import {
  OwnerMessageVisibilityConflictError,
  type OwnerMessageVisibilityInput,
  OwnerMessageVisibilityNotFoundError,
  type OwnerMessageVisibilityRepository,
  type OwnerMessageVisibilityResult,
} from './message-visibility.js';

export class PostgresOwnerMessageVisibilityRepository implements OwnerMessageVisibilityRepository {
  constructor(private readonly database: Database) {}

  async setVisibility(
    input: OwnerMessageVisibilityInput & { tombstoned: boolean },
  ): Promise<OwnerMessageVisibilityResult> {
    return this.database.transaction(async (transaction) => {
      const [message] = await transaction
        .select({
          id: messages.id,
          tombstonedAt: messages.tombstonedAt,
          updatedAt: messages.updatedAt,
        })
        .from(messages)
        .where(eq(messages.id, input.messageId))
        .limit(1)
        .for('update');
      if (!message) {
        throw new OwnerMessageVisibilityNotFoundError('Message was not found');
      }
      if (message.updatedAt.toISOString() !== input.expectedUpdatedAt) {
        throw new OwnerMessageVisibilityConflictError(
          'Message changed after it was loaded; refresh before trying again',
        );
      }

      const beforeTombstoned = message.tombstonedAt !== null;
      let updatedAt = message.updatedAt;
      const changed = beforeTombstoned !== input.tombstoned;
      if (changed) {
        const visibilityCondition = input.tombstoned
          ? isNull(messages.tombstonedAt)
          : isNotNull(messages.tombstonedAt);
        const [updated] = await transaction
          .update(messages)
          .set({
            tombstonedAt: input.tombstoned ? sql`clock_timestamp()` : null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(messages.id, message.id), visibilityCondition))
          .returning({ updatedAt: messages.updatedAt });
        if (!updated) {
          throw new OwnerMessageVisibilityConflictError(
            'Message visibility changed concurrently; refresh before trying again',
          );
        }
        updatedAt = updated.updatedAt;
      }

      if (input.tombstoned) {
        await transaction
          .insert(appMetadata)
          .values({
            key: PUBLIC_READER_COMPATIBILITY_FLOOR_KEY,
            value: { feature: 'message_tombstones', minimumSchemaMigration: 9 },
          })
          .onConflictDoUpdate({
            target: appMetadata.key,
            set: {
              updatedAt: sql`clock_timestamp()`,
              value: { feature: 'message_tombstones', minimumSchemaMigration: 9 },
            },
          });
      }

      const [action] = await transaction
        .insert(operationAuditEvents)
        .values({
          action: input.tombstoned ? 'message.hide' : 'message.unhide',
          actorId: input.actorId,
          actorType: input.actorType,
          details: {
            after: { tombstoned: input.tombstoned, updatedAt: updatedAt.toISOString() },
            before: {
              tombstoned: beforeTombstoned,
              updatedAt: message.updatedAt.toISOString(),
            },
            changed,
          },
          reason: input.reason,
          targetId: message.id,
          targetType: 'message',
        })
        .returning({ id: operationAuditEvents.id });
      if (!action) {
        throw new Error('Failed to audit message visibility change');
      }

      return {
        actionId: action.id,
        changed,
        messageId: message.id,
        tombstoned: input.tombstoned,
        updatedAt: updatedAt.toISOString(),
      };
    });
  }
}
