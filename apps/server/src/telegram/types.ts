import type { Update } from 'grammy/types';

export interface NormalizedMessageEntity {
  customEmojiId?: string;
  dateTimeFormat?: string;
  language?: string;
  length: number;
  offset: number;
  type: string;
  unixTime?: number;
  url?: string;
}

export type NormalizedMediaKind = 'animation' | 'audio' | 'document' | 'photo' | 'video' | 'voice';

export interface NormalizedMedia {
  duration: number | null;
  fileId: string;
  fileName: string | null;
  fileSize: bigint | null;
  fileUniqueId: string;
  height: number | null;
  kind: NormalizedMediaKind;
  mimeType: string | null;
  width: number | null;
}

export interface NormalizedChannelPost {
  channel: {
    telegramChatId: bigint;
    title: string;
    username: string | null;
  };
  message: {
    authorSignature: string | null;
    contentKind: 'caption' | 'none' | 'text';
    editedAt: Date | null;
    entities: NormalizedMessageEntity[];
    mediaGroupId: string | null;
    publishedAt: Date;
    telegramMessageId: bigint;
    text: string | null;
  };
  media: NormalizedMedia[];
  rawUpdate: Update;
  telegramUpdateId: bigint;
  updateType: 'channel_post' | 'edited_channel_post';
}
