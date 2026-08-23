import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create Enums
  await sql`CREATE TYPE payment_status AS ENUM ('created', 'attempted', 'paid', 'failed', 'refunded', 'cancelled')`.execute(
    db,
  );
  await sql`CREATE TYPE recovery_status AS ENUM ('pending', 'analyzing', 'policy_check', 'executing', 'action_outcome_unknown', 'verifying', 'succeeded', 'failed', 'stopped', 'escalated')`.execute(
    db,
  );
  await sql`CREATE TYPE recovery_action_type AS ENUM ('create_payment_link', 'stop_recovery')`.execute(db);
  await sql`CREATE TYPE ai_decision_type AS ENUM ('recover_now', 'stop', 'escalate')`.execute(db);
  await sql`CREATE TYPE policy_decision_type AS ENUM ('approved', 'rejected', 'approved_with_modifications')`.execute(
    db,
  );
  await sql`CREATE TYPE job_type AS ENUM ('analyze', 'execute', 'verify', 'reconcile')`.execute(db);
  await sql`CREATE TYPE job_status AS ENUM ('pending', 'claimed', 'completed', 'failed', 'cancelled')`.execute(db);
  await sql`CREATE TYPE audit_actor AS ENUM ('webhook', 'ai', 'policy', 'executor', 'verifier', 'scheduler', 'reconciler')`.execute(
    db,
  );

  // 2. Payments Table
  await db.schema
    .createTable('payments')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('razorpay_payment_id', 'varchar(64)', (col) => col.notNull().unique())
    .addColumn('razorpay_order_id', 'varchar(64)')
    .addColumn('razorpay_customer_id', 'varchar(64)')
    .addColumn('amount_paise', 'bigint', (col) => col.notNull())
    .addColumn('currency', 'varchar(3)', (col) => col.notNull().defaultTo('INR'))
    .addColumn('status', sql`payment_status`, (col) => col.notNull().defaultTo('created'))
    .addColumn('failure_reason', 'varchar(255)')
    .addColumn('failure_code', 'varchar(64)')
    .addColumn('method', 'varchar(32)')
    .addColumn('email_hash', 'varchar(64)')
    .addColumn('phone_hash', 'varchar(64)')
    .addColumn('customer_name_hash', 'varchar(64)')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('paid_at', 'timestamptz')
    .addColumn('metadata', 'jsonb', (col) => col.defaultTo('{}'))
    .execute();

  await db.schema.createIndex('idx_payments_razorpay_id').on('payments').column('razorpay_payment_id').execute();
  await db.schema.createIndex('idx_payments_status').on('payments').column('status').execute();
  await db.schema.createIndex('idx_payments_customer').on('payments').column('razorpay_customer_id').execute();
  await db.schema.createIndex('idx_payments_created_at').on('payments').column('created_at').execute();

  // 3. Recovery Attempts Table
  await db.schema
    .createTable('recovery_attempts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('payment_id', 'uuid', (col) => col.notNull().references('payments.id').onDelete('cascade'))
    .addColumn('attempt_number', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('status', sql`recovery_status`, (col) => col.notNull().defaultTo('pending'))
    .addColumn('revenue_at_risk_paise', 'bigint', (col) => col.notNull())
    .addColumn('ai_recommendation', 'jsonb')
    .addColumn('ai_decision', sql`ai_decision_type`)
    .addColumn('ai_confidence', sql`decimal(3,2)`)
    .addColumn('ai_reasoning', 'text')
    .addColumn('policy_decision', sql`policy_decision_type`)
    .addColumn('policy_reason', 'text')
    .addColumn('policy_modifications', 'jsonb')
    .addColumn('action_type', sql`recovery_action_type`)
    .addColumn('action_payload', 'jsonb')
    .addColumn('action_result', 'jsonb')
    .addColumn('idempotency_key', 'uuid', (col) => col.notNull().unique().defaultTo(sql`gen_random_uuid()`))
    .addColumn('policy_snapshot', 'jsonb', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('completed_at', 'timestamptz')
    .addColumn('next_retry_at', 'timestamptz')
    .addColumn('error_message', 'text')
    .execute();

  await db.schema.createIndex('idx_recovery_payment').on('recovery_attempts').column('payment_id').execute();
  await db.schema.createIndex('idx_recovery_status').on('recovery_attempts').column('status').execute();
  await db.schema.createIndex('idx_recovery_idempotency').on('recovery_attempts').column('idempotency_key').execute();
  await db.schema
    .createIndex('idx_recovery_payment_status')
    .on('recovery_attempts')
    .columns(['payment_id', 'status'])
    .execute();
  await sql`CREATE INDEX idx_recovery_next_retry ON recovery_attempts(next_retry_at) WHERE next_retry_at IS NOT NULL`.execute(
    db,
  );

  // 4. Webhook Events Table
  await db.schema
    .createTable('webhook_events')
    .addColumn('event_id', 'varchar(128)', (col) => col.primaryKey())
    .addColumn('event_type', 'varchar(64)', (col) => col.notNull())
    .addColumn('razorpay_payment_id', 'varchar(64)')
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('processed', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  await db.schema
    .createIndex('idx_webhook_events_payment')
    .on('webhook_events')
    .column('razorpay_payment_id')
    .execute();
  await db.schema.createIndex('idx_webhook_events_received').on('webhook_events').column('received_at').execute();

  // 5. Recovery Jobs Table
  await db.schema
    .createTable('recovery_jobs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('recovery_attempt_id', 'uuid', (col) =>
      col.notNull().references('recovery_attempts.id').onDelete('cascade'),
    )
    .addColumn('job_type', sql`job_type`, (col) => col.notNull())
    .addColumn('run_at', 'timestamptz', (col) => col.notNull())
    .addColumn('status', sql`job_status`, (col) => col.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (col) => col.notNull().defaultTo(3))
    .addColumn('locked_at', 'timestamptz')
    .addColumn('locked_by', 'varchar(128)')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('error_message', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await sql`CREATE INDEX idx_recovery_jobs_due ON recovery_jobs(run_at, status) WHERE status = 'pending'`.execute(db);
  await db.schema
    .createIndex('idx_recovery_jobs_attempt')
    .on('recovery_jobs')
    .columns(['recovery_attempt_id', 'job_type'])
    .execute();
  await sql`CREATE INDEX idx_recovery_jobs_locked ON recovery_jobs(locked_by) WHERE locked_by IS NOT NULL`.execute(db);

  // 6. Audit Log Table
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('recovery_attempt_id', 'uuid', (col) => col.references('recovery_attempts.id').onDelete('set null'))
    .addColumn('payment_id', 'uuid', (col) => col.references('payments.id').onDelete('set null'))
    .addColumn('actor', 'varchar(32)', (col) => col.notNull())
    .addColumn('action', 'varchar(64)', (col) => col.notNull())
    .addColumn('input', 'jsonb')
    .addColumn('output', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('trace_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema.createIndex('idx_audit_recovery').on('audit_log').column('recovery_attempt_id').execute();
  await db.schema.createIndex('idx_audit_payment').on('audit_log').column('payment_id').execute();
  await db.schema.createIndex('idx_audit_trace').on('audit_log').column('trace_id').execute();
  await db.schema.createIndex('idx_audit_created').on('audit_log').column('created_at').execute();

  // 7. Merchant Config Table
  await db.schema
    .createTable('merchant_config')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('config_json', 'jsonb', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await sql`INSERT INTO merchant_config (id, config_json) VALUES (gen_random_uuid(), '{}') ON CONFLICT DO NOTHING`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('merchant_config').ifExists().execute();
  await db.schema.dropTable('audit_log').ifExists().execute();
  await db.schema.dropTable('recovery_jobs').ifExists().execute();
  await db.schema.dropTable('webhook_events').ifExists().execute();
  await db.schema.dropTable('recovery_attempts').ifExists().execute();
  await db.schema.dropTable('payments').ifExists().execute();

  await sql`DROP TYPE IF EXISTS audit_actor`.execute(db);
  await sql`DROP TYPE IF EXISTS job_status`.execute(db);
  await sql`DROP TYPE IF EXISTS job_type`.execute(db);
  await sql`DROP TYPE IF EXISTS policy_decision_type`.execute(db);
  await sql`DROP TYPE IF EXISTS ai_decision_type`.execute(db);
  await sql`DROP TYPE IF EXISTS recovery_action_type`.execute(db);
  await sql`DROP TYPE IF EXISTS recovery_status`.execute(db);
  await sql`DROP TYPE IF EXISTS payment_status`.execute(db);
}
