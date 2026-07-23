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
});
