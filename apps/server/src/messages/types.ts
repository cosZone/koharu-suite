import type { Update } from 'grammy/types';
import type { LatestMessageCursor, MessageCursor } from '../http/cursor.js';
import type { NormalizedMediaKind, NormalizedMessageEntity } from '../telegram/types.js';
import type { MessageFeed } from './rss.js';
import type { MessageSearchOptions, MessageSearchPage } from './search.js';

export type MessageSourceKind = 'telegram_bot_update' | 'telegram_desktop_json';

export interface NormalizedChannelIdentity {
  telegramChatId: bigint;
  title: string;
  username: string | null;
}

export interface NormalizedMessage {
  authorSignature: string | null;
  contentKind: 'caption' | 'none' | 'text';
  editedAt: Date | null;
  entities: NormalizedMessageEntity[];
  mediaGroupId: string | null;
  publishedAt: Date;
  telegramMessageId: bigint;
  text: string | null;
}

export interface SourceNeutralMedia {
  availabilityReason: string | null;
  duration: number | null;
  fileName: string | null;
  fileSize: bigint | null;
  height: number | null;
  kind: NormalizedMediaKind;
  mimeType: string | null;
  sourceMediaType: string | null;
  sourceMetadata: Record<string, unknown>;
  sourcePath: string | null;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  width: number | null;
}

export interface NormalizedMessageSnapshot {
  channel: NormalizedChannelIdentity;
  media: SourceNeutralMedia[];
  message: NormalizedMessage;
}

export type SourceObservation =
  | {
      importRunId: null;
      kind: 'telegram_bot_update';
      observedAt: Date | null;
      raw: Update;
      sourceMetadata: Record<string, unknown>;
      sourceKey: string;
      telegramUpdateId: bigint;
      updateType: 'channel_post' | 'edited_channel_post';
    }
  | {
      importRunId: string | null;
      kind: 'telegram_desktop_json';
      observedAt: Date | null;
      raw: unknown;
      sourceChatId: bigint;
      sourceMetadata: Record<string, unknown>;
      sourceKey: string;
      sourceMessageId: bigint;
    };

export type SourceResolution = 'conflict' | 'created' | 'matched' | 'stale';

export interface SourceWriteDecision {
  createdMessage: boolean;
  createdRevision: boolean;
  replayed: boolean;
  resolution: SourceResolution;
}

export interface SourceWriteResult extends SourceWriteDecision {
  channelId: string;
  messageId: string;
  observationId: string;
  revisionId: string | null;
}

export interface PublicChannel {
  id: string;
  title: string;
  username: string | null;
}

export interface PublicMedia {
  cacheStatus: 'pending' | 'ready' | 'unavailable';
  duration: number | null;
  fileName: string | null;
  fileSize: string | null;
  height: number | null;
  id: string;
  kind: NormalizedMediaKind;
  mimeType: string | null;
  originalUrl: string | null;
  thumbnailUrl: string | null;
  width: number | null;
}

export interface PublicMessage {
  authorSignature: string | null;
  channel: PublicChannel;
  content: {
    entities: NormalizedMessageEntity[];
    html: string | null;
    kind: 'caption' | 'none' | 'text';
    text: string | null;
  };
  id: string;
  media: PublicMedia[];
  mediaGroupId: string | null;
  publishedAt: string;
  revision: number;
  sourceUrl: string | null;
}

export interface MessagePage {
  items: PublicMessage[];
  nextCursor: MessageCursor | null;
}

export interface LatestMessagePage {
  items: PublicMessage[];
  nextCursor: LatestMessageCursor | null;
}

export interface LatestMessageListOptions {
  channelIds: readonly string[];
  cursor?: LatestMessageCursor;
  limit: number;
}

export interface MessageContextReference {
  channelId: string;
  id: string;
  preview: string | null;
  publishedAt: string;
}

export interface MessageContext {
  message: PublicMessage;
  newer: MessageContextReference | null;
  older: MessageContextReference | null;
}

export interface MessageListOptions {
  cursor?: MessageCursor;
  limit: number;
}

export interface MessageReader {
  getMessageContext(id: string): Promise<MessageContext | null>;
  getMessage(id: string): Promise<PublicMessage | null>;
  listLatestMessages(options: LatestMessageListOptions): Promise<LatestMessagePage>;
  listChannels(): Promise<PublicChannel[]>;
  listMessages(channelId: string, options: MessageListOptions): Promise<MessagePage | null>;
}

export interface MessageDiscoveryReader {
  getFeed(channelId?: string): Promise<MessageFeed | null>;
  searchMessages(options: MessageSearchOptions): Promise<MessageSearchPage | null>;
}
