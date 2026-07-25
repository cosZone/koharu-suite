import type { PublicChannel, PublicMessage } from '../src/schemas.js';

export const CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af1';
export const MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b33';
export const NEWER_MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b37';
export const OLDER_MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b38';
export const MEDIA_ID = '019bf895-0e70-7881-83b3-471b8dbb1b35';
export const MEDIA_OBJECT_ID = '019bf895-0e70-7881-83b3-471b8dbb1b36';

export const channel: PublicChannel = {
  id: CHANNEL_ID,
  title: 'Koharu Test',
  username: 'koharu_test',
};

export const message: PublicMessage = {
  authorSignature: 'Koharu',
  channel,
  content: {
    entities: [
      {
        customEmojiId: 'emoji-id',
        dateTimeFormat: 'relative',
        language: 'zh',
        length: 6,
        offset: 0,
        type: 'future_entity',
        unixTime: 1_785_024_000,
        url: 'tg://user?id=1',
      },
    ],
    html: '<p>Koharu result</p>',
    kind: 'text',
    text: 'Koharu result',
  },
  id: MESSAGE_ID,
  media: [
    {
      cacheStatus: 'ready',
      duration: null,
      fileName: 'image.jpg',
      fileSize: '9007199254740993',
      height: 720,
      id: MEDIA_ID,
      kind: 'photo',
      mimeType: 'image/jpeg',
      originalUrl: `/api/v1/media/${MEDIA_OBJECT_ID}`,
      thumbnailUrl: null,
      width: 1280,
    },
  ],
  mediaGroupId: null,
  publishedAt: '2026-07-24T00:00:00.000Z',
  revision: 2,
  sourceUrl: 'https://t.me/koharu_test/42',
};
