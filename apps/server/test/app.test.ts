import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('health endpoints', () => {
  it.each(['/healthz', '/api/v1/health'])('reports health at %s', async (path) => {
    const response = await createApp().request(path);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: 'koharu-suite',
      status: 'ok',
      version: '0.1.0',
    });
  });
});
