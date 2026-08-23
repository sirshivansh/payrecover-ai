import { PaymentStatus, RecoveryStatus } from '@payrecover/shared';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';

describe('Database Connection & Query Compilation', () => {
  const env = loadEnv();

  it('should initialize database client and pool', async () => {
    const { db, pool, close } = createDatabaseClient(env);
    expect(db).toBeDefined();
    expect(pool).toBeDefined();
    expect(close).toBeTypeOf('function');
    await close();
  });

  it('should compile parameterized SELECT query for payments table', async () => {
    const { db, close } = createDatabaseClient(env);
    const query = db.selectFrom('payments').selectAll().where('razorpay_payment_id', '=', 'pay_123456').compile();

    expect(query.sql).toContain('select');
    expect(query.sql).toContain('"payments"');
    expect(query.sql).toContain('"razorpay_payment_id" = $1');
    expect(query.parameters).toEqual(['pay_123456']);
    await close();
  });

  it('should compile parameterized INSERT query for recovery_attempts table', async () => {
    const { db, close } = createDatabaseClient(env);
    const query = db
      .insertInto('recovery_attempts')
      .values({
        payment_id: '123e4567-e89b-12d3-a456-426614174000',
        attempt_number: 1,
        status: RecoveryStatus.PENDING,
        revenue_at_risk_paise: '250000',
        policy_snapshot: { maxAttempts: 3 },
      })
      .compile();

    expect(query.sql).toContain('insert into "recovery_attempts"');
    expect(query.parameters).toContain('250000');
    await close();
  });
});

describe('Live PostgreSQL Integration Tests', () => {
  const env = loadEnv();

  it('should connect to live PostgreSQL database on host port 5433', async () => {
    const { db, close } = createDatabaseClient(env);
    const result = await db.selectFrom('payments').select(db.fn.count('id').as('count')).executeTakeFirst();
    expect(result).toBeDefined();
    expect(Number(result?.count)).toBeGreaterThanOrEqual(0);
    await close();
  });

  it('should insert, retrieve, and delete a payment record with BIGINT paise', async () => {
    const { db, close } = createDatabaseClient(env);
    const testPaymentId = `pay_test_${Date.now()}`;

    // Insert
    const inserted = await db
      .insertInto('payments')
      .values({
        razorpay_payment_id: testPaymentId,
        amount_paise: '150000', // ₹1,500.00
        currency: 'INR',
        status: PaymentStatus.FAILED,
        failure_reason: 'Card declined by issuing bank',
        failure_code: 'BAD_REQUEST_PAYMENT_DECLINED',
        attempts: 1,
      })
      .returning(['id', 'razorpay_payment_id', 'amount_paise', 'status'])
      .executeTakeFirstOrThrow();

    expect(inserted.id).toBeDefined();
    expect(inserted.razorpay_payment_id).toBe(testPaymentId);
    expect(String(inserted.amount_paise)).toBe('150000');
    expect(inserted.status).toBe(PaymentStatus.FAILED);

    // Retrieve
    const fetched = await db.selectFrom('payments').selectAll().where('id', '=', inserted.id).executeTakeFirstOrThrow();

    expect(fetched.razorpay_payment_id).toBe(testPaymentId);

    // Clean up
    await db.deleteFrom('payments').where('id', '=', inserted.id).execute();
    await close();
  });

  it('should enforce UNIQUE constraint on razorpay_payment_id', async () => {
    const { db, close } = createDatabaseClient(env);
    const testPaymentId = `pay_dup_${Date.now()}`;

    // First insert
    const first = await db
      .insertInto('payments')
      .values({
        razorpay_payment_id: testPaymentId,
        amount_paise: '50000',
        status: PaymentStatus.FAILED,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // Duplicate insert should fail with unique constraint error
    let duplicateError: Error | null = null;
    try {
      await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: testPaymentId,
          amount_paise: '50000',
          status: PaymentStatus.FAILED,
        })
        .execute();
    } catch (err) {
      duplicateError = err as Error;
    }

    expect(duplicateError).toBeDefined();
    expect(duplicateError?.message).toContain('duplicate key value violates unique constraint');

    // Clean up
    await db.deleteFrom('payments').where('id', '=', first.id).execute();
    await close();
  });

  it('should create recovery attempt linked via FK to payment and clean up via CASCADE', async () => {
    const { db, close } = createDatabaseClient(env);
    const testPaymentId = `pay_fk_${Date.now()}`;

    // Create payment
    const payment = await db
      .insertInto('payments')
      .values({
        razorpay_payment_id: testPaymentId,
        amount_paise: '300000',
        status: PaymentStatus.FAILED,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // Create recovery attempt
    const attempt = await db
      .insertInto('recovery_attempts')
      .values({
        payment_id: payment.id,
        attempt_number: 1,
        status: RecoveryStatus.PENDING,
        revenue_at_risk_paise: '300000',
        policy_snapshot: { maxAttempts: 3, cooldownHours: 24 },
      })
      .returning(['id', 'payment_id', 'status', 'revenue_at_risk_paise'])
      .executeTakeFirstOrThrow();

    expect(attempt.payment_id).toBe(payment.id);
    expect(attempt.status).toBe(RecoveryStatus.PENDING);
    expect(String(attempt.revenue_at_risk_paise)).toBe('300000');

    // Delete payment -> ON DELETE CASCADE should delete recovery attempt
    await db.deleteFrom('payments').where('id', '=', payment.id).execute();

    const orphanAttempt = await db
      .selectFrom('recovery_attempts')
      .selectAll()
      .where('id', '=', attempt.id)
      .executeTakeFirst();

    expect(orphanAttempt).toBeUndefined();
    await close();
  });
});
