import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrl, resolvePort } from '../src/config.js';

describe('configuration', () => {
  it('accepts a valid port', () => {
    expect(resolvePort('4321')).toBe(4321);
  });

  it('rejects an invalid port', () => {
    expect(() => resolvePort('70000')).toThrow();
  });

  it('accepts PostgreSQL URLs only', () => {
    expect(resolveDatabaseUrl('postgresql://localhost/koharu')).toBe(
      'postgresql://localhost/koharu',
    );
    expect(() => resolveDatabaseUrl('https://example.com')).toThrow();
  });

  it('encodes discrete PostgreSQL settings without corrupting reserved password characters', () => {
    expect(
      resolveDatabaseUrl(undefined, {
        POSTGRES_DB: 'koharu',
        POSTGRES_HOST: 'db',
        POSTGRES_PASSWORD: 'slash/pass#word',
        POSTGRES_PORT: '5432',
        POSTGRES_USER: 'koharu',
      }),
    ).toBe('postgresql://koharu:slash%2Fpass%23word@db:5432/koharu');
  });
});
