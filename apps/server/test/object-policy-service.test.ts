import { describe, expect, it } from 'vitest';
import {
  MediaCacheObjectPolicyInputError,
  normalizeObjectPolicyInitiator,
  validateMediaCacheEvictedPolicy,
  validateMediaCacheProtectionExpiry,
} from '../src/media-cache/object-policy-service.js';

const NOW = new Date('2026-07-24T10:00:00.000Z');

describe('media cache object policy input', () => {
  it.each(['owner_session', 'local_operator'] as const)(
    'normalizes a bounded %s initiator',
    (kind) => {
      expect(
        normalizeObjectPolicyInitiator({
          id: '  operator-1  ',
          kind,
          reason: '  keep this published asset  ',
        }),
      ).toEqual({
        id: 'operator-1',
        kind,
        reason: 'keep this published asset',
      });
    },
  );

  it.each([
    {
      id: '',
      kind: 'owner_session',
      reason: 'valid',
    },
    {
      id: 'owner',
      kind: 'worker',
      reason: 'valid',
    },
    {
      id: 'owner',
      kind: 'local_operator',
      reason: ' ',
    },
    {
      id: 'x'.repeat(256),
      kind: 'owner_session',
      reason: 'valid',
    },
    {
      id: 'owner',
      kind: 'owner_session',
      reason: 'x'.repeat(501),
    },
  ])('rejects an invalid initiator without echoing its values', (initiator) => {
    expect(() =>
      normalizeObjectPolicyInitiator(
        initiator as Parameters<typeof normalizeObjectPolicyInitiator>[0],
      ),
    ).toThrow(MediaCacheObjectPolicyInputError);
  });

  it('accepts indefinite or bounded future protection and returns a defensive Date copy', () => {
    const expiry = new Date('2036-07-24T10:00:00.000Z');

    expect(validateMediaCacheProtectionExpiry(undefined, NOW)).toBeNull();
    const validated = validateMediaCacheProtectionExpiry(expiry, NOW);

    expect(validated).toEqual(expiry);
    expect(validated).not.toBe(expiry);
  });

  it.each([
    new Date('2026-07-24T10:00:00.000Z'),
    new Date('2026-07-24T09:59:59.999Z'),
    new Date('2036-07-24T10:00:00.001Z'),
    new Date(Number.NaN),
  ])('rejects an invalid or out-of-bounds protection expiry', (expiry) => {
    expect(() => validateMediaCacheProtectionExpiry(expiry, NOW)).toThrow(
      MediaCacheObjectPolicyInputError,
    );
  });

  it('accepts only the two durable eviction policies', () => {
    expect(validateMediaCacheEvictedPolicy('recache_on_access')).toBe('recache_on_access');
    expect(validateMediaCacheEvictedPolicy('stay_evicted')).toBe('stay_evicted');
    expect(() => validateMediaCacheEvictedPolicy('delete_forever')).toThrow(
      MediaCacheObjectPolicyInputError,
    );
  });
});
