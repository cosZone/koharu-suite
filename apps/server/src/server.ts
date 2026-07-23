import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

export function startServer(app: Hono, port: number) {
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

export function closeServer(server: ReturnType<typeof startServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
