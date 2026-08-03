import { describe, expect, it } from 'vitest';
import {
  ArchiveContainerError,
  ArchiveEntryPolicy,
  archiveEntryPathCollisionKey,
  canonicalizeArchiveEntryPath,
  compareArchiveEntryPaths,
  resolveArchiveContainerLimits,
} from '../src/entry-policy.js';

function expectCode(run: () => unknown, code: ArchiveContainerError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveContainerError);
    expect((error as ArchiveContainerError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('archive entry path policy', () => {
  it('accepts bounded canonical POSIX paths', () => {
    expect(canonicalizeArchiveEntryPath('manifest.json')).toBe('manifest.json');
    expect(canonicalizeArchiveEntryPath('blobs/sha256/ab/cd/0123456789abcdef')).toBe(
      'blobs/sha256/ab/cd/0123456789abcdef',
    );
  });

  it.each([
    '',
    '/absolute',
    '//unc/share',
    'C:/windows',
    'https:payload',
    '../escape',
    'safe/../escape',
    './relative',
    'safe//double',
    'safe/trailing/',
    'safe\\windows',
    'safe\0nul',
    'data/频道.jsonl',
    'data/file:name',
    'data/file name',
    'data/file.',
    'CON',
    'con.txt',
    'data/AUX.jsonl',
    'data/COM1.log',
    'data/lpt9',
    `${'a'.repeat(101)}`,
  ])('rejects non-canonical path %j', (entryPath) => {
    expectCode(() => canonicalizeArchiveEntryPath(entryPath), 'INVALID_ARCHIVE_PATH');
  });

  it('rejects unsafe finite-limit configurations', () => {
    expectCode(
      () => resolveArchiveContainerLimits({ maxEntries: Number.POSITIVE_INFINITY }),
      'INVALID_ARCHIVE_LIMIT',
    );
    expectCode(
      () => resolveArchiveContainerLimits({ maxCompressionRatio: Number.NaN }),
      'INVALID_ARCHIVE_LIMIT',
    );
    expectCode(() => resolveArchiveContainerLimits({ maxPathBytes: 101 }), 'INVALID_ARCHIVE_LIMIT');
    expectCode(
      () => resolveArchiveContainerLimits({ maxPathSegments: 0 }),
      'INVALID_ARCHIVE_LIMIT',
    );
    expectCode(
      () => resolveArchiveContainerLimits({ noProgressTimeoutMs: 0 }),
      'INVALID_ARCHIVE_LIMIT',
    );
    expectCode(
      () => resolveArchiveContainerLimits({ zstdWindowLogMax: 31 }),
      'INVALID_ARCHIVE_LIMIT',
    );
  });

  it('rejects paths deeper than the configured segment bound', () => {
    expectCode(
      () => canonicalizeArchiveEntryPath('data/family/000001.jsonl', 100, 2),
      'INVALID_ARCHIVE_PATH',
    );
  });

  it('exposes locale-independent collision and ordering helpers', () => {
    expect(archiveEntryPathCollisionKey('DATA/Family/000001.JSONL')).toBe(
      'data/family/000001.jsonl',
    );
    expect(compareArchiveEntryPaths('A', 'a')).toBe(-1);
    expect(compareArchiveEntryPaths('same', 'same')).toBe(0);
    expect(compareArchiveEntryPaths('z', 'a')).toBe(1);
  });
});

describe('archive entry accounting', () => {
  it('rejects duplicate and extra paths', () => {
    const policy = new ArchiveEntryPolicy({
      isAllowedPath: (entryPath) => entryPath === 'manifest.json',
    });
    policy.accept({ name: 'manifest.json', size: 2, type: 'file' });

    expectCode(
      () => policy.accept({ name: 'manifest.json', size: 2, type: 'file' }),
      'DUPLICATE_ARCHIVE_PATH',
    );

    const extraPolicy = new ArchiveEntryPolicy({ isAllowedPath: () => false });
    expectCode(
      () => extraPolicy.accept({ name: 'extra.txt', size: 1, type: 'file' }),
      'EXTRA_ARCHIVE_ENTRY',
    );

    const casePolicy = new ArchiveEntryPolicy({ isAllowedPath: () => true });
    casePolicy.accept({ name: 'data/file.jsonl', size: 1, type: 'file' });
    expectCode(
      () => casePolicy.accept({ name: 'DATA/FILE.JSONL', size: 1, type: 'file' }),
      'DUPLICATE_ARCHIVE_PATH',
    );
  });

  it('rejects links, non-regular entries, excess count, and excess bytes', () => {
    const limits = {
      maxExpandedBytes: 4096,
      maxEntries: 1,
      maxEntryBytes: 8,
      maxTotalEntryBytes: 8,
    };
    const linkPolicy = new ArchiveEntryPolicy({ isAllowedPath: () => true, limits });
    expectCode(
      () => linkPolicy.accept({ name: 'link', size: 0, type: 'symlink', linkname: '../target' }),
      'UNSUPPORTED_ARCHIVE_ENTRY_TYPE',
    );

    const countPolicy = new ArchiveEntryPolicy({ isAllowedPath: () => true, limits });
    countPolicy.accept({ name: 'one', size: 1, type: 'file' });
    expectCode(
      () => countPolicy.accept({ name: 'two', size: 1, type: 'file' }),
      'ENTRY_COUNT_LIMIT_EXCEEDED',
    );

    const sizePolicy = new ArchiveEntryPolicy({ isAllowedPath: () => true, limits });
    expectCode(
      () => sizePolicy.accept({ name: 'large', size: 9, type: 'file' }),
      'ENTRY_SIZE_LIMIT_EXCEEDED',
    );
  });
});
