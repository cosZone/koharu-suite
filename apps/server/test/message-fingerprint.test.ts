import { describe, expect, it } from 'vitest';
import { fingerprintMessageSnapshot } from '../src/messages/fingerprint.js';
import type { NormalizedMessageSnapshot } from '../src/messages/types.js';

function snapshot(): NormalizedMessageSnapshot {
  return {
    channel: {
      telegramChatId: -1_001_234_567_890n,
      title: 'Channel title is not content identity',
      username: 'channel',
    },
    media: [
      {
        availabilityReason: null,
        duration: null,
        fileName: 'photo.jpg',
        fileSize: 1_024n,
        height: 480,
        kind: 'photo',
        mimeType: 'image/jpeg',
        sourceMediaType: 'photo',
        sourceMetadata: {},
        sourcePath: null,
        telegramFileId: 'bot-file-id',
        telegramFileUniqueId: 'bot-unique-id',
        width: 640,
      },
    ],
    message: {
      authorSignature: 'Koharu',
      contentKind: 'caption',
      editedAt: null,
      entities: [],
      mediaGroupId: null,
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      telegramMessageId: 42n,
      text: 'hello',
    },
  };
}

describe('source-neutral message fingerprint', () => {
  it('ignores source-only Bot and Desktop evidence', () => {
    const bot = snapshot();
    const desktop: NormalizedMessageSnapshot = {
      ...bot,
      channel: {
        ...bot.channel,
        title: 'Desktop export title',
        username: null,
      },
      media: bot.media.map((media) => ({
        ...media,
        availabilityReason: 'not_included',
        sourceMetadata: { stickerEmoji: '🌸' },
        sourcePath: 'photos/photo_1.jpg',
        telegramFileId: null,
        telegramFileUniqueId: null,
      })),
    };

    expect(fingerprintMessageSnapshot(desktop)).toBe(fingerprintMessageSnapshot(bot));
  });

  it('changes when canonical content changes', () => {
    const before = snapshot();
    const after: NormalizedMessageSnapshot = {
      ...before,
      message: {
        ...before.message,
        editedAt: new Date('2026-01-02T00:00:00Z'),
        text: 'edited',
      },
    };

    expect(fingerprintMessageSnapshot(after)).not.toBe(fingerprintMessageSnapshot(before));
  });
});
