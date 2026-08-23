/**
 * PayRecover AI — Shared Domain Enumerations
 * Aligned 1:1 with PostgreSQL enum definitions (see database/schema.sql)
 */

export enum PaymentStatus {
  CREATED = 'created',
  ATTEMPTED = 'attempted',
  PAID = 'paid',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled',
}

export enum RecoveryStatus {
  PENDING = 'pending',
  ANALYZING = 'analyzing',
  POLICY_CHECK = 'policy_check',
  EXECUTING = 'executing',
  ACTION_OUTCOME_UNKNOWN = 'action_outcome_unknown',
  VERIFYING = 'verifying',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  STOPPED = 'stopped',
  ESCALATED = 'escalated',
}

export enum RecoveryActionType {
  CREATE_PAYMENT_LINK = 'create_payment_link',
  STOP_RECOVERY = 'stop_recovery',
}

export enum AIDecisionType {
  RECOVER_NOW = 'recover_now',
  STOP = 'stop',
  ESCALATE = 'escalate',
}

export enum PolicyDecisionType {
  APPROVED = 'approved',
  REJECTED = 'rejected',
  APPROVED_WITH_MODIFICATIONS = 'approved_with_modifications',
}

export enum JobType {
  ANALYZE = 'analyze',
  EXECUTE = 'execute',
  VERIFY = 'verify',
  RECONCILE = 'reconcile',
}

export enum JobStatus {
  PENDING = 'pending',
  CLAIMED = 'claimed',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum AuditActor {
  WEBHOOK = 'webhook',
  AI = 'ai',
  POLICY = 'policy',
  EXECUTOR = 'executor',
  VERIFIER = 'verifier',
  SCHEDULER = 'scheduler',
  RECONCILER = 'reconciler',
}
