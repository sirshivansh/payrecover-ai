import {
  AIDecisionType,
  type AIRecommendation,
  DEFAULT_MERCHANT_CONFIG,
  type MerchantConfig,
  type PolicyContext,
  PolicyDecisionType,
  RecoveryActionType,
} from '@payrecover/shared';
import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../policy/engine.js';

describe('Phase 6 — Deterministic PolicyEngine (§11, v2.1.1 §11)', () => {
  const engine = new PolicyEngine();
  const evaluationDate = new Date('2025-01-15T12:00:00Z');

  const validRecommendation: AIRecommendation = {
    decision: AIDecisionType.RECOVER_NOW,
    confidence: 0.85,
    reasoning: 'High intent customer, transient failure',
    recommended_action: RecoveryActionType.CREATE_PAYMENT_LINK,
  };

  const validContext: PolicyContext = {
    attemptNumber: 1,
    lastAttemptAt: null,
    hasEmail: true,
    hasPhone: false,
    isBusinessHours: true,
    paymentAmountPaise: 250000n, // ₹2,500 in paise
  };

  describe('A. Pure Determinism & Idempotent Evaluation', () => {
    it('should produce identical result for identical inputs without reading system clock', () => {
      const result1 = engine.evaluate(validRecommendation, validContext, DEFAULT_MERCHANT_CONFIG, evaluationDate);

      const result2 = engine.evaluate(validRecommendation, validContext, DEFAULT_MERCHANT_CONFIG, evaluationDate);

      expect(result1.decision).toBe(PolicyDecisionType.APPROVED);
      expect(result1.reason).toBe('All checks passed');
      expect(result1.approvedAction).toBe(RecoveryActionType.CREATE_PAYMENT_LINK);
      expect(result1.evaluatedAt).toEqual(evaluationDate);
      expect(result1).toEqual(result2);
    });
  });

  describe('B. POL-001: Allowed Actions Rule', () => {
    it('should approve when action is in allowedActions', () => {
      const result = engine.evaluate(validRecommendation, validContext, DEFAULT_MERCHANT_CONFIG, evaluationDate);

      const pol001 = result.ruleResults.find((r) => r.ruleId === 'POL-001');
      expect(pol001?.passed).toBe(true);
      expect(result.decision).toBe(PolicyDecisionType.APPROVED);
    });

    it('should reject when action is not in allowedActions', () => {
      const restrictedSnapshot: MerchantConfig = {
        ...DEFAULT_MERCHANT_CONFIG,
        allowedActions: [RecoveryActionType.STOP_RECOVERY],
      };

      const result = engine.evaluate(validRecommendation, validContext, restrictedSnapshot, evaluationDate);

      const pol001 = result.ruleResults.find((r) => r.ruleId === 'POL-001');
      expect(pol001?.passed).toBe(false);
      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.reason).toContain('Action create_payment_link not allowed');
    });
  });

  describe('C. POL-002: Amount Bounds Rule (BigInt Integer Paise Safety)', () => {
    it('should pass at exact min bound (₹100 = 10,000 paise)', () => {
      const context: PolicyContext = { ...validContext, paymentAmountPaise: 10000n };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol002 = result.ruleResults.find((r) => r.ruleId === 'POL-002');
      expect(pol002?.passed).toBe(true);
      expect(result.decision).toBe(PolicyDecisionType.APPROVED);
    });

    it('should reject just below min bound (9,999 paise)', () => {
      const context: PolicyContext = { ...validContext, paymentAmountPaise: 9999n };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol002 = result.ruleResults.find((r) => r.ruleId === 'POL-002');
      expect(pol002?.passed).toBe(false);
      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.reason).toContain('below min 10000');
    });

    it('should pass at exact max bound (₹1,00,000 = 10,000,000 paise)', () => {
      const context: PolicyContext = { ...validContext, paymentAmountPaise: 10000000n };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol002 = result.ruleResults.find((r) => r.ruleId === 'POL-002');
      expect(pol002?.passed).toBe(true);
      expect(result.decision).toBe(PolicyDecisionType.APPROVED);
    });

    it('should reject just above max bound (10,000,001 paise)', () => {
      const context: PolicyContext = { ...validContext, paymentAmountPaise: 10000001n };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol002 = result.ruleResults.find((r) => r.ruleId === 'POL-002');
      expect(pol002?.passed).toBe(false);
      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.reason).toContain('exceeds max 10000000');
    });
  });

  describe('D. POL-003: Max Attempts Rule', () => {
    it('should pass when attemptNumber <= maxAttempts (3)', () => {
      const context: PolicyContext = { ...validContext, attemptNumber: 3 };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol003 = result.ruleResults.find((r) => r.ruleId === 'POL-003');
      expect(pol003?.passed).toBe(true);
      expect(result.decision).toBe(PolicyDecisionType.APPROVED);
    });

    it('should reject when attemptNumber > maxAttempts (attempt 4)', () => {
      const context: PolicyContext = { ...validContext, attemptNumber: 4 };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol003 = result.ruleResults.find((r) => r.ruleId === 'POL-003');
      expect(pol003?.passed).toBe(false);
      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.reason).toContain('Attempt 4 exceeds max 3');
    });
  });

  describe('E. POL-004: Cooldown Period Rule', () => {
    it('should pass on first attempt when lastAttemptAt is null', () => {
      const context: PolicyContext = { ...validContext, lastAttemptAt: null };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol004 = result.ruleResults.find((r) => r.ruleId === 'POL-004');
      expect(pol004?.passed).toBe(true);
    });

    it('should pass when cooldown >= 24h (24.1 hours elapsed)', () => {
      const lastAttempt = new Date(evaluationDate.getTime() - 24.1 * 60 * 60 * 1000);
      const context: PolicyContext = { ...validContext, lastAttemptAt: lastAttempt };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol004 = result.ruleResults.find((r) => r.ruleId === 'POL-004');
      expect(pol004?.passed).toBe(true);
      expect(result.decision).toBe(PolicyDecisionType.APPROVED);
    });

    it('should reject when cooldown < 24h (23.9 hours elapsed)', () => {
      const lastAttempt = new Date(evaluationDate.getTime() - 23.9 * 60 * 60 * 1000);
      const context: PolicyContext = { ...validContext, lastAttemptAt: lastAttempt };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol004 = result.ruleResults.find((r) => r.ruleId === 'POL-004');
      expect(pol004?.passed).toBe(false);
      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.reason).toContain('Cooldown not elapsed');
    });
  });

  describe('F. POL-005 & POL-006: Business Hours & Contact Availability', () => {
    it('should allow CREATE_PAYMENT_LINK outside business hours (§11.2, §11.3)', () => {
      const context: PolicyContext = { ...validContext, isBusinessHours: false };
      const result = engine.evaluate(validRecommendation, context, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol005 = result.ruleResults.find((r) => r.ruleId === 'POL-005');
      expect(pol005?.passed).toBe(true);
      expect(result.decision).toBe(PolicyDecisionType.APPROVED);
    });

    it('should pass POL-006 when email or phone is present', () => {
      const emailOnly: PolicyContext = { ...validContext, hasEmail: true, hasPhone: false };
      expect(engine.evaluate(validRecommendation, emailOnly, DEFAULT_MERCHANT_CONFIG, evaluationDate).decision).toBe(
        PolicyDecisionType.APPROVED,
      );

      const phoneOnly: PolicyContext = { ...validContext, hasEmail: false, hasPhone: true };
      expect(engine.evaluate(validRecommendation, phoneOnly, DEFAULT_MERCHANT_CONFIG, evaluationDate).decision).toBe(
        PolicyDecisionType.APPROVED,
      );
    });

    it('should reject POL-006 when neither email nor phone is available for payment link creation', () => {
      const noContact: PolicyContext = { ...validContext, hasEmail: false, hasPhone: false };
      const result = engine.evaluate(validRecommendation, noContact, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol006 = result.ruleResults.find((r) => r.ruleId === 'POL-006');
      expect(pol006?.passed).toBe(false);
      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.reason).toContain('No customer contact available for notification');
    });
  });

  describe('G. POL-007: Confidence Threshold Rule', () => {
    it('should pass when confidence >= threshold (0.60 >= 0.60)', () => {
      const rec: AIRecommendation = { ...validRecommendation, confidence: 0.6 };
      const result = engine.evaluate(rec, validContext, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol007 = result.ruleResults.find((r) => r.ruleId === 'POL-007');
      expect(pol007?.passed).toBe(true);
    });

    it('should reject when confidence < threshold (0.59 < 0.60) for RECOVER_NOW', () => {
      const rec: AIRecommendation = { ...validRecommendation, confidence: 0.59 };
      const result = engine.evaluate(rec, validContext, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      const pol007 = result.ruleResults.find((r) => r.ruleId === 'POL-007');
      expect(pol007?.passed).toBe(false);
      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.reason).toContain('Confidence 0.59 below threshold 0.6');
    });

    it('should allow low confidence (< 0.60) when decision is STOP or ESCALATE (§11.2)', () => {
      const stopRec: AIRecommendation = {
        decision: AIDecisionType.STOP,
        confidence: 0.3,
        reasoning: 'Low probability of recovery',
        recommended_action: RecoveryActionType.STOP_RECOVERY,
      };

      const result = engine.evaluate(stopRec, validContext, DEFAULT_MERCHANT_CONFIG, evaluationDate);
      expect(result.decision).toBe(PolicyDecisionType.APPROVED);
      expect(result.approvedAction).toBe(RecoveryActionType.STOP_RECOVERY);
    });
  });

  describe('H. Rule Ordering & Multiple Rule Violations', () => {
    it('should evaluate all 7 rules in exact sequential order POL-001 to POL-007', () => {
      const multiFailureRec: AIRecommendation = {
        decision: AIDecisionType.RECOVER_NOW,
        confidence: 0.3, // POL-007 fails
        reasoning: 'Invalid recommendation',
        recommended_action: RecoveryActionType.CREATE_PAYMENT_LINK,
      };

      const lastAttempt = new Date(evaluationDate.getTime() - 10 * 60 * 60 * 1000); // 10h < 24h (POL-004 fails)

      const multiFailureContext: PolicyContext = {
        attemptNumber: 5, // > 3 (POL-003 fails)
        lastAttemptAt: lastAttempt,
        hasEmail: false,
        hasPhone: false, // POL-006 fails
        isBusinessHours: true,
        paymentAmountPaise: 5000n, // < 10000 (POL-002 fails)
      };

      const result = engine.evaluate(multiFailureRec, multiFailureContext, DEFAULT_MERCHANT_CONFIG, evaluationDate);

      expect(result.decision).toBe(PolicyDecisionType.REJECTED);
      expect(result.ruleResults.map((r) => r.ruleId)).toEqual([
        'POL-001',
        'POL-002',
        'POL-003',
        'POL-004',
        'POL-005',
        'POL-006',
        'POL-007',
      ]);

      expect(result.reason).toContain('Amount 5000 below min 10000');
      expect(result.reason).toContain('Attempt 5 exceeds max 3');
      expect(result.reason).toContain('Cooldown not elapsed');
      expect(result.reason).toContain('No customer contact available');
      expect(result.reason).toContain('Confidence 0.3 below threshold 0.6');
    });
  });
});
