import { describe, expect, it } from 'vitest';
import {
  ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES,
  PHOTO_ORIGINAL_LIMIT_BYTES,
  POST_ORIGINAL_LIMIT_BYTES,
  planOriginalMediaCache,
} from '../src/media-cache/policy.js';
import type { NormalizedMediaKind } from '../src/telegram/types.js';

interface MediaInput {
  declaredBytes: bigint | null;
  id: string;
  kind: NormalizedMediaKind;
  position: number;
}

function media(
  id: string,
  position: number,
  kind: NormalizedMediaKind,
  declaredBytes: bigint | null = null,
): MediaInput {
  return { declaredBytes, id, kind, position };
}

describe('original media cache policy', () => {
  it('selects supported originals and keeps unsupported media as fallback in stable position order', () => {
    const plan = planOriginalMediaCache([
      media('video-b', 3, 'video'),
      media('document-a', 0, 'document'),
      media('photo-a', 1, 'photo'),
      media('animation-a', 2, 'animation'),
    ]);

    expect(plan.decision).toBe('eligible');
    expect(plan.items).toEqual([
      {
        ...media('document-a', 0, 'document'),
        decision: 'fallback',
        limitBytes: null,
      },
      {
        ...media('photo-a', 1, 'photo'),
        decision: 'eligible',
        limitBytes: PHOTO_ORIGINAL_LIMIT_BYTES,
      },
      {
        ...media('animation-a', 2, 'animation'),
        decision: 'eligible',
        limitBytes: ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES,
      },
      {
        ...media('video-b', 3, 'video'),
        decision: 'eligible',
        limitBytes: ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES,
      },
    ]);
  });

  it('excludes only an original whose declared size exceeds its kind limit', () => {
    const plan = planOriginalMediaCache([
      media('photo-at-limit', 0, 'photo', PHOTO_ORIGINAL_LIMIT_BYTES),
      media('photo-over-limit', 1, 'photo', PHOTO_ORIGINAL_LIMIT_BYTES + 1n),
      media('video-over-limit', 2, 'video', ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES + 1n),
      media('animation-unknown', 3, 'animation'),
    ]);

    expect(plan.decision).toBe('eligible');
    expect(plan.items.map(({ decision, id }) => ({ decision, id }))).toEqual([
      { decision: 'eligible', id: 'photo-at-limit' },
      { decision: 'skipped_kind_limit', id: 'photo-over-limit' },
      { decision: 'skipped_kind_limit', id: 'video-over-limit' },
      { decision: 'eligible', id: 'animation-unknown' },
    ]);
  });

  it('skips all remaining originals when their known declared aggregate exceeds the post limit', () => {
    const plan = planOriginalMediaCache([
      media('already-kind-skipped', 0, 'photo', PHOTO_ORIGINAL_LIMIT_BYTES + 1n),
      media('video-a', 1, 'video', ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES),
      media('video-b', 2, 'video', ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES),
      media(
        'video-c',
        3,
        'video',
        POST_ORIGINAL_LIMIT_BYTES - 2n * ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES + 1n,
      ),
      media('voice-a', 4, 'voice', 100n),
    ]);

    expect(plan.decision).toBe('skipped_post_limit');
    expect(plan.items.map(({ decision, id }) => ({ decision, id }))).toEqual([
      { decision: 'skipped_kind_limit', id: 'already-kind-skipped' },
      { decision: 'skipped_post_limit', id: 'video-a' },
      { decision: 'skipped_post_limit', id: 'video-b' },
      { decision: 'skipped_post_limit', id: 'video-c' },
      { decision: 'fallback', id: 'voice-a' },
    ]);
  });

  it('keeps the exact post boundary eligible and reserves hard-limit capacity for unknown sizes', () => {
    const plan = planOriginalMediaCache([
      media('photo-unknown', 0, 'photo'),
      media('video-known', 1, 'video', ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES),
      media('animation-known', 2, 'animation', ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES),
      media('photo-known', 3, 'photo', PHOTO_ORIGINAL_LIMIT_BYTES),
    ]);

    expect(plan).toMatchObject({
      decision: 'eligible',
      knownDeclaredBytes: POST_ORIGINAL_LIMIT_BYTES,
      reservationBytes: POST_ORIGINAL_LIMIT_BYTES,
    });
    expect(plan.items.every((item) => item.decision === 'eligible')).toBe(true);
  });

  it('rejects malformed or duplicate canonical candidates before computing a budget', () => {
    expect(() => planOriginalMediaCache([media('negative-size', 0, 'photo', -1n)])).toThrow(
      'declaredBytes must be non-negative',
    );
    expect(() => planOriginalMediaCache([media('invalid-position', -1, 'photo')])).toThrow(
      'position must be a non-negative safe integer',
    );
    expect(() => planOriginalMediaCache([media(' ', 0, 'photo')])).toThrow('id must not be empty');
    expect(() =>
      planOriginalMediaCache([
        media('same-canonical-id', 0, 'photo'),
        media('same-canonical-id', 1, 'video'),
      ]),
    ).toThrow('canonical media id must be unique');
  });
});
