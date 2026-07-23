import { eq } from 'drizzle-orm';
import type { AuthConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { authSessions } from '../db/schema.js';
import { createAuth, type KoharuAuth } from './auth.js';

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

export interface RuntimeAuth {
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
