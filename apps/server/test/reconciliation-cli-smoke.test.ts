import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('kodama reconciliation CLI smoke', () => {
  it('accepts repeatable channel, apply, reason, and JSON through the wired apply path', () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'reconcile',
        'telegram',
        '--channel',
        '-1002234260754',
        '--channel',
        '-1002234260755',
        '--apply',
        '--reason',
        'operator approved',
        '--json',
        '--database-url',
        'postgresql://test:test@127.0.0.1:1/test',
      ],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      issues: [
        {
          code: 'reconciliation_apply_failed',
          sanitizedReason: 'The reconciliation apply could not be completed',
        },
      ],
      mode: 'apply',
      scope: {
        channelIds: ['-1002234260754', '-1002234260755'],
      },
      status: 'fatal',
    });
  });
});
