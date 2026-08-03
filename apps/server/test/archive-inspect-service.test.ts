import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectArchiveArtifact } from '../src/archive/inspect-service.js';
import { renderArchiveReportText } from '../src/archive/report.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'koharu-archive-inspect-'));
  roots.push(value);
  await chmod(value, 0o700);
  return value;
}

describe('portable archive inspect service', () => {
  it('returns a bounded fatal report for a missing input without disclosing its path', async () => {
    const inputPath = join(await root(), 'private-owner-name.tar.zst');
    const report = await inspectArchiveArtifact({ inputPath });
    expect(report).toMatchObject({
      mode: 'inspect',
      status: 'fatal',
      issues: [{ code: 'archive_inspect', sanitizedReason: 'input_unavailable' }],
    });
    expect(JSON.stringify(report)).not.toContain(inputPath);
  });

  it('opens with no-follow semantics and never exposes a symlink target', async () => {
    const directory = await root();
    const target = join(directory, 'private-target');
    const inputPath = join(directory, 'archive.tar.zst');
    await writeFile(target, 'secret');
    await symlink(target, inputPath);
    const report = await inspectArchiveArtifact({ inputPath });
    expect(report.status).toBe('fatal');
    expect(report.issues[0]?.sanitizedReason).toBe('input_unavailable');
    expect(JSON.stringify(report)).not.toContain(target);
  });

  it('rejects directories as non-regular inputs without requiring database configuration', async () => {
    const inputPath = await root();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const report = await inspectArchiveArtifact({ inputPath });
      expect(report.issues[0]?.sanitizedReason).toBe('input_not_regular');
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it('renders only the sanitized structured report', async () => {
    const privatePath = join(await root(), 'private-owner-name.tar.zst');
    const report = await inspectArchiveArtifact({ inputPath: privatePath });
    const rendered = renderArchiveReportText(report);
    expect(rendered).toContain('Portable archive INSPECT: FATAL');
    expect(rendered).toContain('archive_inspect: input_unavailable');
    expect(rendered).not.toContain(privatePath);
  });
});
