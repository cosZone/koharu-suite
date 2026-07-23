import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAdminRepository } from '../../src/admin/repository.js';
import { createApp } from '../../src/app.js';
import { createAuth } from '../../src/auth/auth.js';
import {
  OwnerAlreadyExistsError,
  OwnerService,
  PostgresOwnerRepository,
} from '../../src/auth/owner-service.js';
import { BetterAuthRuntime } from '../../src/auth/runtime-auth.js';
import { ServiceTokenService } from '../../src/auth/service-token.js';
import type { AuthConfig } from '../../src/config.js';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  authAccounts,
  authApiKeys,
  authSessions,
  authTwoFactors,
  authUsers,
  owners,
} from '../../src/db/schema.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const BASE_URL = 'http://localhost:3000';
const AUTH_CONFIG: AuthConfig = {
  baseUrl: BASE_URL,
  secret: 'integration-test-secret-is-at-least-32-characters',
  trustedOrigin: BASE_URL,
};
const PASSWORD = 'correct horse battery staple';
const CHANGED_PASSWORD = 'changed correct horse battery staple';
const NEW_PASSWORD = 'new correct horse battery staple';

function cookieFromResponse(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Response did not set a cookie');
  }

  return setCookie
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
}

type CookieJar = Map<string, string>;

function absorbCookies(jar: CookieJar, response: Response): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    headers.getSetCookie?.() ?? response.headers.get('set-cookie')?.split(/,(?=[^;,]+=)/) ?? [];

  for (const setCookie of setCookies) {
    const [pair, ...attributes] = setCookie.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (!pair || separator < 1) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute.trim()));
    if (!value || expired) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function cookieAttributes(response: Response, namePart: string): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    headers.getSetCookie?.() ?? response.headers.get('set-cookie')?.split(/,(?=[^;,]+=)/) ?? [];
  const cookie = setCookies.find((value) => value.split('=', 1)[0]?.includes(namePart));

  return (
    cookie
      ?.split(';')
      .slice(1)
      .map((attribute) => attribute.trim()) ?? []
  );
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function decodeBase32(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';

  for (const character of value.toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      throw new Error('TOTP URI contained invalid base32');
    }
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function jsonRequest(body: unknown, cookie?: string): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      origin: BASE_URL,
      ...(cookie ? { cookie } : {}),
    },
    method: 'POST',
  };
}

