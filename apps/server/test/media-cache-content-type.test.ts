import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MediaContentTypeError,
  validateMediaContentType,
} from '../src/media-cache/content-type.js';

const temporaryDirectories: string[] = [];
const WEBP_FIXTURE = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const MP4_FIXTURE = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
const WEBM_FIXTURE = Uint8Array.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
  0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x04,
  0x42, 0x85, 0x81, 0x02,
]);

async function openFixture(contents: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'koharu-media-type-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'fixture');
  await writeFile(path, contents);
  return open(path, 'r');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('media cache content type validation', () => {
  it('returns the canonical MIME and extension for an allowed JPEG photo', async () => {
    const file = await openFixture(
      Uint8Array.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
      ]),
    );

    try {
      await expect(validateMediaContentType(file, 'photo')).resolves.toEqual({
        extension: 'jpg',
        mimeType: 'image/jpeg',
      });
    } finally {
      await file.close();
    }
  });

  it.each([
    {
      contents: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      expected: { extension: 'png', mimeType: 'image/png' },
      label: 'PNG',
    },
    {
      contents: WEBP_FIXTURE,
      expected: { extension: 'webp', mimeType: 'image/webp' },
      label: 'WebP',
    },
    {
      contents: Uint8Array.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00,
        0x00, 0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31,
      ]),
      expected: { extension: 'avif', mimeType: 'image/avif' },
      label: 'AVIF',
    },
  ])(
    'returns the canonical MIME and extension for an allowed $label photo',
    async ({ contents, expected }) => {
      const file = await openFixture(contents);

      try {
        await expect(validateMediaContentType(file, 'photo')).resolves.toEqual(expected);
      } finally {
        await file.close();
      }
    },
  );

  it.each([
    {
      contents: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
      expected: { extension: 'gif', mimeType: 'image/gif' },
      label: 'GIF',
    },
    {
      contents: WEBP_FIXTURE,
      expected: { extension: 'webp', mimeType: 'image/webp' },
      label: 'WebP',
    },
    {
      contents: MP4_FIXTURE,
      expected: { extension: 'mp4', mimeType: 'video/mp4' },
      label: 'MP4',
    },
  ])(
    'returns the canonical MIME and extension for an allowed $label animation',
    async ({ contents, expected }) => {
      const file = await openFixture(contents);

      try {
        await expect(validateMediaContentType(file, 'animation')).resolves.toEqual(expected);
      } finally {
        await file.close();
      }
    },
  );

  it.each([
    {
      contents: MP4_FIXTURE,
      expected: { extension: 'mp4', mimeType: 'video/mp4' },
      label: 'MP4',
    },
    {
      contents: WEBM_FIXTURE,
      expected: { extension: 'webm', mimeType: 'video/webm' },
      label: 'WebM',
    },
  ])(
    'returns the canonical MIME and extension for an allowed $label video',
    async ({ contents, expected }) => {
      const file = await openFixture(contents);

      try {
        await expect(validateMediaContentType(file, 'video')).resolves.toEqual(expected);
      } finally {
        await file.close();
      }
    },
  );

  it('rejects content without a recognized magic number using a stable error code', async () => {
    const file = await openFixture(Buffer.from('plain text is not cacheable media'));

    try {
      const validation = validateMediaContentType(file, 'photo');
      await expect(validation).rejects.toBeInstanceOf(MediaContentTypeError);
      await expect(validation).rejects.toMatchObject({
        code: 'media_content_type_unknown',
        name: 'MediaContentTypeError',
      });
    } finally {
      await file.close();
    }
  });

  it('rejects a recognized type outside the declared kind allowlist using a stable error code', async () => {
    const file = await openFixture(WEBM_FIXTURE);

    try {
      const validation = validateMediaContentType(file, 'photo');
      await expect(validation).rejects.toBeInstanceOf(MediaContentTypeError);
      await expect(validation).rejects.toMatchObject({
        code: 'media_content_type_mismatch',
        name: 'MediaContentTypeError',
      });
    } finally {
      await file.close();
    }
  });
});
