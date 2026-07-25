import { loadConfigOverrides, mergeEnvironmentWithOverrides } from './config-overrides.js';
import {
  CONFIGURABLE_ENV_NAMES,
  type ConfigCenterBootState,
  configurableEnvValues,
} from './config-registry.js';

export interface BootEnvironment {
  /** Boot snapshot exposed to the admin config center. */
  configCenter: ConfigCenterBootState;
  /** Merged environment: explicit shell env > database overrides > .env. */
  environment: NodeJS.ProcessEnv;
}

/**
 * Captures the shell environment before loadEnvironmentFile() runs, so explicit
 * variables can be told apart from .env values and keep winning over overrides.
 */
export function captureExplicitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/**
 * Loads database overrides and merges them into the process environment with
 * boot-snapshot metadata for the admin config center. Callers must capture the
 * explicit environment (captureExplicitEnvironment) before loadEnvironmentFile().
 */
export async function resolveBootEnvironment(
  databaseUrl: string,
  explicitEnv: NodeJS.ProcessEnv,
): Promise<BootEnvironment> {
  const overrides = await loadConfigOverrides(databaseUrl);
  const environment = mergeEnvironmentWithOverrides(process.env, overrides, explicitEnv);
  return {
    configCenter: {
      baseEnv: configurableEnvValues({ ...process.env, ...explicitEnv }),
      bootOverrides: configurableEnvValues(overrides),
      effectiveEnv: configurableEnvValues(environment),
      explicitEnvNames: new Set([...CONFIGURABLE_ENV_NAMES].filter((name) => name in explicitEnv)),
    },
    environment,
  };
}
