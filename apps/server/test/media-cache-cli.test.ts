import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMediaCacheCli } from '../src/media-cache/cli.js';

const cliMocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createDatabaseConnection: vi.fn(),
  discoverBatch: vi.fn(),
  discoverScopedBatch: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  createDatabaseConnection: cliMocks.createDatabaseConnection,
}));

vi.mock('../src/media-cache/discovery-repository.js', () => ({
  PostgresMediaCacheDiscoveryRepository: class {
    discoverBatch = cliMocks.discoverBatch;
    discoverScopedBatch = cliMocks.discoverScopedBatch;
  },
}));

const roots: string[] = [];
const databaseUrl = 'postgresql://test:test@127.0.0.1:1/test';

beforeEach(() => {
  cliMocks.close.mockClear();
  cliMocks.createDatabaseConnection.mockReset();
  cliMocks.createDatabaseConnection.mockReturnValue({ close: cliMocks.close, db: {} });
  cliMocks.discoverBatch.mockReset();
  cliMocks.discoverScopedBatch.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'koharu-media-cli-'));
  roots.push(value);
  return value;
}

describe('media cache CLI boundary', () => {
  it('requires the complete exact-run Desktop provenance input before opening PostgreSQL', async () => {
    await expect(
      runMediaCacheCli({
        apply: false,
        databaseUrl,
        json: false,
        mediaCache: {
          downloadConcurrency: 2,
          enabled: false,
          maxBytes: 5 * 1024 * 1024 * 1024,
          root: await root(),
        },
        subcommand: 'cache',
      }),
    ).rejects.toThrow('requires --apply');
  });

  it('requires all Desktop provenance arguments before opening PostgreSQL', async () => {
    await expect(
      runMediaCacheCli({
        apply: true,
        databaseUrl,
        json: false,
        mediaCache: {
          downloadConcurrency: 2,
          enabled: true,
          maxBytes: 5 * 1024 * 1024 * 1024,
          root: await root(),
        },
        reason: 'cache exact Desktop import',
        subcommand: 'cache',
      }),
    ).rejects.toThrow('requires --import-run, --input, and --desktop-root');
  });

  it('requires a bounded reason before any applied maintenance mutation', async () => {
    await expect(
      runMediaCacheCli({
        apply: true,
        databaseUrl,
        json: false,
        mediaCache: {
          downloadConcurrency: 2,
          enabled: false,
          maxBytes: 5 * 1024 * 1024 * 1024,
          root: await root(),
        },
        subcommand: 'prune',
        targetBytes: '1024',
      }),
    ).rejects.toThrow('--apply requires --reason');
  });

  it('rejects unsafe prune targets before accessing PostgreSQL', async () => {
    await expect(
      runMediaCacheCli({
        apply: false,
        databaseUrl,
        json: false,
        mediaCache: {
          downloadConcurrency: 2,
          enabled: false,
          maxBytes: 5 * 1024 * 1024 * 1024,
          root: await root(),
        },
        subcommand: 'prune',
        targetBytes: '5368709121',
      }),
    ).rejects.toThrow('cannot exceed 5 GiB');
  });

  it('strictly validates scoped channel IDs before opening PostgreSQL', async () => {
    await expect(
      runMediaCacheCli({
        apply: false,
        channels: ['1002234260754'],
        databaseUrl,
        json: false,
        mediaCache: {
          downloadConcurrency: 2,
          enabled: false,
          maxBytes: 5 * 1024 * 1024 * 1024,
          root: await root(),
        },
        subcommand: 'scan',
      }),
    ).rejects.toThrow('must be a negative Telegram channel ID');
    expect(cliMocks.createDatabaseConnection).not.toHaveBeenCalled();
  });

  it('aggregates an automatically paginated scoped scan without exposing its cursor', async () => {
    cliMocks.discoverScopedBatch
      .mockResolvedValueOnce({
        cursor: {
          createdAt: new Date('2026-07-24T00:00:00.000Z'),
          id: '00000000-0000-4000-8000-000000000001',
        },
        hasMore: true,
        objectsCreated: 3,
        plansCreated: 2,
        scanned: 100,
        sourcesCreated: 4,
      })
      .mockResolvedValueOnce({
        cursor: {
          createdAt: new Date('2026-07-24T00:00:01.000Z'),
          id: '00000000-0000-4000-8000-000000000002',
        },
        hasMore: false,
        objectsCreated: 1,
        plansCreated: 1,
        scanned: 7,
        sourcesCreated: 2,
      });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runMediaCacheCli({
      apply: false,
      channels: ['-1002234260754', '-1009876543210'],
      databaseUrl,
      json: true,
      mediaCache: {
        downloadConcurrency: 2,
        enabled: false,
        maxBytes: 5 * 1024 * 1024 * 1024,
        root: await root(),
      },
      subcommand: 'scan',
    });

    expect(cliMocks.discoverScopedBatch).toHaveBeenNthCalledWith(
      1,
      [-1002234260754n, -1009876543210n],
      null,
    );
    expect(cliMocks.discoverScopedBatch).toHaveBeenNthCalledWith(
      2,
      [-1002234260754n, -1009876543210n],
      expect.objectContaining({ id: '00000000-0000-4000-8000-000000000001' }),
    );
    const output = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toEqual({
      result: {
        hasMore: false,
        objectsCreated: 4,
        plansCreated: 3,
        scanned: 107,
        sourcesCreated: 6,
      },
      schemaVersion: 1,
    });
    expect(output).not.toContain('cursor');
    expect(output).not.toContain('00000000-0000-4000-8000');
  });

  it('stops a scoped scan when a page repeats the caller-owned cursor', async () => {
    const repeated = {
      cursor: {
        createdAt: new Date('2026-07-24T00:00:00.000Z'),
        id: '00000000-0000-4000-8000-000000000003',
      },
      hasMore: true,
      objectsCreated: 0,
      plansCreated: 0,
      scanned: 1,
      sourcesCreated: 0,
    };
    cliMocks.discoverScopedBatch.mockResolvedValue(repeated);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runMediaCacheCli({
      apply: false,
      channels: ['-1002234260754'],
      databaseUrl,
      json: true,
      mediaCache: {
        downloadConcurrency: 2,
        enabled: false,
        maxBytes: 5 * 1024 * 1024 * 1024,
        root: await root(),
      },
      subcommand: 'scan',
    });

    expect(cliMocks.discoverScopedBatch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(write.mock.calls[0]?.[0])).result).toMatchObject({
      hasMore: true,
      scanned: 2,
    });
  });

  it('caps scoped automatic pagination at 10,000 pages', async () => {
    let page = 0;
    cliMocks.discoverScopedBatch.mockImplementation(async () => {
      page += 1;
      return {
        cursor: {
          createdAt: new Date('2026-07-24T00:00:00.000Z'),
          id: `page-${page}`,
        },
        hasMore: true,
        objectsCreated: 0,
        plansCreated: 0,
        scanned: 1,
        sourcesCreated: 0,
      };
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runMediaCacheCli({
      apply: false,
      channels: ['-1002234260754'],
      databaseUrl,
      json: true,
      mediaCache: {
        downloadConcurrency: 2,
        enabled: false,
        maxBytes: 5 * 1024 * 1024 * 1024,
        root: await root(),
      },
      subcommand: 'scan',
    });

    expect(cliMocks.discoverScopedBatch).toHaveBeenCalledTimes(10_000);
    expect(JSON.parse(String(write.mock.calls[0]?.[0])).result).toMatchObject({
      hasMore: true,
      scanned: 10_000,
    });
  });

  it('keeps an unscoped scan to one bounded global batch and omits its cursor', async () => {
    cliMocks.discoverBatch.mockResolvedValue({
      cursor: {
        createdAt: new Date('2026-07-24T00:00:00.000Z'),
        id: '00000000-0000-4000-8000-000000000004',
      },
      hasMore: true,
      objectsCreated: 2,
      plansCreated: 1,
      scanned: 100,
      sourcesCreated: 2,
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runMediaCacheCli({
      apply: false,
      databaseUrl,
      json: true,
      mediaCache: {
        downloadConcurrency: 2,
        enabled: false,
        maxBytes: 5 * 1024 * 1024 * 1024,
        root: await root(),
      },
      subcommand: 'scan',
    });

    expect(cliMocks.discoverBatch).toHaveBeenCalledTimes(1);
    expect(cliMocks.discoverScopedBatch).not.toHaveBeenCalled();
    const output = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(output).result).toEqual({
      hasMore: true,
      objectsCreated: 2,
      plansCreated: 1,
      scanned: 100,
      sourcesCreated: 2,
    });
    expect(output).not.toContain('cursor');
  });
});
