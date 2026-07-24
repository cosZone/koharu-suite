import type { NormalizedMediaKind } from '../telegram/types.js';

const MEBIBYTE = 1024n * 1024n;

export const PHOTO_ORIGINAL_LIMIT_BYTES = 10n * MEBIBYTE;
export const ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES = 20n * MEBIBYTE;
export const POST_ORIGINAL_LIMIT_BYTES = 50n * MEBIBYTE;

export interface OriginalMediaCandidate {
  declaredBytes: bigint | null;
  id: string;
  kind: NormalizedMediaKind;
  position: number;
}

export type OriginalMediaItemDecision =
  | 'eligible'
  | 'fallback'
  | 'skipped_kind_limit'
  | 'skipped_post_limit';

export interface OriginalMediaPlanItem extends OriginalMediaCandidate {
  decision: OriginalMediaItemDecision;
  limitBytes: bigint | null;
}

export interface OriginalMediaCachePlan {
  decision: 'eligible' | 'skipped_post_limit';
  items: OriginalMediaPlanItem[];
  knownDeclaredBytes: bigint;
  reservationBytes: bigint;
}

function originalLimit(kind: NormalizedMediaKind): bigint | null {
  switch (kind) {
    case 'photo':
      return PHOTO_ORIGINAL_LIMIT_BYTES;
    case 'animation':
    case 'video':
      return ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES;
    case 'audio':
    case 'document':
    case 'voice':
      return null;
  }
}

export function planOriginalMediaCache(
  candidates: readonly OriginalMediaCandidate[],
): OriginalMediaCachePlan {
  assertCandidates(candidates);
  const items = candidates
    .map<OriginalMediaPlanItem>((candidate) => {
      const limitBytes = originalLimit(candidate.kind);

      return {
        ...candidate,
        decision:
          limitBytes === null
            ? 'fallback'
            : candidate.declaredBytes !== null && candidate.declaredBytes > limitBytes
              ? 'skipped_kind_limit'
              : 'eligible',
        limitBytes,
      };
    })
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));

  const knownEligibleBytes = items.reduce(
    (total, item) =>
      item.decision === 'eligible' && item.declaredBytes !== null
        ? total + item.declaredBytes
        : total,
    0n,
  );

  if (knownEligibleBytes > POST_ORIGINAL_LIMIT_BYTES) {
    return {
      decision: 'skipped_post_limit',
      items: items.map((item) =>
        item.decision === 'eligible'
          ? {
              ...item,
              decision: 'skipped_post_limit',
            }
          : item,
      ),
      knownDeclaredBytes: knownEligibleBytes,
      reservationBytes: 0n,
    };
  }

  const reservationBytes = items.reduce(
    (total, item) => (item.decision === 'eligible' ? total + (item.limitBytes ?? 0n) : total),
    0n,
  );

  return {
    decision: 'eligible',
    items,
    knownDeclaredBytes: knownEligibleBytes,
    reservationBytes:
      reservationBytes > POST_ORIGINAL_LIMIT_BYTES ? POST_ORIGINAL_LIMIT_BYTES : reservationBytes,
  };
}

function assertCandidates(candidates: readonly OriginalMediaCandidate[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.id.trim()) {
      throw new TypeError('canonical media id must not be empty');
    }
    if (ids.has(candidate.id)) {
      throw new TypeError('canonical media id must be unique within a post plan');
    }
    ids.add(candidate.id);
    if (!Number.isSafeInteger(candidate.position) || candidate.position < 0) {
      throw new TypeError('position must be a non-negative safe integer');
    }
    if (candidate.declaredBytes !== null && candidate.declaredBytes < 0n) {
      throw new TypeError('declaredBytes must be non-negative');
    }
  }
}
