import { and, asc, eq } from 'drizzle-orm';
import type { AuthConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { authApiKeys, owners } from '../db/schema.js';
import { createAuth } from './auth.js';

export const SERVICE_TOKEN_SCOPES = ['admin:read', 'content:write', 'ingestion:write'] as const;

export type ServiceTokenScope = (typeof SERVICE_TOKEN_SCOPES)[number];

export type ServiceTokenPermissions = Record<string, string[]>;

export interface ServiceTokenSummary {
  createdAt: Date;
  enabled: boolean;
  expiresAt: Date | null;
  id: string;
  name: string | null;
  permissions: ServiceTokenPermissions;
  prefix: string | null;
  start: string | null;
}

export interface CreatedServiceToken extends ServiceTokenSummary {
  key: string;
}

function permissionsFromScopes(scopes: ServiceTokenScope[]): ServiceTokenPermissions {
  const permissions: ServiceTokenPermissions = {};
  for (const scope of scopes) {
    const [resource, action] = scope.split(':') as [keyof ServiceTokenPermissions, string];
    const actions = permissions[resource] ?? [];
    if (!actions.includes(action)) {
      permissions[resource] = [...actions, action];
    }
  }
  return permissions;
}

export function parseServiceTokenScopes(values: string[]): ServiceTokenScope[] {
  if (values.length === 0) {
    throw new Error('token create requires at least one --scope');
  }

  const known = new Set<string>(SERVICE_TOKEN_SCOPES);
  const scopes = [...new Set(values.map((value) => value.trim()))];
  const unknown = scopes.find((scope) => !known.has(scope));
  if (unknown) {
    throw new Error(
      `Unknown service token scope: ${unknown}. Expected ${SERVICE_TOKEN_SCOPES.join(', ')}`,
    );
  }

  return scopes as ServiceTokenScope[];
}

export function parseServiceTokenExpiry(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d{1,4})d$/.exec(value.trim());
  if (!match?.[1]) {
    throw new Error('token --expires-in must use whole days, for example 30d');
  }
  const days = Number(match[1]);
  if (days < 1 || days > 3_650) {
    throw new Error('token --expires-in must be between 1d and 3650d');
  }
  return days * 24 * 60 * 60;
}

function parseStoredPermissions(value: string | null): ServiceTokenPermissions {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ServiceTokenPermissions)
      : {};
  } catch {
    return {};
  }
}

export function serviceTokenHasPermission(
  permissions: ServiceTokenPermissions | null | undefined,
  scope: ServiceTokenScope,
): boolean {
  const [resource, action] = scope.split(':') as [keyof ServiceTokenPermissions, string];
  return permissions?.[resource]?.includes(action) === true;
}

export class ServiceTokenService {
  constructor(
    private readonly database: Database,
    private readonly config: AuthConfig,
  ) {}

  async create(options: {
    expiresIn?: number;
    name: string;
    scopes: ServiceTokenScope[];
  }): Promise<CreatedServiceToken> {
    const name = options.name.trim();
    if (name.length < 1 || name.length > 64) {
      throw new Error('token name must contain between 1 and 64 characters');
    }

    const ownerId = await this.getOwnerId();
    const created = await createAuth(this.database, this.config).api.createApiKey({
      body: {
        expiresIn: options.expiresIn ?? null,
        name,
        permissions: permissionsFromScopes(options.scopes),
        userId: ownerId,
      },
    });

    return {
      createdAt: created.createdAt,
      enabled: created.enabled,
      expiresAt: created.expiresAt,
      id: created.id,
      key: created.key,
      name: created.name,
      permissions: created.permissions ?? {},
      prefix: created.prefix,
      start: created.start,
    };
  }

  async list(): Promise<ServiceTokenSummary[]> {
    const ownerId = await this.getOwnerId();
    const rows = await this.database
      .select({
        createdAt: authApiKeys.createdAt,
        enabled: authApiKeys.enabled,
        expiresAt: authApiKeys.expiresAt,
        id: authApiKeys.id,
        name: authApiKeys.name,
        permissions: authApiKeys.permissions,
        prefix: authApiKeys.prefix,
        start: authApiKeys.start,
      })
      .from(authApiKeys)
      .where(eq(authApiKeys.referenceId, ownerId))
      .orderBy(asc(authApiKeys.createdAt), asc(authApiKeys.id));

    return rows.map((row) => ({
      ...row,
      permissions: parseStoredPermissions(row.permissions),
    }));
  }

  async revoke(id: string): Promise<void> {
    const ownerId = await this.getOwnerId();
    const [revoked] = await this.database
      .update(authApiKeys)
      .set({
        enabled: false,
        updatedAt: new Date(),
      })
      .where(and(eq(authApiKeys.id, id), eq(authApiKeys.referenceId, ownerId)))
      .returning({ id: authApiKeys.id });

    if (!revoked) {
      throw new Error('Service token was not found');
    }
  }

  private async getOwnerId(): Promise<string> {
    const [owner] = await this.database
      .select({ userId: owners.userId })
      .from(owners)
      .where(eq(owners.singleton, 1))
      .limit(1);
    if (!owner) {
      throw new Error('Create the singleton owner before managing service tokens');
    }
    return owner.userId;
  }
}
