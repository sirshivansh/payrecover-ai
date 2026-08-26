import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'], override: true });
import type { Database } from '@payrecover/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrateToLatest, rollbackMigration } from './migrator.js';

async function main() {
  const command = process.argv[2] || 'latest';
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/payrecover';

  const pool = new pg.Pool({ connectionString });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  try {
    if (command === 'rollback') {
      console.log('Rolling back database migration...');
      await rollbackMigration(db);
    } else {
      console.log('Migrating database to latest schema...');
      await migrateToLatest(db);
    }
    console.log('Database operation finished.');
  } catch (err) {
    console.error('Database migration error:', err);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

main();
