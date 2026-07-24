import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaBlobLocations,
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjectProtections,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaStorageBackends,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';
import {
  type MediaCacheObjectPolicyConflictError,
  MediaCacheObjectPolicyNotFoundError,
  PostgresMediaCacheObjectPolicyService,
} from '../../src/media-cache/object-policy-service.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const SHARED_SHA256 = 'a'.repeat(64);
let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;
let fixtureIndex = 0;

async function createReadyObject(): Promise<string> {
  if (!connection) throw new Error('Database connection was not created');
  fixtureIndex += 1;
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_009_000_000_000n - BigInt(fixtureIndex),
      title: `Object policy ${fixtureIndex}`,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Fixture channel was not created');
  const [message] = await connection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      publishedAt: new Date('2026-07-24T08:00:00.000Z'),
      telegramMessageId: BigInt(fixtureIndex),
    })
    .returning({ id: messages.id });
  if (!message) throw new Error('Fixture message was not created');
  const [revision] = await connection.db
    .insert(messageRevisions)
    .values({
      contentKind: 'none',
      entities: [],
      messageId: message.id,
      revisionNumber: 1,
    })
    .returning({ id: messageRevisions.id });
  if (!revision) throw new Error('Fixture revision was not created');
  const [media] = await connection.db
    .insert(messageMedia)
    .values({
      kind: 'photo',
      position: 0,
      revisionId: revision.id,
      sourceKind: 'telegram_bot_update',
      telegramFileId: `private-file-${fixtureIndex}`,
      telegramFileUniqueId: `private-unique-${fixtureIndex}`,
    })
    .returning({ id: messageMedia.id });
  if (!media) throw new Error('Fixture media was not created');
  await connection.db
    .insert(mediaCacheBlobs)
    .values({
      byteLength: 128n,
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/aa/aa/${SHARED_SHA256}`,
      sha256: SHARED_SHA256,
      state: 'ready',
    })
    .onConflictDoNothing();
  const [plan] = await connection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: message.id,
      readyOriginalBytes: 128n,
      revisionId: revision.id,
      state: 'ready',
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) throw new Error('Fixture plan was not created');
  const [object] = await connection.db
    .insert(mediaCacheObjects)
    .values({
      actualBytes: 128n,
      blobSha256: SHARED_SHA256,
      canonicalMediaId: media.id,
      postPlanId: plan.id,
      recipeVersion: 1,
      revisionId: revision.id,
      state: 'ready',
      variant: 'original',
    })
    .returning({ id: mediaCacheObjects.id });
  if (!object) throw new Error('Fixture object was not created');
  return object.id;
}

function service(): PostgresMediaCacheObjectPolicyService {
  if (!connection) throw new Error('Database connection was not created');
  return new PostgresMediaCacheObjectPolicyService(connection.db);
}

describe('PostgreSQL media cache object policy service', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  }, 30_000);

  beforeEach(async () => {
    if (!connection) throw new Error('Database connection was not created');
    await connection.db.execute(sql`
      truncate table
        ${mediaBlobLocations},
        ${mediaStorageBackends},
        ${mediaCacheActions},
        ${mediaCacheObjectProtections},
        ${mediaCacheObjects},
        ${mediaCacheBlobs},
        ${mediaCachePostPlans},
        ${telegramChannels}
      cascade
    `);
  });

  it('aggregates active shared-blob protection and ignores expired rows', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const firstObjectId = await createReadyObject();
    const secondObjectId = await createReadyObject();
    const thirdObjectId = await createReadyObject();
    const laterExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const nextExpiry = new Date(Date.now() + 60 * 60 * 1000);
    await service().protect({
      expiresAt: laterExpiry,
      initiator: {
        id: 'owner-1',
        kind: 'owner_session',
        reason: 'keep the public hero image',
      },
      objectId: firstObjectId,
    });
    await connection.db.insert(mediaCacheObjectProtections).values({
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      objectId: secondObjectId,
      ownerId: 'expired-local-operator',
      ownerKind: 'local_operator',
      protectedAt: new Date('2025-01-01T00:00:00.000Z'),
      reason: 'expired maintenance hold',
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    });
    await service().protect({
      expiresAt: nextExpiry,
      initiator: {
        id: 'owner-2',
        kind: 'owner_session',
        reason: 'keep the next-expiring reference',
      },
      objectId: thirdObjectId,
    });

    await expect(service().getActiveBlobProtection(SHARED_SHA256)).resolves.toEqual({
      activeCount: 2,
      blocked: true,
      hasIndefinite: false,
      nextExpiry,
    });

    await service().protect({
      initiator: {
        id: 'local-console',
        kind: 'local_operator',
        reason: 'pin a second reference',
      },
      objectId: secondObjectId,
    });
    await expect(service().getActiveBlobProtection(SHARED_SHA256)).resolves.toEqual({
      activeCount: 3,
      blocked: true,
      hasIndefinite: true,
      nextExpiry,
    });

    await service().unprotect({
      initiator: {
        id: 'owner-2',
        kind: 'owner_session',
        reason: 'release the next-expiring reference',
      },
      objectId: thirdObjectId,
    });
    await expect(service().getActiveBlobProtection(SHARED_SHA256)).resolves.toEqual({
      activeCount: 2,
      blocked: true,
      hasIndefinite: true,
      nextExpiry: laterExpiry,
    });

    await service().unprotect({
      initiator: {
        id: 'owner-1',
        kind: 'owner_session',
        reason: 'the first reference can be pruned',
      },
      objectId: firstObjectId,
    });
    await expect(service().getActiveBlobProtection(SHARED_SHA256)).resolves.toEqual({
      activeCount: 1,
      blocked: true,
      hasIndefinite: true,
      nextExpiry: null,
    });
    await service().unprotect({
      initiator: {
        id: 'local-console',
        kind: 'local_operator',
        reason: 'release the final pin',
      },
      objectId: secondObjectId,
    });
    await expect(service().getActiveBlobProtection(SHARED_SHA256)).resolves.toEqual({
      activeCount: 0,
      blocked: false,
      hasIndefinite: false,
      nextExpiry: null,
    });
  });

  it('upserts protection with truthful sanitized before/after audit state', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const objectId = await createReadyObject();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await connection.db.insert(mediaCacheObjectProtections).values({
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      objectId,
      ownerId: 'expired-private-id',
      ownerKind: 'local_operator',
      protectedAt: new Date('2025-01-01T00:00:00.000Z'),
      reason: 'expired private reason',
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    });
    await service().protect({
      expiresAt: futureExpiry,
      initiator: {
        id: 'owner-private-id',
        kind: 'owner_session',
        reason: 'first private reason',
      },
      objectId,
    });
    await service().protect({
      initiator: {
        id: 'local-private-id',
        kind: 'local_operator',
        reason: 'replacement private reason',
      },
      objectId,
    });

    const [protection] = await connection.db
      .select()
      .from(mediaCacheObjectProtections)
      .where(eq(mediaCacheObjectProtections.objectId, objectId));
    expect(protection).toMatchObject({
      expiresAt: null,
      ownerId: 'local-private-id',
      ownerKind: 'local_operator',
      reason: 'replacement private reason',
    });
    const actions = await connection.db
      .select()
      .from(mediaCacheActions)
      .where(eq(mediaCacheActions.objectId, objectId));
    expect(actions).toHaveLength(2);
    const initialAction = actions.find((action) => action.beforeState.protected === false);
    const replacementAction = actions.find((action) => action.beforeState.protected === true);
    expect(initialAction).toMatchObject({
      actionKind: 'protect',
      afterState: { configured: true, protected: true },
      beforeState: { configured: true, protected: false },
      initiatorKind: 'owner_session',
    });
    expect(replacementAction).toMatchObject({
      actionKind: 'protect',
      afterState: { configured: true, protected: true },
      initiatorKind: 'local_operator',
    });
    expect(replacementAction?.beforeState).toMatchObject({
      configured: true,
      expiresAt: futureExpiry.toISOString(),
      ownerKind: 'owner_session',
      protected: true,
    });
    const serializedStates = JSON.stringify(
      actions.map(({ afterState, beforeState }) => ({ afterState, beforeState })),
    );
    expect(serializedStates).not.toContain('private-id');
    expect(serializedStates).not.toContain('private reason');
  });

  it('keeps an expired configured row when unprotect is already applied', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const objectId = await createReadyObject();
    await connection.db.insert(mediaCacheObjectProtections).values({
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      objectId,
      ownerId: 'expired-owner',
      ownerKind: 'owner_session',
      protectedAt: new Date('2025-01-01T00:00:00.000Z'),
      reason: 'expired hold',
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    await expect(
      service().unprotect({
        initiator: {
          id: 'owner-1',
          kind: 'owner_session',
          reason: 'confirm the hold is inactive',
        },
        objectId,
      }),
    ).resolves.toMatchObject({
      alreadyApplied: true,
      protected: false,
    });

    const [retained] = await connection.db
      .select({ objectId: mediaCacheObjectProtections.objectId })
      .from(mediaCacheObjectProtections)
      .where(eq(mediaCacheObjectProtections.objectId, objectId));
    expect(retained).toEqual({ objectId });
    const actions = await connection.db
      .select({ actionKind: mediaCacheActions.actionKind })
      .from(mediaCacheActions)
      .where(eq(mediaCacheActions.objectId, objectId));
    expect(actions).toEqual([]);
  });

  it.each(['legacy_blob', 'storage_location'] as const)(
    'rejects protection without mutation while a shared %s is deleting',
    async (deletingKind) => {
      if (!connection) throw new Error('Database connection was not created');
      const objectId = await createReadyObject();
      if (deletingKind === 'legacy_blob') {
        await connection.db
          .update(mediaCacheBlobs)
          .set({
            evictionExpiresAt: new Date(Date.now() + 60_000),
            evictionOwner: 'worker-private-id',
            evictionToken: randomUUID(),
            state: 'deleting',
          })
          .where(eq(mediaCacheBlobs.sha256, SHARED_SHA256));
      } else {
        await connection.db.insert(mediaStorageBackends).values({
          configFingerprint: 'f'.repeat(64),
          id: 's3-default',
          kind: 's3',
          label: 'S3',
          maxBytes: 1024n,
        });
        await connection.db.insert(mediaBlobLocations).values({
          backendId: 's3-default',
          blobSha256: SHARED_SHA256,
          lastAccessedAt: new Date(),
          mutationExpiresAt: new Date(Date.now() + 60_000),
          mutationOwner: 'worker-private-id',
          mutationToken: randomUUID(),
          state: 'deleting',
          storageKey: `blobs/${SHARED_SHA256.slice(0, 2)}/${SHARED_SHA256.slice(2, 4)}/${SHARED_SHA256}`,
        });
      }

      await expect(
        service().protect({
          initiator: {
            id: 'owner-private-id',
            kind: 'owner_session',
            reason: 'private protection reason',
          },
          objectId,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'conflict',
          message: 'Cannot protect a media cache object while its blob is being deleted',
        }) satisfies Partial<MediaCacheObjectPolicyConflictError>,
      );
      await expect(
        connection.db
          .select()
          .from(mediaCacheObjectProtections)
          .where(eq(mediaCacheObjectProtections.objectId, objectId)),
      ).resolves.toEqual([]);
      await expect(
        connection.db
          .select()
          .from(mediaCacheActions)
          .where(eq(mediaCacheActions.objectId, objectId)),
      ).resolves.toEqual([]);
    },
  );

  it('unprotects idempotently and does not manufacture a second audit action', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const objectId = await createReadyObject();
    const initiator = {
      id: 'owner-1',
      kind: 'owner_session' as const,
      reason: 'release the explicit hold',
    };
    await service().protect({ initiator, objectId });

    await expect(service().unprotect({ initiator, objectId })).resolves.toMatchObject({
      alreadyApplied: false,
      protected: false,
    });
    await expect(service().unprotect({ initiator, objectId })).resolves.toMatchObject({
      alreadyApplied: true,
      protected: false,
    });
    const actions = await connection.db
      .select({ actionKind: mediaCacheActions.actionKind })
      .from(mediaCacheActions)
      .where(eq(mediaCacheActions.objectId, objectId));
    expect(actions).toEqual(
      expect.arrayContaining([{ actionKind: 'protect' }, { actionKind: 'unprotect' }]),
    );
    expect(actions).toHaveLength(2);
  });

  it('changes the default eviction policy once and audits its before/after values', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const objectId = await createReadyObject();
    const [before] = await connection.db
      .select({ policy: mediaCacheObjects.evictedPolicy })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, objectId));
    expect(before).toEqual({ policy: 'recache_on_access' });
    const input = {
      initiator: {
        id: 'local-console',
        kind: 'local_operator' as const,
        reason: 'keep this object cold after eviction',
      },
      objectId,
      policy: 'stay_evicted' as const,
    };

    await expect(service().setEvictedPolicy(input)).resolves.toEqual({
      alreadyApplied: false,
      objectId,
      policy: 'stay_evicted',
    });
    await expect(service().setEvictedPolicy(input)).resolves.toEqual({
      alreadyApplied: true,
      objectId,
      policy: 'stay_evicted',
    });

    const actions = await connection.db
      .select()
      .from(mediaCacheActions)
      .where(eq(mediaCacheActions.objectId, objectId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKind: 'set_evicted_policy',
      afterState: { evictedPolicy: 'stay_evicted' },
      beforeState: { evictedPolicy: 'recache_on_access' },
      initiatorKind: 'local_operator',
      reason: 'keep this object cold after eviction',
    });
  });

  it('returns a stable not-found error before any mutation', async () => {
    await expect(
      service().protect({
        initiator: {
          id: 'owner-1',
          kind: 'owner_session',
          reason: 'hold an unknown object',
        },
        objectId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(MediaCacheObjectPolicyNotFoundError);
  });
});
