import type {
  AIDecisionType,
  NotificationStatus,
  PaymentStatus,
  PolicyDecisionType,
  RecoveryActionType,
  RecoveryStatus,
} from '@payrecover/shared';

export interface SyntheticCaseResult {
  id: number;
  name: string;
  description: string;
  passed: boolean;
  expected: {
    attemptStatus: RecoveryStatus;
    paymentStatus?: PaymentStatus;
    attemptCount?: number;
    errorSubstr?: string;
    notificationStatus?: NotificationStatus;
    policyDecision?: PolicyDecisionType;
    aiDecision?: AIDecisionType;
    actionType?: RecoveryActionType;
  };
  actual: {
    attemptStatus?: RecoveryStatus;
    paymentStatus?: PaymentStatus;
    attemptCount?: number;
    error?: string;
    notificationStatus?: NotificationStatus;
    policyDecision?: PolicyDecisionType;
    aiDecision?: AIDecisionType;
    actionType?: RecoveryActionType;
    reconciliationOutcome?: string;
    metricsVerified?: boolean;
  };
  traceId?: string;
  details?: string;
  scenarioDiagnostics?: Record<string, unknown>;
}

export interface EvaluationReport {
  timestamp: string;
  totalCases: number;
  passedCount: number;
  failedCount: number;
  durationMs: number;
  verdict: 'PASS' | 'FAIL';
  results: SyntheticCaseResult[];
}
