import postgres from 'postgres';
import { CONFIGURABLE_ENV_NAMES } from './config-registry.js';

export interface ConfigOverridesLoadResult {
  /** Overrides keyed by environment variable name ({} when unreadable or missing). */
  overrides: Record<string, string>;
  /** Sanitized failure description when the override table could not be read. */
  readError: string | null;
}

interface ConfigOverrideRow extends Record<string, unknown> {
  key: string;
  value: string;
}

function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42P01'
  );
}

/**
 * Reads config_overrides with a short-lived connection before any config is resolved.
 * The table may not exist yet (migrations run separately), and a config-center failure
 * must never block startup, so every failure degrades to an empty override map.
 */
export async function readConfigOverrides(databaseUrl: string): Promise<ConfigOverridesLoadResult> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await client<ConfigOverrideRow[]>`
      select key, value from config_overrides
    `;
    const overrides: Record<string, string> = {};
    for (const row of rows) {
      // Only panel-configurable keys may influence the environment; stray rows
      // (manual inserts, stale keys) must never shadow non-configurable variables.
      if (CONFIGURABLE_ENV_NAMES.has(row.key)) {
        overrides[row.key] = row.value;
      }
    }
    return { overrides, readError: null };
  } catch (error) {
    if (isUndefinedTable(error)) {
      return { overrides: {}, readError: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { overrides: {}, readError: message };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function loadConfigOverrides(databaseUrl: string): Promise<Record<string, string>> {
  const result = await readConfigOverrides(databaseUrl);
  if (result.readError !== null) {
    console.warn('kodama: could not read config overrides; continuing without them');
  }
  return result.overrides;
}

/**
 * Merge precedence: explicit shell env > database overrides > .env/base env.
 */
export function mergeEnvironmentWithOverrides(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  explicitEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...baseEnv, ...overrides, ...explicitEnv };
}
