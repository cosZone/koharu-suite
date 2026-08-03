import { describe, expect, it } from 'vitest';
import {
  ChecksumFormatError,
  compareChecksumPaths,
  parseChecksumFile,
  renderChecksumFile,
  sha256Hex,
} from '../src/checksums.js';

const A_HASH = 'a'.repeat(64);
const B_HASH = 'b'.repeat(64);

describe('checksum manifest', () => {
  it('rejects a UTF-8 BOM as a non-canonical checksum prefix', () => {
    expect(() =>
      parseChecksumFile(`\uFEFF${A_HASH}\t1\tdata/channels/000000.jsonl\n`),
    ).toThrowError(expect.objectContaining({ code: 'invalid_sha256', line: 1 }));
  });
  it('renders path-sorted canonical lines and parses them losslessly', () => {
    const rendered = renderChecksumFile([
      { byteLength: '2', path: 'data/messages/000000.jsonl', sha256: B_HASH },
      { byteLength: '1', path: 'data/channels/000000.jsonl', sha256: A_HASH },
    ]);

    expect(rendered).toBe(
      `${A_HASH}\t1\tdata/channels/000000.jsonl\n${B_HASH}\t2\tdata/messages/000000.jsonl\n`,
    );
    expect(parseChecksumFile(rendered)).toEqual([
      { byteLength: '1', path: 'data/channels/000000.jsonl', sha256: A_HASH },
      { byteLength: '2', path: 'data/messages/000000.jsonl', sha256: B_HASH },
    ]);
  });

  it.each([
    [`${A_HASH}\t1\tmanifest.json`, 'non_lf_line_ending'],
    [`${A_HASH}\t1\tmanifest.json\r\n`, 'non_lf_line_ending'],
    [`${A_HASH.toUpperCase()}\t1\tmanifest.json\n`, 'invalid_sha256'],
    [`${A_HASH}\t01\tmanifest.json\n`, 'invalid_byte_length'],
    [`${A_HASH}\t1\t../manifest.json\n`, 'invalid_path'],
    [`${A_HASH}\t1\thttps:manifest.json\n`, 'invalid_path'],
  ])('rejects non-canonical input without including the line (%s)', (input, code) => {
    try {
      parseChecksumFile(input);
      throw new Error('Expected checksum parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ChecksumFormatError);
      expect((error as ChecksumFormatError).code).toBe(code);
      expect((error as Error).message).not.toContain(input);
    }
  });

  it('represents a logically empty checksum inventory as an empty file', () => {
    expect(renderChecksumFile([])).toBe('');
    expect(parseChecksumFile('')).toEqual([]);
    expect(() => parseChecksumFile('\n')).toThrowError(
      expect.objectContaining({ code: 'empty_file' }),
    );
  });

  it('rejects exact and ASCII-casefold path collisions', () => {
    expect(() =>
      parseChecksumFile(`${A_HASH}\t1\tManifest.json\n${B_HASH}\t2\tmanifest.json\n`),
    ).toThrowError(expect.objectContaining({ code: 'duplicate_path' }));
    expect(() =>
      renderChecksumFile([
        { byteLength: '1', path: 'manifest.json', sha256: A_HASH },
        { byteLength: '2', path: 'manifest.json', sha256: B_HASH },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'duplicate_path' }));
  });

  it('rejects non-canonical path order and configured resource excess', () => {
    expect(() =>
      parseChecksumFile(
        `${A_HASH}\t1\tdata/messages/000000.jsonl\n${B_HASH}\t2\tdata/channels/000000.jsonl\n`,
      ),
    ).toThrowError(expect.objectContaining({ code: 'non_canonical_order' }));
    expect(() =>
      parseChecksumFile(`${A_HASH}\t11\tmanifest.json\n`, { maxEntryBytes: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'byte_length_limit_exceeded' }));
    expect(() =>
      parseChecksumFile(`${A_HASH}\t1\tmanifest.json\n`, { maxFileBytes: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'input_limit_exceeded' }));
    expect(() =>
      renderChecksumFile([{ byteLength: '1', path: 'manifest.json', sha256: A_HASH }], {
        maxLineBytes: 10,
      }),
    ).toThrowError(expect.objectContaining({ code: 'line_size_limit_exceeded' }));
  });

  it('compares declared checksums with actual archive entries in both directions', () => {
    const entries = parseChecksumFile(
      `${A_HASH}\t1\tdata/channels/000000.jsonl\n${B_HASH}\t2\tmanifest.json\n`,
    );
    expect(compareChecksumPaths(entries, ['manifest.json', 'data/messages/000000.jsonl'])).toEqual({
      unlistedArchivePaths: ['data/messages/000000.jsonl'],
      undeclaredChecksumPaths: ['data/channels/000000.jsonl'],
    });
  });

  it('hashes bytes using lowercase SHA-256', () => {
    expect(sha256Hex('koharu')).toBe(
      '90dc981e8e824a0c916b18bc0767e2dab7a9034898846441873c01f17c873239',
    );
  });
});
