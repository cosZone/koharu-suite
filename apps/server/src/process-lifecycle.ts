import type { ApplicationRuntime } from './runtime.js';

export interface ProcessLifecycleOptions {
  secrets?: string[];
}

function errorMessage(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, '[REDACTED]');
    }
  }
  return message;
}

export function registerProcessLifecycle(
  application: ApplicationRuntime,
  options: ProcessLifecycleOptions = {},
): () => void {
  const secrets = options.secrets ?? [];
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };

  const reportShutdownError = (error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`kodama: shutdown failed: ${errorMessage(error, secrets)}\n`);
  };

  const shutdown = () => {
    cleanup();
    void application.stop().catch(reportShutdownError);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  void application.done.catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`kodama: Telegram collector stopped: ${errorMessage(error, secrets)}\n`);
    cleanup();
    void application.stop().catch(() => {});
  });

  return cleanup;
}
