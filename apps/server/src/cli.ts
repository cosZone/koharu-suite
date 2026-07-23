#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { PostgresAdminOperations } from './admin/operations.js';
import { OwnerService, PostgresOwnerRepository } from './auth/owner-service.js';
import { readOwnerPassword } from './auth/password-input.js';
import {
  parseServiceTokenExpiry,
  parseServiceTokenScopes,
  type ServiceTokenPermissions,
  ServiceTokenService,
} from './auth/service-token.js';
import {
  parseTelegramChannelId,
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolvePort,
  resolvePublicApiConfig,
  resolveTelegramConfig,
} from './config.js';
import { createDatabaseConnection } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnvironmentFile } from './env.js';
import {
  doctorHasFailures,
  renderDoctorReport,
  runDoctor,
  sanitizeDiagnosticText,
} from './ops/doctor.js';
import { PostgresDoctorDiagnostics, TelegramDoctorDiagnostics } from './ops/doctor-runtime.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { startApplication } from './runtime.js';
import { GrammyTelegramApi } from './telegram/api.js';
import { TelegramChannelService } from './telegram/channel-service.js';
import { VERSION } from './version.js';

const HELP = `kodama ${VERSION}

Usage:
  kodama <command> [options]

Commands:
  serve       Start the HTTP API and Telegram collector
  migrate     Apply pending database migrations
  owner       Create or reset the singleton owner
  token       Create, list, or revoke scoped service tokens
  channel     Add, list, enable, or disable Telegram channels
  doctor      Run read-only deployment diagnostics
  help        Show this help

Options:
  -h, --help                   Show command help
  -v, --version                Show the version
  -p, --port <port>            Server port (default: PORT or 3000)
      --database-url <url>     PostgreSQL URL (default: DATABASE_URL)
      --email <email>          Owner email for an owner command
      --password-stdin         Read one password line from stdin
      --telegram-id <id>       Negative Telegram channel ID
      --name <name>            Service token name
      --scope <scope>          Repeatable service token scope
      --expires-in <duration>  Optional token expiry in whole days, for example 30d
      --id <id>                Service token ID

Owner commands:
  kodama owner create --email owner@example.com [--password-stdin]
  kodama owner reset-password --email owner@example.com [--password-stdin]

Token commands:
  kodama token create --name deploy --scope admin:read [--scope content:write] [--expires-in 30d]
  kodama token list
  kodama token revoke --id <api-key-id>

Channel commands:
  kodama channel add --telegram-id -1001234567890
  kodama channel list
  kodama channel enable --telegram-id -1001234567890
  kodama channel disable --telegram-id -1001234567890

Doctor command:
  kodama doctor

serve requires BETTER_AUTH_SECRET, BETTER_AUTH_URL, and TELEGRAM_BOT_TOKEN.
TELEGRAM_CHANNEL_ID is an optional one-time bootstrap when the allowlist is empty.
`;

interface CliOptions {
  'database-url'?: string;
  email?: string;
  'expires-in'?: string;
  help?: boolean;
  id?: string;
  name?: string;
  'password-stdin'?: boolean;
  port?: string;
  scope?: string[];
  'telegram-id'?: string;
  version?: boolean;
}

function printHelp(): void {
  process.stdout.write(HELP);
}

function parseCli(): {
  command: string | undefined;
  options: CliOptions;
  subcommand: string | undefined;
} {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'database-url': { type: 'string' },
      email: { type: 'string' },
      'expires-in': { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      id: { type: 'string' },
      name: { type: 'string' },
      'password-stdin': { type: 'boolean' },
      port: { short: 'p', type: 'string' },
      scope: { multiple: true, type: 'string' },
      'telegram-id': { type: 'string' },
      version: { short: 'v', type: 'boolean' },
    },
    strict: true,
  });

  return {
    command: positionals[0],
    options: values,
    subcommand: positionals[1],
  };
}

