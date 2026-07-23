import type { StoppableRuntime } from './runtime.js';

export const DEFAULT_SHUTDOWN_DEADLINE_MS = 25_000;

export interface ProcessLifecycleOptions {
  forceExit?: (code: number) => void;
  secrets?: string[];
  shutdownDeadlineMs?: number;
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
  runtime: StoppableRuntime,
  options: ProcessLifecycleOptions = {},
): () => void {
  const secrets = options.secrets ?? [];
  const shutdownDeadlineMs = options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  let cleanedUp = false;
  let shutdownStarted = false;
  let deadline: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    if (deadline) {
      clearTimeout(deadline);
      deadline = undefined;
    }
  };

  const reportShutdownError = (error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`kodama: shutdown failed: ${errorMessage(error, secrets)}\n`);
  };

  const shutdown = () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    deadline = setTimeout(() => {
      process.stderr.write(
        `kodama: shutdown exceeded ${shutdownDeadlineMs}ms deadline; forcing exit\n`,
      );
      forceExit(1);
    }, shutdownDeadlineMs);

    void runtime.stop().then(cleanup, (error: unknown) => {
      reportShutdownError(error);
      cleanup();
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  void runtime.done.then(shutdown, (error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`kodama: runtime stopped: ${errorMessage(error, secrets)}\n`);
    shutdown();
  });

  return cleanup;
}
