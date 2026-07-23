import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readOwnerPassword } from '../src/auth/password-input.js';

function streamWith(value: string): NodeJS.ReadStream {
  const stream = new PassThrough();
  stream.end(value);
  return stream as unknown as NodeJS.ReadStream;
}

describe('owner password input', () => {
  it('reads exactly one password line only when --password-stdin is explicit', async () => {
    await expect(
      readOwnerPassword(true, streamWith('correct horse battery staple\n')),
    ).resolves.toBe('correct horse battery staple');

    await expect(
      readOwnerPassword(true, streamWith('correct horse\nbattery staple\n')),
    ).rejects.toThrow('exactly one line');
  });

  it('rejects weak passwords and implicit non-interactive input', async () => {
    await expect(readOwnerPassword(true, streamWith('too-short\n'))).rejects.toThrow();
    await expect(
      readOwnerPassword(false, streamWith('correct horse battery staple\n')),
    ).rejects.toThrow('--password-stdin');
  });
});
