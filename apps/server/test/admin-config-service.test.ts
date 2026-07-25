import { describe, expect, it, vi } from 'vitest';
import {
  AdminConfigLockedError,
  AdminConfigValidationError,
  PostgresConfigService,
} from '../src/admin/config-service.js';
import type { AdminPrincipal } from '../src/auth/runtime-auth.js';
import type { ConfigCenterBootState } from '../src/config-registry.js';
import type { Database } from '../src/db/client.js';
import { configOverrides, operationAuditEvents } from '../src/db/schema.js';

const owner: AdminPrincipal = {
  actorId: 'owner-user-id',
  actorType: 'owner_session',
  email: 'owner@example.com',
  permissions: null,
  twoFactorEnabled: true,
};

interface OverrideRow {
  key: string;
  value: string;
}

function createDatabase(rows: OverrideRow[] = [], transactionRows: OverrideRow[] = rows) {
  const deleted: unknown[] = [];
  const inserted: { table: unknown; values: unknown }[] = [];
  const transaction = {
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        deleted.push(table);
      }),
    })),
    execute: vi.fn(async () => undefined),
    insert: vi.fn((table: unknown) => ({
      values: (values: unknown) => {
        inserted.push({ table, values });
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate: vi.fn(async () => undefined),
        });
      },
    })),
    select: vi.fn(() => ({
      from: vi.fn(async () => transactionRows),
    })),
  };
  const transactionSpy = vi.fn(async (callback: (active: typeof transaction) => Promise<unknown>) =>
    callback(transaction),
  );
  const database = {
    select: vi.fn(() => ({
      from: vi.fn(async () => rows),
    })),
    transaction: transactionSpy,
  } as unknown as Database;
  return { database, deleted, inserted, transaction, transactionSpy };
}

function createBoot(overrides: Partial<ConfigCenterBootState> = {}): ConfigCenterBootState {
  return {
    baseEnv: {},
    bootOverrides: {},
    effectiveEnv: {},
    explicitEnvNames: new Set<string>(),
    ...overrides,
  };
}

function settingState(
  response: Awaited<ReturnType<PostgresConfigService['describe']>>,
  envName: string,
) {
  const setting = response.sections
    .flatMap((section) => section.settings)
    .find((entry) => entry.envName === envName);
  expect(setting, `expected ${envName} in the config descriptor`).toBeDefined();
  return setting as NonNullable<typeof setting>;
}

describe('admin config service describe', () => {
  it('reports defaults, value sources, and masked secret effective values', async () => {
    const { database } = createDatabase([{ key: 'MEDIA_CACHE_ENABLED', value: 'true' }]);
    const service = new PostgresConfigService(
      database,
      createBoot({
        bootOverrides: { MEDIA_CACHE_ENABLED: 'true' },
        effectiveEnv: { MEDIA_CACHE_ENABLED: 'true', S3_KEY: 'abcd1234secret' },
        explicitEnvNames: new Set(['TRUST_PROXY']),
      }),
    );

    const response = await service.describe();
    expect(response.sections.map((section) => section.id)).toEqual([
      'media_cache',
      's3',
      'public_api',
      'ingestion',
    ]);

    expect(settingState(response, 'MEDIA_CACHE_ENABLED')).toMatchObject({
      effective: 'true',
      pendingRestart: false,
      source: 'override',
    });
    expect(settingState(response, 'TRUST_PROXY')).toMatchObject({
      locked: true,
      source: 'explicit_env',
    });
    expect(settingState(response, 'S3_REGION')).toMatchObject({
      effective: 'us-east-1',
      locked: false,
      source: 'default',
    });
    expect(settingState(response, 'S3_ENDPOINT')).toMatchObject({
      effective: null,
      source: 'default',
    });
    expect(settingState(response, 'S3_KEY')).toMatchObject({
      effective: { last4: 'cret', set: true },
    });
    expect(JSON.stringify(response)).not.toContain('abcd1234secret');
  });

  it('flags pending restart when live overrides differ from the boot snapshot', async () => {
    const { database } = createDatabase([
      { key: 'S3_KEY', value: 'newsecretvalue' },
      { key: 'S3_REGION', value: 'eu-west-1' },
    ]);
    const service = new PostgresConfigService(
      database,
      createBoot({ effectiveEnv: { S3_KEY: 'oldsecretvalue' } }),
    );

    const response = await service.describe();
    expect(settingState(response, 'S3_REGION')).toMatchObject({
      pendingRestart: true,
      pendingValue: 'eu-west-1',
    });
    expect(settingState(response, 'S3_KEY')).toMatchObject({
      pendingRestart: true,
      pendingValue: { last4: 'alue', set: true },
    });
    const enabled = settingState(response, 'MEDIA_CACHE_ENABLED');
    expect(enabled.pendingRestart).toBe(false);
    expect('pendingValue' in enabled).toBe(false);
    expect(JSON.stringify(response)).not.toContain('newsecretvalue');
    expect(JSON.stringify(response)).not.toContain('oldsecretvalue');
  });
});

