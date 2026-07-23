import type {
  Animation,
  Audio,
  Document,
  MessageEntity,
  PhotoSize,
  Update,
  Video,
  Voice,
} from 'grammy/types';
import type { NormalizedChannelPost, NormalizedMedia, NormalizedMessageEntity } from './types.js';

function normalizeEntity(entity: MessageEntity): NormalizedMessageEntity {
  return {
    type: entity.type,
    offset: entity.offset,
    length: entity.length,
    ...('url' in entity ? { url: entity.url } : {}),
    ...('language' in entity && entity.language !== undefined ? { language: entity.language } : {}),
    ...('custom_emoji_id' in entity ? { customEmojiId: entity.custom_emoji_id } : {}),
    ...('unix_time' in entity ? { unixTime: entity.unix_time } : {}),
    ...('date_time_format' in entity ? { dateTimeFormat: entity.date_time_format } : {}),
  };
}

function toFileSize(value: number | undefined): bigint | null {
  return value === undefined ? null : BigInt(value);
}

function normalizePhoto(photo: PhotoSize): NormalizedMedia {
  return {
    duration: null,
    fileId: photo.file_id,
    fileName: null,
    fileSize: toFileSize(photo.file_size),
    fileUniqueId: photo.file_unique_id,
    height: photo.height,
    kind: 'photo',
    mimeType: 'image/jpeg',
    width: photo.width,
  };
}

function normalizeAnimation(animation: Animation): NormalizedMedia {
  return {
    duration: animation.duration,
    fileId: animation.file_id,
    fileName: animation.file_name ?? null,
    fileSize: toFileSize(animation.file_size),
    fileUniqueId: animation.file_unique_id,
    height: animation.height,
    kind: 'animation',
    mimeType: animation.mime_type ?? null,
    width: animation.width,
  };
}

function normalizeAudio(audio: Audio): NormalizedMedia {
  return {
    duration: audio.duration,
    fileId: audio.file_id,
    fileName: audio.file_name ?? null,
    fileSize: toFileSize(audio.file_size),
    fileUniqueId: audio.file_unique_id,
    height: null,
    kind: 'audio',
    mimeType: audio.mime_type ?? null,
    width: null,
  };
}

function normalizeDocument(document: Document): NormalizedMedia {
  return {
    duration: null,
    fileId: document.file_id,
    fileName: document.file_name ?? null,
    fileSize: toFileSize(document.file_size),
    fileUniqueId: document.file_unique_id,
    height: null,
    kind: 'document',
    mimeType: document.mime_type ?? null,
    width: null,
  };
}

function normalizeVideo(video: Video): NormalizedMedia {
  return {
    duration: video.duration,
    fileId: video.file_id,
    fileName: video.file_name ?? null,
    fileSize: toFileSize(video.file_size),
    fileUniqueId: video.file_unique_id,
    height: video.height,
    kind: 'video',
    mimeType: video.mime_type ?? null,
    width: video.width,
  };
}

function normalizeVoice(voice: Voice): NormalizedMedia {
  return {
    duration: voice.duration,
    fileId: voice.file_id,
    fileName: null,
    fileSize: toFileSize(voice.file_size),
    fileUniqueId: voice.file_unique_id,
    height: null,
    kind: 'voice',
    mimeType: voice.mime_type ?? null,
    width: null,
  };
}

function largestPhoto(photos: PhotoSize[]): PhotoSize | undefined {
  return photos.reduce<PhotoSize | undefined>((largest, photo) => {
    if (!largest) {
      return photo;
    }

    const area = photo.width * photo.height;
    const largestArea = largest.width * largest.height;
    if (area !== largestArea) {
      return area > largestArea ? photo : largest;
    }

    return (photo.file_size ?? 0) > (largest.file_size ?? 0) ? photo : largest;
  }, undefined);
}

function normalizeMedia(update: Update & { channel_post: NonNullable<Update['channel_post']> }) {
  const message = update.channel_post;

  if (message.animation) {
    return [normalizeAnimation(message.animation)];
  }

  if (message.audio) {
    return [normalizeAudio(message.audio)];
  }

  if (message.document) {
    return [normalizeDocument(message.document)];
  }

  if (message.photo) {
    const photo = largestPhoto(message.photo);
    return photo ? [normalizePhoto(photo)] : [];
  }

  if (message.video) {
    return [normalizeVideo(message.video)];
  }

  if (message.voice) {
    return [normalizeVoice(message.voice)];
  }

  return [];
}

export function normalizeChannelPost(
  update: Update,
  allowedTelegramChannelId: bigint,
): NormalizedChannelPost | null {
  const message = update.channel_post;
  if (message?.chat.type !== 'channel') {
    return null;
  }

  const telegramChatId = BigInt(message.chat.id);
  if (telegramChatId !== allowedTelegramChannelId) {
    return null;
  }

  const contentKind =
    message.text !== undefined ? 'text' : message.caption !== undefined ? 'caption' : 'none';
  const text = message.text ?? message.caption ?? null;
  const entities = message.text !== undefined ? message.entities : message.caption_entities;

  return {
    channel: {
      telegramChatId,
      title: message.chat.title,
      username: message.chat.username ?? null,
    },
    message: {
      authorSignature: message.author_signature ?? null,
      contentKind,
      entities: (entities ?? []).map(normalizeEntity),
      mediaGroupId: message.media_group_id ?? null,
      publishedAt: new Date(message.date * 1_000),
      telegramMessageId: BigInt(message.message_id),
      text,
    },
    media: normalizeMedia(update as Update & { channel_post: typeof message }),
    rawUpdate: update,
    telegramUpdateId: BigInt(update.update_id),
  };
}
