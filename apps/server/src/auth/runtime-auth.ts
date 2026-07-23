import { and, eq } from 'drizzle-orm';
import type { AuthConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { authSessions, owners } from '../db/schema.js';
import { createAuth, type KoharuAuth } from './auth.js';
import {
  type ServiceTokenPermissions,
  type ServiceTokenScope,
  serviceTokenHasPermission,
} from './service-token.js';

const PASSWORD_CHANGE_PATH = '/api/auth/change-password';
const TOTP_DISABLE_PATH = '/api/auth/two-factor/disable';
const TOTP_ENABLE_PATH = '/api/auth/two-factor/enable';
const TOTP_VERIFY_PATH = '/api/auth/two-factor/verify-totp';

export interface AuthenticatedUser {
  email: string;
  id: string;
  twoFactorEnabled: boolean;
}

export interface AuthSession {
  user: AuthenticatedUser;
}

export interface AdminPrincipal {
  actorId: string;
  actorType: 'owner_session' | 'service_token';
  email: string | null;
  permissions: ServiceTokenPermissions | null;
  twoFactorEnabled: boolean | null;
}

export interface AdminAuthorization {
  allowed: boolean;
  principal: AdminPrincipal | null;
}

export interface RuntimeAuth {
  authorize(headers: Headers, scope: ServiceTokenScope): Promise<AdminAuthorization>;
  getSession(headers: Headers): Promise<AuthSession | null>;
  handle(request: Request): Promise<Response>;
}

export class BetterAuthRuntime implements RuntimeAuth {
  private readonly auth: KoharuAuth;

  constructor(
    private readonly database: Database,
    config: AuthConfig,
  ) {
    this.auth = createAuth(database, config);
  }

  async authorize(headers: Headers, scope: ServiceTokenScope): Promise<AdminAuthorization> {
    const authorization = headers.get('Authorization');
    if (authorization !== null) {
      const match = /^Bearer ([^\s]+)$/.exec(authorization);
      if (!match?.[1]) {
        return { allowed: false, principal: null };
      }

      const verified = await this.auth.api
        .verifyApiKey({
          body: {
            key: match[1],
          },
        })
        .catch(() => null);
      if (!verified?.valid || !verified.key) {
        return { allowed: false, principal: null };
      }

      const [owner] = await this.database
        .select({ userId: owners.userId })
        .from(owners)
        .where(and(eq(owners.singleton, 1), eq(owners.userId, verified.key.referenceId)))
        .limit(1);
      if (!owner) {
        return { allowed: false, principal: null };
      }

      const permissions = (verified.key.permissions ?? {}) as ServiceTokenPermissions;
      return {
        allowed: serviceTokenHasPermission(permissions, scope),
        principal: {
          actorId: verified.key.id,
          actorType: 'service_token',
          email: null,
          permissions,
          twoFactorEnabled: null,
        },
      };
    }

    const session = await this.getSession(headers);
    if (!session) {
      return { allowed: false, principal: null };
    }
    const [owner] = await this.database
      .select({ userId: owners.userId })
      .from(owners)
      .where(and(eq(owners.singleton, 1), eq(owners.userId, session.user.id)))
      .limit(1);
    if (!owner) {
      return {
        allowed: false,
        principal: {
          actorId: session.user.id,
          actorType: 'owner_session',
          email: session.user.email,
          permissions: null,
          twoFactorEnabled: session.user.twoFactorEnabled,
        },
      };
    }

    return {
      allowed: true,
      principal: {
        actorId: session.user.id,
        actorType: 'owner_session',
        email: session.user.email,
        permissions: null,
        twoFactorEnabled: session.user.twoFactorEnabled,
      },
    };
  }

  async getSession(headers: Headers): Promise<AuthSession | null> {
    const session = await this.auth.api.getSession({ headers });
    if (!session) {
      return null;
    }

    return {
      user: {
        email: session.user.email,
        id: session.user.id,
        twoFactorEnabled: session.user.twoFactorEnabled ?? false,
      },
    };
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const shouldInspectSession =
      path === PASSWORD_CHANGE_PATH ||
      path === TOTP_DISABLE_PATH ||
      path === TOTP_ENABLE_PATH ||
      path === TOTP_VERIFY_PATH;
    const sessionBefore = shouldInspectSession ? await this.getSession(request.headers) : null;
    const authRequest =
      path === PASSWORD_CHANGE_PATH ? await forcePasswordSessionRevocation(request) : request;
    const response = await this.auth.handler(authRequest);

    const finishedTotpSetup =
      path === TOTP_VERIFY_PATH &&
      sessionBefore !== null &&
      !sessionBefore.user.twoFactorEnabled &&
      response.ok;
    const disabledTotp = path === TOTP_DISABLE_PATH && sessionBefore !== null && response.ok;
    const rotatedTotp =
      path === TOTP_ENABLE_PATH && sessionBefore?.user.twoFactorEnabled === true && response.ok;
    const changedPassword = path === PASSWORD_CHANGE_PATH && sessionBefore !== null && response.ok;

    if (changedPassword || finishedTotpSetup || disabledTotp || rotatedTotp) {
      await this.database
        .delete(authSessions)
        .where(eq(authSessions.userId, sessionBefore.user.id));
    }

    return response;
  }
}

async function forcePasswordSessionRevocation(request: Request): Promise<Request> {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return request;
  }

  return new Request(request, {
    body: JSON.stringify({
      ...(body as Record<string, unknown>),
      revokeOtherSessions: true,
    }),
  });
}
