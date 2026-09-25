import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasFreshRunningHeartbeat } from '../src/worker-healthcheck.js';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

describe('worker healthcheck heartbeat', () => {
  it('accepts a running heartbeat exactly 30 seconds old', () => {
    expect(
      hasFreshRunningHeartbeat({ heartbeat_at: new Date(NOW - 30_000), state: 'running' }, NOW),
    ).toBe(true);
  });

  it('accepts a current running heartbeat', () => {
    expect(hasFreshRunningHeartbeat({ heartbeat_at: new Date(NOW), state: 'running' }, NOW)).toBe(
      true,
    );
  });

  it('rejects a heartbeat older than 30 seconds', () => {
    expect(
      hasFreshRunningHeartbeat({ heartbeat_at: new Date(NOW - 30_001), state: 'running' }, NOW),
    ).toBe(false);
  });

  it.each(['starting', 'stopping'])('rejects a fresh heartbeat in %s state', (state) => {
    expect(hasFreshRunningHeartbeat({ heartbeat_at: new Date(NOW), state }, NOW)).toBe(false);
  });

  it('rejects a missing worker row', () => {
    expect(hasFreshRunningHeartbeat(undefined, NOW)).toBe(false);
  });

  it('rejects an invalid heartbeat date', () => {
    expect(
      hasFreshRunningHeartbeat({ heartbeat_at: new Date(Number.NaN), state: 'running' }, NOW),
    ).toBe(false);
  });
});

describe('worker healthcheck process', () => {
  it('exits nonzero when it cannot connect to the database', () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/worker-healthcheck.ts'], {
      cwd: serverRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
        HOSTNAME: 'probe-test',
      },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
  });
});
