#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolveDatabaseUrl, resolvePort, resolveTelegramConfig } from './config.js';
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
  help        Show this help

Options:
  -h, --help                  Show command help
  -v, --version               Show the version
  -p, --port <port>           Server port (default: PORT or 3000)
      --database-url <url>    PostgreSQL URL (default: DATABASE_URL)

serve also requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.
`;

interface CliOptions {
  'database-url'?: string;
  help?: boolean;
  port?: string;
  version?: boolean;
}

function printHelp(): void {
  process.stdout.write(HELP);
}

function parseCli(): { command: string | undefined; options: CliOptions } {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'database-url': { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      port: { short: 'p', type: 'string' },
      version: { short: 'v', type: 'boolean' },
    },
    strict: true,
  });

  return {
    command: positionals[0],
    options: values,
  };
}

async function main(): Promise<void> {
  const { command, options } = parseCli();

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
    const telegram = resolveTelegramConfig();
    const application = startApplication({
      databaseUrl,
      port: resolvePort(options.port),
      telegramBotToken: telegram.botToken,
      telegramChannelId: telegram.channelId,
    });
    registerProcessLifecycle(application, {
      secrets: [databaseUrl, telegram.botToken],
    });
    return;
  }

  if (command === 'migrate') {
    await runMigrations(resolveDatabaseUrl(options['database-url']));
    process.stdout.write('Database migrations applied.\n');
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kodama: ${message}\n`);
  process.exitCode = 1;
});
