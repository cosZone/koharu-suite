import { Hono } from 'hono';
import { VERSION } from './version.js';

export interface HealthResponse {
  service: 'koharu-suite';
  status: 'ok';
  version: string;
}

const healthResponse = (): HealthResponse => ({
  service: 'koharu-suite',
  status: 'ok',
  version: VERSION,
});

export function createApp() {
  return new Hono()
    .get('/healthz', (context) => context.json(healthResponse()))
    .get('/api/v1/health', (context) => context.json(healthResponse()));
}

export const app = createApp();
