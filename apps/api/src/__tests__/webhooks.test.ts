import crypto from 'node:crypto';
import { PaymentStatus, hmacPII } from '@payrecover/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { closeRedisClient } from '../services/redis.service.js';

describe('Phase 2 — Webhook Ingestion & Idempotency', () => {
  const env = loadEnv();
  const dbClient = createDatabaseClient(env);
  const webhookSecret = 'test_webhook_secret_key_123';
  const piiSecret = 'test_pii_secret_key_123';

  // Override env secrets for deterministic testing
  const testEnv = {
    ...env,
    RAZORPAY_WEBHOOK_SECRET: webhookSecret,
    PII_HMAC_SECRET: piiSecret,
  };

  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ env: testEnv, dbClient });
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
    await closeRedisClient();
  });

  function createSignedPayload(eventObj: Record<string, unknown>, secret = webhookSecret) {
    const rawBody = JSON.stringify(eventObj);
    const signature = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    return { rawBody, signature };
  }

  it('should reject webhook with invalid signature returning 401', async () => {
    const payloadObj = {
      id: 'event_invalid_sig_123',
      entity: 'event',
      event: 'payment.failed',
      account_id: 'acc_test_123',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: 'pay_invalid_sig_123',
            entity: 'payment',
            amount: 50000,
            currency: 'INR',
            status: 'failed',
            method: 'card',
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const { rawBody } = createSignedPayload(payloadObj, 'wrong_secret');

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'wrong_invalid_signature_hex',
      },
      body: rawBody,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.message).toContain('Invalid webhook signature');
  });

  it('should reject invalid payload format returning 400', async () => {
    const invalidObj = {
      id: 'event_bad_format',
      entity: 'invalid_entity',
    };

    const { rawBody, signature } = createSignedPayload(invalidObj);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
      },
      body: rawBody,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.message).toContain('Invalid webhook payload format');
  });

  it('should ingest valid payment.failed webhook, hash PII, store payment & audit trail', async () => {
    const eventId = `evt_test_${Date.now()}_1`;
    const paymentId = `pay_test_${Date.now()}_1`;
    const testEmail = 'customer@example.com';
    const testPhone = '+919876543210';

    const payloadObj = {
      id: eventId,
      entity: 'event',
      event: 'payment.failed',
      account_id: 'acc_test_123',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            entity: 'payment',
            amount: 250000, // ₹2,500.00
            currency: 'INR',
            status: 'failed',
            method: 'card',
            email: testEmail,
            contact: testPhone,
            error_code: 'BAD_REQUEST_PAYMENT_DECLINED',
            error_description: 'Card issuing bank declined transaction',
            created_at: Math.floor(Date.now() / 1000),
            attempts: 1,
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const { rawBody, signature } = createSignedPayload(payloadObj);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
      },
      body: rawBody,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('processed');
    expect(body.eventId).toBe(eventId);
    expect(body.razorpayPaymentId).toBe(paymentId);

    // Verify payment record in PostgreSQL
    const dbPayment = await dbClient.db
      .selectFrom('payments')
      .selectAll()
      .where('razorpay_payment_id', '=', paymentId)
      .executeTakeFirstOrThrow();

    expect(String(dbPayment.amount_paise)).toBe('250000');
    expect(dbPayment.status).toBe(PaymentStatus.FAILED);
    expect(dbPayment.failure_code).toBe('BAD_REQUEST_PAYMENT_DECLINED');

    // Verify PII hashes (no raw email or phone in DB)
    expect(dbPayment.email_hash).toBe(hmacPII(piiSecret, testEmail));
    expect(dbPayment.phone_hash).toBe(hmacPII(piiSecret, testPhone));

    // Verify webhook event log in DB
    const dbEvent = await dbClient.db
      .selectFrom('webhook_events')
      .selectAll()
      .where('event_id', '=', eventId)
      .executeTakeFirst();

    expect(dbEvent).toBeDefined();
    expect(dbEvent?.processed).toBe(true);

    // Verify Audit Log entry in DB (no raw PII)
    const dbAudit = await dbClient.db
      .selectFrom('audit_log')
      .selectAll()
      .where('payment_id', '=', dbPayment.id)
      .executeTakeFirst();

    expect(dbAudit).toBeDefined();
    expect(dbAudit?.actor).toBe('webhook');
    expect(dbAudit?.action).toBe('webhook_received');
    expect(dbAudit?.input).toMatchObject({
      event_id: eventId,
      email_hash: hmacPII(piiSecret, testEmail),
    });

    // Clean up DB test records
    await dbClient.db.deleteFrom('audit_log').where('payment_id', '=', dbPayment.id).execute();
    await dbClient.db.deleteFrom('webhook_events').where('event_id', '=', eventId).execute();
    await dbClient.db.deleteFrom('payments').where('id', '=', dbPayment.id).execute();
  });

  it('should detect duplicate webhooks via Redis/DB idempotency and return 200 duplicate', async () => {
    const eventId = `evt_dup_${Date.now()}_2`;
    const paymentId = `pay_dup_${Date.now()}_2`;

    const payloadObj = {
      id: eventId,
      entity: 'event',
      event: 'payment.failed',
      account_id: 'acc_test_123',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            entity: 'payment',
            amount: 100000,
            currency: 'INR',
            status: 'failed',
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const { rawBody, signature } = createSignedPayload(payloadObj);

    // 1st request -> Processed
    const res1 = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
      },
      body: rawBody,
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.json().status).toBe('processed');

    // 2nd request (duplicate) -> Detected as duplicate
    const res2 = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
      },
      body: rawBody,
    });

    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.status).toBe('duplicate');
    expect(body2.message).toContain('already processed');

    // Clean up
    await dbClient.db.deleteFrom('webhook_events').where('event_id', '=', eventId).execute();
    await dbClient.db.deleteFrom('payments').where('razorpay_payment_id', '=', paymentId).execute();
  });
});
