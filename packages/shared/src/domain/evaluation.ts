import type { AIDecisionType, PaymentStatus, PolicyDecisionType, RecoveryStatus } from './enums.js';

export type EvaluationOutcome = 'succeeded' | 'failed' | 'stopped' | 'escalated' | 'action_outcome_unknown';

export interface EvaluationInput {
  paymentStatus: PaymentStatus | string;
  recoveryAttemptStatus: RecoveryStatus | string;
  amountPaise: bigint;
  currency: string;
  attemptNumber: number;
  maxAttempts: number;
  actionResult?: {
    paymentLinkId?: string;
    paymentLinkUrl?: string;
    success?: boolean;
    outcomeUnknown?: boolean;
  } | null;
  policyDecision?: PolicyDecisionType | string | null;
  aiDecision?: AIDecisionType | string | null;
  errorMessage?: string | null;
}

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  isRecovered: boolean;
  isTerminal: boolean;
  targetRecoveryStatus: RecoveryStatus;
  reason: string;
  financialMatch: boolean;
  requiresReconciliation: boolean;
  evaluatedAt: string;
}
