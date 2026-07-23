import { describe, expect, it } from 'vitest';
import {
  parseServiceTokenExpiry,
  parseServiceTokenScopes,
  serviceTokenHasPermission,
} from '../src/auth/service-token.js';

describe('service token input contracts', () => {
  it('accepts known scopes, trims input, and removes duplicates', () => {
    expect(
      parseServiceTokenScopes([' admin:read ', 'content:write', 'admin:read', 'ingestion:write']),
    ).toEqual(['admin:read', 'content:write', 'ingestion:write']);
  });

  it('rejects an empty or unknown scope request', () => {
    expect(() => parseServiceTokenScopes([])).toThrow('token create requires at least one --scope');
    expect(() => parseServiceTokenScopes(['admin:delete'])).toThrow(
      'Unknown service token scope: admin:delete',
    );
  });

  it('parses bounded whole-day expiry without applying an implicit expiry', () => {
    expect(parseServiceTokenExpiry(undefined)).toBeUndefined();
    expect(parseServiceTokenExpiry('1d')).toBe(86_400);
    expect(parseServiceTokenExpiry('3650d')).toBe(315_360_000);
  });

  it.each(['0d', '3651d', '1h', '1.5d', 'forever'])('rejects invalid expiry %s', (value) => {
    expect(() => parseServiceTokenExpiry(value)).toThrow();
  });

  it('matches the requested resource action exactly', () => {
    const permissions = {
      admin: ['read'],
      content: ['write'],
    };

    expect(serviceTokenHasPermission(permissions, 'admin:read')).toBe(true);
    expect(serviceTokenHasPermission(permissions, 'content:write')).toBe(true);
    expect(serviceTokenHasPermission(permissions, 'ingestion:write')).toBe(false);
    expect(serviceTokenHasPermission(null, 'admin:read')).toBe(false);
  });
});
