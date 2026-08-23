import type { Database } from '@payrecover/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { AppEnv } from '../config/env.js';

export interface DatabaseClient {
  db: Kysely<Database>;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDatabaseClient(env: AppEnv): DatabaseClient {
  const connectionString = env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/payrecover';

  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  });

  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
      await pool.end();
    },
  };
}
