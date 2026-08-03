import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('kodama archive CLI smoke', () => {
  it('handles a closed stdout pipe without an unhandled stream error or stack trace', async () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(
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
      { cwd: serverRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.destroy();
    const [status] = await once(child, 'close');

    expect(status).toBe(1);
    expect(stderr).toContain('kodama:');
    expect(stderr).not.toContain(serverRoot);
    expect(stderr).not.toContain('node:events');
  });

  it('keeps unknown-option failures on the versioned JSON stdout contract', () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
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
        '--unknown-option',
      ],
      { cwd: serverRoot, encoding: 'utf8', env: process.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: 'invalid_arguments',
        message: 'Archive inspect received invalid arguments',
      },
      operation: 'inspect',
      schemaVersion: 1,
      status: 'fatal',
    });
  });

  it('keeps the JSON parse-failure contract when global options precede archive', () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--json', 'archive', 'inspect', '--unknown-option'],
      { cwd: serverRoot, encoding: 'utf8', env: process.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'invalid_arguments' },
      operation: 'inspect',
      schemaVersion: 1,
      status: 'fatal',
    });
  });

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
  }, 30_000);
});
