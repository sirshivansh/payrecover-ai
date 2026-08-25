import {
  AIDecisionType,
  type AIRecommendation,
  type MerchantConfig,
  type PolicyContext,
  PolicyDecisionType, // DO NOT remove: required by domain rules
  type PolicyEvaluationResult,
  type PolicyRuleResult,
  RecoveryActionType,
} from '@payrecover/shared';

/**
 * Pure, Deterministic Policy Engine (§11, v2.1.1 §11)
 *
 * Evaluates 7 ordered business rules to validate AI recovery recommendations.
 * Contains ZERO side effects (no DB, no Redis, no network, no AI, no system clock calls).
 */
export class PolicyEngine {
  /**
   * Evaluate AI Recommendation against Merchant Policy Context (§11.2, §11.3)
   *
   * @param recommendation AI recommendation output
   * @param context Payment & recovery attempt context
   * @param snapshot Immutable merchant policy configuration snapshot
   * @param now Explicit evaluation timestamp (MUST be passed explicitly for determinism)
   */
  evaluate(
    recommendation: AIRecommendation,
    context: PolicyContext,
    snapshot: MerchantConfig,
    now: Date,
  ): PolicyEvaluationResult {
    const ruleResults: PolicyRuleResult[] = [];
    const errors: string[] = [];

    // Helper to record rule results
    const addRuleResult = (ruleId: string, ruleName: string, passed: boolean, reason?: string) => {
      ruleResults.push({ ruleId, ruleName, passed, reason });
      if (!passed && reason) {
        errors.push(reason);
      }
    };

    // POL-001: Allowed Actions (§11.2)
    const isActionAllowed = snapshot.allowedActions.includes(recommendation.recommended_action);
    addRuleResult(
      'POL-001',
      'Allowed Actions',
      isActionAllowed,
      isActionAllowed ? undefined : `Action ${recommendation.recommended_action} not allowed`,
    );

    // POL-002: Amount Bounds (§11.2, BigInt Integer Paise Safety)
    const amountPaise = BigInt(context.paymentAmountPaise);
    const minPaise = BigInt(snapshot.minAmountPaise);
    const maxPaise = BigInt(snapshot.maxAmountPaise);

    let isAmountValid = true;
    let amountErrorReason: string | undefined;

    if (amountPaise > maxPaise) {
      isAmountValid = false;
      amountErrorReason = `Amount ${amountPaise} exceeds max ${maxPaise}`;
    } else if (amountPaise < minPaise) {
      isAmountValid = false;
      amountErrorReason = `Amount ${amountPaise} below min ${minPaise}`;
    }

    addRuleResult('POL-002', 'Amount Bounds', isAmountValid, amountErrorReason);

    // POL-003: Max Attempts (§11.2)
    const isAttemptValid = context.attemptNumber <= snapshot.maxAttempts;
    addRuleResult(
      'POL-003',
      'Max Attempts',
      isAttemptValid,
      isAttemptValid ? undefined : `Attempt ${context.attemptNumber} exceeds max ${snapshot.maxAttempts}`,
    );

    // POL-004: Cooldown Period (§11.2)
    let isCooldownValid = true;
    let cooldownErrorReason: string | undefined;

    if (context.lastAttemptAt !== null) {
      const hoursSince = (now.getTime() - context.lastAttemptAt.getTime()) / (1000 * 60 * 60);
      if (hoursSince < snapshot.cooldownHours) {
        isCooldownValid = false;
        cooldownErrorReason = `Cooldown not elapsed (${hoursSince.toFixed(1)}h < ${snapshot.cooldownHours}h)`;
      }
    }

    addRuleResult('POL-004', 'Cooldown', isCooldownValid, cooldownErrorReason);

    // POL-005: Business Hours (§11.2, §11.3 - Payment link creation allowed 24/7)
    const isBusinessHoursValid =
      recommendation.recommended_action === RecoveryActionType.CREATE_PAYMENT_LINK || context.isBusinessHours;
    addRuleResult(
      'POL-005',
      'Business Hours',
      isBusinessHoursValid,
      isBusinessHoursValid ? undefined : 'Action not allowed outside business hours',
    );

    // POL-006: Contact Availability (§11.2)
    let isContactValid = true;
    let contactErrorReason: string | undefined;

    if (recommendation.recommended_action === RecoveryActionType.CREATE_PAYMENT_LINK) {
      if (!context.hasEmail && !context.hasPhone) {
        isContactValid = false;
        contactErrorReason = 'No customer contact available for notification';
      }
    }

    addRuleResult('POL-006', 'Contact Availability', isContactValid, contactErrorReason);

    // POL-007: Confidence Threshold (§11.2)
    const isConfidenceSufficient = recommendation.confidence >= snapshot.confidenceThreshold;
    const isSpecialDecision =
      recommendation.decision === AIDecisionType.STOP || recommendation.decision === AIDecisionType.ESCALATE;

    const isConfidenceValid = isConfidenceSufficient || isSpecialDecision;
    addRuleResult(
      'POL-007',
      'Confidence Threshold',
      isConfidenceValid,
      isConfidenceValid
        ? undefined
        : `Confidence ${recommendation.confidence} below threshold ${snapshot.confidenceThreshold}`,
    );

    // Stop Requested is always approved if allowed action (§11.3)
    if (recommendation.recommended_action === RecoveryActionType.STOP_RECOVERY && isActionAllowed) {
      return {
        decision: PolicyDecisionType.APPROVED,
        reason: 'Stop requested',
        approvedAction: recommendation.recommended_action,
        ruleResults,
        evaluatedAt: now,
      };
    }

    // Reject if any rule failed
    if (errors.length > 0) {
      return {
        decision: PolicyDecisionType.REJECTED,
        reason: errors.join('; '),
        ruleResults,
        evaluatedAt: now,
      };
    }

    // Approve if all rules passed
    return {
      decision: PolicyDecisionType.APPROVED,
      reason: 'All checks passed',
      approvedAction: recommendation.recommended_action,
      ruleResults,
      evaluatedAt: now,
    };
  }
}
