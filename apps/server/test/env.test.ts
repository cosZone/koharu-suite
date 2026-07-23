import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvironmentFile, resolveEnvironmentFile } from '../src/env.js';

const TEST_KEY = 'KOHARU_SUITE_ENV_TEST';
const originalValue = process.env[TEST_KEY];

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[TEST_KEY];
  } else {
    process.env[TEST_KEY] = originalValue;
  }
});

describe('environment file loading', () => {
  it('resolves the workspace root from a package directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koharu-suite-workspace-'));
    const packageDirectory = join(directory, 'apps', 'server');

    try {
      await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');

      expect(resolveEnvironmentFile(packageDirectory)).toBe(join(directory, '.env'));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('loads a present file and ignores a missing optional file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koharu-suite-env-'));
    const file = join(directory, '.env');

    try {
      await writeFile(file, `${TEST_KEY}=loaded\n`, 'utf8');
      delete process.env[TEST_KEY];

      loadEnvironmentFile(file);

      expect(process.env[TEST_KEY]).toBe('loaded');
      expect(() => loadEnvironmentFile(join(directory, 'missing.env'))).not.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
