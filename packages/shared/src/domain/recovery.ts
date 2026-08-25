import {
  type AIDecisionType,
  type PaymentStatus as DomainPaymentStatus,
  PaymentStatus,
  type PolicyDecisionType,
  type RecoveryActionType,
  RecoveryStatus,
} from './enums.js';

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly currentStatus: string,
    public readonly targetStatus: string,
    message?: string,
  ) {
    super(message ?? `Invalid recovery state transition from '${currentStatus}' to '${targetStatus}'`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class RecoveryAttemptNotFoundError extends Error {
  constructor(public readonly attemptId: string) {
    super(`Recovery attempt with ID '${attemptId}' was not found`);
    this.name = 'RecoveryAttemptNotFoundError';
  }
}

export class ConcurrentRecoveryError extends Error {
  constructor(message = 'Concurrent recovery attempt creation detected') {
    super(message);
    this.name = 'ConcurrentRecoveryError';
  }
}

export interface CreateAttemptParams {
  paymentId: string;
  revenueAtRiskPaise?: bigint | string | number;
  policySnapshot?: Record<string, unknown>;
  traceId?: string;
}

export interface TransitionAttemptParams {
  attemptId: string;
  targetStatus: RecoveryStatus;
  aiRecommendation?: Record<string, unknown>;
  aiDecision?: AIDecisionType;
  aiConfidence?: number;
  aiReasoning?: string;
  policyDecision?: PolicyDecisionType;
  policyReason?: string;
  policyModifications?: Record<string, unknown>;
  actionType?: RecoveryActionType;
  actionPayload?: Record<string, unknown>;
  actionResult?: Record<string, unknown>;
  nextRetryAt?: Date;
  errorMessage?: string;
  traceId?: string;
}

/**
 * Determine if a RecoveryStatus is a terminal sink state (§6, §6.1)
 * Terminal states (SUCCEEDED, STOPPED, ESCALATED) accept no further transitions.
 */
export function isTerminalRecoveryStatus(status: RecoveryStatus): boolean {
  return (
    status === RecoveryStatus.SUCCEEDED || status === RecoveryStatus.STOPPED || status === RecoveryStatus.ESCALATED
  );
}

/**
 * Determine if a PaymentStatus is terminal (§5)
 */
export function isTerminalPaymentStatus(status: DomainPaymentStatus): boolean {
  return status === PaymentStatus.PAID || status === PaymentStatus.REFUNDED || status === PaymentStatus.CANCELLED;
}
