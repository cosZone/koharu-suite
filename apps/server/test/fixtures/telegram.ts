import type { Update } from 'grammy/types';

export interface ChannelPostFixtureOptions {
  channelId?: number;
  date?: number;
  messageId?: number;
  text?: string;
  updateId?: number;
}

export function channelPostFixture(options: ChannelPostFixtureOptions = {}): Update {
  return {
    update_id: options.updateId ?? 1_001,
    channel_post: {
      author_signature: 'Koharu',
      chat: {
        id: options.channelId ?? -1_001_234_567_890,
        title: 'Koharu Test Channel',
        type: 'channel',
        username: 'koharu_test',
      },
      date: options.date ?? 1_751_300_000,
      entities: [
        {
          length: 6,
          offset: 0,
          type: 'bold',
        },
      ],
      media_group_id: 'album-1',
      message_id: options.messageId ?? 42,
      photo: [
        {
          file_id: 'small-file-id',
          file_size: 1_024,
          file_unique_id: 'small-unique-id',
          height: 90,
          width: 160,
        },
        {
          file_id: 'large-file-id',
          file_size: 4_096,
          file_unique_id: 'large-unique-id',
          height: 720,
          width: 1_280,
        },
      ],
      text: options.text ?? 'Koharu first channel post',
    },
  };
}
