import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  messageSourceObservations,
  messages,
  operationAuditEvents,
  reconciliationActions,
  reconciliationFindings,
  reconciliationRuns,
  reconciliationSchedule,
  telegramChannelAllowlist,
  telegramChannels,
  telegramPollingState,
} from '../../src/db/schema.js';
import { PostgresReconciliationPersistenceRepository } from '../../src/reconciliation/persistence-repository.js';
import type {
  ReconciliationCandidate,
  ReconciliationCandidateVisitor,
  ReconciliationScanSnapshot,
  ReconciliationSnapshotScanner,
  ReconciliationTransaction,
} from '../../src/reconciliation/repository.js';
import {
  PostgresReconciliationScheduleRepository,
  type ReconciliationScheduleLease,
} from '../../src/reconciliation/schedule-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_A = -1_001n;
const CHANNEL_B = -1_002n;

describe('persisted reconciliation lifecycle', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connection: DatabaseConnection | undefined;

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
    await connection?.db.execute(sql`
      truncate table
        ${reconciliationActions},
        ${reconciliationFindings},
        ${reconciliationSchedule},
        ${reconciliationRuns},
        ${messageSourceObservations},
        ${messages},
        ${operationAuditEvents},
        ${telegramPollingState},
        ${telegramChannelAllowlist},
        ${telegramChannels}
      cascade
    `);
  });

  it('lists the most recent findings and runs with stable bounded cursors', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const older = new Date('2026-07-24T10:00:00.000Z');
    const newer = new Date('2026-07-24T11:00:00.000Z');
    const insertedFindings = await connection.db
      .insert(reconciliationFindings)
      .values([
        {
          evidenceVersion: 1,
          firstSeenAt: older,
          kind: 'retention_risk',
          lastSeenAt: older,
          sanitizedDetails: { reason: 'older' },
          severity: 'warning',
          stableKey: 'retention:older',
        },
        {
          evidenceVersion: 1,
          firstSeenAt: newer,
          kind: 'retention_risk',
          lastSeenAt: newer,
          sanitizedDetails: { reason: 'newer' },
          severity: 'warning',
          stableKey: 'retention:newer',
        },
      ])
      .returning({ id: reconciliationFindings.id, stableKey: reconciliationFindings.stableKey });
    const insertedRuns = await connection.db
      .insert(reconciliationRuns)
      .values([
        {
          completedAt: older,
          initiatorKind: 'local_operator',
          mode: 'persisted_scan',
          report: {},
          scope: [],
          startedAt: older,
          status: 'completed',
        },
        {
          completedAt: newer,
          initiatorKind: 'local_operator',
          mode: 'persisted_scan',
          report: {},
          scope: [],
          startedAt: newer,
          status: 'completed',
        },
      ])
      .returning({ id: reconciliationRuns.id, startedAt: reconciliationRuns.startedAt });
    const repository = new PostgresReconciliationPersistenceRepository(connection.db);

    const firstFindingsPage = await repository.listFindings({ limit: 1 });
    expect(firstFindingsPage.items.map((finding) => finding.stableKey)).toEqual([
      'retention:newer',
    ]);
    expect(firstFindingsPage.nextCursor).toBe(
      insertedFindings.find((finding) => finding.stableKey === 'retention:newer')?.id,
    );
    await expect(
      repository.listFindings({ cursor: firstFindingsPage.nextCursor ?? '', limit: 1 }),
    ).resolves.toMatchObject({
      items: [{ stableKey: 'retention:older' }],
      nextCursor: null,
    });

    const firstRunsPage = await repository.listRuns({ limit: 1 });
    expect(firstRunsPage.items[0]?.startedAt).toBe(newer.toISOString());
    expect(firstRunsPage.nextCursor).toBe(
      insertedRuns.find((run) => run.startedAt.getTime() === newer.getTime())?.id,
    );
    await expect(
      repository.listRuns({ cursor: firstRunsPage.nextCursor ?? '', limit: 1 }),
    ).resolves.toMatchObject({
      items: [{ startedAt: older.toISOString() }],
      nextCursor: null,
    });
  });

  it('persists a disable window after re-enable and preserves its verified resolution', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const now = new Date('2026-07-24T12:00:00.000Z');
    const disabledAt = new Date('2026-07-24T10:00:00.000Z');
    await connection.db.insert(telegramChannelAllowlist).values({
      disabledAt,
      enabled: false,
      telegramChatId: CHANNEL_A,
      title: 'Historical window',
      username: 'historical_window',
    });
    await connection.db.insert(telegramPollingState).values({
      botId: 123_456n,
      nextUpdateId: 1n,
      updatedAt: now,
    });
    await connection.db.insert(operationAuditEvents).values({
      action: 'channel.disable',
      actorId: 'owner-1',
      actorType: 'owner_session',
      createdAt: disabledAt,
      targetId: CHANNEL_A.toString(),
      targetType: 'channel',
    });

    const repository = new PostgresReconciliationPersistenceRepository(connection.db);
    const first = await repository.persistScan({
      initiatorKind: 'local_operator',
      now,
      telegramChannelIds: [CHANNEL_A],
    });
    expect(first.report.findings).toEqual([
      expect.objectContaining({
        channelId: CHANNEL_A.toString(),
        kind: 'disabled_window',
        state: 'open',
      }),
    ]);
    const [firstFinding] = await connection.db.select().from(reconciliationFindings);
    if (!firstFinding) {
      throw new Error('Persisted finding was not created');
    }
    const firstSeenAt = firstFinding.firstSeenAt;
    await expect(
      repository.ignoreFinding({
        expectedEvidenceVersion: 1,
        findingId: firstFinding.id,
        initiatorId: 'owner-1',
        initiatorKind: 'owner_session',
        reason: 'Verified that this historical window is already covered',
      }),
    ).resolves.toMatchObject({ state: 'ignored' });

    const enabledAt = new Date('2026-07-24T11:00:00.000Z');
    await connection.db
      .update(telegramChannelAllowlist)
      .set({ disabledAt: null, enabled: true })
      .where(eq(telegramChannelAllowlist.telegramChatId, CHANNEL_A));
    await connection.db.insert(operationAuditEvents).values({
      action: 'channel.enable',
      actorId: 'owner-1',
      actorType: 'owner_session',
      createdAt: enabledAt,
      targetId: CHANNEL_A.toString(),
      targetType: 'channel',
    });

    const second = await repository.persistScan({
      initiatorKind: 'local_operator',
      now: new Date('2026-07-24T12:05:00.000Z'),
      telegramChannelIds: [CHANNEL_A],
    });
    expect(second.report.findings).toEqual([
      expect.objectContaining({
        kind: 'disabled_window',
        stableKey: firstFinding.stableKey,
        state: 'ignored',
      }),
    ]);
    const persistedFindings = await connection.db.select().from(reconciliationFindings);
    expect(persistedFindings).toHaveLength(1);
    expect(persistedFindings[0]).toMatchObject({
      firstSeenAt,
      id: firstFinding.id,
      state: 'ignored',
    });
    const runs = await connection.db
      .select({ report: reconciliationRuns.report, status: reconciliationRuns.status })
      .from(reconciliationRuns)
      .orderBy(asc(reconciliationRuns.startedAt));
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe('partial');
    expect(runs[1]?.status).toBe('completed');
    expect(runs[1]?.report).toMatchObject({ status: 'clean' });
    const actions = await connection.db.select().from(reconciliationActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKind: 'ignore_finding',
      reason: 'Verified that this historical window is already covered',
    });
  });

  it('rolls back cross-channel findings and reopens resolved state only for newer evidence', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const channelA = await createChannel(connection, CHANNEL_A, 'channel_a');
    const channelB = await createChannel(connection, CHANNEL_B, 'channel_b');
    const [message] = await connection.db
      .insert(messages)
      .values({
        channelId: channelB,
        publishedAt: new Date('2026-07-24T10:00:00.000Z'),
        telegramMessageId: 42n,
      })
      .returning({ id: messages.id });
    if (!message) {
      throw new Error('Fixture message was not created');
    }
    const [observation] = await connection.db
      .insert(messageSourceObservations)
      .values({
        channelId: channelB,
        contentFingerprint: 'fixture-conflict',
        contentFingerprintVersion: 1,
        messageId: message.id,
        rawJson: {},
        resolution: 'conflict',
        sourceKey: 'desktop:fixture:42',
        sourceKind: 'telegram_desktop_json',
        telegramMessageId: 42n,
      })
      .returning({ id: messageSourceObservations.id });
    if (!observation) {
      throw new Error('Fixture observation was not created');
    }
    expect(channelA).not.toBe(channelB);

    const candidate = {
      channelId: CHANNEL_B.toString(),
      evidenceIds: ['conflict-evidence'],
      evidenceVersion: 1,
      kind: 'observation_conflict',
      messageId: message.id,
      observationId: observation.id,
      sanitizedReason: 'A source observation conflicts with the current revision',
      severity: 'warning',
    } as const satisfies ReconciliationCandidate;
    const invalidRepository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([{ ...candidate, channelId: CHANNEL_A.toString() }]),
    );
    await expect(
      invalidRepository.persistScan({
        initiatorKind: 'local_operator',
        telegramChannelIds: [CHANNEL_A],
      }),
    ).rejects.toThrow('belongs to another channel');
    const [runCount] = await connection.db.select({ value: count() }).from(reconciliationRuns);
    const [findingCount] = await connection.db
      .select({ value: count() })
      .from(reconciliationFindings);
    expect(runCount?.value).toBe(0);
    expect(findingCount?.value).toBe(0);

    const firstRepository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([candidate]),
    );
    await firstRepository.persistScan({
      initiatorKind: 'local_operator',
      telegramChannelIds: [CHANNEL_B],
    });
    const [finding] = await connection.db.select().from(reconciliationFindings);
    if (!finding) {
      throw new Error('Fixture finding was not persisted');
    }
    await expect(
      firstRepository.ignoreFinding({
        expectedEvidenceVersion: 1,
        findingId: finding.id,
        initiatorId: 'service-token-1',
        initiatorKind: 'service_token',
        reason: 'service token must not ignore',
      }),
    ).rejects.toThrow('Only an identified owner session');
    await expect(
      firstRepository.ignoreFinding({
        expectedEvidenceVersion: 2,
        findingId: finding.id,
        initiatorId: 'owner-1',
        initiatorKind: 'owner_session',
        reason: 'stale verifier',
      }),
    ).rejects.toThrow('evidence version changed');
    await expect(
      firstRepository.ignoreFinding({
        expectedEvidenceVersion: 1,
        findingId: finding.id,
        initiatorId: 'owner-1',
        initiatorKind: 'owner_session',
        reason: 'x'.repeat(501),
      }),
    ).rejects.toThrow('between 1 and 500');
    await firstRepository.ignoreFinding({
      expectedEvidenceVersion: 1,
      findingId: finding.id,
      initiatorId: 'owner-1',
      initiatorKind: 'owner_session',
      reason: '  Owner accepts this conflict  ',
    });

    const secondRepository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([{ ...candidate, evidenceVersion: 2 }]),
    );
    await secondRepository.persistScan({
      initiatorKind: 'local_operator',
      telegramChannelIds: [CHANNEL_B],
    });
    const [reopened] = await connection.db.select().from(reconciliationFindings);
    expect(reopened).toMatchObject({
      evidenceVersion: 2,
      id: finding.id,
      resolvedAt: null,
      state: 'open',
    });
    const actions = await connection.db
      .select({
        actionKind: reconciliationActions.actionKind,
        reason: reconciliationActions.reason,
      })
      .from(reconciliationActions)
      .orderBy(asc(reconciliationActions.createdAt));
    expect(actions).toEqual([
      { actionKind: 'ignore_finding', reason: 'Owner accepts this conflict' },
      {
        actionKind: 'reopen_new_evidence',
        reason: 'A newer evidence version reopened this finding',
      },
    ]);
  });

  it('auto-resolves only absent exhaustive findings and preserves non-exhaustive risk', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    await connection.db.insert(telegramChannelAllowlist).values({
      telegramChatId: CHANNEL_A,
      title: 'Exhaustive verifier',
      username: 'exhaustive_verifier',
    });
    const initialCandidates = [
      findingCandidate('derived_html_drift', 'derived'),
      findingCandidate('media_evidence_missing', 'media'),
      findingCandidate('durable_pending', 'pending'),
      findingCandidate('message_id_candidate', 'message-gap'),
      findingCandidate('observation_conflict', 'immutable-conflict'),
      findingCandidate('operator_skipped', 'immutable-skip'),
      findingCandidate('disabled_window', 'disabled-risk'),
      {
        channelId: null,
        evidenceIds: ['retention-risk'],
        evidenceVersion: 1,
        kind: 'retention_risk',
        sanitizedReason: 'retention risk fixture',
        severity: 'warning',
      },
    ] satisfies ReconciliationCandidate[];
    const initialRepository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner(initialCandidates),
    );
    await initialRepository.persistScan({
      initiatorKind: 'local_operator',
      telegramChannelIds: [CHANNEL_A],
    });

    const nextRepository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([
        findingCandidate('disabled_window', 'disabled-risk'),
        findingCandidate('observation_conflict', 'immutable-conflict'),
        findingCandidate('operator_skipped', 'immutable-skip'),
      ]),
    );
    const result = await nextRepository.persistScan({
      initiatorKind: 'local_operator',
      telegramChannelIds: [CHANNEL_A],
    });
    expect(result.report.counts.resolved).toBe(5);
    const findings = await connection.db
      .select({
        kind: reconciliationFindings.kind,
        state: reconciliationFindings.state,
      })
      .from(reconciliationFindings)
      .orderBy(asc(reconciliationFindings.kind));
    expect(findings).toEqual([
      { kind: 'derived_html_drift', state: 'resolved' },
      { kind: 'disabled_window', state: 'open' },
      { kind: 'durable_pending', state: 'resolved' },
      { kind: 'media_evidence_missing', state: 'resolved' },
      { kind: 'message_id_candidate', state: 'resolved' },
      { kind: 'observation_conflict', state: 'open' },
      { kind: 'operator_skipped', state: 'open' },
      { kind: 'retention_risk', state: 'resolved' },
    ]);
    const actions = await connection.db
      .select({ actionKind: reconciliationActions.actionKind })
      .from(reconciliationActions);
    expect(actions).toHaveLength(5);
    expect(actions.every((action) => action.actionKind === 'resolve_verified_invariant')).toBe(
      true,
    );

    const repeatedRepository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([
        findingCandidate('derived_html_drift', 'derived'),
        findingCandidate('disabled_window', 'disabled-risk'),
      ]),
    );
    await repeatedRepository.persistScan({
      initiatorKind: 'local_operator',
      telegramChannelIds: [CHANNEL_A],
    });
    const [sameEvidence] = await connection.db
      .select({ state: reconciliationFindings.state })
      .from(reconciliationFindings)
      .where(eq(reconciliationFindings.kind, 'derived_html_drift'));
    expect(sameEvidence?.state).toBe('resolved');
  });

  it('reconstructs a disable window whose enable audit crosses the 500-row page boundary', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const base = new Date('2026-07-24T10:00:00.000Z');
    const now = new Date('2026-07-24T12:00:00.000Z');
    await connection.db.insert(telegramChannelAllowlist).values({
      telegramChatId: CHANNEL_A,
      title: 'Audit page boundary',
      username: 'audit_page_boundary',
    });
    await connection.db.insert(telegramPollingState).values({
      botId: 123_456n,
      nextUpdateId: 1n,
      updatedAt: now,
    });
    await connection.db.insert(operationAuditEvents).values([
      ...Array.from({ length: 499 }, (_, index) => ({
        action: 'channel.enable' as const,
        actorId: 'owner-1',
        actorType: 'owner_session' as const,
        createdAt: new Date(base.getTime() + index),
        targetId: CHANNEL_A.toString(),
        targetType: 'channel' as const,
      })),
      {
        action: 'channel.disable' as const,
        actorId: 'owner-1',
        actorType: 'owner_session' as const,
        createdAt: new Date(base.getTime() + 499),
        targetId: CHANNEL_A.toString(),
        targetType: 'channel' as const,
      },
      {
        action: 'channel.enable' as const,
        actorId: 'owner-1',
        actorType: 'owner_session' as const,
        createdAt: new Date(base.getTime() + 500),
        targetId: CHANNEL_A.toString(),
        targetType: 'channel' as const,
      },
    ]);

    const repository = new PostgresReconciliationPersistenceRepository(connection.db);
    const result = await repository.persistScan({
      initiatorKind: 'local_operator',
      now,
      telegramChannelIds: [CHANNEL_A],
    });
    expect(result.report.findings).toEqual([
      expect.objectContaining({
        kind: 'disabled_window',
        state: 'open',
      }),
    ]);
    const findings = await connection.db.select().from(reconciliationFindings);
    expect(findings).toHaveLength(1);
  });

  it('uses the current disabledAt fallback when history contains only an enable audit', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const now = new Date('2026-07-24T12:00:00.000Z');
    await connection.db.insert(telegramChannelAllowlist).values({
      disabledAt: new Date('2026-07-24T11:00:00.000Z'),
      enabled: false,
      telegramChatId: CHANNEL_A,
      title: 'Legacy disabled fallback',
      username: 'legacy_disabled_fallback',
    });
    await connection.db.insert(telegramPollingState).values({
      botId: 123_456n,
      nextUpdateId: 1n,
      updatedAt: now,
    });
    await connection.db.insert(operationAuditEvents).values({
      action: 'channel.enable',
      actorId: 'owner-1',
      actorType: 'owner_session',
      createdAt: new Date('2026-07-24T10:00:00.000Z'),
      targetId: CHANNEL_A.toString(),
      targetType: 'channel',
    });

    const repository = new PostgresReconciliationPersistenceRepository(connection.db);
    const result = await repository.persistScan({
      initiatorKind: 'local_operator',
      now,
      telegramChannelIds: [CHANNEL_A],
    });
    expect(result.report.findings).toEqual([
      expect.objectContaining({
        kind: 'disabled_window',
        sanitizedReason: 'The channel is currently disabled and may have an unobserved window',
      }),
    ]);
  });

  it('persists a claimed scheduled scan without terminalizing its run', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const { lease, schedule } = await claimScheduledRun(connection, [CHANNEL_A.toString()]);
    const repository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([findingCandidate('disabled_window', 'scheduled')]),
    );

    const report = await repository.scanClaimedRun({
      runId: lease.claimedRunId,
      signal: new AbortController().signal,
      telegramChannelIds: [CHANNEL_A.toString()],
    });

    expect(report).toMatchObject({
      counts: { repaired: 0, scanned: 1 },
      mode: 'scheduled-scan',
      status: 'partial',
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'disabled_window',
        state: 'open',
      }),
    ]);
    const [persistedFinding] = await connection.db.select().from(reconciliationFindings);
    expect(persistedFinding).toMatchObject({
      kind: 'disabled_window',
      state: 'open',
    });
    const [running] = await connection.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, lease.claimedRunId));
    expect(running).toMatchObject({
      completedAt: null,
      mode: 'scheduled_scan',
      status: 'running',
    });
    expect(running?.report).toMatchObject({ findings: [], status: 'clean' });

    await schedule.complete(lease.leaseOwner, {
      leaseToken: lease.leaseToken,
      report,
      runId: lease.claimedRunId,
      status: 'partial',
    });
    const [completed] = await connection.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, lease.claimedRunId));
    expect(completed).toMatchObject({
      mode: 'scheduled_scan',
      status: 'partial',
    });
    expect(completed?.completedAt).toBeInstanceOf(Date);
    expect(completed?.report).toMatchObject({ mode: 'scheduled-scan', status: 'partial' });
  });

  it('rejects unclaimed, mismatched-scope, token-mismatched, and wrong-mode runs', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const { lease } = await claimScheduledRun(connection, [CHANNEL_A.toString()]);
    const repository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([]),
    );
    const [unclaimed] = await connection.db
      .insert(reconciliationRuns)
      .values({
        initiatorId: `${lease.leaseOwner}:${lease.leaseToken}`,
        initiatorKind: 'worker',
        mode: 'scheduled_scan',
        report: {},
        scope: [CHANNEL_A.toString()],
        status: 'running',
      })
      .returning({ id: reconciliationRuns.id });
    if (!unclaimed) {
      throw new Error('Unclaimed fixture run was not created');
    }
    await expect(
      repository.scanClaimedRun({
        runId: unclaimed.id,
        signal: new AbortController().signal,
        telegramChannelIds: [CHANNEL_A.toString()],
      }),
    ).rejects.toThrow('not the current claimed run');

    await expect(
      repository.scanClaimedRun({
        runId: lease.claimedRunId,
        signal: new AbortController().signal,
        telegramChannelIds: [CHANNEL_B.toString()],
      }),
    ).rejects.toThrow('scope does not match');

    await connection.db
      .update(reconciliationRuns)
      .set({ initiatorId: `${lease.leaseOwner}:wrong-token` })
      .where(eq(reconciliationRuns.id, lease.claimedRunId));
    await expect(
      repository.scanClaimedRun({
        runId: lease.claimedRunId,
        signal: new AbortController().signal,
        telegramChannelIds: [CHANNEL_A.toString()],
      }),
    ).rejects.toThrow('lease token binding is invalid');

    await connection.db
      .update(reconciliationRuns)
      .set({
        initiatorId: `${lease.leaseOwner}:${lease.leaseToken}`,
        mode: 'persisted_scan',
      })
      .where(eq(reconciliationRuns.id, lease.claimedRunId));
    await expect(
      repository.scanClaimedRun({
        runId: lease.claimedRunId,
        signal: new AbortController().signal,
        telegramChannelIds: [CHANNEL_A.toString()],
      }),
    ).rejects.toThrow('running worker scheduled scan');
    const [findingCount] = await connection.db
      .select({ value: count() })
      .from(reconciliationFindings);
    expect(findingCount?.value).toBe(0);
  });

  it('fails closed before scanning when the claimed schedule lease has expired', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const { lease } = await claimScheduledRun(connection, [CHANNEL_A.toString()]);
    const [before] = await connection.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, lease.claimedRunId));
    await connection.db
      .update(reconciliationSchedule)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(reconciliationSchedule.singletonKey, 'telegram'));
    const repository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new FixtureScanner([findingCandidate('disabled_window', 'expired-lease')]),
    );

    await expect(
      repository.scanClaimedRun({
        runId: lease.claimedRunId,
        signal: new AbortController().signal,
        telegramChannelIds: [CHANNEL_A.toString()],
      }),
    ).rejects.toThrow('lease has expired');

    const [findingCount] = await connection.db
      .select({ value: count() })
      .from(reconciliationFindings);
    const [actionCount] = await connection.db
      .select({ value: count() })
      .from(reconciliationActions);
    const [after] = await connection.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, lease.claimedRunId));
    expect(findingCount?.value).toBe(0);
    expect(actionCount?.value).toBe(0);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ completedAt: null, status: 'running' });
  });

  it('returns interrupted and rolls back scheduled finding writes when aborted', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const { lease } = await claimScheduledRun(connection, [CHANNEL_A.toString()]);
    const controller = new AbortController();
    const candidates = Array.from({ length: 500 }, (_, index) =>
      findingCandidate('disabled_window', `abort-${index}`),
    );
    const repository = new PostgresReconciliationPersistenceRepository(
      connection.db,
      new AbortingFixtureScanner(candidates, controller),
    );

    const report = await repository.scanClaimedRun({
      runId: lease.claimedRunId,
      signal: controller.signal,
      telegramChannelIds: [CHANNEL_A.toString()],
    });

    expect(report).toMatchObject({
      counts: { findings: 0, repaired: 0 },
      findings: [],
      mode: 'scheduled-scan',
      status: 'interrupted',
    });
    const [findingCount] = await connection.db
      .select({ value: count() })
      .from(reconciliationFindings);
    expect(findingCount?.value).toBe(0);
    const [run] = await connection.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, lease.claimedRunId));
    expect(run).toMatchObject({
      completedAt: null,
      status: 'running',
    });
  });
});

