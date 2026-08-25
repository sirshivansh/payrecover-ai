import type { AIDecisionType, PaymentStatus, RecoveryStatus } from '@payrecover/shared';

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
  };
  actual: {
    attemptStatus?: RecoveryStatus;
    paymentStatus?: PaymentStatus;
    attemptCount?: number;
    error?: string;
  };
  details?: string;
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