function serviceTokenScopes(permissions: ServiceTokenPermissions): string {
  const scopes = Object.entries(permissions)
    .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`))
    .sort();
  return scopes.length > 0 ? scopes.join(',') : '—';
}

function dateOrDash(value: Date | null): string {
  return value?.toISOString() ?? '—';
}

function sensitiveEnvironmentValues(): string[] {
  return [
    process.env.DATABASE_URL,
    process.env.POSTGRES_PASSWORD,
    process.env.BETTER_AUTH_SECRET,
    process.env.TELEGRAM_BOT_TOKEN,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

async function main(): Promise<void> {
  const { command, options, subcommand } = parseCli();

  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (options.help || command === undefined || command === 'help') {
    printHelp();
    return;
  }

  loadEnvironmentFile();

  if (command === 'serve') {
    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const auth = resolveAuthConfig();
    const telegram = resolveTelegramConfig();
    const application = startApplication({
      auth,
      databaseUrl,
      port: resolvePort(options.port),
      publicApi: resolvePublicApiConfig(),
      telegramBotToken: telegram.botToken,
      telegramLegacyChannelId: telegram.legacyChannelId,
      telegramWorkerConcurrency: telegram.workerConcurrency,
    });
    registerProcessLifecycle(application, {
      secrets: [auth.secret, databaseUrl, telegram.botToken],
    });
    return;
  }

  if (command === 'migrate') {
    await runMigrations(resolveDatabaseUrl(options['database-url']));
    process.stdout.write('Database migrations applied.\n');
    return;
  }

  if (command === 'owner') {
    if (subcommand !== 'create' && subcommand !== 'reset-password') {
      throw new Error('owner command must be create or reset-password');
    }
    if (!options.email) {
      throw new Error('owner command requires --email');
    }

    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const password = await readOwnerPassword(options['password-stdin'] === true);
    const connection = createDatabaseConnection(databaseUrl);

    try {
      const service = new OwnerService(connection.db, resolveAuthConfig());
      const owner =
        subcommand === 'create'
          ? await service.create(options.email, password)
          : await service.resetPassword(options.email, password);
      const action = subcommand === 'create' ? 'created' : 'password reset';
      process.stdout.write(`Owner ${action}: ${owner.email}\n`);
    } finally {
      await connection.close();
    }
    return;
  }

  if (command === 'token') {
    if (subcommand !== 'create' && subcommand !== 'list' && subcommand !== 'revoke') {
      throw new Error('token command must be create, list, or revoke');
    }
    if (subcommand === 'create' && !options.name) {
      throw new Error('token create requires --name');
    }
    if (subcommand === 'revoke' && !options.id) {
      throw new Error('token revoke requires --id');
    }
    const createOptions =
      subcommand === 'create'
        ? {
            expiresIn: parseServiceTokenExpiry(options['expires-in']),
            name: options.name ?? '',
            scopes: parseServiceTokenScopes(options.scope ?? []),
          }
        : null;

    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const connection = createDatabaseConnection(databaseUrl);
    try {
      const service = new ServiceTokenService(connection.db, resolveAuthConfig());
      if (createOptions) {
        const created = await service.create({
          ...(createOptions.expiresIn === undefined ? {} : { expiresIn: createOptions.expiresIn }),
          name: createOptions.name,
          scopes: createOptions.scopes,
        });
        process.stdout.write(
          [
            `Created service token ${created.name ?? created.id} (${created.id}).`,
            `Scopes: ${serviceTokenScopes(created.permissions)}`,
            `Expires: ${dateOrDash(created.expiresAt)}`,
            'Copy this key now. It will not be shown again:',
            created.key,
            '',
          ].join('\n'),
        );
      } else if (subcommand === 'list') {
        const tokens = await service.list();
        if (tokens.length === 0) {
          process.stdout.write('No service tokens configured.\n');
        } else {
          process.stdout.write('ID\tSTATE\tNAME\tPREFIX\tSTART\tSCOPES\tCREATED\tEXPIRES\n');
          for (const token of tokens) {
            const state = !token.enabled
              ? 'revoked'
              : token.expiresAt && token.expiresAt.getTime() <= Date.now()
                ? 'expired'
                : 'enabled';
            process.stdout.write(
              `${[
                token.id,
                state,
                token.name ?? '—',
                token.prefix ?? '—',
                token.start ?? '—',
                serviceTokenScopes(token.permissions),
                token.createdAt.toISOString(),
                dateOrDash(token.expiresAt),
              ].join('\t')}\n`,
            );
          }
        }
      } else {
        await service.revoke(options.id ?? '');
        process.stdout.write(`Revoked service token ${options.id}.\n`);
      }
    } finally {
      await connection.close();
    }
    return;
  }

  if (command === 'channel') {
    if (
      subcommand !== 'add' &&
      subcommand !== 'list' &&
      subcommand !== 'enable' &&
      subcommand !== 'disable'
    ) {
      throw new Error('channel command must be add, list, enable, or disable');
    }
    if (subcommand !== 'list' && !options['telegram-id']) {
      throw new Error(`channel ${subcommand} requires --telegram-id`);
    }
    const telegramChatId =
      subcommand === 'list' ? null : parseTelegramChannelId(options['telegram-id'] ?? '');

    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const connection = createDatabaseConnection(databaseUrl);
    try {
      if (subcommand === 'add') {
        const telegram = resolveTelegramConfig();
        const service = new TelegramChannelService(
          connection.db,
          new GrammyTelegramApi(telegram.botToken),
        );
        if (telegramChatId === null) {
          throw new Error('channel add requires --telegram-id');
        }
        const channel = await service.add(telegramChatId);
        process.stdout.write(
          `Configured ${channel.title} (@${channel.username}, ${channel.telegramChatId})\n`,
        );
      } else if (subcommand === 'list') {
        const service = new TelegramChannelService(connection.db);
        const channels = await service.list();
        if (channels.length === 0) {
          process.stdout.write('No Telegram channels configured.\n');
        } else {
          for (const channel of channels) {
            process.stdout.write(
              `${channel.telegramChatId}\t${channel.enabled ? 'enabled' : 'disabled'}\t${channel.username ? `@${channel.username}` : '—'}\t${channel.title}\n`,
            );
          }
        }
      } else {
        const owner = await new PostgresOwnerRepository(connection.db).findOwner();
        if (!owner) {
          throw new Error('Create the singleton owner before changing channel state');
        }
        const enabled = subcommand === 'enable';
        if (telegramChatId === null) {
          throw new Error(`channel ${subcommand} requires --telegram-id`);
        }
        const channel = await new PostgresAdminOperations(connection.db).setChannelEnabled(
          telegramChatId,
          enabled,
          {
            actorId: owner.userId,
            actorType: 'owner_session',
            email: owner.email,
            permissions: null,
            twoFactorEnabled: null,
          },
        );
        process.stdout.write(
          `${enabled ? 'Enabled' : 'Disabled'} ${channel.title} (${channel.telegramChatId}).\n`,
        );
      }
    } finally {
      await connection.close();
    }
    return;
  }

  if (command === 'doctor') {
    if (subcommand !== undefined) {
      throw new Error('doctor does not accept a subcommand');
    }
    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const telegram = resolveTelegramConfig();
    const connection = createDatabaseConnection(databaseUrl, { max: 2 });
    try {
      const telegramApi = new GrammyTelegramApi(telegram.botToken);
      const report = await runDoctor({
        database: new PostgresDoctorDiagnostics(connection.db),
        sensitiveValues: [...sensitiveEnvironmentValues(), databaseUrl, telegram.botToken],
        telegram: new TelegramDoctorDiagnostics(telegramApi),
        validateConfig: () => {
          resolveDatabaseUrl(options['database-url']);
          resolveAuthConfig();
          resolveTelegramConfig();
          resolvePublicApiConfig();
        },
      });
      process.stdout.write(`${renderDoctorReport(report)}\n`);
      if (doctorHasFailures(report)) {
        process.exitCode = 1;
      }
    } finally {
      await connection.close();
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = sanitizeDiagnosticText(error, sensitiveEnvironmentValues());
  process.stderr.write(`kodama: ${message}\n`);
  process.exitCode = 1;
});
