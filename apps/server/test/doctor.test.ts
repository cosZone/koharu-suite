import { describe, expect, it, vi } from 'vitest';
import {
  type DoctorDatabaseDiagnostics,
  type DoctorDependencies,
  type DoctorTelegramDiagnostics,
  doctorHasFailures,
  EXPECTED_DATABASE_OBJECTS,
  renderDoctorReport,
  runDoctor,
  sanitizeDiagnosticText,
} from '../src/ops/doctor.js';

function createDatabase(
  overrides: Partial<DoctorDatabaseDiagnostics> = {},
): DoctorDatabaseDiagnostics {
  return {
    getBoundTelegramBotId: vi.fn(async () => 123n),
    getMediaCacheLedgerSnapshot: vi.fn(async () => ({
      activeThumbnailReservationCount: 0n,
      activeThumbnailReservedBytes: 0n,
      cacheRowCount: 0n,
      originalReservationCount: 0n,
      originalReservedBytes: 0n,
      physicalBlobBytes: 0n,
      physicalBlobCount: 0n,
      runtimeMaxBytes: null,
      runtimeReadyBytes: null,
      runtimeReservedBytes: null,
      runtimeRowCount: 0n,
    })),
    getPostgresMajorVersion: vi.fn(async () => 18),
    listEnabledChannels: vi.fn(async () => [
      {
        telegramChatId: -1_002_234_260_754n,
        title: 'cos test dev channel backup',
        username: 'cos_test_dev',
      },
    ]),
    listMissingSchemaObjects: vi.fn(async () => []),
    listOwners: vi.fn(async () => [{ userId: 'owner-1' }]),
    ...overrides,
  };
}

function createTelegram() {
  return {
    getChat: vi.fn<DoctorTelegramDiagnostics['getChat']>(async (chatId) => ({
      id: Number(chatId),
      title: 'cos test dev channel backup',
      type: 'channel',
      username: 'cos_test_dev',
    })),
    getChatMember: vi.fn<DoctorTelegramDiagnostics['getChatMember']>(async () => ({
      status: 'administrator',
    })),
    getMe: vi.fn<DoctorTelegramDiagnostics['getMe']>(async () => ({
      id: 123,
      username: 'koharu_test_bot',
    })),
    getUpdates: vi.fn(),
  } satisfies DoctorTelegramDiagnostics & { getUpdates: ReturnType<typeof vi.fn> };
}

type TestTelegram = ReturnType<typeof createTelegram>;

