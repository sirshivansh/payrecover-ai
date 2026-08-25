import crypto from 'node:crypto';
import type {
  ActionIdempotencyResult,
  Database,
  LockAcquisitionResult,
  LockReleaseResult,
  WebhookIdempotencyResult,
} from '@payrecover/shared';
import type Redis from 'ioredis';
import type { Kysely } from 'kysely';
import { isRedisHealthy } from './redis.service.js';

/**
 * Lua Script for Atomic Lock Release (Compare-and-Delete) (§13.2, §13.3)
 * Guarantees a process can only release a lock if it still holds the matching ownerToken.
 */
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`;

export class IdempotencyService {
  constructor(
    private redis: Redis | null,
    private db: Kysely<Database>,
  ) {}

  /**
   * Dual-layer idempotency check for incoming webhooks (§13.1, §13.2, §13.3).
   *
   * Fast-Path (Redis): SETNX `idem:wh:{eventId}` EX 604800 (7 days).
   * Fallback (PostgreSQL): Query `webhook_events` table if Redis is down.
   * Fail Closed: Returns 'FAIL_CLOSED' if both Redis and DB are unavailable.
   */
  async checkAndSetWebhookIdempotency(eventId: string): Promise<WebhookIdempotencyResult> {
    const key = `idem:wh:${eventId}`;
    const ttlSeconds = 604800; // 7 days per spec §13.2

    // 1. Try Redis Fast-Path if Redis client is ready
    if (isRedisHealthy(this.redis)) {
      try {
        const setRes = await this.redis?.set(key, '1', 'EX', ttlSeconds, 'NX');
        if (setRes === 'OK') {
          return 'NEW';
        }
        return 'DUPLICATE';
      } catch (err) {
        console.warn('[IdempotencyService] Redis error during webhook check, falling back to DB:', err);
      }
    }

    // 2. Fallback to PostgreSQL durable check
    try {
      const existing = await this.db
        .selectFrom('webhook_events')
        .select('event_id')
        .where('event_id', '=', eventId)
        .executeTakeFirst();

      if (existing) {
        return 'DUPLICATE';
      }
      return 'NEW';
    } catch (err) {
      console.error('[IdempotencyService] PostgreSQL fallback check failed for webhook:', err);
      return 'FAIL_CLOSED';
    }
  }

  /**
   * Dual-layer idempotency check for Action execution (§13.1, §13.2, §13.3).
   *
   * Fast-Path (Redis): SETNX `idem:action:{attemptId}:{actionType}` EX 86400 (24 hours).
   * Fallback (PostgreSQL): Check `action_result` column on `recovery_attempts` table.
   * Fail Closed: Returns 'FAIL_CLOSED' if both Redis and DB are unavailable.
   */
  async checkAndSetActionIdempotency(attemptId: string, actionType: string): Promise<ActionIdempotencyResult> {
    const key = `idem:action:${attemptId}:${actionType}`;
    const ttlSeconds = 86400; // 24 hours per spec §13.2

    // 1. Try Redis Fast-Path
    if (isRedisHealthy(this.redis)) {
      try {
        const setRes = await this.redis?.set(key, '1', 'EX', ttlSeconds, 'NX');
        if (setRes === 'OK') {
          return 'NEW';
        }
        return 'DUPLICATE';
      } catch (err) {
        console.warn('[IdempotencyService] Redis error during action check, falling back to DB:', err);
      }
    }

    // 2. Fallback to PostgreSQL durable check
    try {
      const attempt = await this.db
        .selectFrom('recovery_attempts')
        .select(['id', 'action_result', 'action_type'])
        .where('id', '=', attemptId)
        .executeTakeFirst();

      if (attempt && (attempt.action_result !== null || attempt.action_type === actionType)) {
        return 'DUPLICATE';
      }
      return 'NEW';
    } catch (err) {
      console.error('[IdempotencyService] PostgreSQL fallback check failed for action:', err);
      return 'FAIL_CLOSED';
    }
  }

  /**
   * Acquire a distributed recovery lock with unique owner token (§13.1, §13.2, §13.3).
   *
   * Fast-Path (Redis): SET `lock:recovery:{paymentId}` {ownerToken} EX 30 NX.
   * Redis Failure (Fail Open): Returns `{ acquired: true, ownerToken: null, isFallback: true }`.
   * Downstream callers rely on PostgreSQL `SELECT FOR UPDATE` transaction row locking.
   */
  async acquireRecoveryLock(paymentId: string, ttlSeconds = 30): Promise<LockAcquisitionResult> {
    const key = `lock:recovery:${paymentId}`;
    const ownerToken = crypto.randomUUID();

    if (isRedisHealthy(this.redis)) {
      try {
        const setRes = await this.redis?.set(key, ownerToken, 'EX', ttlSeconds, 'NX');
        if (setRes === 'OK') {
          return { acquired: true, ownerToken, isFallback: false };
        }
        return { acquired: false, ownerToken: null, isFallback: false };
      } catch (err) {
        console.warn('[IdempotencyService] Redis lock acquisition error, failing open to DB:', err);
      }
    }

    // Fail Open to PostgreSQL SELECT FOR UPDATE
    return { acquired: true, ownerToken: null, isFallback: true };
  }

  /**
   * Release a distributed recovery lock safely using atomic Lua script (§13.2, §13.3).
   * Verifies lock ownership before deletion to prevent Process A from deleting Process B's lock.
   */
  async releaseRecoveryLock(paymentId: string, ownerToken: string | null): Promise<LockReleaseResult> {
    if (!ownerToken) {
      // Fallback mode lock release is handled by PostgreSQL transaction completion
      return { released: true, reason: 'fallback_mode' };
    }

    const key = `lock:recovery:${paymentId}`;

    if (isRedisHealthy(this.redis)) {
      try {
        const res = await this.redis?.eval(RELEASE_LOCK_LUA, 1, key, ownerToken);
        if (res === 1) {
          return { released: true };
        }
        return { released: false, reason: 'owner_mismatch_or_expired' };
      } catch (err) {
        console.warn('[IdempotencyService] Redis lock release error:', err);
        return { released: false, reason: 'redis_error' };
      }
    }

    return { released: false, reason: 'redis_unavailable' };
  }
}
