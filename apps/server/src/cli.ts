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
import { normalizeCliArguments } from './cli-arguments.js';
import {
  parseTelegramChannelId,
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolveMediaCacheConfig,
  resolvePort,
  resolvePublicApiConfig,
  resolveTelegramConfig,
  resolveWorkerInstanceId,
} from './config.js';
import { createDatabaseConnection } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnvironmentFile } from './env.js';
import { parseTelegramDesktopCompleteRange } from './imports/coverage.js';
import { closeImportResources, registerImportCancellation } from './imports/import-lifecycle.js';
import { PostgresTelegramDesktopImportRepository } from './imports/import-repository.js';
import {
  renderTelegramDesktopImportReport,
  TELEGRAM_DESKTOP_REPORT_SCHEMA_VERSION,
  telegramDesktopImportExitCode,
} from './imports/report.js';
import { TelegramDesktopInputError } from './imports/telegram-desktop-parser.js';
import { TelegramDesktopImportService } from './imports/telegram-desktop-service.js';
import { runMediaCacheCli } from './media-cache/cli.js';
import { PostgresMessageRepository } from './messages/repository.js';
import {
  doctorHasFailures,
  renderDoctorReport,
  runDoctor,
  sanitizeDiagnosticText,
} from './ops/doctor.js';
import { PostgresDoctorDiagnostics, TelegramDoctorDiagnostics } from './ops/doctor-runtime.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { ReconciliationApplyService } from './reconciliation/apply-service.js';
import { runReconciliationCli } from './reconciliation/cli.js';
import { PostgresReconciliationPersistenceRepository } from './reconciliation/persistence-repository.js';
import { PostgresDeterministicRepairRepository } from './reconciliation/repair-repository.js';
import { PostgresReconciliationRepository } from './reconciliation/repository.js';
import { ReconciliationService } from './reconciliation/service.js';
import { createWorkerRuntime, startServerRuntime } from './runtime.js';
import { GrammyTelegramApi } from './telegram/api.js';
import { TelegramChannelService } from './telegram/channel-service.js';
import { VERSION } from './version.js';
import { PostgresWorkerRuntimeRepository } from './worker-runtime-repository.js';

const HELP = `kodama ${VERSION}

Usage:
  kodama <command> [options]

Commands:
  serve       Start the HTTP API
  worker      Start the Telegram collector
  migrate     Apply pending database migrations
  owner       Create or reset the singleton owner
  token       Create, list, or revoke scoped service tokens
  channel     Add, list, enable, or disable Telegram channels
  import      Import historical content
  media       Inspect or maintain the optional local media cache
  reconcile   Inspect scoped Telegram archive consistency
  doctor      Run read-only deployment diagnostics
  health      Run a container-local health check
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
      --input <path>           Telegram Desktop result.json
      --import-run <uuid>      Exact completed Desktop import run for media cache
      --desktop-root <path>    Process-local Telegram Desktop export root
      --channel <id>           Repeatable canonical Telegram channel ID
      --complete-range <range> Explicit complete channel:start:end coverage; repeatable, apply only
      --apply                  Apply a supported operation (default: dry-run)
      --reason <text>          Required operator reason for reconciliation apply
      --target-bytes <bytes>   Desired ready-byte ceiling for media prune
      --json                   Print a versioned JSON report

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

Import command:
  kodama import telegram-desktop --input /path/to/result.json --channel -1001234567890 [--apply] [--complete-range=-1001234567890:1:100] [--json]

Reconciliation command:
  kodama reconcile telegram --channel -1001234567890 [--channel -1009876543210] [--json]
  kodama reconcile telegram --channel -1001234567890 --apply --reason "approved repair"

Media commands:
  kodama media status [--json]
  kodama media scan [--channel -1001234567890] [--channel -1009876543210] [--json]
  kodama media cache --import-run <uuid> --input <result.json> --desktop-root <path> --apply --reason <text>
  kodama media prune [--target-bytes <bytes>] [--apply --reason <text>] [--json]
  kodama media reconcile [--apply --reason <text>] [--json]

Doctor command:
  kodama doctor

Health command:
  kodama health worker

serve requires BETTER_AUTH_SECRET and BETTER_AUTH_URL.
worker requires TELEGRAM_BOT_TOKEN and HOSTNAME.
TELEGRAM_CHANNEL_ID is an optional one-time bootstrap when the allowlist is empty.
`;