function createDependencies(
  overrides: Omit<Partial<DoctorDependencies>, 'telegram'> & {
    telegram?: TestTelegram;
  } = {},
): DoctorDependencies & {
  telegram: TestTelegram;
} {
  return {
    database: createDatabase(),
    telegram: createTelegram(),
    validateConfig: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('kodama doctor diagnostics', () => {
  it('runs read-only checks in order without Telegram update polling capability', async () => {
    const dependencies = createDependencies();
    const report = await runDoctor(dependencies);

    expect(report.checks.map((check) => check.id)).toEqual([
      'config',
      'postgres-version',
      'database-schema',
      'media-cache-ledger',
      'owner',
      'telegram-bot',
      'telegram-channels',
    ]);
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(dependencies.telegram.getUpdates).not.toHaveBeenCalled();
    expect(dependencies.database.listMissingSchemaObjects).toHaveBeenCalledWith(
      EXPECTED_DATABASE_OBJECTS,
    );
  });

  it('redacts credentials, URLs, Telegram tokens, and known sensitive values', async () => {
    const telegramToken = '123456789:very-secret-telegram-token';
    const password = 'db-password-from-env';
    const authSecret = 'auth-secret-with-at-least-32-characters';
    const databaseUrl = `postgresql://koharu:${password}@db:5432/koharu`;
    const dependencies = createDependencies({
      sensitiveValues: [telegramToken, password, authSecret, databaseUrl],
      validateConfig: vi.fn(async () => {
        throw new Error(
          `DATABASE_URL=${databaseUrl} TELEGRAM_BOT_TOKEN=${telegramToken} ` +
            `BETTER_AUTH_SECRET=${authSecret} POSTGRES_PASSWORD=${password}`,
        );
      }),
    });

    const output = renderDoctorReport(await runDoctor(dependencies));

    for (const secret of [telegramToken, password, authSecret, databaseUrl]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain('postgresql://');
    expect(output).toContain('[redacted]');
    expect(
      sanitizeDiagnosticText(
        `Authorization: Bearer ${telegramToken} https://x.test/?password=${password}`,
        [password],
      ),
    ).toBe('Authorization: [redacted] [redacted] https://x.test/?password=[redacted]');
  });

  it('treats warnings as non-fatal and failures as fatal', async () => {
    const warningReport = await runDoctor(
      createDependencies({
        database: createDatabase({
          getBoundTelegramBotId: vi.fn(async () => null),
          listEnabledChannels: vi.fn(async () => []),
          listOwners: vi.fn(async () => []),
        }),
      }),
    );

    expect(warningReport.checks.map((check) => check.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'warn',
      'warn',
      'warn',
    ]);
    expect(doctorHasFailures(warningReport)).toBe(false);

    const failureReport = await runDoctor(
      createDependencies({
        database: createDatabase({
          getPostgresMajorVersion: vi.fn(async () => 17),
        }),
      }),
    );
    expect(doctorHasFailures(failureReport)).toBe(true);
    expect(renderDoctorReport(failureReport)).toContain('1 failure(s)');
  });

  it('continues independent checks and all channel inspections after safe partial failures', async () => {
    const database = createDatabase({
      getPostgresMajorVersion: vi.fn(async () => {
        throw new Error('database version query failed');
      }),
      listEnabledChannels: vi.fn(async () => [
        {
          telegramChatId: -1_001n,
          title: 'private',
          username: null,
        },
        {
          telegramChatId: -1_002n,
          title: 'healthy',
          username: 'healthy',
        },
      ]),
    });
    const telegram = createTelegram();
    telegram.getChat
      .mockResolvedValueOnce({ id: -1_001, title: 'private', type: 'channel' })
      .mockResolvedValueOnce({
        id: -1_002,
        title: 'healthy',
        type: 'channel',
        username: 'healthy',
      });
    telegram.getChatMember
      .mockResolvedValueOnce({ status: 'member' })
      .mockResolvedValueOnce({ status: 'creator' });

    const report = await runDoctor(createDependencies({ database, telegram }));

    expect(report.checks.find((check) => check.id === 'postgres-version')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'database-schema')?.status).toBe('ok');
    expect(report.checks.find((check) => check.id === 'owner')?.status).toBe('ok');
    const channels = report.checks.find((check) => check.id === 'telegram-channels');
    expect(channels?.status).toBe('fail');
    expect(channels?.details).toEqual([
      '-1001: Channel is not public; Bot is not an administrator (status: member)',
      '@healthy: public and Bot administrator verified',
    ]);
    expect(telegram.getChat).toHaveBeenCalledTimes(2);
    expect(telegram.getChatMember).toHaveBeenCalledTimes(2);
    expect(telegram.getUpdates).not.toHaveBeenCalled();
  });

  it('reports schema, owner, and Bot identity contract violations', async () => {
    const report = await runDoctor(
      createDependencies({
        database: createDatabase({
          getBoundTelegramBotId: vi.fn(async () => 999n),
          listMissingSchemaObjects: vi.fn(async () => ['telegram_polling_state']),
          listOwners: vi.fn(async () => [{ userId: 'owner-1' }, { userId: 'owner-2' }]),
        }),
      }),
    );

    expect(report.checks.find((check) => check.id === 'database-schema')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'owner')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'telegram-bot')?.status).toBe('fail');
    expect(doctorHasFailures(report)).toBe(true);
  });

  it('fails on media-cache ledger drift and reports only aggregate counts', async () => {
    const database = createDatabase({
      getMediaCacheLedgerSnapshot: vi.fn(async () => ({
        activeThumbnailReservationCount: 1n,
        activeThumbnailReservedBytes: 1_048_576n,
        cacheRowCount: 7n,
        originalReservationCount: 1n,
        originalReservedBytes: 10_485_760n,
        physicalBlobBytes: 30n,
        physicalBlobCount: 2n,
        runtimeMaxBytes: 5_368_709_120n,
        runtimeReadyBytes: 29n,
        runtimeReservedBytes: 11_534_336n,
        runtimeRowCount: 1n,
      })),
    });

    const report = await runDoctor(createDependencies({ database }));
    const ledger = report.checks.find((check) => check.id === 'media-cache-ledger');

    expect(ledger).toMatchObject({
      message: 'Media cache counters do not match the read-only ledger recomputation',
      status: 'fail',
    });
    expect(ledger?.details).toEqual([
      'Cache rows: 7',
      'Runtime rows: 1',
      'Physical blob rows: 2',
      'Original reservation rows: 1',
      'Active thumbnail reservation rows: 1',
      'Ready bytes: runtime=29, ledger=30',
      'Reserved bytes: runtime=11534336, ledger=11534336',
      'Maximum bytes: 5368709120',
    ]);
    expect(JSON.stringify(ledger)).not.toMatch(/sha256|relative|locator|blobs\//u);
    expect(doctorHasFailures(report)).toBe(true);
  });
});
