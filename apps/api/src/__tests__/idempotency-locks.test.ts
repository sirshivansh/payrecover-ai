import { type Database, PaymentStatus, RecoveryActionType, RecoveryStatus } from '@payrecover/shared';
import type Redis from 'ioredis';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { IdempotencyService } from '../services/idempotency.service.js';
import { getRedisClient } from '../services/redis.service.js';

describe('Phase 5 — Redis Idempotency, Locks & Dual-Layer Infrastructure', () => {
  const env = loadEnv();
  const { db, close: closeDb } = createDatabaseClient(env);
  let redis: Redis;
  let idempotency: IdempotencyService;

  beforeAll(async () => {
    redis = getRedisClient(env);
    await redis.ping();
    idempotency = new IdempotencyService(redis, db);
  });

  afterAll(async () => {
    await redis.quit();
    await closeDb();
  });

  describe('1. Webhook Fast-Path & Dual-Layer Deduplication (§13.1, §13.2, §13.3)', () => {
    it('should return NEW on first webhook check and DUPLICATE on second via Redis fast-path', async () => {
      const eventId = `evt_wh_test_${Date.now()}`;

      const firstResult = await idempotency.checkAndSetWebhookIdempotency(eventId);
      expect(firstResult).toBe('NEW');

      const secondResult = await idempotency.checkAndSetWebhookIdempotency(eventId);
      expect(secondResult).toBe('DUPLICATE');

      // Verify Redis key format and TTL
      const ttl = await redis.ttl(`idem:wh:${eventId}`);
      expect(ttl).toBeGreaterThan(600000); // 7 days = 604800s
      expect(ttl).toBeLessThanOrEqual(604800);
    });

    it('should fall back to PostgreSQL check if Redis is unavailable', async () => {
      const eventId = `evt_wh_fallback_${Date.now()}`;

      // Insert event into DB manually
      await db
        .insertInto('webhook_events')
        .values({
          event_id: eventId,
          event_type: 'payment.failed',
          razorpay_payment_id: 'pay_123',
          processed: true,
        })
        .execute();

      // Create IdempotencyService with null Redis client (simulating Redis outage)
      const fallbackService = new IdempotencyService(null, db);

      const result = await fallbackService.checkAndSetWebhookIdempotency(eventId);
      expect(result).toBe('DUPLICATE');

      // Clean up DB
      await db.deleteFrom('webhook_events').where('event_id', '=', eventId).execute();
    });

    it('should return FAIL_CLOSED if both Redis and PostgreSQL fail for webhooks', async () => {
      // Mock DB that throws error
      const brokenDb = {
        selectFrom: () => {
          throw new Error('Database connection crashed');
        },
      } as unknown as Kysely<Database>;

      const failClosedService = new IdempotencyService(null, brokenDb);
      const result = await failClosedService.checkAndSetWebhookIdempotency(`evt_fail_${Date.now()}`);

      expect(result).toBe('FAIL_CLOSED');
    });
  });

  describe('2. Action Execution Dual-Layer Idempotency (§13.1, §13.2, §13.3)', () => {
    it('should return NEW on first action check and DUPLICATE on second via Redis fast-path', async () => {
      const attemptId = `att_act_${Date.now()}`;
      const actionType = 'SEND_DISCOUNT_SMS';

      const firstResult = await idempotency.checkAndSetActionIdempotency(attemptId, actionType);
      expect(firstResult).toBe('NEW');

      const secondResult = await idempotency.checkAndSetActionIdempotency(attemptId, actionType);
      expect(secondResult).toBe('DUPLICATE');

      // Verify Redis key format and TTL
      const ttl = await redis.ttl(`idem:action:${attemptId}:${actionType}`);
      expect(ttl).toBeGreaterThan(80000); // 24h = 86400s
      expect(ttl).toBeLessThanOrEqual(86400);
    });

    it('should fall back to PostgreSQL check when Redis is unavailable', async () => {
      const razorpayId = `pay_act_fb_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '100000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const attempt = await db
        .insertInto('recovery_attempts')
        .values({
          payment_id: payment.id,
          attempt_number: 1,
          status: RecoveryStatus.EXECUTING,
          revenue_at_risk_paise: '100000',
          policy_snapshot: {},
          action_type: RecoveryActionType.SEND_PAYMENT_LINK,
          action_result: { success: true },
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const fallbackService = new IdempotencyService(null, db);
      const result = await fallbackService.checkAndSetActionIdempotency(
        attempt.id,
        RecoveryActionType.SEND_PAYMENT_LINK,
      );

      expect(result).toBe('DUPLICATE');

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });
  });

  describe('3. Distributed Recovery Concurrency Locks (§13.1, §13.2, §13.3)', () => {
    it('should acquire lock with unique owner token and reject concurrent acquisition', async () => {
      const paymentId = `pay_lock_test_${Date.now()}`;

      // 1. First lock acquisition succeeds
      const lock1 = await idempotency.acquireRecoveryLock(paymentId, 30);
      expect(lock1.acquired).toBe(true);
      expect(lock1.ownerToken).not.toBeNull();
      expect(lock1.isFallback).toBe(false);

      // 2. Second concurrent lock acquisition fails
      const lock2 = await idempotency.acquireRecoveryLock(paymentId, 30);
      expect(lock2.acquired).toBe(false);
      expect(lock2.ownerToken).toBeNull();

      // 3. Releasing lock with ownerToken succeeds
      const releaseResult = await idempotency.releaseRecoveryLock(paymentId, lock1.ownerToken);
      expect(releaseResult.released).toBe(true);

      // 4. Subsequent acquisition after release succeeds
      const lock3 = await idempotency.acquireRecoveryLock(paymentId, 30);
      expect(lock3.acquired).toBe(true);

      // Clean up
      await idempotency.releaseRecoveryLock(paymentId, lock3.ownerToken);
    });

    it('should prevent non-owner from releasing another process lock (Compare-and-Delete Lua)', async () => {
      const paymentId = `pay_lock_owner_${Date.now()}`;

      // Process A acquires lock
      const lockA = await idempotency.acquireRecoveryLock(paymentId, 30);
      expect(lockA.acquired).toBe(true);

      // Process B attempts to release Process A lock using arbitrary token
      const fakeToken = '00000000-0000-0000-0000-000000000000';
      const releaseB = await idempotency.releaseRecoveryLock(paymentId, fakeToken);

      expect(releaseB.released).toBe(false);
      expect(releaseB.reason).toBe('owner_mismatch_or_expired');

      // Verify lock is still held by Process A
      const lockC = await idempotency.acquireRecoveryLock(paymentId, 30);
      expect(lockC.acquired).toBe(false);

      // Process A releases lock successfully
      const releaseA = await idempotency.releaseRecoveryLock(paymentId, lockA.ownerToken);
      expect(releaseA.released).toBe(true);
    });

    it('should fail open to PostgreSQL SELECT FOR UPDATE when Redis is unavailable', async () => {
      const paymentId = `pay_lock_failopen_${Date.now()}`;
      const fallbackService = new IdempotencyService(null, db);

      const lockResult = await fallbackService.acquireRecoveryLock(paymentId, 30);

      expect(lockResult.acquired).toBe(true);
      expect(lockResult.ownerToken).toBeNull();
      expect(lockResult.isFallback).toBe(true);

      const releaseResult = await fallbackService.releaseRecoveryLock(paymentId, lockResult.ownerToken);
      expect(releaseResult.released).toBe(true);
      expect(releaseResult.reason).toBe('fallback_mode');
    });

    it('should automatically expire lock after TTL', async () => {
      const paymentId = `pay_lock_ttl_${Date.now()}`;

      // Acquire lock with short 1-second TTL
      const lock = await idempotency.acquireRecoveryLock(paymentId, 1);
      expect(lock.acquired).toBe(true);

      // Wait 1.1s for lock to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // New acquisition succeeds after expiration
      const lock2 = await idempotency.acquireRecoveryLock(paymentId, 30);
      expect(lock2.acquired).toBe(true);

      await idempotency.releaseRecoveryLock(paymentId, lock2.ownerToken);
    });
  });
});
