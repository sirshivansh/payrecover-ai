import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';

describe('API Health Check', () => {
  const env = loadEnv();
  const appPromise = buildApp({ env });

  afterAll(async () => {
    const app = await appPromise;
    await app.close();
  });

  it('GET /health should return 200 with status ok', async () => {
    const app = await appPromise;
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('payrecover-api');
    expect(body.timestamp).toBeDefined();
    expect(body.version).toBe('0.1.0');
  });

  it('GET /health should include ISO timestamp', async () => {
    const app = await appPromise;
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const body = response.json();
    // Verify it's a valid ISO date
    const parsed = new Date(body.timestamp);
    expect(parsed.toISOString()).toBe(body.timestamp);
  });
});
