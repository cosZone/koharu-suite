import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMediaBlobStore } from '../src/media-cache/blob-store.js';
import { MediaCacheLedgerError } from '../src/media-cache/ledger-repository.js';
import {
  TelegramMediaSourcePermanentError,
  TelegramMediaSourceTransientError,
} from '../src/media-cache/telegram-source.js';
import { MediaCacheWorker } from '../src/media-cache/worker.js';

const PLAN_ID = '10000000-0000-4000-8000-000000000001';
const OBJECT_ID = '20000000-0000-4000-8000-000000000001';
const LEASE_TOKEN = '30000000-0000-4000-8000-000000000001';
const OLD_LEASE_TOKEN = '30000000-0000-4000-8000-000000000002';
const THUMBNAIL_ID = '20000000-0000-4000-8000-000000000002';
const SECOND_OBJECT_ID = '20000000-0000-4000-8000-000000000003';
const THIRD_OBJECT_ID = '20000000-0000-4000-8000-000000000004';
const JPEG_FIXTURE = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const MP4_20_MIB_FIXTURE = new Uint8Array(20 * 1024 * 1024);
MP4_20_MIB_FIXTURE.set([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('bounded media cache worker', () => {
  it('runs no more than the configured original download concurrency in parallel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-concurrency-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const planIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    let active = 0;
    let maxActive = 0;
    let releaseClaims: (() => void) | undefined;
    const allClaimsEntered = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    const claimPostPlan = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 3) {
        releaseClaims?.();
      }
      await allClaimsEntered;
      active -= 1;
      return null;
    });
    const listRunnablePostPlanIds = vi.fn(async (limit: number) => planIds.slice(0, limit));
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan,
        completeSettlement: vi.fn(async () => undefined),
        failClaimedPostPlan: vi.fn(async () => undefined),
        markExpiredRecoveryFailed: vi.fn(async () => true),
        recordPublishedObjects: vi.fn(async () => undefined),
        recoverExpiredPostPlan: vi.fn(async () => null),
        skipClaimedObject: vi.fn(async () => true),
      },
      leaseOwner: 'worker-concurrency-test',
      maxPlansPerRun: 3,
      source: {
        open: vi.fn(async () => {
          throw new Error('No plan should be claimed');
        }),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 0),
        listExpiredPostPlanIds: vi.fn(async () => []),
        listRunnablePostPlanIds,
        loadClaimedOriginals: vi.fn(async () => []),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completedPlans: 0,
      failedPlans: 0,
    });
    expect(listRunnablePostPlanIds).toHaveBeenCalledWith(3);
    expect(claimPostPlan).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(3);
  });

  it('discovers, claims, streams, validates, publishes, and settles one original plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();

    const publish = vi.fn(async () => undefined);
    const completeSettlement = vi.fn(async () => undefined);
    const ledger = {
      claimPostPlan: vi.fn(async () => ({
        objectIds: [OBJECT_ID],
        planId: PLAN_ID,
        requestedBytes: 10n * 1024n * 1024n,
      })),
      completeSettlement,
      failClaimedPostPlan: vi.fn(async () => undefined),
      markExpiredRecoveryFailed: vi.fn(async () => true),
      recordPublishedObjects: vi.fn(async (input: { publish: () => Promise<void> }) => {
        await input.publish();
        await publish();
      }),
      recoverExpiredPostPlan: vi.fn(async () => null),
      skipClaimedObject: vi.fn(async () => true),
    };
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 1,
          plansCreated: 1,
          scanned: 1,
          sourcesCreated: 1,
        })),
      },
      ledger,
      leaseDurationMs: 30_000,
      leaseOwner: 'worker-test',
      randomUuid: () => LEASE_TOKEN,
      source: {
        open: vi.fn(async () => ({
          declaredBytes: BigInt(JPEG_FIXTURE.byteLength),
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(JPEG_FIXTURE);
              controller.close();
            },
          }),
        })),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 1),
        listExpiredPostPlanIds: vi.fn(async () => []),
        listRunnablePostPlanIds: vi.fn(async () => [PLAN_ID]),
        loadClaimedOriginals: vi.fn(async () => [
          {
            kind: 'photo' as const,
            objectId: OBJECT_ID,
            position: 0,
            sources: [{ fileId: 'telegram-file-1' }],
          },
        ]),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completedPlans: 1,
      discovered: 1,
      failedPlans: 0,
      recoveredPlans: 0,
    });
    expect(ledger.recordPublishedObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseToken: LEASE_TOKEN,
        objects: [
          expect.objectContaining({
            byteLength: BigInt(JPEG_FIXTURE.byteLength),
            detectedMime: 'image/jpeg',
            objectId: OBJECT_ID,
          }),
        ],
        planId: PLAN_ID,
      }),
    );
    expect(publish).toHaveBeenCalledOnce();
    expect(completeSettlement).toHaveBeenCalledWith({
      leaseToken: LEASE_TOKEN,
      planId: PLAN_ID,
    });
  });

  it('falls back to the next current Bot evidence only after a permanent source failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-fallback-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const open = vi
      .fn()
      .mockRejectedValueOnce(new TelegramMediaSourcePermanentError('sanitized permanent failure'))
      .mockResolvedValueOnce({
        declaredBytes: BigInt(JPEG_FIXTURE.byteLength),
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(JPEG_FIXTURE);
            controller.close();
          },
        }),
      });
    const ledger = {
      claimPostPlan: vi.fn(async () => ({
        objectIds: [OBJECT_ID],
        planId: PLAN_ID,
        requestedBytes: 10n * 1024n * 1024n,
      })),
      completeSettlement: vi.fn(async () => undefined),
      failClaimedPostPlan: vi.fn(async () => undefined),
      markExpiredRecoveryFailed: vi.fn(async () => true),
      recordPublishedObjects: vi.fn(async (input: { publish: () => Promise<void> }) =>
        input.publish(),
      ),
      recoverExpiredPostPlan: vi.fn(async () => null),
      skipClaimedObject: vi.fn(async () => true),
    };
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger,
      leaseOwner: 'worker-test',
      randomUuid: () => LEASE_TOKEN,
      source: { open },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 1),
        listExpiredPostPlanIds: vi.fn(async () => []),
        listRunnablePostPlanIds: vi.fn(async () => [PLAN_ID]),
        loadClaimedOriginals: vi.fn(async () => [
          {
            kind: 'photo' as const,
            objectId: OBJECT_ID,
            position: 0,
            sources: [{ fileId: 'stale-locator' }, { fileId: 'working-locator' }],
          },
        ]),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completedPlans: 1,
      failedPlans: 0,
    });
    expect(open).toHaveBeenNthCalledWith(1, expect.objectContaining({ fileId: 'stale-locator' }));
    expect(open).toHaveBeenNthCalledWith(2, expect.objectContaining({ fileId: 'working-locator' }));
  });

  it('stops fallback on a transient source error and releases the plan through durable retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-retry-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const open = vi.fn(async () => {
      throw new TelegramMediaSourceTransientError('sanitized transient failure');
    });
    const failClaimedPostPlan = vi.fn(async (input: { cleanup: () => Promise<void> }) => {
      await input.cleanup();
      return {
        attemptCount: 1,
        availableAt: new Date(),
        nextState: 'retry_wait' as const,
        planId: PLAN_ID,
        releasedReservationBytes: 10n * 1024n * 1024n,
      };
    });
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan: vi.fn(async () => ({
          objectIds: [OBJECT_ID],
          planId: PLAN_ID,
          requestedBytes: 10n * 1024n * 1024n,
        })),
        completeSettlement: vi.fn(async () => undefined),
        failClaimedPostPlan,
        markExpiredRecoveryFailed: vi.fn(async () => true),
        recordPublishedObjects: vi.fn(async () => undefined),
        recoverExpiredPostPlan: vi.fn(async () => null),
        skipClaimedObject: vi.fn(async () => true),
      },
      leaseOwner: 'worker-test',
      randomUuid: () => LEASE_TOKEN,
      source: { open },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 0),
        listExpiredPostPlanIds: vi.fn(async () => []),
        listRunnablePostPlanIds: vi.fn(async () => [PLAN_ID]),
        loadClaimedOriginals: vi.fn(async () => [
          {
            kind: 'photo' as const,
            objectId: OBJECT_ID,
            position: 0,
            sources: [{ fileId: 'temporarily-broken' }, { fileId: 'must-not-fallback' }],
          },
        ]),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completedPlans: 0,
      failedPlans: 1,
    });
    expect(open).toHaveBeenCalledOnce();
    expect(failClaimedPostPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'retry',
        errorClass: 'source',
        errorCode: 'telegram_media_source_transient',
        leaseToken: LEASE_TOKEN,
        planId: PLAN_ID,
      }),
    );
  });

  it('fails the whole post and removes every staged original when actual aggregate bytes exceed 50 MiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-post-limit-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const publish = vi.spyOn(blobs, 'publish');
    const recordPublishedObjects = vi.fn(async () => undefined);
    const skipClaimedObject = vi.fn(async () => true);
    const failClaimedPostPlan = vi.fn(async (input: { cleanup: () => Promise<void> }) => {
      await input.cleanup();
    });
    const objectIds = [OBJECT_ID, SECOND_OBJECT_ID, THIRD_OBJECT_ID];
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan: vi.fn(async () => ({
          objectIds,
          planId: PLAN_ID,
          requestedBytes: 50n * 1024n * 1024n,
        })),
        completeSettlement: vi.fn(async () => undefined),
        failClaimedPostPlan,
        markExpiredRecoveryFailed: vi.fn(async () => true),
        recordPublishedObjects,
        recoverExpiredPostPlan: vi.fn(async () => null),
        skipClaimedObject,
      },
      leaseOwner: 'worker-post-limit-test',
      randomUuid: () => LEASE_TOKEN,
      source: {
        open: vi.fn(async () => ({
          declaredBytes: null,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(MP4_20_MIB_FIXTURE);
              controller.close();
            },
          }),
        })),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 0),
        listExpiredPostPlanIds: vi.fn(async () => []),
        listRunnablePostPlanIds: vi.fn(async () => [PLAN_ID]),
        loadClaimedOriginals: vi.fn(async () =>
          objectIds.map((objectId, position) => ({
            kind: 'video' as const,
            objectId,
            position,
            sources: [{ fileId: `telegram-file-${position}` }],
          })),
        ),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completedPlans: 0,
      failedPlans: 1,
    });
    expect(failClaimedPostPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'skip',
        errorClass: 'source',
        errorCode: 'skipped_post_limit',
        reasonCode: 'skipped_post_limit',
      }),
    );
    expect(skipClaimedObject).not.toHaveBeenCalled();
    expect(recordPublishedObjects).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(blobs.recoverLease({ leaseToken: LEASE_TOKEN, planId: PLAN_ID })).resolves.toEqual(
      [],
    );
  });

  it('settles a sticky hash mismatch as one auditable integrity conflict without retrying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-sticky-conflict-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const publish = vi.spyOn(blobs, 'publish');
    const failClaimedPostPlan = vi.fn(async (input: { cleanup: () => Promise<void> }) => {
      await input.cleanup();
    });
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan: vi.fn(async () => ({
          objectIds: [OBJECT_ID],
          planId: PLAN_ID,
          requestedBytes: 10n * 1024n * 1024n,
        })),
        completeSettlement: vi.fn(async () => undefined),
        failClaimedPostPlan,
        markExpiredRecoveryFailed: vi.fn(async () => true),
        recordPublishedObjects: vi.fn(async () => {
          throw new MediaCacheLedgerError(
            'sticky_hash_conflict',
            'sanitized sticky hash conflict',
            OBJECT_ID,
          );
        }),
        recoverExpiredPostPlan: vi.fn(async () => null),
        skipClaimedObject: vi.fn(async () => true),
      },
      leaseOwner: 'worker-sticky-conflict-test',
      randomUuid: () => LEASE_TOKEN,
      source: {
        open: vi.fn(async () => ({
          declaredBytes: BigInt(JPEG_FIXTURE.byteLength),
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(JPEG_FIXTURE);
              controller.close();
            },
          }),
        })),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 0),
        listExpiredPostPlanIds: vi.fn(async () => []),
        listRunnablePostPlanIds: vi.fn(async () => [PLAN_ID]),
        loadClaimedOriginals: vi.fn(async () => [
          {
            kind: 'photo' as const,
            objectId: OBJECT_ID,
            position: 0,
            sources: [{ fileId: 'changed-bytes' }],
          },
        ]),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      completedPlans: 0,
      failedPlans: 1,
    });
    expect(failClaimedPostPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictingObjectId: OBJECT_ID,
        disposition: 'integrity_conflict',
        errorClass: 'integrity',
        errorCode: 'sticky_hash_conflict',
        reasonCode: 'integrity_conflict',
      }),
    );
    expect(publish).not.toHaveBeenCalled();
    await expect(blobs.recoverLease({ leaseToken: LEASE_TOKEN, planId: PLAN_ID })).resolves.toEqual(
      [],
    );
  });

  it('settles expired precommit staging before releasing its reservation to retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-recovery-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    await blobs.stage({
      lease: { leaseToken: OLD_LEASE_TOKEN, planId: PLAN_ID },
      maxBytes: 1024,
      objectId: OBJECT_ID,
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(JPEG_FIXTURE);
          controller.close();
        },
      }),
    });
    const recoverExpiredPostPlan = vi.fn(
      async (input: {
        recover: (snapshot: {
          objects: Array<{
            actualBytes: bigint | null;
            blobSha256: string | null;
            objectId: string;
          }>;
          phase: 'precommit';
          planId: string;
          previousLeaseToken: string;
        }) => Promise<void>;
      }) => {
        await input.recover({
          objects: [{ actualBytes: null, blobSha256: null, objectId: OBJECT_ID }],
          phase: 'precommit',
          planId: PLAN_ID,
          previousLeaseToken: OLD_LEASE_TOKEN,
        });
        return {
          nextState: 'retry_wait' as const,
          planId: PLAN_ID,
          releasedReservationBytes: 10n * 1024n * 1024n,
        };
      },
    );
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan: vi.fn(async () => null),
        completeSettlement: vi.fn(async () => undefined),
        failClaimedPostPlan: vi.fn(async () => undefined),
        markExpiredRecoveryFailed: vi.fn(async () => true),
        recordPublishedObjects: vi.fn(async () => undefined),
        recoverExpiredPostPlan,
        skipClaimedObject: vi.fn(async () => true),
      },
      leaseOwner: 'worker-recovery-test',
      randomUuid: () => LEASE_TOKEN,
      source: {
        open: vi.fn(async () => {
          throw new Error('source should not be opened during recovery');
        }),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 0),
        listExpiredPostPlanIds: vi.fn(async () => [PLAN_ID]),
        listRunnablePostPlanIds: vi.fn(async () => []),
        loadClaimedOriginals: vi.fn(async () => []),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      failedPlans: 0,
      recoveredPlans: 1,
    });
    await expect(
      blobs.recoverLease({ leaseToken: OLD_LEASE_TOKEN, planId: PLAN_ID }),
    ).resolves.toEqual([]);
    expect(recoverExpiredPostPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseOwner: 'worker-recovery-test',
        leaseToken: LEASE_TOKEN,
        planId: PLAN_ID,
      }),
    );
  });

  it('keeps retrying exhausted recovery work after cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-exhausted-recovery-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    let attemptCount = 10;
    const markExpiredRecoveryFailed = vi.fn(async () => {
      attemptCount = Math.min(attemptCount + 1, 10);
      return true;
    });
    const recoverExpiredPostPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('simulated cleanup failure'))
      .mockResolvedValueOnce({
        nextState: 'blocked' as const,
        planId: PLAN_ID,
        releasedReservationBytes: 10n * 1024n * 1024n,
      });
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan: vi.fn(async () => null),
        completeSettlement: vi.fn(async () => undefined),
        failClaimedPostPlan: vi.fn(async () => undefined),
        markExpiredRecoveryFailed,
        recordPublishedObjects: vi.fn(async () => undefined),
        recoverExpiredPostPlan,
        skipClaimedObject: vi.fn(async () => true),
      },
      leaseOwner: 'worker-exhausted-recovery-test',
      randomUuid: () => LEASE_TOKEN,
      source: {
        open: vi.fn(async () => {
          throw new Error('source should not be opened during recovery');
        }),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 0),
        listExpiredPostPlanIds: vi.fn(async () => (attemptCount === 10 ? [PLAN_ID] : [])),
        listRunnablePostPlanIds: vi.fn(async () => []),
        loadClaimedOriginals: vi.fn(async () => []),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ recoveredPlans: 0 });
    expect(markExpiredRecoveryFailed).toHaveBeenCalledOnce();
    expect(attemptCount).toBe(10);
    await expect(worker.runOnce()).resolves.toMatchObject({ recoveredPlans: 1 });
    expect(recoverExpiredPostPlan).toHaveBeenCalledTimes(2);
  });

  it('verifies and settles expired postcommit staging before completing with the fresh token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-postcommit-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const staged = await blobs.stage({
      lease: { leaseToken: OLD_LEASE_TOKEN, planId: PLAN_ID },
      maxBytes: 1024,
      objectId: OBJECT_ID,
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(JPEG_FIXTURE);
          controller.close();
        },
      }),
    });
    const published = await blobs.publish(staged);
    const completeSettlement = vi.fn(async () => undefined);
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan: vi.fn(async () => null),
        completeSettlement,
        failClaimedPostPlan: vi.fn(async () => undefined),
        markExpiredRecoveryFailed: vi.fn(async () => true),
        recordPublishedObjects: vi.fn(async () => undefined),
        recoverExpiredPostPlan: vi.fn(async (input) => {
          await input.recover({
            objects: [
              {
                actualBytes: BigInt(staged.byteLength),
                blobSha256: staged.sha256,
                objectId: OBJECT_ID,
              },
            ],
            phase: 'postcommit',
            planId: PLAN_ID,
            previousLeaseToken: OLD_LEASE_TOKEN,
          });
          return {
            leaseToken: LEASE_TOKEN,
            nextState: 'settling' as const,
            planId: PLAN_ID,
            releasedReservationBytes: 0n as const,
          };
        }),
        skipClaimedObject: vi.fn(async () => true),
      },
      leaseOwner: 'worker-recovery-test',
      randomUuid: () => LEASE_TOKEN,
      source: {
        open: vi.fn(async () => {
          throw new Error('source should not be opened during recovery');
        }),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 1),
        listExpiredPostPlanIds: vi.fn(async () => [PLAN_ID]),
        listRunnablePostPlanIds: vi.fn(async () => []),
        loadClaimedOriginals: vi.fn(async () => []),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ recoveredPlans: 1 });
    expect(completeSettlement).toHaveBeenCalledWith({
      leaseToken: LEASE_TOKEN,
      planId: PLAN_ID,
    });
    await expect(
      blobs.recoverLease({ leaseToken: OLD_LEASE_TOKEN, planId: PLAN_ID }),
    ).resolves.toEqual([]);
    const final = await blobs.open(published);
    await final.close();
  });

  it('generates and independently settles one bounded WebP thumbnail after original work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-worker-thumbnail-'));
    temporaryDirectories.push(root);
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const originalStage = await blobs.stage({
      lease: { leaseToken: OLD_LEASE_TOKEN, planId: PLAN_ID },
      maxBytes: 1024,
      objectId: OBJECT_ID,
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(png);
          controller.close();
        },
      }),
    });
    const original = await blobs.publish(originalStage);
    await blobs.settle(originalStage, 'db_committed');
    const complete = vi.fn(async () => undefined);
    const recordPublished = vi.fn(async (input: { publish: () => Promise<void> }) =>
      input.publish(),
    );
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: vi.fn(async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        })),
      },
      ledger: {
        claimPostPlan: vi.fn(async () => null),
        completeSettlement: vi.fn(async () => undefined),
        failClaimedPostPlan: vi.fn(async () => undefined),
        markExpiredRecoveryFailed: vi.fn(async () => true),
        recordPublishedObjects: vi.fn(async () => undefined),
        recoverExpiredPostPlan: vi.fn(async () => null),
        skipClaimedObject: vi.fn(async () => true),
      },
      leaseOwner: 'worker-thumbnail-test',
      randomUuid: () => LEASE_TOKEN,
      source: {
        open: vi.fn(async () => {
          throw new Error('Telegram source should not be opened for thumbnails');
        }),
      },
      thumbnailLedger: {
        claim: vi.fn(async () => ({
          objectId: THUMBNAIL_ID,
          original: {
            byteLength: BigInt(original.byteLength),
            detectedMime: 'image/png',
            relativeKey: original.relativeKey,
            sha256: original.sha256,
          },
          planId: PLAN_ID,
        })),
        complete,
        fail: vi.fn(async () => undefined),
        recordPublished,
        recoverExpired: vi.fn(async () => null),
      },
      work: {
        ensureThumbnailObjects: vi.fn(async () => 0),
        listExpiredPostPlanIds: vi.fn(async () => []),
        listRunnablePostPlanIds: vi.fn(async () => []),
        listRunnableThumbnailObjectIds: vi.fn(async () => [THUMBNAIL_ID]),
        loadClaimedOriginals: vi.fn(async () => []),
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      thumbnailsCompleted: 1,
      thumbnailsSkipped: 0,
    });
    expect(recordPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        object: expect.objectContaining({
          detectedMime: 'image/webp',
          objectId: THUMBNAIL_ID,
        }),
      }),
    );
    expect(complete).toHaveBeenCalledWith({
      leaseToken: LEASE_TOKEN,
      objectId: THUMBNAIL_ID,
    });
  });
});
