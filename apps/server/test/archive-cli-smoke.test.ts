import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('kodama archive CLI smoke', () => {
  it('inspects without resolving DATABASE_URL or opening PostgreSQL', () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'archive',
        'inspect',
        '--input',
        './missing-archive.tar.zst',
        '--json',
      ],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'inspect',
      status: 'fatal',
    });
  });
});