class FixtureScanner implements ReconciliationSnapshotScanner {
  constructor(private readonly candidates: readonly ReconciliationCandidate[]) {}

  async scanSnapshotInTransaction(
    _transaction: ReconciliationTransaction,
    _telegramChannelIds: readonly bigint[],
    _now: Date,
    visit: ReconciliationCandidateVisitor,
  ): Promise<ReconciliationScanSnapshot> {
    for (const candidate of this.candidates) {
      await visit(candidate);
    }
    return { scanned: this.candidates.length };
  }
}

class AbortingFixtureScanner extends FixtureScanner {
  constructor(
    candidates: readonly ReconciliationCandidate[],
    private readonly controller: AbortController,
  ) {
    super(candidates);
  }

  override async scanSnapshotInTransaction(
    transaction: ReconciliationTransaction,
    telegramChannelIds: readonly bigint[],
    now: Date,
    visit: ReconciliationCandidateVisitor,
  ): Promise<ReconciliationScanSnapshot> {
    const snapshot = await super.scanSnapshotInTransaction(
      transaction,
      telegramChannelIds,
      now,
      visit,
    );
    this.controller.abort(new Error('fixture abort'));
    return snapshot;
  }
}

async function claimScheduledRun(
  connection: DatabaseConnection,
  scope: readonly string[],
): Promise<{
  lease: ReconciliationScheduleLease;
  schedule: PostgresReconciliationScheduleRepository;
}> {
  const schedule = new PostgresReconciliationScheduleRepository(connection.db);
  if (scope.length > 0) {
    await connection.db.insert(telegramChannelAllowlist).values(
      scope.map((telegramChatId, index) => ({
        telegramChatId: BigInt(telegramChatId),
        title: `Scheduled fixture ${index}`,
        username: `scheduled_fixture_${index}`,
      })),
    );
  }
  await schedule.initialize({
    intervalSeconds: 60,
    nextRunAt: new Date('2026-07-24T00:00:00.000Z'),
  });
  const lease = await schedule.claimDue('scheduled-test-worker', 600_000, scope);
  if (!lease) {
    throw new Error('Scheduled fixture run was not claimed');
  }
  return { lease, schedule };
}

async function createChannel(
  connection: DatabaseConnection,
  telegramChatId: bigint,
  username: string,
): Promise<string> {
  await connection.db.insert(telegramChannelAllowlist).values({
    telegramChatId,
    title: username,
    username,
  });
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId,
      title: username,
      username,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) {
    throw new Error('Fixture channel was not created');
  }
  return channel.id;
}

function findingCandidate(
  kind: ReconciliationCandidate['kind'],
  evidenceId: string,
): ReconciliationCandidate {
  return {
    channelId: CHANNEL_A.toString(),
    evidenceIds: [evidenceId],
    evidenceVersion: 1,
    kind,
    sanitizedReason: `${kind} fixture`,
    severity: 'warning',
  };
}
