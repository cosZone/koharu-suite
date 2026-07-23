import { createHash } from 'node:crypto';
import type { NormalizedMessageSnapshot } from './types.js';

export const CURRENT_MESSAGE_FINGERPRINT_VERSION = 1;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintMessageSnapshot(snapshot: NormalizedMessageSnapshot): string {
  const fingerprintInput = {
    channelId: snapshot.channel.telegramChatId.toString(),
    message: {
      authorSignature: snapshot.message.authorSignature,
      contentKind: snapshot.message.contentKind,
      editedAt: snapshot.message.editedAt?.toISOString() ?? null,
      entities: snapshot.message.entities,
      id: snapshot.message.telegramMessageId.toString(),
      text: snapshot.message.text,
    },
    media: snapshot.media.map((media) => ({
      duration: media.duration,
      fileName: media.fileName,
      fileSize: media.fileSize?.toString() ?? null,
      height: media.height,
      kind: media.kind,
      mimeType: media.mimeType,
      width: media.width,
    })),
    version: CURRENT_MESSAGE_FINGERPRINT_VERSION,
  };
  return createHash('sha256').update(canonicalJson(fingerprintInput)).digest('hex');
}
