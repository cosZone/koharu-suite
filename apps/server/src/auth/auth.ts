import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import type { AuthConfig } from '../config.js';
import {
  authAccounts,
  authApiKeys,
  authSessions,
  authTwoFactors,
  authUsers,
  authVerifications,
} from '../db/schema.js';

const authSchema = {
  account: authAccounts,
  apikey: authApiKeys,
  session: authSessions,
  twoFactor: authTwoFactors,
  user: authUsers,
  verification: authVerifications,
};

export interface AuthFactoryOptions {
  allowSignUp?: boolean;
  sendResetPassword?: (data: { token: string; url: string }) => Promise<void>;
}

export function createAuth(
  database: Parameters<typeof drizzleAdapter>[0],
  config: AuthConfig,
  options: AuthFactoryOptions = {},
) {
  return betterAuth({
    appName: 'koharu-suite',
    basePath: '/api/auth',
    baseURL: config.baseUrl,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: authSchema,
      transaction: true,
    }),
    emailAndPassword: {
      autoSignIn: false,
      disableSignUp: options.allowSignUp !== true,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      ...(options.sendResetPassword ? { sendResetPassword: options.sendResetPassword } : {}),
    },
    plugins: [
      apiKey({
        defaultPrefix: 'khs_',
        keyExpiration: {
          defaultExpiresIn: null,
          maxExpiresIn: 3_650,
          minExpiresIn: 1,
        },
        maximumNameLength: 64,
        permissions: {
          defaultPermissions: {},
        },
        rateLimit: {
          enabled: true,
          maxRequests: 600,
          timeWindow: 60_000,
        },
        requireName: true,
      }),
      twoFactor({
        issuer: 'koharu-suite',
        trustDeviceMaxAge: 30 * 24 * 60 * 60,
      }),
    ],
    secret: config.secret,
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    trustedOrigins: [config.trustedOrigin],
  });
}

export type KoharuAuth = ReturnType<typeof createAuth>;