describe('owner authentication', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connection: DatabaseConnection | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  });

  it('creates exactly one owner under concurrent bootstrap attempts without orphan users', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const service = new OwnerService(connection.db, AUTH_CONFIG);
    const results = await Promise.allSettled([
      service.create('owner-a@example.com', PASSWORD),
      service.create('owner-b@example.com', PASSWORD),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<{ email: string; userId: string }> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(OwnerAlreadyExistsError);

    const database = connection.db;
    const counts = await Promise.all(
      [authUsers, authAccounts, owners].map(async (table) => {
        const [result] = await database.select({ value: count() }).from(table);
        return result?.value;
      }),
    );
    expect(counts).toEqual([1, 1, 1]);
  }, 30_000);

  it('stores only hashed scoped service tokens and rejects them after revocation', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const service = new ServiceTokenService(connection.db, AUTH_CONFIG);
    const created = await service.create({
      expiresIn: 30 * 24 * 60 * 60,
      name: 'integration deploy',
      scopes: ['admin:read'],
    });
    expect(created.key).toMatch(/^khs_/);
    expect(created.permissions).toEqual({ admin: ['read'] });

    const [stored] = await connection.db
      .select({
        enabled: authApiKeys.enabled,
        key: authApiKeys.key,
        permissions: authApiKeys.permissions,
      })
      .from(authApiKeys)
      .where(eq(authApiKeys.id, created.id));
    expect(stored).toMatchObject({
      enabled: true,
      permissions: JSON.stringify({ admin: ['read'] }),
    });
    expect(stored?.key).not.toBe(created.key);
    expect(stored?.key).not.toContain(created.key);

    const runtime = new BetterAuthRuntime(connection.db, AUTH_CONFIG);
    const headers = new Headers({ Authorization: `Bearer ${created.key}` });
    await expect(runtime.authorize(headers, 'admin:read')).resolves.toMatchObject({
      allowed: true,
      principal: {
        actorId: created.id,
        actorType: 'service_token',
      },
    });
    await expect(runtime.authorize(headers, 'ingestion:write')).resolves.toMatchObject({
      allowed: false,
      principal: {
        actorId: created.id,
      },
    });

    await service.revoke(created.id);
    await expect(runtime.authorize(headers, 'admin:read')).resolves.toEqual({
      allowed: false,
      principal: null,
    });
  }, 30_000);

  it('keeps sign-up closed, protects admin routes, and revokes sessions on password reset', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const ownerRepository = new PostgresOwnerRepository(connection.db);
    const owner = await ownerRepository.findOwner();
    if (!owner) {
      throw new Error('The owner fixture was not created');
    }

    const app = createApp({
      admin: new PostgresAdminRepository(connection.db),
      auth: new BetterAuthRuntime(connection.db, AUTH_CONFIG),
      owners: ownerRepository,
    });

    const anonymousStatus = await app.request('/api/v1/admin/status');
    expect(anonymousStatus.status).toBe(401);

    const signUp = await app.request(
      '/api/auth/sign-up/email',
      jsonRequest({
        email: 'attacker@example.com',
        name: 'Attacker',
        password: PASSWORD,
      }),
    );
    expect(signUp.status).toBe(400);

    const signIn = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: PASSWORD,
        rememberMe: true,
      }),
    );
    expect(signIn.status).toBe(200);
    expect(cookieAttributes(signIn, 'session_token')).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Max-Age=604800']),
    );
    const cookie = cookieFromResponse(signIn);
    const [createdSession] = await connection.db
      .select({
        expiresAt: authSessions.expiresAt,
        id: authSessions.id,
      })
      .from(authSessions);
    expect(createdSession).toBeDefined();
    expect((createdSession?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1000,
    );

    if (!createdSession) {
      throw new Error('The sign-in session was not persisted');
    }
    await connection.db
      .update(authSessions)
      .set({
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      })
      .where(eq(authSessions.id, createdSession.id));
    const refresh = await app.request('/api/auth/get-session', {
      headers: { cookie },
    });
    expect(refresh.status).toBe(200);
    const [refreshedSession] = await connection.db
      .select({ expiresAt: authSessions.expiresAt })
      .from(authSessions)
      .where(eq(authSessions.id, createdSession.id));
    expect((refreshedSession?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1000,
    );

    const ownerStatus = await app.request('/api/v1/admin/status', {
      headers: { cookie },
    });
    expect(ownerStatus.status).toBe(200);
    expect(ownerStatus.headers.get('cache-control')).toBe('private, no-store');
    await expect(ownerStatus.json()).resolves.toMatchObject({
      collector: {
        state: 'stopped',
        version: null,
      },
      owner: {
        email: owner.email,
        twoFactorEnabled: false,
      },
    });

    const changePassword = await app.request(
      '/api/auth/change-password',
      jsonRequest(
        {
          currentPassword: PASSWORD,
          newPassword: CHANGED_PASSWORD,
          revokeOtherSessions: false,
        },
        cookie,
      ),
    );
    expect(changePassword.status).toBe(200);
    const revokedAfterChange = await app.request('/api/v1/admin/status', {
      headers: { cookie },
    });
    expect(revokedAfterChange.status).toBe(401);

    await new OwnerService(connection.db, AUTH_CONFIG).resetPassword(owner.email, NEW_PASSWORD);

    const revokedStatus = await app.request('/api/v1/admin/status', {
      headers: { cookie },
    });
    expect(revokedStatus.status).toBe(401);

    const [sessions] = await connection.db.select({ value: count() }).from(authSessions);
    expect(sessions?.value).toBe(0);

    const oldPassword = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: PASSWORD,
        rememberMe: true,
      }),
    );
    expect(oldPassword.status).toBe(401);

    const changedPassword = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: CHANGED_PASSWORD,
        rememberMe: true,
      }),
    );
    expect(changedPassword.status).toBe(401);

    const newPassword = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: NEW_PASSWORD,
        rememberMe: true,
      }),
    );
    expect(newPassword.status).toBe(200);
  }, 30_000);

  it('enables TOTP with session revocation, trusts a device, and consumes recovery codes once', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const ownerRepository = new PostgresOwnerRepository(connection.db);
    const owner = await ownerRepository.findOwner();
    if (!owner) {
      throw new Error('The owner fixture was not created');
    }
    const runtimeAuth = new BetterAuthRuntime(connection.db, AUTH_CONFIG);
    const app = createApp({
      admin: new PostgresAdminRepository(connection.db),
      auth: runtimeAuth,
      owners: ownerRepository,
    });
    const authenticatedJar: CookieJar = new Map();

    const signIn = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: NEW_PASSWORD,
        rememberMe: true,
      }),
    );
    expect(signIn.status).toBe(200);
    absorbCookies(authenticatedJar, signIn);

    const enable = await app.request(
      '/api/auth/two-factor/enable',
      jsonRequest(
        {
          issuer: 'koharu-suite',
          password: NEW_PASSWORD,
        },
        cookieHeader(authenticatedJar),
      ),
    );
    expect(enable.status).toBe(200);
    const setup = (await enable.json()) as {
      backupCodes: string[];
      totpURI: string;
    };
    expect(setup.backupCodes.length).toBeGreaterThan(0);
    const secret = new URL(setup.totpURI).searchParams.get('secret');
    if (!secret) {
      throw new Error('TOTP URI did not include a secret');
    }
    const [storedTwoFactor] = await connection.db
      .select({
        backupCodes: authTwoFactors.backupCodes,
        secret: authTwoFactors.secret,
      })
      .from(authTwoFactors);
    expect(storedTwoFactor).toBeDefined();
    expect(storedTwoFactor?.backupCodes.includes(setup.backupCodes[0] ?? '')).toBe(false);
    expect(storedTwoFactor?.secret).not.toBe(secret);

    const auth = createAuth(connection.db, AUTH_CONFIG);
    const decodedSecret = decodeBase32(secret);
    const { code } = await auth.api.generateTOTP({ body: { secret: decodedSecret } });

    const verifySetup = await app.request(
      '/api/auth/two-factor/verify-totp',
      jsonRequest(
        {
          code,
          trustDevice: false,
        },
        cookieHeader(authenticatedJar),
      ),
    );
    const verifySetupBody = (await verifySetup.clone().json()) as unknown;
    expect(verifySetup.status, JSON.stringify(verifySetupBody)).toBe(200);
    absorbCookies(authenticatedJar, verifySetup);

    const revokedAfterSetup = await app.request('/api/v1/admin/status', {
      headers: { cookie: cookieHeader(authenticatedJar) },
    });
    expect(revokedAfterSetup.status).toBe(401);

    const challengeJar: CookieJar = new Map();
    const challengedSignIn = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: NEW_PASSWORD,
        rememberMe: true,
      }),
    );
    absorbCookies(challengeJar, challengedSignIn);
    await expect(challengedSignIn.json()).resolves.toMatchObject({
      twoFactorRedirect: true,
    });

    const nextCode = await auth.api.generateTOTP({ body: { secret: decodedSecret } });
    const trustedVerification = await app.request(
      '/api/auth/two-factor/verify-totp',
      jsonRequest(
        {
          code: nextCode.code,
          trustDevice: true,
        },
        cookieHeader(challengeJar),
      ),
    );
    expect(trustedVerification.status).toBe(200);
    expect(cookieAttributes(trustedVerification, 'trust_device')).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Max-Age=2592000']),
    );
    absorbCookies(challengeJar, trustedVerification);

    const trustedCookie = [...challengeJar].find(([name]) => name.includes('trust_device'));
    expect(trustedCookie).toBeDefined();
    const trustedOnlyJar: CookieJar = new Map(trustedCookie ? [trustedCookie] : []);
    const trustedSignIn = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest(
        {
          email: owner.email,
          password: NEW_PASSWORD,
          rememberMe: true,
        },
        cookieHeader(trustedOnlyJar),
      ),
    );
    expect(trustedSignIn.status).toBe(200);
    await expect(trustedSignIn.json()).resolves.not.toMatchObject({
      twoFactorRedirect: true,
    });

    const recoveryJar: CookieJar = new Map();
    const recoverySignIn = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: NEW_PASSWORD,
        rememberMe: true,
      }),
    );
    absorbCookies(recoveryJar, recoverySignIn);

    const recoveryCode = setup.backupCodes[0];
    if (!recoveryCode) {
      throw new Error('No recovery code was generated');
    }
    const firstRecovery = await app.request(
      '/api/auth/two-factor/verify-backup-code',
      jsonRequest({ code: recoveryCode }, cookieHeader(recoveryJar)),
    );
    expect(firstRecovery.status).toBe(200);
    absorbCookies(recoveryJar, firstRecovery);

    const replayJar: CookieJar = new Map();
    const replaySignIn = await app.request(
      '/api/auth/sign-in/email',
      jsonRequest({
        email: owner.email,
        password: NEW_PASSWORD,
        rememberMe: true,
      }),
    );
    absorbCookies(replayJar, replaySignIn);
    const replayRecovery = await app.request(
      '/api/auth/two-factor/verify-backup-code',
      jsonRequest({ code: recoveryCode }, cookieHeader(replayJar)),
    );
    expect(replayRecovery.status).toBe(401);

    const sessionsBeforeRotation = await connection.db
      .select({ value: count() })
      .from(authSessions);
    expect(sessionsBeforeRotation[0]?.value).toBeGreaterThanOrEqual(2);
    const secondBrowserBeforeRotation = await app.request('/api/v1/admin/status', {
      headers: { cookie: cookieHeader(recoveryJar) },
    });
    expect(secondBrowserBeforeRotation.status).toBe(200);

    const rotateTotp = await app.request(
      '/api/auth/two-factor/enable',
      jsonRequest(
        {
          issuer: 'koharu-suite',
          password: NEW_PASSWORD,
        },
        cookieHeader(challengeJar),
      ),
    );
    const rotateTotpBody = (await rotateTotp.clone().json()) as unknown;
    expect(rotateTotp.status, JSON.stringify(rotateTotpBody)).toBe(200);

    const [sessionsAfterRotation] = await connection.db
      .select({ value: count() })
      .from(authSessions);
    expect(sessionsAfterRotation?.value).toBe(0);

    const revokedAfterRotation = await app.request('/api/v1/admin/status', {
      headers: { cookie: cookieHeader(recoveryJar) },
    });
    expect(revokedAfterRotation.status).toBe(401);
  }, 30_000);
});
