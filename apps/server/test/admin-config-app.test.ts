import { describe, expect, it, vi } from 'vitest';
import {
  AdminConfigLockedError,
  type AdminConfigResponse,
  AdminConfigValidationError,
} from '../src/admin/config-service.js';
import { type AppDependencies, createApp } from '../src/app.js';
import type { AdminPrincipal, RuntimeAuth } from '../src/auth/runtime-auth.js';

const owner: AdminPrincipal = {
  actorId: 'owner-user-id',
  actorType: 'owner_session',
  email: 'owner@example.com',
  permissions: null,
  twoFactorEnabled: true,
};
const serviceToken: AdminPrincipal = {
  actorId: 'service-token-id',
  actorType: 'service_token',
  email: null,
  permissions: {
    admin: ['read'],
    content: ['write'],
    ingestion: ['write'],
  },
  twoFactorEnabled: null,
};

function auth(authorize: RuntimeAuth['authorize']): RuntimeAuth {
  return {
    authorize,
    getSession: vi.fn(async () => null),
    handle: vi.fn(async () => new Response(null, { status: 204 })),
  };
}

const describeFixture: AdminConfigResponse = {
  sections: [
    {
      id: 's3',
      label: 'S3 存储',
      settings: [
        {
          description: 'S3 区域。',
          effective: 'us-east-1',
          envName: 'S3_REGION',
          kind: 'string',
          label: '区域',
          locked: false,
          pendingRestart: false,
          secret: false,
          source: 'default',
        },
        {
          description: 'S3 访问密钥 ID；只写，保存后不回显。',
          effective: { last4: 'cret', set: true },
          envName: 'S3_KEY',
          kind: 'secret',
          label: '访问密钥 ID',
          locked: false,
          pendingRestart: false,
          secret: true,
          source: 'override',
        },
      ],
    },
  ],
};

function createConfigService(
  overrides: Partial<AppDependencies['configService']> = {},
): AppDependencies['configService'] {
  return {
    apply: vi.fn(async () => ({ applied: ['S3_REGION'], pendingRestart: true as const })),
    describe: vi.fn(async () => describeFixture),
    ...overrides,
  };
}

function put(body: unknown) {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  } as const;
}

describe('admin config endpoints', () => {
  it('requires authentication for the config descriptor', async () => {
    const app = createApp({
      auth: auth(vi.fn(async () => ({ allowed: false, principal: null }))),
      configService: createConfigService(),
    });

    const response = await app.request('/api/v1/admin/config');
    expect(response.status).toBe(401);
  });

  it('returns the registry-driven descriptor with secrets masked', async () => {
    const configService = createConfigService();
    const app = createApp({
      auth: auth(vi.fn(async () => ({ allowed: true, principal: serviceToken }))),
      configService,
    });

    const response = await app.request('/api/v1/admin/config');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(describeFixture);
    expect(configService.describe).toHaveBeenCalledOnce();
  });

  it('rejects config changes from non-owner credentials', async () => {
    const configService = createConfigService();
    const app = createApp({
      auth: auth(vi.fn(async () => ({ allowed: true, principal: serviceToken }))),
      configService,
    });

    const response = await app.request(
      '/api/v1/admin/config',
      put({ changes: { S3_REGION: 'eu-west-1' }, reason: 'service token attempt' }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'owner_session_required' },
    });
    expect(configService.apply).not.toHaveBeenCalled();
  });

  it.each([
    [{ reason: 'missing changes' }],
    [{ changes: { S3_REGION: 'eu-west-1' } }],
    [{ changes: { S3_REGION: 'eu-west-1' }, reason: '', unexpected: true }],
  ])('rejects an invalid update body', async (body) => {
    const configService = createConfigService();
    const app = createApp({
      auth: auth(vi.fn(async () => ({ allowed: true, principal: owner }))),
      configService,
    });

    const response = await app.request('/api/v1/admin/config', put(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_config_change' },
    });
    expect(configService.apply).not.toHaveBeenCalled();
  });

  it('applies owner config changes and reports the pending restart', async () => {
    const configService = createConfigService();
    const app = createApp({
      auth: auth(vi.fn(async () => ({ allowed: true, principal: owner }))),
      configService,
    });

    const response = await app.request(
      '/api/v1/admin/config',
      put({ changes: { S3_REGION: 'eu-west-1' }, reason: 'move closer to the bucket' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applied: ['S3_REGION'],
      pendingRestart: true,
    });
    expect(configService.apply).toHaveBeenCalledWith(
      { changes: { S3_REGION: 'eu-west-1' }, reason: 'move closer to the bucket' },
      owner,
    );
  });

  it('maps validation and locking failures to client errors', async () => {
    const invalid = createApp({
      auth: auth(vi.fn(async () => ({ allowed: true, principal: owner }))),
      configService: createConfigService({
        apply: vi.fn(async () => {
          throw new AdminConfigValidationError('Invalid value for S3_REGION');
        }),
      }),
    });
    const invalidResponse = await invalid.request(
      '/api/v1/admin/config',
      put({ changes: { S3_REGION: ' ' }, reason: 'bad value' }),
    );
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: { code: 'invalid_config_change' },
    });

    const locked = createApp({
      auth: auth(vi.fn(async () => ({ allowed: true, principal: owner }))),
      configService: createConfigService({
        apply: vi.fn(async () => {
          throw new AdminConfigLockedError(
            'S3_REGION is locked by an explicit environment variable',
          );
        }),
      }),
    });
    const lockedResponse = await locked.request(
      '/api/v1/admin/config',
      put({ changes: { S3_REGION: 'eu-west-1' }, reason: 'locked key' }),
    );
    expect(lockedResponse.status).toBe(409);
    await expect(lockedResponse.json()).resolves.toMatchObject({
      error: { code: 'config_locked' },
    });
  });
});
