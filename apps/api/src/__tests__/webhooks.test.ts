import crypto from 'node:crypto';
import { PaymentStatus, RecoveryStatus, hmacPII } from '@payrecover/shared';
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

  it('should process valid payment_link.paid webhook, link existing recovery attempt & transition to SUCCEEDED', async () => {
    const origRzpId = `pay_orig_${Date.now()}`;
    const plinkId = `plink_test_${Date.now()}`;
    const newRzpId = `pay_link_paid_${Date.now()}`;
    const eventId = `evt_plink_paid_${Date.now()}`;

    // 1. Create original failed payment & recovery attempt in verifying status
    const origPayment = await dbClient.db
      .insertInto('payments')
      .values({
        razorpay_payment_id: origRzpId,
        amount_paise: '350000',
        currency: 'INR',
        status: PaymentStatus.FAILED,
        attempts: 1,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const attempt = await dbClient.db
      .insertInto('recovery_attempts')
      .values({
        payment_id: origPayment.id,
        attempt_number: 1,
        status: RecoveryStatus.VERIFYING,
        revenue_at_risk_paise: '350000',
        policy_snapshot: { maxAttempts: 3 },
        ai_decision: 'recover_now',
        action_type: 'create_payment_link',
        action_result: { paymentLinkId: plinkId, paymentLinkUrl: `https://rzp.io/i/${plinkId}` },
        started_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 2. Build payment_link.paid webhook payload
    const payloadObj = {
      id: eventId,
      entity: 'event',
      event: 'payment_link.paid',
      account_id: 'acc_test_123',
      contains: ['payment', 'payment_link'],
      payload: {
        payment: {
          entity: {
            id: newRzpId,
            entity: 'payment',
            amount: 350000,
            currency: 'INR',
            status: 'captured',
            created_at: Math.floor(Date.now() / 1000),
          },
        },
        payment_link: {
          entity: {
            id: plinkId,
            entity: 'payment_link',
            amount: 350000,
            currency: 'INR',
            status: 'paid',
            notes: { payment_id: origPayment.id },
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const { rawBody, signature } = createSignedPayload(payloadObj);

    // 3. Send webhook request
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

    // 4. Verify PostgreSQL state update
    const updatedPayment = await dbClient.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', origPayment.id)
      .executeTakeFirstOrThrow();

    expect(updatedPayment.status).toBe(PaymentStatus.PAID);
    expect(updatedPayment.paid_at).toBeDefined();

    const updatedAttempt = await dbClient.db
      .selectFrom('recovery_attempts')
      .selectAll()
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow();

    expect(updatedAttempt.status).toBe(RecoveryStatus.SUCCEEDED);

    // Verify no new recovery attempts were created
    const attemptsCount = await dbClient.db
      .selectFrom('recovery_attempts')
      .select(dbClient.db.fn.count('id').as('count'))
      .where('payment_id', '=', origPayment.id)
      .executeTakeFirstOrThrow();

    expect(Number(attemptsCount.count)).toBe(1);

    // Cleanup
    await dbClient.db.deleteFrom('audit_log').where('payment_id', '=', origPayment.id).execute();
    await dbClient.db.deleteFrom('webhook_events').where('event_id', '=', eventId).execute();
    await dbClient.db.deleteFrom('recovery_attempts').where('id', '=', attempt.id).execute();
    await dbClient.db.deleteFrom('payments').where('id', '=', origPayment.id).execute();
  });
});