describe('admin config service apply', () => {
  it('rejects unknown settings and invalid values before touching the database', async () => {
    const { database, transactionSpy } = createDatabase();
    const service = new PostgresConfigService(database, createBoot());

    await expect(
      service.apply({ changes: { NOT_A_SETTING: 'x' }, reason: 'unknown key' }, owner),
    ).rejects.toBeInstanceOf(AdminConfigValidationError);
    await expect(
      service.apply({ changes: { MEDIA_CACHE_MAX_BYTES: '0' }, reason: 'invalid value' }, owner),
    ).rejects.toBeInstanceOf(AdminConfigValidationError);
    await expect(
      service.apply({ changes: {}, reason: 'empty change' }, owner),
    ).rejects.toBeInstanceOf(AdminConfigValidationError);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('rejects settings locked by an explicit environment variable', async () => {
    const { database, transactionSpy } = createDatabase();
    const service = new PostgresConfigService(
      database,
      createBoot({ explicitEnvNames: new Set(['S3_REGION']) }),
    );

    await expect(
      service.apply({ changes: { S3_REGION: 'eu-west-1' }, reason: 'locked key' }, owner),
    ).rejects.toBeInstanceOf(AdminConfigLockedError);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('enforces the S3 core group as all-or-none across merged sources', async () => {
    const { database } = createDatabase();
    const service = new PostgresConfigService(database, createBoot());

    await expect(
      service.apply(
        { changes: { S3_ENDPOINT: 'https://s3.example.com' }, reason: 'partial s3' },
        owner,
      ),
    ).rejects.toThrow(/incomplete/u);

    const complete = {
      S3_BUCKET: 'media',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_KEY: 'key-id',
      S3_SECRET: 'key-secret',
    };
    await expect(
      service.apply({ changes: complete, reason: 'configure s3' }, owner),
    ).resolves.toMatchObject({ pendingRestart: true });
  });

  it('merges changes with existing overrides before the S3 group check', async () => {
    const rows: OverrideRow[] = [
      { key: 'S3_BUCKET', value: 'media' },
      { key: 'S3_KEY', value: 'key-id' },
      { key: 'S3_SECRET', value: 'key-secret' },
    ];
    const { database } = createDatabase(rows);
    const service = new PostgresConfigService(database, createBoot());

    await expect(
      service.apply(
        { changes: { S3_ENDPOINT: 'https://s3.example.com' }, reason: 'complete the group' },
        owner,
      ),
    ).resolves.toMatchObject({ applied: ['S3_ENDPOINT'] });

    const clearing = createDatabase([
      ...rows,
      { key: 'S3_ENDPOINT', value: 'https://s3.example.com' },
    ]);
    const clearingService = new PostgresConfigService(clearing.database, createBoot());
    await expect(
      clearingService.apply({ changes: { S3_BUCKET: null }, reason: 'break the group' }, owner),
    ).rejects.toThrow(/incomplete/u);
  });

  it('re-reads and re-validates overrides inside the locked transaction', async () => {
    // The pre-transaction snapshot would complete the S3 group, but the
    // in-transaction read (as after a concurrent delete committed first) does
    // not — the apply must be rejected before any write happens.
    const outerRows: OverrideRow[] = [
      { key: 'S3_BUCKET', value: 'media' },
      { key: 'S3_KEY', value: 'key-id' },
      { key: 'S3_SECRET', value: 'key-secret' },
    ];
    const { database, transaction } = createDatabase(outerRows, []);
    const service = new PostgresConfigService(database, createBoot());

    await expect(
      service.apply(
        { changes: { S3_ENDPOINT: 'https://s3.example.com' }, reason: 'stale snapshot' },
        owner,
      ),
    ).rejects.toThrow(/incomplete/u);
    expect(transaction.execute).toHaveBeenCalledOnce();
    expect(transaction.select).toHaveBeenCalledOnce();
    expect(transaction.execute.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.select.mock.invocationCallOrder[0] as number,
    );
    expect(transaction.insert).not.toHaveBeenCalled();
    expect(transaction.delete).not.toHaveBeenCalled();
  });

  it('upserts, deletes, and audits without ever recording secret values', async () => {
    const { database, deleted, inserted, transaction } = createDatabase([
      { key: 'S3_KEY', value: 'old-secret-value' },
      { key: 'S3_REGION', value: 'us-east-1' },
    ]);
    const service = new PostgresConfigService(database, createBoot());

    const result = await service.apply(
      {
        changes: {
          S3_BUCKET: 'media',
          S3_ENDPOINT: 'https://s3.example.com',
          S3_KEY: 'new-secret-value',
          S3_REGION: null,
          S3_SECRET: 'new-secret-secret',
        },
        reason: 'rotate s3 credentials',
      },
      owner,
    );

    expect(result).toEqual({
      applied: ['S3_BUCKET', 'S3_ENDPOINT', 'S3_KEY', 'S3_REGION', 'S3_SECRET'],
      pendingRestart: true,
    });
    expect(deleted).toEqual([configOverrides]);
    expect(transaction.execute).toHaveBeenCalledOnce();
    expect(transaction.execute.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.insert.mock.invocationCallOrder[0] as number,
    );

    const audit = inserted.find((entry) => entry.table === operationAuditEvents);
    expect(audit).toBeDefined();
    const auditValues = audit?.values as {
      details: { changes: Record<string, unknown>[] };
    };
    expect(auditValues).toMatchObject({
      action: 'config.update',
      actorId: 'owner-user-id',
      actorType: 'owner_session',
      reason: 'rotate s3 credentials',
      targetId: 'config_overrides',
      targetType: 'config',
    });
    const details = JSON.stringify(auditValues.details);
    expect(details).not.toContain('old-secret-value');
    expect(details).not.toContain('new-secret-value');
    expect(details).not.toContain('new-secret-secret');
    expect(details).toContain('https://s3.example.com');

    const { changes } = auditValues.details;
    expect(changes.find((change) => change.key === 'S3_KEY')).toEqual({
      key: 'S3_KEY',
      next: 'set',
      previous: 'set',
      secret: true,
    });
    expect(changes.find((change) => change.key === 'S3_REGION')).toEqual({
      key: 'S3_REGION',
      next: null,
      previous: 'us-east-1',
    });
  });
});
