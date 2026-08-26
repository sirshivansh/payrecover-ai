import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';

describe('Phase 17 — Route Authorization & Security Audit (§16, §20, §26)', () => {
  const env = loadEnv();
  const testKey = 'test-merchant-api-key-32-chars!';
  process.env.MERCHANT_API_KEY = testKey;

  it('should return HTTP 401 Unauthorized when X-Merchant-Key header is missing on protected routes', async () => {
    const app = await buildApp({ env });

    const routesToTest = ['/api/v1/metrics/summary', '/api/v1/recoveries', '/api/v1/recoveries/att_123'];

    for (const route of routesToTest) {
      const res = await app.inject({
        method: 'GET',
        url: route,
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.status).toBe('error');
      expect(json.message).toContain('Unauthorized');
    }

    await app.close();
  });

  it('should return HTTP 401 Unauthorized when X-Merchant-Key is invalid', async () => {
    const app = await buildApp({ env });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics/summary',
      headers: {
        'x-merchant-key': 'invalid_secret_key_999',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain('Unauthorized');

    await app.close();
  });

  it('should audit API responses to ensure zero raw PII or secret credentials are exposed', async () => {
    const app = await buildApp({ env });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics/summary',
      headers: {
        'x-merchant-key': testKey,
      },
    });

    expect(res.statusCode).toBe(200);
    const bodyText = res.body;

    // Verify secrets are NOT leaked in response text
    expect(bodyText).not.toContain(testKey);
    expect(bodyText).not.toContain('rzp_test_');
    expect(bodyText).not.toContain('nvapi-');

    await app.close();
  });

  it('should verify rate limiting headers are returned on API routes', async () => {
    const app = await buildApp({ env });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics/summary',
      headers: {
        'x-merchant-key': testKey,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toHaveProperty('x-ratelimit-limit');
    expect(res.headers).toHaveProperty('x-ratelimit-remaining');

    await app.close();
  });
});
