import type { MessageCursor } from '../http/cursor.js';
import type { NormalizedMediaKind, NormalizedMessageEntity } from '../telegram/types.js';

export interface PublicChannel {
  id: string;
  title: string;
  username: string | null;
}

export interface PublicMedia {
  duration: number | null;
  fileName: string | null;
  fileSize: string | null;
  height: number | null;
  kind: NormalizedMediaKind;
  mimeType: string | null;
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

export interface MessageListOptions {
  cursor?: MessageCursor;
  limit: number;
}

export interface MessageReader {
  getMessage(id: string): Promise<PublicMessage | null>;
  listChannels(): Promise<PublicChannel[]>;
  listMessages(channelId: string, options: MessageListOptions): Promise<MessagePage | null>;
}
