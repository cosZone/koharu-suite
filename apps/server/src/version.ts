import { readFileSync } from 'node:fs';

const packageJson: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

if (
  typeof packageJson !== 'object' ||
  packageJson === null ||
  !('version' in packageJson) ||
  typeof packageJson.version !== 'string'
) {
  throw new Error('Server package metadata does not contain a valid version');
}

export const VERSION = packageJson.version;
