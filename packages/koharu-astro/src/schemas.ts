import { z } from 'astro/zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PUBLIC_MEDIA_PATH_PATTERN =
  /^\/api\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const suiteIdSchema = z.string().regex(UUID_PATTERN, 'Expected a suite UUID');

export const canonicalUtcTimestampSchema = z.string().refine(
  (value) => {
    if (!value.endsWith('Z')) return false;
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
  },
  { message: 'Expected a canonical UTC timestamp' },
);

export const publicMediaPathSchema = z
  .string()
  .regex(PUBLIC_MEDIA_PATH_PATTERN, 'Expected a suite media path');

export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const publicChannelSchema = z
  .object({
    id: suiteIdSchema,
    title: z.string(),
    username: z.string().nullable(),
  })
  .passthrough();

export const publicMessageEntitySchema = z
  .object({
    customEmojiId: z.string().optional(),
    dateTimeFormat: z.string().optional(),
    language: z.string().optional(),
    length: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    type: z.string().min(1),
    unixTime: z.number().int().optional(),
    url: z.string().optional(),
  })
  .passthrough();

export const publicMediaKindSchema = z.enum([
  'animation',
  'audio',
  'document',
  'photo',
  'video',
  'voice',
]);

export const publicMediaSchema = z
  .object({
    cacheStatus: z.enum(['pending', 'ready', 'unavailable']),
    duration: z.number().int().nullable(),
    fileName: z.string().nullable(),
    fileSize: z
      .string()
      .regex(/^(0|[1-9]\d*)$/u, 'Expected a non-negative decimal string')
      .nullable(),
    height: z.number().int().nullable(),
    id: suiteIdSchema,
    kind: publicMediaKindSchema,
    mimeType: z.string().nullable(),
    originalUrl: publicMediaPathSchema.nullable(),
    thumbnailUrl: publicMediaPathSchema.nullable(),
    width: z.number().int().nullable(),
  })
  .passthrough();

export const publicMessageSchema = z
  .object({
    authorSignature: z.string().nullable(),
    channel: publicChannelSchema,
    content: z
      .object({
        entities: z.array(publicMessageEntitySchema),
        html: z.string().nullable(),
        kind: z.enum(['caption', 'none', 'text']),
        text: z.string().nullable(),
      })
      .passthrough(),
    id: suiteIdSchema,
    media: z.array(publicMediaSchema),
    mediaGroupId: z.string().nullable(),
    publishedAt: canonicalUtcTimestampSchema,
    revision: z.number().int().positive(),
    sourceUrl: z.url().nullable(),
  })
  .passthrough();

export const channelListResponseSchema = z
  .object({
    items: z.array(publicChannelSchema),
  })
  .passthrough();

export const messagePageSchema = z
  .object({
    items: z.array(publicMessageSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .passthrough();

export const searchMessageResultSchema = z
  .object({
    match: z
      .object({
        score: z.number().min(0).max(1).nullable(),
        snippet: z.string(),
      })
      .passthrough(),
    message: publicMessageSchema,
  })
  .passthrough();

export const searchMessagePageSchema = z
  .object({
    items: z.array(searchMessageResultSchema),
    mode: z.enum(['short_substring', 'trigram']),
    nextCursor: z.string().min(1).nullable(),
  })
  .passthrough();

export const knownKoharuErrorCodes = [
  'channel_not_found',
  'invalid_channel',
  'invalid_cursor',
  'invalid_limit',
  'invalid_message_id',
  'invalid_query',
  'invalid_sort',
  'invalid_time_range',
  'message_not_found',
  'rate_limited',
  'short_query_requires_bounded_scope',
] as const;

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type PublicChannel = z.infer<typeof publicChannelSchema>;
export type PublicMessageEntity = z.infer<typeof publicMessageEntitySchema>;
export type PublicMediaKind = z.infer<typeof publicMediaKindSchema>;
export type PublicMedia = z.infer<typeof publicMediaSchema>;
export type PublicMessage = z.infer<typeof publicMessageSchema>;
export type ChannelListResponse = z.infer<typeof channelListResponseSchema>;
export type MessagePage = z.infer<typeof messagePageSchema>;
export type SearchMessageResult = z.infer<typeof searchMessageResultSchema>;
export type SearchMessagePage = z.infer<typeof searchMessagePageSchema>;
export type KnownKoharuErrorCode = (typeof knownKoharuErrorCodes)[number];
