import Redis from 'ioredis';
import type { AppEnv } from '../config/env.js';

let redisInstance: Redis | null = null;

export function getRedisClient(env: AppEnv): Redis {
  if (!redisInstance) {
    const redisUrl = env.REDIS_URL || 'redis://localhost:6379';
    redisInstance = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) {
          return null; // Stop retrying after 3 attempts
        }
        return Math.min(times * 100, 1000);
      },
    });

    redisInstance.on('error', (err) => {
      console.warn('[Redis] Connection error:', err.message);
    });
  }

  return redisInstance;
}

export function isRedisHealthy(redis: Redis | null): boolean {
  return redis !== null && redis.status === 'ready';
}

export async function closeRedisClient(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit().catch(() => redisInstance?.disconnect());
    redisInstance = null;
  }
}
