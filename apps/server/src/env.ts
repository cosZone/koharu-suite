import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export function resolveEnvironmentFile(startDirectory = process.cwd()): string {
  const fallback = join(resolve(startDirectory), '.env');
  let directory = resolve(startDirectory);

  while (true) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      return join(directory, '.env');
    }

    const parent = dirname(directory);

    if (parent === directory) {
      return fallback;
    }

    directory = parent;
  }
}

export function loadEnvironmentFile(path = resolveEnvironmentFile()): void {
  try {
    loadEnvFile(path);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}
