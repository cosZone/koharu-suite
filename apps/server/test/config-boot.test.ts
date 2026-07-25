import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clientMock, postgresMock } = vi.hoisted(() => {
  const client = Object.assign(vi.fn(), { end: vi.fn(async () => undefined) });
  return { clientMock: client, postgresMock: vi.fn(() => client) };
});

vi.mock('postgres', () => ({ default: postgresMock }));

import { captureExplicitEnvironment, resolveBootEnvironment } from '../src/config-boot.js';
import { CONFIGURABLE_ENV_NAMES } from '../src/config-registry.js';

const DATABASE_URL = 'postgresql://koharu:koharu@localhost:5432/koharu';

// Isolate process.env from registry-keyed variables inherited from the test runner.
const savedEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of CONFIGURABLE_ENV_NAMES) {
    savedEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnvironment.clear();
});

describe('captureExplicitEnvironment', () => {
  it('returns a detached copy of the shell environment', () => {
    process.env.S3_REGION = 'eu-west-1';
    const explicit = captureExplicitEnvironment();
    explicit.S3_REGION = 'mutated';
    expect(process.env.S3_REGION).toBe('eu-west-1');
  });
});

describe('resolveBootEnvironment', () => {
  it('merges shell env over database overrides over the base env', async () => {
    process.env.S3_REGION = 'from-dotenv';
    process.env.TRUST_PROXY = 'false';
    const explicitEnv = { S3_REGION: 'from-shell' };
    clientMock.mockResolvedValueOnce([
      { key: 'S3_PREFIX', value: 'from-override' },
      { key: 'S3_REGION', value: 'from-override' },
    ]);

    const { configCenter, environment } = await resolveBootEnvironment(DATABASE_URL, explicitEnv);

    expect(environment.S3_REGION).toBe('from-shell');
    expect(environment.S3_PREFIX).toBe('from-override');
    expect(environment.TRUST_PROXY).toBe('false');
    expect(configCenter).toEqual({
      baseEnv: {
        S3_REGION: 'from-shell',
        TRUST_PROXY: 'false',
      },
      bootOverrides: { S3_PREFIX: 'from-override', S3_REGION: 'from-override' },
      effectiveEnv: {
        S3_PREFIX: 'from-override',
        S3_REGION: 'from-shell',
        TRUST_PROXY: 'false',
      },
      explicitEnvNames: new Set(['S3_REGION']),
    });
  });

  it('boots without overrides when the table is empty', async () => {
    process.env.MEDIA_CACHE_ENABLED = 'true';
    clientMock.mockResolvedValueOnce([]);

    const { configCenter, environment } = await resolveBootEnvironment(DATABASE_URL, {});

    expect(environment.MEDIA_CACHE_ENABLED).toBe('true');
    expect(configCenter.bootOverrides).toEqual({});
    expect(configCenter.explicitEnvNames).toEqual(new Set());
  });
});
