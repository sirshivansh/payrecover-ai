/**
 * PayRecover AI — AI Provider Abstraction (§10, v2.1.1 §10)
 *
 * Defines the AIProvider interface, typed context structures,
 * and error types for the AI advisory layer.
 *
 * AI is ADVISORY ONLY — it may recommend but never authorize.
 * The PolicyEngine remains deterministic and authoritative.
 */

import type { AIDecisionType, PolicyDecisionType, RecoveryActionType, RecoveryStatus } from '../domain/enums.js';
import type { AIRecommendation } from '../domain/policy.js';

// ─── Provider Interface ────────────────────────────────────────────

/**
 * AIProvider interface (§10.1)
 *
 * All AI providers (NemotronProvider, MockAIProvider) implement this.
 * The application depends on this interface, never on a concrete provider.
 */
export interface AIProvider {
  recommend(context: AgentContext): Promise<AIRecommendation>;
  readonly name: string;
}

// ─── AI Input Context ──────────────────────────────────────────────

/**
 * Complete sanitized context sent to the AI provider (§10.1, v2.1.1 §10.1)
 *
 * Contains ONLY sanitized, typed data. No raw PII.
 */
export interface AgentContext {
  payment: PaymentContext;
  policy: PolicySnapshot;
  attemptNumber: number;
  previousAttempts: PreviousAttempt[];
  customerHistory: CustomerHistory;
  allowedActions: RecoveryActionType[];
  isBusinessHours: boolean;
  currentTime: string;
}

/**
 * Payment context for AI reasoning (§10.1, v2.1.1 §10.1)
 *
 * amountPaise and currency are READ-ONLY context for AI reasoning.
 * AI MUST NOT determine, modify, return, or authorize financial amounts.
 */
export interface PaymentContext {
  razorpayPaymentId: string;
  amountPaise: number; // READ-ONLY context for AI reasoning
  currency: string; // READ-ONLY context
  method: string;
  failureCode: string | null;
  failureReason: string | null; // Sanitized, ≤200 chars
  hasEmail: boolean;
  hasPhone: boolean;
  hasCustomerName: boolean;
  createdAt: string;
}

/**
 * Summary of a previous recovery attempt (§10.1)
 */
export interface PreviousAttempt {
  attemptNumber: number;
  actionType: RecoveryActionType;
  aiDecision: AIDecisionType;
  policyDecision: PolicyDecisionType;
  outcome: RecoveryStatus;
  errorMessage: string | null;
}

/**
 * Aggregated customer history (§10.1)
 * Contains counts only — no PII.
 */
export interface CustomerHistory {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  recoveredPayments: number;
  avgTimeToRecoveryHours: number | null;
}

/**
 * Frozen policy snapshot for AI context (§10.1)
 */
export interface PolicySnapshot {
  maxAttempts: number;
  cooldownHours: number;
  allowedActions: RecoveryActionType[];
  minAmountPaise: number;
  maxAmountPaise: number;
  businessHoursStart: number;
  businessHoursEnd: number;
  timezone: string;
  confidenceThreshold: number;
  snapshotAt: string;
}

// ─── AI Output ─────────────────────────────────────────────────────
// AIRecommendation is defined in domain/policy.ts and re-exported above.

// ─── Error Types ───────────────────────────────────────────────────

export type AIProviderErrorCode =
  | 'AUTH_FAILURE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'API_ERROR'
  | 'SCHEMA_VALIDATION'
  | 'PARSE_ERROR';

/**
 * Typed AI provider error.
 * Never exposes secrets or API keys in the error message.
 */
export class AIProviderError extends Error {
  public readonly code: AIProviderErrorCode;
  public override readonly cause?: unknown;

  constructor(code: AIProviderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.cause = cause;
  }
}
