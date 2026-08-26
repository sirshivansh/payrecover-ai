import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('notifications')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('recovery_attempt_id', 'uuid', (col) => col.references('recovery_attempts.id').onDelete('set null'))
    .addColumn('payment_id', 'uuid', (col) => col.references('payments.id').onDelete('set null'))
    .addColumn('channel', 'varchar(32)', (col) => col.notNull())
    .addColumn('event_type', 'varchar(64)', (col) => col.notNull())
    .addColumn('recipient', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('idempotency_key', 'varchar(128)', (col) => col.notNull().unique())
    .addColumn('payload', 'jsonb')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (col) => col.notNull().defaultTo(3))
    .addColumn('error_message', 'text')
    .addColumn('trace_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('sent_at', 'timestamptz')
    .execute();

  await db.schema.createIndex('idx_notifications_idempotency').on('notifications').column('idempotency_key').execute();
  await db.schema.createIndex('idx_notifications_recovery').on('notifications').column('recovery_attempt_id').execute();
  await db.schema.createIndex('idx_notifications_payment').on('notifications').column('payment_id').execute();
  await db.schema.createIndex('idx_notifications_trace').on('notifications').column('trace_id').execute();
  await db.schema.createIndex('idx_notifications_status').on('notifications').column('status').execute();
  await db.schema.createIndex('idx_notifications_created').on('notifications').column('created_at').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('notifications').ifExists().execute();
}
