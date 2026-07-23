import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BetterAuthRuntime } from '../src/auth/runtime-auth.js';
import type { AuthConfig } from '../src/config.js';
import type { Database } from '../src/db/client.js';

const authApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyApiKey: vi.fn(),
}));

vi.mock('../src/auth/auth.js', () => ({
  createAuth: () => ({
    api: authApi,
    handler: vi.fn(async () => new Response(null, { status: 204 })),
  }),
}));

const AUTH_CONFIG: AuthConfig = {
  baseUrl: 'https://suite.example.com',
  secret: 'test-secret-with-at-least-32-characters',
  trustedOrigin: 'https://suite.example.com',
};

function createOwnerDatabase(ownerId = 'owner-user-id'): Database {
  const query = {
    from: vi.fn(),
    limit: vi.fn(async () => [{ userId: ownerId }]),
    where: vi.fn(),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);

  return {
    select: vi.fn(() => query),
  } as unknown as Database;
}

describe('BetterAuthRuntime authorization', () => {
  beforeEach(() => {
    authApi.getSession.mockReset();
    authApi.verifyApiKey.mockReset();
  });

  it('authorizes the singleton owner session for every admin scope', async () => {
    authApi.getSession.mockResolvedValue({
      user: {
        email: 'owner@example.com',
        id: 'owner-user-id',
        twoFactorEnabled: true,
      },
    });
    const runtime = new BetterAuthRuntime(createOwnerDatabase(), AUTH_CONFIG);

    await expect(
      runtime.authorize(new Headers({ Cookie: 'session=test' }), 'admin:read'),
    ).resolves.toEqual({
      allowed: true,
      principal: {
        actorId: 'owner-user-id',
        actorType: 'owner_session',
        email: 'owner@example.com',
        permissions: null,
        twoFactorEnabled: true,
      },
    });
    expect(authApi.verifyApiKey).not.toHaveBeenCalled();
  });

  it('checks service-token permissions against the requested scope', async () => {
    authApi.verifyApiKey.mockResolvedValue({
      key: {
        id: 'service-token-id',
        permissions: {
          admin: ['read'],
          content: ['write'],
        },
        referenceId: 'owner-user-id',
      },
      valid: true,
    });
    const runtime = new BetterAuthRuntime(createOwnerDatabase(), AUTH_CONFIG);
    const headers = new Headers({ Authorization: 'Bearer khs_scoped' });

    const allowed = await runtime.authorize(headers, 'content:write');
    const forbidden = await runtime.authorize(headers, 'ingestion:write');

    expect(allowed).toMatchObject({
      allowed: true,
      principal: {
        actorId: 'service-token-id',
        actorType: 'service_token',
      },
    });
    expect(forbidden).toMatchObject({
      allowed: false,
      principal: {
        actorId: 'service-token-id',
        actorType: 'service_token',
      },
    });
    expect(authApi.verifyApiKey).toHaveBeenCalledWith({
      body: { key: 'khs_scoped' },
    });
    expect(authApi.getSession).not.toHaveBeenCalled();
  });

  it('does not fall back to a valid cookie when an invalid bearer is present', async () => {
    authApi.verifyApiKey.mockResolvedValue({ error: null, valid: false });
    authApi.getSession.mockResolvedValue({
      user: {
        email: 'owner@example.com',
        id: 'owner-user-id',
        twoFactorEnabled: true,
      },
    });
    const runtime = new BetterAuthRuntime(createOwnerDatabase(), AUTH_CONFIG);

    await expect(
      runtime.authorize(
        new Headers({
          Authorization: 'Bearer invalid-token',
          Cookie: 'session=otherwise-valid',
        }),
        'admin:read',
      ),
    ).resolves.toEqual({ allowed: false, principal: null });
    expect(authApi.verifyApiKey).toHaveBeenCalledTimes(1);
    expect(authApi.getSession).not.toHaveBeenCalled();
  });

  it('rejects malformed bearer syntax without consulting either credential backend', async () => {
    const runtime = new BetterAuthRuntime(createOwnerDatabase(), AUTH_CONFIG);

    await expect(
      runtime.authorize(
        new Headers({
          Authorization: 'Basic not-a-bearer',
          Cookie: 'session=otherwise-valid',
        }),
        'admin:read',
      ),
    ).resolves.toEqual({ allowed: false, principal: null });
    expect(authApi.verifyApiKey).not.toHaveBeenCalled();
    expect(authApi.getSession).not.toHaveBeenCalled();
  });
});
