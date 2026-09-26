import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { WORKER_HEARTBEAT_STALE_AFTER_MS } from './worker-heartbeat.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

export function hasFreshRunningHeartbeat(
  row: { heartbeat_at: Date; state: string } | undefined,
  now = Date.now(),
): boolean {
  return (
    !!row &&
    row.state === 'running' &&
    now - row.heartbeat_at.getTime() <= WORKER_HEARTBEAT_STALE_AFTER_MS
  );
}

async function main(): Promise<void> {
  const instanceId = required('HOSTNAME').trim();
  if (!instanceId || instanceId.length > 255) {
    throw new Error('Invalid HOSTNAME');
  }
  const options = { connect_timeout: 3, max: 1 };
  const sql = (() => {
    if (process.env.DATABASE_URL !== undefined) {
      return postgres(required('DATABASE_URL'), options);
    }
    const port = Number(required('POSTGRES_PORT'));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Invalid POSTGRES_PORT');
    }
    return postgres({
      ...options,
      database: required('POSTGRES_DB'),
      host: required('POSTGRES_HOST'),
      password: process.env.POSTGRES_PASSWORD ?? required('POSTGRES_PASSWORD'),
      port,
      username: required('POSTGRES_USER'),
    });
  })();

  try {
    const now = Date.now();
    const [row] = await sql<{ heartbeat_at: Date; state: string }[]>`
      select state, heartbeat_at from worker_runtime
      where singleton_key = 'telegram' and instance_id = ${instanceId}
    `;
    if (!hasFreshRunningHeartbeat(row, now)) {
      process.exitCode = 1;
      process.stderr.write('worker healthcheck: no fresh running heartbeat\n');
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.exitCode = 1;
    process.stderr.write('worker healthcheck: probe failed\n');
  });
}
