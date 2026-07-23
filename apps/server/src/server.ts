import { serve } from '@hono/node-server';
import { app } from './app.js';

export function startServer(port: number) {
  return serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`koharu-suite listening on http://localhost:${info.port}`);
    },
  );
}

export function registerGracefulShutdown(server: ReturnType<typeof startServer>): void {
  const cleanup = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
  const shutdown = () => {
    cleanup();
    server.close();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('close', cleanup);
}
