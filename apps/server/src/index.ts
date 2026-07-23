import { resolveDatabaseUrl, resolvePort, resolveTelegramConfig } from './config.js';
import { loadEnvironmentFile } from './env.js';
import { registerProcessLifecycle } from './process-lifecycle.js';
import { startApplication } from './runtime.js';

loadEnvironmentFile();
const databaseUrl = resolveDatabaseUrl();
const telegram = resolveTelegramConfig();
const application = startApplication({
  databaseUrl,
  port: resolvePort(),
  telegramBotToken: telegram.botToken,
  telegramChannelId: telegram.channelId,
});
registerProcessLifecycle(application, {
  secrets: [databaseUrl, telegram.botToken],
});
