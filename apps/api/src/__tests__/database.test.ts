import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';

describe('Database Connection & Query Compilation', () => {
  const env = loadEnv();

  it('should initialize database client and pool', () => {
    const { db, pool, close } = createDatabaseClient(env);
    expect(db).toBeDefined();
    expect(pool).toBeDefined();
    expect(close).toBeTypeOf('function');
    close();
  });

  it('should compile parameterized SELECT query for payments table', () => {
    const { db, close } = createDatabaseClient(env);
    const query = db.selectFrom('payments').selectAll().where('razorpay_payment_id', '=', 'pay_123456').compile();

    expect(query.sql).toContain('select');
    expect(query.sql).toContain('"payments"');
    expect(query.sql).toContain('"razorpay_payment_id" = $1');
    expect(query.parameters).toEqual(['pay_123456']);
    close();
  });

  it('should compile parameterized INSERT query for recovery_attempts table', () => {
    const { db, close } = createDatabaseClient(env);
    const query = db
      .insertInto('recovery_attempts')
      .values({
        payment_id: '123e4567-e89b-12d3-a456-426614174000',
        attempt_number: 1,
        status: 'pending',
        revenue_at_risk_paise: '250000',
        policy_snapshot: { maxAttempts: 3 },
      })
      .compile();

    expect(query.sql).toContain('insert into "recovery_attempts"');
    expect(query.parameters).toContain('250000');
    close();
  });

  it('should compile parameterized query for recovery_jobs table', () => {
    const { db, close } = createDatabaseClient(env);
    const query = db
      .selectFrom('recovery_jobs')
      .selectAll()
      .where('status', '=', 'pending')
      .where('run_at', '<=', new Date().toISOString())
      .compile();

    expect(query.sql).toContain('select');
    expect(query.sql).toContain('"recovery_jobs"');
    close();
  });
});
