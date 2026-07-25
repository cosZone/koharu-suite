import { describe, expect, it } from 'vitest';
import { mergeEnvironmentWithOverrides } from '../src/config-overrides.js';
import {
  CONFIGURABLE_ENV_NAMES,
  CONFIGURABLE_SETTINGS,
  configurableEnvValues,
  getConfigurableSetting,
  maskSecretValue,
} from '../src/config-registry.js';

const EXPECTED_ENV_NAMES = [
  'MEDIA_CACHE_ENABLED',
  'MEDIA_CACHE_ROOT',
  'MEDIA_CACHE_MAX_BYTES',
  'MEDIA_CACHE_DOWNLOAD_CONCURRENCY',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_PREFIX',
  'S3_MAX_BYTES',
  'S3_FORCE_PATH_STYLE',
  'S3_ALLOW_INSECURE',
  'S3_CONNECT_TIMEOUT_MS',
  'S3_REQUEST_TIMEOUT_MS',
  'S3_KEY',
  'S3_SECRET',
  'PUBLIC_CORS_ORIGINS',
  'PUBLIC_RATE_LIMIT_MAX',
  'PUBLIC_RATE_LIMIT_WINDOW_SECONDS',
  'TRUST_PROXY',
  'TELEGRAM_WORKER_CONCURRENCY',
];

describe('config registry', () => {
  it('covers exactly the panel-configurable environment variables', () => {
    expect([...CONFIGURABLE_ENV_NAMES].sort()).toEqual([...EXPECTED_ENV_NAMES].sort());
    expect(CONFIGURABLE_SETTINGS).toHaveLength(EXPECTED_ENV_NAMES.length);
  });

  it('marks only the S3 credentials as write-only secrets', () => {
    const secrets = CONFIGURABLE_SETTINGS.filter((setting) => setting.secret).map(
      (setting) => setting.envName,
    );
    expect(secrets.sort()).toEqual(['S3_KEY', 'S3_SECRET']);
    for (const setting of CONFIGURABLE_SETTINGS) {
      expect(setting.kind === 'secret').toBe(setting.secret);
    }
  });

  it.each([
    ['MEDIA_CACHE_ENABLED', 'true', true],
    ['MEDIA_CACHE_ENABLED', 'yes', false],
    ['MEDIA_CACHE_MAX_BYTES', '1073741824', true],
    ['MEDIA_CACHE_MAX_BYTES', '0', false],
    ['MEDIA_CACHE_MAX_BYTES', 'not-a-number', false],
    ['MEDIA_CACHE_DOWNLOAD_CONCURRENCY', '4', true],
    ['MEDIA_CACHE_DOWNLOAD_CONCURRENCY', '5', false],
    ['S3_REGION', 'eu-west-1', true],
    ['S3_REGION', '', false],
    ['S3_CONNECT_TIMEOUT_MS', '249', false],
    ['S3_ALLOW_INSECURE', 'false', true],
    ['S3_ALLOW_INSECURE', '1', false],
    ['PUBLIC_RATE_LIMIT_WINDOW_SECONDS', '3600', true],
    ['PUBLIC_RATE_LIMIT_WINDOW_SECONDS', '3601', false],
    ['TRUST_PROXY', 'true', true],
    ['TRUST_PROXY', 'on', false],
    ['TELEGRAM_WORKER_CONCURRENCY', '16', true],
    ['TELEGRAM_WORKER_CONCURRENCY', '17', false],
  ] as const)('validates %s=%s as %s', (envName, value, valid) => {
    const setting = getConfigurableSetting(envName);
    expect(setting).toBeDefined();
    expect(setting?.schema.safeParse(value).success).toBe(valid);
  });

  it('extracts only registry-keyed environment values', () => {
    expect(
      configurableEnvValues({ PATH: '/usr/bin', S3_REGION: 'eu-west-1', TRUST_PROXY: 'true' }),
    ).toEqual({ S3_REGION: 'eu-west-1', TRUST_PROXY: 'true' });
  });

  it('masks secrets down to set state and last4', () => {
    expect(maskSecretValue(undefined)).toEqual({ set: false });
    expect(maskSecretValue('')).toEqual({ set: false });
    expect(maskSecretValue('abc')).toEqual({ set: true });
    expect(maskSecretValue('abcd1234secret')).toEqual({ last4: 'cret', set: true });
  });
});

describe('environment merge precedence', () => {
  it('prefers explicit shell env over database overrides over the base env', () => {
    const merged = mergeEnvironmentWithOverrides(
      { S3_REGION: 'from-dotenv', TRUST_PROXY: 'false' },
      { S3_REGION: 'from-override', S3_PREFIX: 'from-override' },
      { S3_REGION: 'from-shell' },
    );
    expect(merged.S3_REGION).toBe('from-shell');
    expect(merged.S3_PREFIX).toBe('from-override');
    expect(merged.TRUST_PROXY).toBe('false');
  });
});
