import {
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolvePort,
  resolveTelegramConfig,
} from './config.js';
import { loadEnvironmentFile } from './env.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { startApplication } from './runtime.js';

loadEnvironmentFile();
const databaseUrl = resolveDatabaseUrl();
const auth = resolveAuthConfig();
const telegram = resolveTelegramConfig();
const application = startApplication({
  auth,
  databaseUrl,
  port: resolvePort(),
  telegramBotToken: telegram.botToken,
  telegramLegacyChannelId: telegram.legacyChannelId,
  telegramWorkerConcurrency: telegram.workerConcurrency,
});
registerProcessLifecycle(application, {
  secrets: [auth.secret, databaseUrl, telegram.botToken],
});
