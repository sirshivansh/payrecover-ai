import type {
  AIDecisionType,
  AuditActor,
  PaymentStatus,
  PolicyDecisionType,
  RecoveryActionType,
  RecoveryStatus,
} from '@payrecover/shared';

/**
 * Metrics summary response (§8.1)
 */
export interface MetricsSummary {
  revenueAtRiskPaise: number;
  recoveredRevenuePaise: number;
  recoveryRatePct: number;
  attemptSuccessRatePct: number;
  totalAttempts: number;
  succeededAttempts: number;
  stoppedAttempts: number;
  escalatedAttempts: number;
  period: {
    from: string;
    to: string;
  };
}

/**
 * Summary item in recovery list response (§8.1)
 */
export interface RecoveryAttemptSummary {
  id: string;
  paymentId: string;
  attemptNumber: number;
  status: RecoveryStatus;
  revenueAtRiskPaise: number;
  aiDecision: AIDecisionType | null;
  aiConfidence: number | null;
  actionType: RecoveryActionType | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Pagination metadata (§8.1)
 */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Paginated list response (§8.1)
 */
export interface PaginatedRecoveryAttempts {
  data: RecoveryAttemptSummary[];
  pagination: PaginationMeta;
}

/**
 * Payment summary embedded in detail (§8.1)
 * PII Safe: boolean flags only, no raw email/phone/name
 */
export interface PaymentSummary {
  id: string;
  razorpayPaymentId: string;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  failureReason: string | null;
  method: string;
  hasEmail: boolean;
  hasPhone: boolean;
  createdAt: string;
  paidAt: string | null;
}

/**
 * Policy decision summary in detail (§8.1)
 */
export interface PolicyDecisionSummary {
  decision: PolicyDecisionType;
  reason: string | null;
}

/**
 * Audit log entry embedded in detail (§8.1)
 */
export interface AuditLogEntry {
  id: string;
  actor: AuditActor | string;
  action: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

/**
 * Recovery attempt detail response (§8.1)
 */
export interface RecoveryAttemptDetail {
  id: string;
  paymentId: string;
  attemptNumber: number;
  status: RecoveryStatus;
  revenueAtRiskPaise: number;
  aiDecision: AIDecisionType | null;
  aiConfidence: number | null;
  actionType: RecoveryActionType | null;
  createdAt: string;
  completedAt: string | null;
  payment: PaymentSummary | null;
  aiRecommendation: Record<string, unknown> | null;
  policyDecision: PolicyDecisionSummary | null;
  policyModifications: Record<string, unknown> | null;
  actionResult: Record<string, unknown> | null;
  paymentLinkUrl: string | null;
  auditLogs: AuditLogEntry[];
}
