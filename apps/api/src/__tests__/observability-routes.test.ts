import { PaymentStatus, RecoveryStatus } from '@payrecover/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';

describe('Phase 12 — Observability API Routes', () => {
  const env = loadEnv();
  const dbClient = createDatabaseClient(env);
  let app: Awaited<ReturnType<typeof buildApp>>;

  // Use MERCHANT_API_KEY from env for authenticated requests
  const apiKey = env.MERCHANT_API_KEY || 'test-merchant-key';

  beforeAll(async () => {
    // Set MERCHANT_API_KEY for auth middleware
    process.env.MERCHANT_API_KEY = apiKey;
    app = await buildApp({ env, dbClient });
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  describe('1. Authentication (§16.2)', () => {
    it('should reject requests without X-Merchant-Key header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary',
      });
      expect(response.statusCode).toBe(401);
    });

    it('should reject requests with invalid X-Merchant-Key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary',
        headers: { 'x-merchant-key': 'wrong-key' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('should accept requests with valid X-Merchant-Key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary',
        headers: { 'x-merchant-key': apiKey },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('2. GET /api/v1/metrics/summary (§8.1)', () => {
    it('should return MetricsSummary with correct schema', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Verify schema matches §8.1
      expect(body).toHaveProperty('revenueAtRiskPaise');
      expect(body).toHaveProperty('recoveredRevenuePaise');
      expect(body).toHaveProperty('recoveryRatePct');
      expect(body).toHaveProperty('attemptSuccessRatePct');
      expect(body).toHaveProperty('totalAttempts');
      expect(body).toHaveProperty('succeededAttempts');
      expect(body).toHaveProperty('stoppedAttempts');
      expect(body).toHaveProperty('escalatedAttempts');
      expect(body).toHaveProperty('period');
      expect(body.period).toHaveProperty('from');
      expect(body.period).toHaveProperty('to');

      // Verify types
      expect(typeof body.revenueAtRiskPaise).toBe('number');
      expect(typeof body.recoveredRevenuePaise).toBe('number');
      expect(typeof body.recoveryRatePct).toBe('number');
      expect(typeof body.totalAttempts).toBe('number');
    });

    it('should accept from/to date parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary?from=2020-01-01&to=2030-12-31',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should reject invalid date parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary?from=not-a-date',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject from >= to', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary?from=2030-01-01&to=2020-01-01',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('3. GET /api/v1/recoveries (§8.1)', () => {
    it('should return paginated recovery list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/recoveries',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toHaveProperty('page');
      expect(body.pagination).toHaveProperty('limit');
      expect(body.pagination).toHaveProperty('total');
      expect(body.pagination).toHaveProperty('totalPages');
    });

    it('should filter by status parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/recoveries?status=succeeded',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // All returned items should have status=succeeded
      for (const item of body.data) {
        expect(item.status).toBe('succeeded');
      }
    });

    it('should respect page and limit parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/recoveries?page=1&limit=5',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(5);
      expect(body.data.length).toBeLessThanOrEqual(5);
    });

    it('should cap limit at 100', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/recoveries?limit=500',
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pagination.limit).toBe(100);
    });

    it('should require auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/recoveries',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('4. GET /api/v1/recoveries/:id (§8.1)', () => {
    let testAttemptId: string;
    let testPaymentId: string;

    beforeAll(async () => {
      // Create test data
      const razorpayId = `pay_route_${Date.now()}`;
      const payment = await dbClient.db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '250000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
          email_hash: 'hash_email_test',
          phone_hash: 'hash_phone_test',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      testPaymentId = payment.id;

      const attempt = await dbClient.db
        .insertInto('recovery_attempts')
        .values({
          payment_id: payment.id,
          attempt_number: 1,
          status: RecoveryStatus.PENDING,
          revenue_at_risk_paise: '250000',
          policy_snapshot: { maxAttempts: 3 },
          started_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      testAttemptId = attempt.id;

      // Add an audit log for this attempt
      await dbClient.db
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: attempt.id,
          payment_id: payment.id,
          actor: 'scheduler',
          action: 'recovery_attempt_created',
          input: { payment_id: payment.id },
          output: { status: 'pending' },
          trace_id: crypto.randomUUID(),
          created_at: new Date(),
        })
        .execute();
    });

    afterAll(async () => {
      await dbClient.db.deleteFrom('audit_log').where('recovery_attempt_id', '=', testAttemptId).execute();
      await dbClient.db.deleteFrom('recovery_attempts').where('id', '=', testAttemptId).execute();
      await dbClient.db.deleteFrom('payments').where('id', '=', testPaymentId).execute();
    });

    it('should return recovery detail with payment and audit logs', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/recoveries/${testAttemptId}`,
        headers: { 'x-merchant-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Verify attempt fields
      expect(body.id).toBe(testAttemptId);
      expect(body.status).toBe('pending');
      expect(body.revenueAtRiskPaise).toBe(250000);

      // Verify payment (no raw PII — §8.1 Payment schema)
      expect(body.payment).toBeDefined();
      expect(body.payment.hasEmail).toBe(true);
      expect(body.payment.hasPhone).toBe(true);
      // Must NOT expose raw email/phone — only boolean flags
      expect(body.payment.email).toBeUndefined();
      expect(body.payment.phone).toBeUndefined();
      expect(body.payment.email_hash).toBeUndefined();

      // Verify audit logs
      expect(Array.isArray(body.auditLogs)).toBe(true);
      expect(body.auditLogs.length).toBeGreaterThanOrEqual(1);
    });

    it('should return 404 for non-existent attempt', async () => {
      const fakeId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/recoveries/${fakeId}`,
        headers: { 'x-merchant-key': apiKey },
      });
      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/recoveries/not-a-uuid',
        headers: { 'x-merchant-key': apiKey },
      });
      expect(response.statusCode).toBe(400);
    });

    it('should require auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/recoveries/${testAttemptId}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('5. Read-Only Safety', () => {
    it('should not modify any state when querying metrics summary', async () => {
      const paymentsBefore = await dbClient.db.selectFrom('payments').selectAll().execute();
      const attemptsBefore = await dbClient.db.selectFrom('recovery_attempts').selectAll().execute();
      const jobsBefore = await dbClient.db.selectFrom('recovery_jobs').selectAll().execute();

      await app.inject({
        method: 'GET',
        url: '/api/v1/metrics/summary',
        headers: { 'x-merchant-key': apiKey },
      });

      const paymentsAfter = await dbClient.db.selectFrom('payments').selectAll().execute();
      const attemptsAfter = await dbClient.db.selectFrom('recovery_attempts').selectAll().execute();
      const jobsAfter = await dbClient.db.selectFrom('recovery_jobs').selectAll().execute();

      expect(paymentsAfter.length).toBe(paymentsBefore.length);
      expect(attemptsAfter.length).toBe(attemptsBefore.length);
      expect(jobsAfter.length).toBe(jobsBefore.length);
    });

    it('should not modify any state when querying recovery list', async () => {
      const auditBefore = await dbClient.db.selectFrom('audit_log').selectAll().execute();

      await app.inject({
        method: 'GET',
        url: '/api/v1/recoveries',
        headers: { 'x-merchant-key': apiKey },
      });

      const auditAfter = await dbClient.db.selectFrom('audit_log').selectAll().execute();
      expect(auditAfter.length).toBe(auditBefore.length);
    });
  });

  describe('6. Health Endpoint (Existing — Regression)', () => {
    it('should still respond on /health without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(response.statusCode).toBe(200);
    });
  });
});
