import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type {
  AIDecisionType,
  AuditActor,
  JobStatus,
  JobType,
  PaymentStatus,
  PolicyDecisionType,
  RecoveryActionType,
  RecoveryStatus,
} from '../domain/enums.js';

/**
 * Monetary columns use BIGINT in PostgreSQL (paise).
 * Kysely column typing allows selecting as string|bigint, inserting as string|bigint, updating as string|bigint.
 */
export type BigIntColumn = ColumnType<string, string | bigint | number, string | bigint | number>;

/**
 * Payments Table Interface
 */
export interface PaymentsTable {
  id: Generated<string>;
  razorpay_payment_id: string;
  razorpay_order_id: string | null;
  razorpay_customer_id: string | null;
  amount_paise: BigIntColumn;
  currency: ColumnType<string, string | undefined, string>;
  status: ColumnType<PaymentStatus, PaymentStatus | undefined, PaymentStatus>;
  failure_reason: string | null;
  failure_code: string | null;
  method: string | null;
  email_hash: string | null;
  phone_hash: string | null;
  customer_name_hash: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  paid_at: Date | string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
}

export type PaymentRow = Selectable<PaymentsTable>;
export type NewPayment = Insertable<PaymentsTable>;
export type PaymentUpdate = Updateable<PaymentsTable>;

/**
 * Recovery Attempts Table Interface
 */
export interface RecoveryAttemptsTable {
  id: Generated<string>;
  payment_id: string;
  attempt_number: ColumnType<number, number | undefined, number>;
  status: ColumnType<RecoveryStatus, RecoveryStatus | undefined, RecoveryStatus>;
  revenue_at_risk_paise: BigIntColumn;
  ai_recommendation: Record<string, unknown> | null;
  ai_decision: AIDecisionType | null;
  ai_confidence: number | string | null;
  ai_reasoning: string | null;
  policy_decision: PolicyDecisionType | null;
  policy_reason: string | null;
  policy_modifications: Record<string, unknown> | null;
  action_type: RecoveryActionType | null;
  action_payload: Record<string, unknown> | null;
  action_result: Record<string, unknown> | null;
  idempotency_key: Generated<string>;
  policy_snapshot: Record<string, unknown>;
  started_at: ColumnType<Date, Date | string | undefined, Date | string>;
  completed_at: Date | string | null;
  next_retry_at: Date | string | null;
  error_message: string | null;
}

export type RecoveryAttemptRow = Selectable<RecoveryAttemptsTable>;
export type NewRecoveryAttempt = Insertable<RecoveryAttemptsTable>;
export type RecoveryAttemptUpdate = Updateable<RecoveryAttemptsTable>;

/**
 * Webhook Events Table Interface
 */
export interface WebhookEventsTable {
  event_id: string;
  event_type: string;
  razorpay_payment_id: string | null;
  received_at: ColumnType<Date, Date | string | undefined, Date | string>;
  processed: ColumnType<boolean, boolean | undefined, boolean>;
}

export type WebhookEventRow = Selectable<WebhookEventsTable>;
export type NewWebhookEvent = Insertable<WebhookEventsTable>;
export type WebhookEventUpdate = Updateable<WebhookEventsTable>;

/**
 * Recovery Jobs Table Interface
 */
export interface RecoveryJobsTable {
  id: Generated<string>;
  recovery_attempt_id: string;
  job_type: JobType;
  run_at: Date | string;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  max_attempts: ColumnType<number, number | undefined, number>;
  locked_at: Date | string | null;
  locked_by: string | null;
  completed_at: Date | string | null;
  error_message: string | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type RecoveryJobRow = Selectable<RecoveryJobsTable>;
export type NewRecoveryJob = Insertable<RecoveryJobsTable>;
export type RecoveryJobUpdate = Updateable<RecoveryJobsTable>;

/**
 * Audit Log Table Interface
 */
export interface AuditLogTable {
  id: Generated<string>;
  recovery_attempt_id: string | null;
  payment_id: string | null;
  actor: AuditActor | string;
  action: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  trace_id: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type AuditLogRow = Selectable<AuditLogTable>;
export type NewAuditLog = Insertable<AuditLogTable>;
export type AuditLogUpdate = Updateable<AuditLogTable>;

/**
 * Merchant Config Table Interface (Single-row MVP)
 */
export interface MerchantConfigTable {
  id: Generated<string>;
  config_json: Record<string, unknown>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type MerchantConfigRow = Selectable<MerchantConfigTable>;
export type NewMerchantConfig = Insertable<MerchantConfigTable>;
export type MerchantConfigUpdate = Updateable<MerchantConfigTable>;

/**
 * Notifications Table Interface (Phase 14)
 */
export interface NotificationsTable {
  id: Generated<string>;
  recovery_attempt_id: string | null;
  payment_id: string | null;
  channel: string;
  event_type: string;
  recipient: string;
  status: string;
  idempotency_key: string;
  payload: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
  attempts: ColumnType<number, number | undefined, number>;
  max_attempts: ColumnType<number, number | undefined, number>;
  error_message: string | null;
  trace_id: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  sent_at: Date | string | null;
}

export type NotificationRow = Selectable<NotificationsTable>;
export type NewNotification = Insertable<NotificationsTable>;
export type NotificationUpdate = Updateable<NotificationsTable>;

/**
 * Root Kysely Database Interface
 */
export interface Database {
  payments: PaymentsTable;
  recovery_attempts: RecoveryAttemptsTable;
  webhook_events: WebhookEventsTable;
  recovery_jobs: RecoveryJobsTable;
  audit_log: AuditLogTable;
  merchant_config: MerchantConfigTable;
  notifications: NotificationsTable;
}
