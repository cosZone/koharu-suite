import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { authUsers, owners } from '../db/schema.js';
import { createAuth } from './auth.js';

const OWNER_LOCK_NAMESPACE = 1_267_663_173;
const OWNER_LOCK_KEY = 2;
const emailSchema = z.email().transform((value) => value.trim().toLowerCase());
const passwordSchema = z.string().min(12).max(128);

export class OwnerAlreadyExistsError extends Error {
  constructor() {
    super('An owner already exists');
    this.name = 'OwnerAlreadyExistsError';
  }
}

export class OwnerNotFoundError extends Error {
  constructor() {
    super('The owner was not found');
    this.name = 'OwnerNotFoundError';
  }
}

export interface OwnerIdentity {
  email: string;
  userId: string;
}

export class PostgresOwnerRepository {
  constructor(private readonly database: Database) {}

  async findOwner(): Promise<OwnerIdentity | null> {
    const [owner] = await this.database
      .select({
        email: authUsers.email,
        userId: authUsers.id,
      })
      .from(owners)
      .innerJoin(authUsers, eq(authUsers.id, owners.userId))
      .where(eq(owners.singleton, 1))
      .limit(1);

    return owner ?? null;
  }

  async isOwner(userId: string): Promise<boolean> {
    const [owner] = await this.database
      .select({ singleton: owners.singleton })
      .from(owners)
      .where(and(eq(owners.singleton, 1), eq(owners.userId, userId)))
      .limit(1);

    return owner !== undefined;
  }
}

export class OwnerService {
  constructor(
    private readonly database: Database,
    private readonly authConfig: AuthConfig,
  ) {}

  async create(email: string, password: string): Promise<OwnerIdentity> {
    const normalizedEmail = emailSchema.parse(email);
    const validatedPassword = passwordSchema.parse(password);

    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${OWNER_LOCK_NAMESPACE}, ${OWNER_LOCK_KEY})`,
      );

      const [existingOwner] = await transaction
        .select({ singleton: owners.singleton })
        .from(owners)
        .where(eq(owners.singleton, 1))
        .limit(1);
      if (existingOwner) {
        throw new OwnerAlreadyExistsError();
      }

      const auth = createAuth(transaction, this.authConfig, { allowSignUp: true });
      const result = await auth.api.signUpEmail({
        body: {
          email: normalizedEmail,
          name: 'Owner',
          password: validatedPassword,
        },
      });

      await transaction.insert(owners).values({
        singleton: 1,
        userId: result.user.id,
      });

      return {
        email: result.user.email,
        userId: result.user.id,
      };
    });
  }

  async resetPassword(email: string, password: string): Promise<OwnerIdentity> {
    const normalizedEmail = emailSchema.parse(email);
    const validatedPassword = passwordSchema.parse(password);
    const [owner] = await this.database
      .select({
        email: authUsers.email,
        userId: authUsers.id,
      })
      .from(owners)
      .innerJoin(authUsers, eq(authUsers.id, owners.userId))
      .where(and(eq(owners.singleton, 1), eq(authUsers.email, normalizedEmail)))
      .limit(1);
    if (!owner) {
      throw new OwnerNotFoundError();
    }

    let resetToken: string | undefined;
    const auth = createAuth(this.database, this.authConfig, {
      sendResetPassword: async ({ token }) => {
        resetToken = token;
      },
    });

    await auth.api.requestPasswordReset({
      body: { email: owner.email },
    });
    if (!resetToken) {
      throw new Error('Better Auth did not issue a password reset token');
    }

    await auth.api.resetPassword({
      body: {
        newPassword: validatedPassword,
        token: resetToken,
      },
    });

    return owner;
  }
}

export function validateOwnerPassword(password: string): string {
  return passwordSchema.parse(password);
}
