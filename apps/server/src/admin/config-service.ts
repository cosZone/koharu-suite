import { eq, sql } from 'drizzle-orm';
import type { AdminPrincipal } from '../auth/runtime-auth.js';
import { resolveMediaCacheConfig, resolveMediaS3Config } from '../config.js';
import {
  CONFIG_SECTION_LABELS,
  CONFIGURABLE_SETTINGS,
  type ConfigCenterBootState,
  type ConfigSection,
  type ConfigSettingKind,
  type ConfigValueSource,
  getConfigurableSetting,
  type MaskedSecretValue,
  maskSecretValue,
} from '../config-registry.js';
import type { Database } from '../db/client.js';
import { configOverrides, operationAuditEvents } from '../db/schema.js';

export class AdminConfigLockedError extends Error {}
export class AdminConfigValidationError extends Error {}

export interface AdminConfigSettingState {
  description: string;
  /** Boot-resolved current value; secrets are only reported as set/last4. */
  effective: MaskedSecretValue | string | null;
  envName: string;
  kind: ConfigSettingKind;
  label: string;
  locked: boolean;
  pendingRestart: boolean;
  /** Live override when it differs from the boot value; secrets are masked. */
  pendingValue?: MaskedSecretValue | string | null;
  secret: boolean;
  source: ConfigValueSource;
}

export interface AdminConfigSectionState {
  id: ConfigSection;
  label: string;
  settings: AdminConfigSettingState[];
}

export interface AdminConfigResponse {
  sections: AdminConfigSectionState[];
}

export interface AdminConfigApplyInput {
  changes: Record<string, string | null>;
  reason: string;
}

export interface AdminConfigApplyResult {
  applied: string[];
  pendingRestart: true;
}

const SECTION_ORDER: readonly ConfigSection[] = ['media_cache', 's3', 'public_api', 'ingestion'];

/**
 * Serializes config.update transactions so the read-validate-write sequence below
 * cannot interleave with a concurrent update and persist an unvalidated mix.
 */
const CONFIG_OVERRIDES_ADVISORY_LOCK = 6_309_648_946_926_692;

export class PostgresConfigService {
  constructor(
    private readonly database: Database,
    private readonly boot: ConfigCenterBootState,
  ) {}

  async describe(): Promise<AdminConfigResponse> {
    const liveOverrides = await this.readOverrides();
    const bySection = new Map<ConfigSection, AdminConfigSettingState[]>();
    for (const setting of CONFIGURABLE_SETTINGS) {
      const locked = this.boot.explicitEnvNames.has(setting.envName);
      const bootOverride = this.boot.bootOverrides[setting.envName];
      const source: ConfigValueSource = locked
        ? 'explicit_env'
        : bootOverride !== undefined
          ? 'override'
          : 'default';
      const liveValue = liveOverrides[setting.envName];
      const pendingRestart = liveValue !== bootOverride;
      const effectiveRaw = this.boot.effectiveEnv[setting.envName] ?? null;
      const state: AdminConfigSettingState = {
        description: setting.description,
        effective: setting.secret
          ? maskSecretValue(effectiveRaw)
          : (effectiveRaw ?? (setting.defaultValue === '' ? null : setting.defaultValue)),
        envName: setting.envName,
        kind: setting.kind,
        label: setting.label,
        locked,
        pendingRestart,
        ...(pendingRestart
          ? {
              pendingValue: setting.secret
                ? maskSecretValue(liveValue ?? null)
                : (liveValue ?? null),
            }
          : {}),
        secret: setting.secret,
        source,
      };
      const list = bySection.get(setting.section) ?? [];
      list.push(state);
      bySection.set(setting.section, list);
    }

    return {
      sections: SECTION_ORDER.map((id) => ({
        id,
        label: CONFIG_SECTION_LABELS[id],
        settings: bySection.get(id) ?? [],
      })),
    };
  }

  async apply(
    input: AdminConfigApplyInput,
    principal: AdminPrincipal,
  ): Promise<AdminConfigApplyResult> {
    const entries = Object.entries(input.changes);
    if (entries.length === 0) {
      throw new AdminConfigValidationError('At least one config change is required');
    }
    for (const [envName, value] of entries) {
      const setting = getConfigurableSetting(envName);
      if (!setting) {
        throw new AdminConfigValidationError(`Unknown configurable setting: ${envName}`);
      }
      if (this.boot.explicitEnvNames.has(envName)) {
        throw new AdminConfigLockedError(
          `${envName} is locked by an explicit environment variable`,
        );
      }
      if (value !== null && !setting.schema.safeParse(value).success) {
        throw new AdminConfigValidationError(`Invalid value for ${envName}`);
      }
    }

    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${CONFIG_OVERRIDES_ADVISORY_LOCK})`,
      );
      // Re-read and re-validate inside the lock: the prospective state checked here
      // is exactly the state this transaction commits, even under concurrent PUTs.
      const current = await this.readOverrides(transaction);
      const prospective: Record<string, string> = { ...current };
      for (const [envName, value] of entries) {
        if (value === null) {
          delete prospective[envName];
        } else {
          prospective[envName] = value;
        }
      }
      this.validateGroupRules(prospective);

      for (const [envName, value] of entries) {
        if (value === null) {
          await transaction.delete(configOverrides).where(eq(configOverrides.key, envName));
        } else {
          await transaction
            .insert(configOverrides)
            .values({ key: envName, updatedAt: now, updatedBy: principal.actorId, value })
            .onConflictDoUpdate({
              set: { updatedAt: now, updatedBy: principal.actorId, value },
              target: configOverrides.key,
            });
        }
      }
      await transaction.insert(operationAuditEvents).values({
        actorId: principal.actorId,
        actorType: principal.actorType,
        action: 'config.update',
        details: {
          changes: entries.map(([envName, value]) =>
            this.auditChange(envName, current[envName], value),
          ),
        },
        reason: input.reason,
        targetId: 'config_overrides',
        targetType: 'config',
      });
    });

    return { applied: entries.map(([envName]) => envName), pendingRestart: true };
  }

  /** Audit details never contain secret values, only key names and set/unset markers. */
  private auditChange(
    envName: string,
    previous: string | undefined,
    next: string | null,
  ): Record<string, unknown> {
    const setting = getConfigurableSetting(envName);
    if (setting?.secret) {
      return {
        key: envName,
        next: next === null ? null : 'set',
        previous: previous === undefined ? null : 'set',
        secret: true,
      };
    }
    return { key: envName, next, previous: previous ?? null };
  }

  /**
   * Merges prospective overrides with the base environment (locked explicit env wins) and
   * reuses the boot-time resolvers so cross-field rules (S3 all-or-none, endpoint shape,
   * absolute cache root) stay identical to startup semantics.
   */
  private validateGroupRules(overrides: Record<string, string>): void {
    const environment: Record<string, string> = { ...this.boot.baseEnv };
    for (const [envName, value] of Object.entries(overrides)) {
      if (!this.boot.explicitEnvNames.has(envName)) {
        environment[envName] = value;
      }
    }
    try {
      resolveMediaCacheConfig(environment);
      resolveMediaS3Config(environment);
    } catch (error) {
      throw new AdminConfigValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  private async readOverrides(
    executor: Pick<Database, 'select'> = this.database,
  ): Promise<Record<string, string>> {
    const rows = await executor
      .select({ key: configOverrides.key, value: configOverrides.value })
      .from(configOverrides);
    const overrides: Record<string, string> = {};
    for (const row of rows) {
      overrides[row.key] = row.value;
    }
    return overrides;
  }
}
