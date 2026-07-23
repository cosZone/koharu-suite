#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { OwnerService } from './auth/owner-service.js';
import { readOwnerPassword } from './auth/password-input.js';
import {
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolvePort,
  resolveTelegramConfig,
} from './config.js';
import { createDatabaseConnection } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnvironmentFile } from './env.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { startApplication } from './runtime.js';
import { VERSION } from './version.js';

const HELP = `kodama ${VERSION}

Usage:
  kodama <command> [options]

Commands:
  serve       Start the HTTP API and Telegram collector
  migrate     Apply pending database migrations
  owner       Create or reset the singleton owner
  help        Show this help

Options:
  -h, --help                  Show command help
  -v, --version               Show the version
  -p, --port <port>           Server port (default: PORT or 3000)
      --database-url <url>    PostgreSQL URL (default: DATABASE_URL)
      --email <email>         Owner email for an owner command
      --password-stdin        Read one password line from stdin

Owner commands:
  kodama owner create --email owner@example.com [--password-stdin]
  kodama owner reset-password --email owner@example.com [--password-stdin]

serve also requires BETTER_AUTH_SECRET, BETTER_AUTH_URL, TELEGRAM_BOT_TOKEN,
and TELEGRAM_CHANNEL_ID.
`;

interface CliOptions {
  'database-url'?: string;
  email?: string;
  help?: boolean;
  'password-stdin'?: boolean;
  port?: string;
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
      help: { short: 'h', type: 'boolean' },
      'password-stdin': { type: 'boolean' },
      port: { short: 'p', type: 'string' },
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
      telegramBotToken: telegram.botToken,
      telegramChannelId: telegram.channelId,
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

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kodama: ${message}\n`);
  process.exitCode = 1;
});
