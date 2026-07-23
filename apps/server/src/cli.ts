#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolveDatabaseUrl, resolvePort } from './config.js';
import { runMigrations } from './db/migrate.js';
import { loadEnvironmentFile } from './env.js';
import { registerGracefulShutdown, startServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `kodama ${VERSION}

Usage:
  kodama <command> [options]

Commands:
  serve       Start the koharu-suite HTTP server
  migrate     Apply pending database migrations
  help        Show this help

Options:
  -h, --help                  Show command help
  -v, --version               Show the version
  -p, --port <port>           Server port (default: PORT or 3000)
      --database-url <url>    PostgreSQL URL (default: DATABASE_URL)
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
  loadEnvironmentFile();
  const { command, options } = parseCli();

  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (options.help || command === undefined || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'serve') {
    registerGracefulShutdown(startServer(resolvePort(options.port)));
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