interface CliOptions {
  apply?: boolean;
  channel?: string[];
  'complete-range'?: string[];
  'database-url'?: string;
  'desktop-root'?: string;
  email?: string;
  'expires-in'?: string;
  help?: boolean;
  id?: string;
  'import-run'?: string;
  input?: string;
  json?: boolean;
  name?: string;
  'password-stdin'?: boolean;
  port?: string;
  reason?: string;
  scope?: string[];
  'target-bytes'?: string;
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
    args: normalizeCliArguments(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      apply: { type: 'boolean' },
      channel: { multiple: true, type: 'string' },
      'complete-range': { multiple: true, type: 'string' },
      'database-url': { type: 'string' },
      'desktop-root': { type: 'string' },
      email: { type: 'string' },
      'expires-in': { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      id: { type: 'string' },
      'import-run': { type: 'string' },
      input: { type: 'string' },
      json: { type: 'boolean' },
      name: { type: 'string' },
      'password-stdin': { type: 'boolean' },
      port: { short: 'p', type: 'string' },
      reason: { type: 'string' },
      scope: { multiple: true, type: 'string' },
      'target-bytes': { type: 'string' },
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
    process.env.MEDIA_CACHE_ROOT,
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
    const mediaCache = resolveMediaCacheConfig();
    const runtime = await startServerRuntime({
      auth,
      databaseUrl,
      mediaCache,
      port: resolvePort(options.port),
      publicApi: resolvePublicApiConfig(),
    });
    registerProcessLifecycle(runtime, {
      secrets: [auth.secret, databaseUrl, mediaCache.root],
    });
    return;
  }

  if (command === 'worker') {
    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const telegram = resolveTelegramConfig();
    const mediaCache = resolveMediaCacheConfig();
    const runtime = createWorkerRuntime({
      ...telegram,
      databaseUrl,
      instanceId: resolveWorkerInstanceId(),
      mediaCache,
    });
    registerProcessLifecycle(runtime, {
      secrets: [databaseUrl, telegram.botToken, mediaCache.root],
    });
    void runtime.start().catch(() => {
      // The lifecycle reporter owns sanitized process diagnostics.
    });
    return;
  }

  if (command === 'migrate') {
    await runMigrations(resolveDatabaseUrl(options['database-url']));
    process.stdout.write('Database migrations applied.\n');
    return;
  }

  if (command === 'media') {
    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const mediaCache = resolveMediaCacheConfig();
    try {
      await runMediaCacheCli({
        apply: options.apply === true,
        ...(options.channel ? { channels: options.channel } : {}),
        databaseUrl,
        ...(options['desktop-root'] ? { desktopRoot: options['desktop-root'] } : {}),
        ...(options['import-run'] ? { importRunId: options['import-run'] } : {}),
        ...(options.input ? { inputPath: options.input } : {}),
        json: options.json === true,
        mediaCache,
        ...(options.reason ? { reason: options.reason } : {}),
        subcommand,
        ...(options['target-bytes'] ? { targetBytes: options['target-bytes'] } : {}),
      });
    } catch (error) {
      throw new Error(
        sanitizeDiagnosticText(error, [
          ...sensitiveEnvironmentValues(),
          databaseUrl,
          mediaCache.root,
          ...(options.input ? [options.input] : []),
          ...(options['desktop-root'] ? [options['desktop-root']] : []),
        ]),
      );
    }
    return;
  }

  if (command === 'import') {
    if (subcommand !== 'telegram-desktop') {
      throw new Error('import command must be telegram-desktop');
    }
    if (!options.input) {
      throw new Error('import telegram-desktop requires --input');
    }
    if (!options.channel || options.channel.length === 0) {
      throw new Error('import telegram-desktop requires at least one --channel');
    }

    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const channelIds = options.channel.map(parseTelegramChannelId);
    const completeRanges = (options['complete-range'] ?? []).map(parseTelegramDesktopCompleteRange);
    const connection = createDatabaseConnection(databaseUrl);
    const repository = new PostgresTelegramDesktopImportRepository(databaseUrl, connection.db);
    const cancellation = registerImportCancellation();
    try {
      const report = await new TelegramDesktopImportService(
        repository,
        new PostgresMessageRepository(connection.db),
      ).run({
        apply: options.apply === true,
        channelIds,
        completeRanges,
        inputPath: options.input,
        signal: cancellation.signal,
      });
      process.stdout.write(renderTelegramDesktopImportReport(report, options.json === true));
      process.exitCode = telegramDesktopImportExitCode(report);
    } catch (error) {
      const message = sanitizeDiagnosticText(error, [...sensitiveEnvironmentValues(), databaseUrl]);
      if (options.json) {
        const code =
          error instanceof TelegramDesktopInputError
            ? error.code
            : 'telegram_desktop_import_failed';
        process.stdout.write(
          `${JSON.stringify({
            error: { code, message },
            schemaVersion: TELEGRAM_DESKTOP_REPORT_SCHEMA_VERSION,
            status: 'fatal',
          })}\n`,
        );
      } else {
        process.stderr.write(`kodama: ${message}\n`);
      }
      process.exitCode = 1;
    } finally {
      cancellation.cleanup();
      try {
        await closeImportResources(
          () => repository.close(),
          () => connection.close(),
        );
      } catch (error) {
        const message = sanitizeDiagnosticText(error, [
          ...sensitiveEnvironmentValues(),
          databaseUrl,
        ]);
        process.stderr.write(`kodama: import cleanup failed: ${message}\n`);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (command === 'reconcile') {
    if (subcommand !== 'telegram') {
      throw new Error('reconcile command must be telegram');
    }
    if (!options.channel || options.channel.length === 0) {
      throw new Error('reconcile telegram requires at least one --channel');
    }

    const channelIds = options.channel.map(parseTelegramChannelId);
    if (options.reason !== undefined && options.apply !== true) {
      process.exitCode = await runReconciliationCli(
        {
          apply: false,
          channelIds,
          json: options.json === true,
          reason: options.reason,
        },
        {
          write: (output) => process.stdout.write(output),
        },
      );
      return;
    }

    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const connection = createDatabaseConnection(databaseUrl);
    try {
      const scanner = new ReconciliationService(
        new PostgresReconciliationRepository(connection.db),
      );
      const persistence = new PostgresReconciliationPersistenceRepository(connection.db);
      const repair = new PostgresDeterministicRepairRepository(connection.db);
      const apply = new ReconciliationApplyService(connection.db, persistence, repair);
      process.exitCode = await runReconciliationCli(
        {
          apply: options.apply === true,
          channelIds,
          json: options.json === true,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        },
        {
          apply: (input) => apply.apply(input),
          scan: (scope) => scanner.scan({ telegramChannelIds: scope }),
          write: (output) => process.stdout.write(output),
        },
      );
    } finally {
      await connection.close();
    }
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
          new GrammyTelegramApi(telegram.botToken, {
            ...(telegram.apiRoot ? { apiRoot: telegram.apiRoot } : {}),
          }),
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
      const telegramApi = new GrammyTelegramApi(telegram.botToken, {
        ...(telegram.apiRoot ? { apiRoot: telegram.apiRoot } : {}),
      });
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

  if (command === 'health') {
    if (subcommand !== 'worker') {
      throw new Error('health command must be worker');
    }
    const databaseUrl = resolveDatabaseUrl(options['database-url']);
    const instanceId = resolveWorkerInstanceId();
    const connection = createDatabaseConnection(databaseUrl, { max: 1 });
    try {
      const health = await new PostgresWorkerRuntimeRepository(connection.db).getHealthyInstance(
        instanceId,
      );
      if (!health) {
        throw new Error(`Worker ${instanceId} does not have a fresh running heartbeat`);
      }
      process.stdout.write(
        `Worker ${health.instanceId} is healthy (${health.version}, ${health.heartbeatAt}).\n`,
      );
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
