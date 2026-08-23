import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@payrecover/shared';
import { FileMigrationProvider, type Kysely, Migrator } from 'kysely';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createMigrator(db: Kysely<Database>): Migrator {
  const migrationsFolder = path.join(__dirname, 'migrations');

  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: migrationsFolder,
    }),
  });
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`Migration "${it.migrationName}" executed successfully.`);
    } else if (it.status === 'Error') {
      console.error(`Failed to execute migration "${it.migrationName}".`);
    }
  });

  if (error) {
    console.error('Failed to run migrations to latest:', error);
    throw error;
  }
}

export async function rollbackMigration(db: Kysely<Database>): Promise<void> {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateDown();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`Rollback "${it.migrationName}" executed successfully.`);
    } else if (it.status === 'Error') {
      console.error(`Failed to rollback migration "${it.migrationName}".`);
    }
  });

  if (error) {
    console.error('Failed to rollback migration:', error);
    throw error;
  }
}
