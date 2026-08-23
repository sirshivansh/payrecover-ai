import type { Database } from '@payrecover/shared';
import type Redis from 'ioredis';
import type { Kysely } from 'kysely';

export type IdempotencyResult = 'NEW' | 'DUPLICATE' | 'FAIL_CLOSED';

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
   * Fail Closed: Returns 'FAIL_CLOSED' (HTTP 409) if both Redis and DB are unavailable.
   */
  async checkAndSetWebhookIdempotency(eventId: string): Promise<IdempotencyResult> {
    const key = `idem:wh:${eventId}`;
    const ttlSeconds = 604800; // 7 days per spec §13.2

    // 1. Try Redis Fast-Path if Redis client is connected
    if (this.redis && this.redis.status === 'ready') {
      try {
        const setRes = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
        if (setRes === 'OK') {
          return 'NEW';
        }
        return 'DUPLICATE';
      } catch (err) {
        console.warn('[IdempotencyService] Redis error, falling back to DB:', err);
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
      console.error('[IdempotencyService] PostgreSQL fallback check failed:', err);
      return 'FAIL_CLOSED';
    }
  }
}
