import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { normalizeChannelPost } from '../src/telegram/normalize.js';
import { channelPostFixture } from './fixtures/telegram.js';

const ALLOWED_CHANNEL_ID = -1_001_234_567_890n;

describe('Telegram channel post normalization', () => {
  it('normalizes public text, entities, and the largest photo metadata', () => {
    const normalized = normalizeChannelPost(channelPostFixture(), ALLOWED_CHANNEL_ID);

    expect(normalized).toMatchObject({
      channel: {
        telegramChatId: ALLOWED_CHANNEL_ID,
        title: 'Koharu Test Channel',
        username: 'koharu_test',
      },
      message: {
        authorSignature: 'Koharu',
        contentKind: 'text',
        entities: [{ length: 6, offset: 0, type: 'bold' }],
        mediaGroupId: 'album-1',
        telegramMessageId: 42n,
        text: 'Koharu first channel post',
      },
      media: [
        {
          fileId: 'large-file-id',
          fileSize: 4_096n,
          fileUniqueId: 'large-unique-id',
          height: 720,
          kind: 'photo',
          mimeType: 'image/jpeg',
          width: 1_280,
        },
      ],
      telegramUpdateId: 1_001n,
    });
    expect(normalized?.message.publishedAt.toISOString()).toBe('2025-06-30T16:13:20.000Z');
  });

  it('uses caption content and media metadata when text is absent', () => {
    const update = channelPostFixture();
    if (!update.channel_post) {
      throw new Error('Fixture is missing channel_post');
    }

    delete update.channel_post.text;
    delete update.channel_post.entities;
    delete update.channel_post.photo;
    update.channel_post.caption = 'A video caption';
    update.channel_post.caption_entities = [
      {
        length: 5,
        offset: 2,
        type: 'italic',
      },
    ];
    update.channel_post.video = {
      duration: 12,
      file_id: 'video-file-id',
      file_name: 'clip.mp4',
      file_size: 12_345,
      file_unique_id: 'video-unique-id',
      height: 720,
      mime_type: 'video/mp4',
      width: 1_280,
    };

    expect(normalizeChannelPost(update, ALLOWED_CHANNEL_ID)).toMatchObject({
      message: {
        contentKind: 'caption',
        entities: [{ length: 5, offset: 2, type: 'italic' }],
        text: 'A video caption',
      },
      media: [
        {
          duration: 12,
          fileName: 'clip.mp4',
          fileSize: 12_345n,
          height: 720,
          kind: 'video',
          mimeType: 'video/mp4',
          width: 1_280,
        },
      ],
    });
  });

  it('ignores updates from another channel or a non-channel chat', () => {
    expect(
      normalizeChannelPost(
        channelPostFixture({ channelId: -1_009_999_999_999 }),
        ALLOWED_CHANNEL_ID,
      ),
    ).toBeNull();

    const channelUpdate = channelPostFixture();
    const nonChannelUpdate = {
      ...channelUpdate,
      channel_post: {
        ...channelUpdate.channel_post,
        chat: {
          id: -1_001_234_567_890,
          title: 'Not a channel',
          type: 'supergroup',
        },
      },
    } as unknown as Update;

    expect(normalizeChannelPost(nonChannelUpdate, ALLOWED_CHANNEL_ID)).toBeNull();
  });
});
