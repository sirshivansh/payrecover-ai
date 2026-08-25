import type { Kysely } from 'kysely';

/**
 * Migration 002: Add UNIQUE constraint on (payment_id, attempt_number) in recovery_attempts (§13.2)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('idx_recovery_attempts_payment_attempt')
    .on('recovery_attempts')
    .columns(['payment_id', 'attempt_number'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_recovery_attempts_payment_attempt').ifExists().execute();
}
