import {
  type AIDecisionType,
  RecoveryActionType as DomainRecoveryActionType,
  type PolicyDecisionType,
  type RecoveryActionType,
} from './enums.js';

/**
 * Merchant Policy Configuration Snapshot (§11.1)
 */
export interface MerchantConfig {
  maxAttempts: number;
  cooldownHours: number;
  allowedActions: RecoveryActionType[];
  minAmountPaise: bigint;
  maxAmountPaise: bigint;
  businessHoursStart: number; // 0-23
  businessHoursEnd: number; // 0-23
  timezone: string;
  confidenceThreshold: number; // 0.0 - 1.0
}

/**
 * Default Merchant Policy Configuration (§11.1)
 */
export const DEFAULT_MERCHANT_CONFIG: MerchantConfig = {
  maxAttempts: 3,
  cooldownHours: 24,
  allowedActions: [DomainRecoveryActionType.CREATE_PAYMENT_LINK, DomainRecoveryActionType.STOP_RECOVERY],
  minAmountPaise: 10000n, // ₹100 in paise
  maxAmountPaise: 10000000n, // ₹1,00,000 in paise
  businessHoursStart: 9,
  businessHoursEnd: 21,
  timezone: 'Asia/Kolkata',
  confidenceThreshold: 0.6,
};

export const DEFAULT_MERCHANT_CONFIG_JSON = {
  maxAttempts: 3,
  cooldownHours: 24,
  allowedActions: [DomainRecoveryActionType.CREATE_PAYMENT_LINK, DomainRecoveryActionType.STOP_RECOVERY],
  minAmountPaise: 10000,
  maxAmountPaise: 10000000,
  businessHoursStart: 9,
  businessHoursEnd: 21,
  timezone: 'Asia/Kolkata',
  confidenceThreshold: 0.6,
};

/**
 * AI Recommendation Input for Policy Engine (§10.1, v2.1.1 §10.1)
 */
export interface AIRecommendation {
  decision: AIDecisionType;
  confidence: number;
  reasoning: string;
  recommended_action: RecoveryActionType;
}

/**
 * Input Context for Policy Engine (§11.3)
 */
export interface PolicyContext {
  attemptNumber: number;
  lastAttemptAt: Date | null;
  hasEmail: boolean;
  hasPhone: boolean;
  isBusinessHours: boolean;
  paymentAmountPaise: bigint | number | string;
}

/**
 * Individual Policy Rule Result (§11.2)
 */
export interface PolicyRuleResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  reason?: string;
}

/**
 * Policy Engine Evaluation Output Result (§11.3)
 */
export interface PolicyEvaluationResult {
  decision: PolicyDecisionType;
  reason: string;
  approvedAction?: RecoveryActionType;
  ruleResults: PolicyRuleResult[];
  evaluatedAt: Date;
}
