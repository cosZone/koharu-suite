import { describe, expect, it } from 'vitest';
import {
  normalizeTelegramDesktopMediaPath,
  normalizeTelegramDesktopMessage,
} from '../src/imports/telegram-desktop-normalize.js';
import { fingerprintMessageSnapshot } from '../src/messages/fingerprint.js';

const CONTEXT = {
  channel: {
    telegramChatId: -1_001_234_567_890n,
    title: 'Allowlist title',
    username: 'allowlist_username',
  },
  sourceChatId: 1_234_567_890n,
};

describe('Telegram Desktop message normalization', () => {
  it('uses text_entities as authoritative UTF-16 segments and maps entity attributes', () => {
    const result = normalizeTelegramDesktopMessage(
      {
        author: 'Koharu',
        date_unixtime: '1735787045',
        edited_unixtime: '1735787105',
        forwarded_from: 'Source channel',
        from: 'Ignored sender',
        from_id: 'channel1234567890',
        id: '42',
        reply_to_message_id: '41',
        text: 'ignored fallback',
        text_entities: [
          { text: 'A😀', type: 'bold' },
          { href: 'https://example.com', text: 'link', type: 'text_link' },
          { collapsed: true, text: 'quote', type: 'blockquote' },
          { document_id: 'emoji-1', text: '🌸', type: 'custom_emoji' },
          { language: 'ts', text: 'code', type: 'pre' },
          { text: 'visible', type: 'future_entity' },
        ],
        type: 'message',
      },
      CONTEXT,
    );

    expect(result).toMatchObject({
      kind: 'eligible',
      snapshot: {
        channel: CONTEXT.channel,
        message: {
          authorSignature: 'Koharu',
          contentKind: 'text',
          entities: [
            { length: 3, offset: 0, type: 'bold' },
            {
              length: 4,
              offset: 3,
              type: 'text_link',
              url: 'https://example.com',
            },
            { length: 5, offset: 7, type: 'expandable_blockquote' },
            {
              customEmojiId: 'emoji-1',
              length: 2,
              offset: 12,
              type: 'custom_emoji',
            },
            { language: 'ts', length: 4, offset: 14, type: 'pre' },
          ],
          telegramMessageId: 42n,
          text: 'A😀linkquote🌸codevisible',
        },
      },
      warnings: ['unknown_entity'],
    });
    if (result.kind !== 'eligible') {
      throw new Error('Expected eligible result');
    }
    expect(result.snapshot.message.publishedAt.toISOString()).toBe('2025-01-02T03:04:05.000Z');
    expect(result.snapshot.message.editedAt?.toISOString()).toBe('2025-01-02T03:05:05.000Z');
    expect(result.observation.sourceKey).toContain(
      'telegram-desktop:-1001234567890:42:2025-01-02T03:05:05.000Z:',
    );
    expect(result.observation.sourceMetadata).toEqual({
      forwardedFrom: 'Source channel',
      replyToMessageId: '41',
    });
    expect(result.sourceMetadata).toEqual({
      forwardedFrom: 'Source channel',
      replyToMessageId: '41',
    });
  });

  it('falls back to explicitly-zoned ISO dates and string/segment text', () => {
    const result = normalizeTelegramDesktopMessage(
      {
        date: '2025-01-02T03:04:05+08:00',
        edited: '2025-01-02T04:04:05+08:00',
        id: 43,
        text: ['hello ', { text: '+86 123', type: 'phone' }],
        type: 'message',
      },
      CONTEXT,
    );

    expect(result).toMatchObject({
      kind: 'eligible',
      snapshot: {
        message: {
          entities: [{ length: 7, offset: 6, type: 'phone_number' }],
          text: 'hello +86 123',
        },
      },
      warnings: ['date_iso_fallback', 'edited_iso_fallback'],
    });
  });

  it('rejects dates without zones and IDs outside the exact integer range', () => {
    expect(
      normalizeTelegramDesktopMessage(
        { date: '2025-01-02T03:04:05', id: 1, text: 'bad', type: 'message' },
        CONTEXT,
      ),
    ).toMatchObject({ code: 'invalid_date', kind: 'item_error' });
    expect(
      normalizeTelegramDesktopMessage(
        {
          date_unixtime: '1735787045',
          id: Number.MAX_SAFE_INTEGER + 1,
          text: 'bad',
          type: 'message',
        },
        CONTEXT,
      ),
    ).toMatchObject({ code: 'invalid_id', kind: 'item_error' });
  });

  it('normalizes media metadata and placeholders without manufacturing Bot IDs', () => {
    const result = normalizeTelegramDesktopMessage(
      {
        date_unixtime: '1735787045',
        duration_seconds: 12,
        file: 'video_files/clip.mp4',
        file_name: 'clip.mp4',
        file_size: '12345',
        height: 720,
        id: 44,
        media_type: 'video_message',
        mime_type: 'video/mp4',
        text: 'caption',
        type: 'message',
        width: 1280,
      },
      CONTEXT,
    );
    expect(result).toMatchObject({
      kind: 'eligible',
      snapshot: {
        media: [
          {
            availabilityReason: null,
            fileSize: 12_345n,
            kind: 'video',
            sourceMediaType: 'video_message',
            sourcePath: 'video_files/clip.mp4',
            telegramFileId: null,
            telegramFileUniqueId: null,
          },
        ],
        message: { contentKind: 'caption', mediaGroupId: null },
      },
    });

    const placeholder = normalizeTelegramDesktopMessage(
      {
        date_unixtime: '1735787045',
        id: 45,
        photo: '(File exceeds maximum size. Change data exporting settings to download.)',
        type: 'message',
      },
      CONTEXT,
    );
    expect(placeholder).toMatchObject({
      kind: 'eligible',
      snapshot: {
        media: [
          {
            availabilityReason: 'exceeds_maximum_size',
            kind: 'photo',
            sourcePath: null,
          },
        ],
      },
    });
  });

  it.each([
    ['animation', 'animation'],
    ['audio_file', 'audio'],
    ['file', 'document'],
    ['sticker', 'document'],
    ['video_file', 'video'],
    ['video_message', 'video'],
    ['voice_message', 'voice'],
  ] as const)('maps %s media to canonical %s metadata', (mediaType, kind) => {
    const result = normalizeTelegramDesktopMessage(
      {
        date_unixtime: '1735787045',
        file: `files/${mediaType}.bin`,
        id: 50,
        media_type: mediaType,
        type: 'message',
      },
      CONTEXT,
    );
    expect(result).toMatchObject({
      kind: 'eligible',
      snapshot: { media: [{ kind, sourceMediaType: mediaType }] },
    });
  });

  it.each([
    ['(File not included. Change data exporting settings to download.)', 'not_included'],
    [
      '(File exceeds maximum size. Change data exporting settings to download.)',
      'exceeds_maximum_size',
    ],
    ['(File unavailable, please try again later.)', 'unavailable'],
  ])('maps the media placeholder to %s', (placeholderPath, availabilityReason) => {
    const result = normalizeTelegramDesktopMessage(
      {
        date_unixtime: '1735787045',
        file: placeholderPath,
        id: 51,
        media_type: 'file',
        type: 'message',
      },
      CONTEXT,
    );
    expect(result).toMatchObject({
      kind: 'eligible',
      snapshot: { media: [{ availabilityReason, sourcePath: null }] },
    });
  });

  it('preserves unknown media as document metadata with a warning', () => {
    const result = normalizeTelegramDesktopMessage(
      {
        date_unixtime: '1735787045',
        file: 'files/future.bin',
        id: 52,
        media_type: 'future_media',
        type: 'message',
      },
      CONTEXT,
    );
    expect(result).toMatchObject({
      kind: 'eligible',
      snapshot: { media: [{ kind: 'document', sourceMediaType: 'unknown' }] },
      warnings: ['unknown_media'],
    });
  });

  it('skips non-message records and reports unsupported empty records', () => {
    expect(normalizeTelegramDesktopMessage({ type: 'service' }, CONTEXT)).toEqual({
      kind: 'skipped',
      reason: 'service',
    });
    expect(normalizeTelegramDesktopMessage({ type: 'unsupported' }, CONTEXT)).toEqual({
      kind: 'skipped',
      reason: 'unsupported',
    });
    expect(normalizeTelegramDesktopMessage({ type: 'rich_message' }, CONTEXT)).toEqual({
      kind: 'skipped',
      reason: 'rich_message',
    });
    expect(
      normalizeTelegramDesktopMessage(
        { date_unixtime: '1735787045', id: 46, type: 'message' },
        CONTEXT,
      ),
    ).toMatchObject({ code: 'empty_message', kind: 'item_error' });
  });

  it('normalizes only export-relative POSIX paths and never resolves symlinks', () => {
    expect(normalizeTelegramDesktopMediaPath('./photos/image.jpg')).toBe('photos/image.jpg');
    expect(normalizeTelegramDesktopMediaPath('media/symlink/image.jpg')).toBe(
      'media/symlink/image.jpg',
    );
    for (const unsafe of [
      '',
      '/etc/passwd',
      '../secret',
      'photos/../../secret',
      'C:\\secret',
      'file:///tmp/secret',
      'https://example.com/image.jpg',
      'photos\\image.jpg',
      'photos/\0image.jpg',
    ]) {
      expect(() => normalizeTelegramDesktopMediaPath(unsafe)).toThrowError(
        expect.objectContaining({ code: 'unsafe_media_path' }),
      );
    }
  });

  it('keeps fingerprints stable across raw field order and excludes mutable channel metadata', () => {
    const first = normalizeTelegramDesktopMessage(
      { date_unixtime: '1735787045', id: 47, text: 'same', type: 'message' },
      CONTEXT,
    );
    const second = normalizeTelegramDesktopMessage(
      { text: 'same', type: 'message', id: 47, date_unixtime: '1735787045' },
      {
        ...CONTEXT,
        channel: { ...CONTEXT.channel, title: 'Renamed', username: 'renamed' },
      },
    );
    if (first.kind !== 'eligible' || second.kind !== 'eligible') {
      throw new Error('Expected eligible results');
    }

    expect(fingerprintMessageSnapshot(first.snapshot)).toBe(
      fingerprintMessageSnapshot(second.snapshot),
    );
  });
});
