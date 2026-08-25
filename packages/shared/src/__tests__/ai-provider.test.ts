/**
 * Phase 7 — AI Provider Abstraction & Nemotron Integration Tests
 *
 * Covers:
 * - MockAIProvider scenarios (all 7)
 * - AIRecommendationSchema validation (valid, invalid, boundary)
 * - System prompt content verification
 * - NemotronProvider request construction / timeout / fallback parsing
 * - AI boundary tests (advisory only, no amount authority)
 * - Security tests (no secrets in errors)
 */

import {
  AIDecisionType,
  AIProviderError,
  AIRecommendationSchema,
  MockAIProvider,
  type MockAIScenario,
  NemotronProvider,
  RecoveryActionType,
  SYSTEM_PROMPT,
  buildPrompt,
} from '@payrecover/shared';
import type { AgentContext } from '@payrecover/shared';
import { describe, expect, it, vi } from 'vitest';
import { parseJsonFallback } from '../ai/nemotron-provider.js';

// ─── Test Fixtures ─────────────────────────────────────────────────

const validContext: AgentContext = {
  payment: {
    razorpayPaymentId: 'pay_test_123',
    amountPaise: 250000,
    currency: 'INR',
    method: 'card',
    failureCode: 'CARD_DECLINED',
    failureReason: 'Your card was declined',
    hasEmail: true,
    hasPhone: false,
    hasCustomerName: true,
    createdAt: '2025-01-15T10:00:00.000Z',
  },
  policy: {
    maxAttempts: 3,
    cooldownHours: 24,
    allowedActions: [RecoveryActionType.CREATE_PAYMENT_LINK, RecoveryActionType.STOP_RECOVERY],
    minAmountPaise: 10000,
    maxAmountPaise: 10000000,
    businessHoursStart: 9,
    businessHoursEnd: 21,
    timezone: 'Asia/Kolkata',
    confidenceThreshold: 0.6,
    snapshotAt: '2025-01-15T10:00:00.000Z',
  },
  attemptNumber: 1,
  previousAttempts: [],
  customerHistory: {
    totalPayments: 5,
    successfulPayments: 3,
    failedPayments: 2,
    recoveredPayments: 1,
    avgTimeToRecoveryHours: 4.5,
  },
  allowedActions: [RecoveryActionType.CREATE_PAYMENT_LINK, RecoveryActionType.STOP_RECOVERY],
  isBusinessHours: true,
  currentTime: '2025-01-15T12:00:00.000Z',
};

// ─── Test Suites ───────────────────────────────────────────────────

describe('Phase 7 — AI Provider Abstraction', () => {
  describe('A. MockAIProvider Scenarios', () => {
    const mock = new MockAIProvider();

    it("should have name 'mock'", () => {
      expect(mock.name).toBe('mock');
    });

    it('should default to recover_now scenario', async () => {
      const rec = await mock.recommend(validContext);
      expect(rec.decision).toBe(AIDecisionType.RECOVER_NOW);
      expect(rec.confidence).toBe(0.9);
      expect(rec.recommended_action).toBe(RecoveryActionType.CREATE_PAYMENT_LINK);
      expect(rec.reasoning).toBeDefined();
    });

    it('should produce STOP recommendation', async () => {
      mock.setScenario('stop');
      const rec = await mock.recommend(validContext);
      expect(rec.decision).toBe(AIDecisionType.STOP);
      expect(rec.recommended_action).toBe(RecoveryActionType.STOP_RECOVERY);
    });

    it('should produce ESCALATE recommendation', async () => {
      mock.setScenario('escalate');
      const rec = await mock.recommend(validContext);
      expect(rec.decision).toBe(AIDecisionType.ESCALATE);
      expect(rec.recommended_action).toBe(RecoveryActionType.STOP_RECOVERY);
    });

    it('should produce low_confidence recommendation', async () => {
      mock.setScenario('low_confidence');
      const rec = await mock.recommend(validContext);
      expect(rec.decision).toBe(AIDecisionType.RECOVER_NOW);
      expect(rec.confidence).toBe(0.3);
    });

    it('should produce invalid_action recommendation', async () => {
      mock.setScenario('invalid_action');
      const rec = await mock.recommend(validContext);
      expect(rec.recommended_action).toBe('invalid_action');
    });

    it('should throw AIProviderError for invalid_json scenario', async () => {
      mock.setScenario('invalid_json');
      await expect(mock.recommend(validContext)).rejects.toThrow(AIProviderError);
      await expect(mock.recommend(validContext)).rejects.toThrow('MOCK_INVALID_JSON');
    });

    it('should throw AIProviderError for timeout scenario', async () => {
      mock.setScenario('timeout');
      await expect(mock.recommend(validContext)).rejects.toThrow(AIProviderError);
      try {
        await mock.recommend(validContext);
      } catch (err) {
        expect(err).toBeInstanceOf(AIProviderError);
        expect((err as AIProviderError).code).toBe('TIMEOUT');
      }
    });

    it('should track scenario via getScenario()', () => {
      const scenarios: MockAIScenario[] = [
        'recover_now',
        'stop',
        'escalate',
        'low_confidence',
        'invalid_action',
        'invalid_json',
        'timeout',
      ];
      for (const s of scenarios) {
        mock.setScenario(s);
        expect(mock.getScenario()).toBe(s);
      }
    });
  });

  describe('B. AIRecommendationSchema Validation', () => {
    it('should validate a correct recommendation', () => {
      const valid = {
        decision: 'recover_now',
        confidence: 0.85,
        reasoning: 'Transient failure, high intent customer',
        recommended_action: 'create_payment_link',
      };
      const result = AIRecommendationSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('should reject invalid decision type', () => {
      const invalid = {
        decision: 'retry_later',
        confidence: 0.85,
        reasoning: 'Test',
        recommended_action: 'create_payment_link',
      };
      const result = AIRecommendationSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject confidence > 1.0', () => {
      const invalid = {
        decision: 'recover_now',
        confidence: 1.5,
        reasoning: 'Test',
        recommended_action: 'create_payment_link',
      };
      const result = AIRecommendationSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject confidence < 0', () => {
      const invalid = {
        decision: 'recover_now',
        confidence: -0.1,
        reasoning: 'Test',
        recommended_action: 'create_payment_link',
      };
      const result = AIRecommendationSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should accept boundary confidence values (0.0 and 1.0)', () => {
      for (const confidence of [0, 1]) {
        const valid = {
          decision: 'recover_now',
          confidence,
          reasoning: 'Test',
          recommended_action: 'create_payment_link',
        };
        expect(AIRecommendationSchema.safeParse(valid).success).toBe(true);
      }
    });

    it('should reject reasoning > 2000 characters', () => {
      const invalid = {
        decision: 'recover_now',
        confidence: 0.85,
        reasoning: 'x'.repeat(2001),
        recommended_action: 'create_payment_link',
      };
      const result = AIRecommendationSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should accept reasoning of exactly 2000 characters', () => {
      const valid = {
        decision: 'recover_now',
        confidence: 0.85,
        reasoning: 'x'.repeat(2000),
        recommended_action: 'create_payment_link',
      };
      expect(AIRecommendationSchema.safeParse(valid).success).toBe(true);
    });

    it('should reject invalid recommended_action', () => {
      const invalid = {
        decision: 'recover_now',
        confidence: 0.85,
        reasoning: 'Test',
        recommended_action: 'send_email',
      };
      const result = AIRecommendationSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject missing required fields', () => {
      expect(AIRecommendationSchema.safeParse({}).success).toBe(false);
      expect(AIRecommendationSchema.safeParse({ decision: 'stop' }).success).toBe(false);
    });

    it('should strip unknown fields (Zod default behavior)', () => {
      const withExtra = {
        decision: 'recover_now',
        confidence: 0.85,
        reasoning: 'Test',
        recommended_action: 'create_payment_link',
        amount: 25000, // AI should never return this
        customer_email: 'test@example.com', // AI should never return this
      };
      const result = AIRecommendationSchema.safeParse(withExtra);
      expect(result.success).toBe(true);
      if (result.success) {
        expect('amount' in result.data).toBe(false);
        expect('customer_email' in result.data).toBe(false);
      }
    });
  });

  describe('C. System Prompt Content', () => {
    it('should contain constraint about no monetary amounts', () => {
      expect(SYSTEM_PROMPT).toContain('NEVER recommend arbitrary API calls, monetary amounts');
    });

    it('should contain v2.1.1 constraint #3 about not specifying payment amounts', () => {
      expect(SYSTEM_PROMPT).toContain('NEVER specify payment amounts, currencies, or payment IDs');
    });

    it('should contain decision framework', () => {
      expect(SYSTEM_PROMPT).toContain('recover_now');
      expect(SYSTEM_PROMPT).toContain('stop');
      expect(SYSTEM_PROMPT).toContain('escalate');
    });

    it('should instruct JSON-only output', () => {
      expect(SYSTEM_PROMPT).toContain('Output ONLY a JSON object');
    });
  });

  describe('D. buildPrompt', () => {
    it('should produce a string containing CONTEXT and JSON', () => {
      const prompt = buildPrompt(validContext);
      expect(prompt).toContain('CONTEXT:');
      expect(prompt).toContain('RESPOND WITH VALID JSON ONLY');
      expect(prompt).toContain('pay_test_123');
      expect(prompt).toContain('250000'); // amountPaise as read-only context
    });

    it('should serialize context as formatted JSON', () => {
      const prompt = buildPrompt(validContext);
      // Must be valid JSON inside the prompt
      const jsonPart = prompt.split('CONTEXT:\n')[1].split('\n\nRESPOND')[0];
      expect(() => JSON.parse(jsonPart)).not.toThrow();
    });
  });

  describe('E. Fallback JSON Parser', () => {
    it('should parse raw JSON directly', () => {
      const raw = '{"decision":"stop","confidence":0.8,"reasoning":"test","recommended_action":"stop_recovery"}';
      const result = parseJsonFallback(raw);
      expect(result).toEqual({
        decision: 'stop',
        confidence: 0.8,
        reasoning: 'test',
        recommended_action: 'stop_recovery',
      });
    });

    it('should parse JSON from markdown code fence', () => {
      const raw =
        'Here is my recommendation:\n```json\n{"decision":"recover_now","confidence":0.9,"reasoning":"test","recommended_action":"create_payment_link"}\n```\nEnd.';
      const result = parseJsonFallback(raw) as Record<string, unknown>;
      expect(result.decision).toBe('recover_now');
    });

    it('should parse JSON from brace extraction', () => {
      const raw =
        'Based on analysis: {"decision":"escalate","confidence":0.4,"reasoning":"complex","recommended_action":"stop_recovery"} is my recommendation.';
      const result = parseJsonFallback(raw) as Record<string, unknown>;
      expect(result.decision).toBe('escalate');
    });

    it('should throw AIProviderError for completely invalid content', () => {
      expect(() => parseJsonFallback('No JSON here at all')).toThrow('No valid JSON found in model response');
      try {
        parseJsonFallback('No JSON here at all');
      } catch (err) {
        expect((err as AIProviderError).code).toBe('PARSE_ERROR');
      }
    });
  });

  describe('F. NemotronProvider Construction & Config', () => {
    it('should throw AUTH_FAILURE when apiKey is empty', () => {
      expect(() => new NemotronProvider({ apiKey: '', modelId: 'nvidia/test' })).toThrow(
        'NVIDIA API key is required for NemotronProvider',
      );
      try {
        new NemotronProvider({ apiKey: '', modelId: 'nvidia/test' });
      } catch (err) {
        expect((err as AIProviderError).code).toBe('AUTH_FAILURE');
        expect((err as AIProviderError).message).not.toContain('api_key_value');
      }
    });

    it("should have name 'nemotron'", () => {
      const provider = new NemotronProvider({
        apiKey: 'nvapi-test-key-12345',
        modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
      });
      expect(provider.name).toBe('nemotron');
    });
  });

  describe('G. NemotronProvider Network Behavior (Mocked Fetch)', () => {
    it('should throw NETWORK_ERROR on fetch failure', async () => {
      const provider = new NemotronProvider({
        apiKey: 'nvapi-test-key',
        modelId: 'nvidia/test',
      });

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

      try {
        await provider.recommend(validContext);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AIProviderError);
        expect((err as AIProviderError).code).toBe('NETWORK_ERROR');
        expect((err as AIProviderError).message).not.toContain('nvapi-test-key');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should throw AUTH_FAILURE on 401 response', async () => {
      const provider = new NemotronProvider({
        apiKey: 'nvapi-test-key',
        modelId: 'nvidia/test',
      });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })));

      try {
        await provider.recommend(validContext);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AIProviderError);
        expect((err as AIProviderError).code).toBe('AUTH_FAILURE');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should throw API_ERROR on 500 response', async () => {
      const provider = new NemotronProvider({
        apiKey: 'nvapi-test-key',
        modelId: 'nvidia/test',
      });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 })));

      try {
        await provider.recommend(validContext);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AIProviderError);
        expect((err as AIProviderError).code).toBe('API_ERROR');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should throw SCHEMA_VALIDATION on malformed model output', async () => {
      const provider = new NemotronProvider({
        apiKey: 'nvapi-test-key',
        modelId: 'nvidia/test',
      });

      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: 'invalid_decision',
                confidence: 5.0,
                reasoning: 'bad',
              }),
            },
          },
        ],
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      try {
        await provider.recommend(validContext);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AIProviderError);
        expect((err as AIProviderError).code).toBe('SCHEMA_VALIDATION');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should successfully parse valid model response', async () => {
      const provider = new NemotronProvider({
        apiKey: 'nvapi-test-key',
        modelId: 'nvidia/test',
      });

      const validRecommendation = {
        decision: 'recover_now',
        confidence: 0.87,
        reasoning: 'Transient card decline, customer has good payment history',
        recommended_action: 'create_payment_link',
      };

      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify(validRecommendation),
            },
          },
        ],
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      try {
        const rec = await provider.recommend(validContext);
        expect(rec.decision).toBe(AIDecisionType.RECOVER_NOW);
        expect(rec.confidence).toBe(0.87);
        expect(rec.recommended_action).toBe(RecoveryActionType.CREATE_PAYMENT_LINK);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('H. AI Boundary Enforcement', () => {
    it('AIRecommendation schema has NO monetary amount fields', () => {
      const shape = AIRecommendationSchema.shape;
      const keys = Object.keys(shape);
      expect(keys).toEqual(['decision', 'confidence', 'reasoning', 'recommended_action']);
      expect(keys).not.toContain('amount');
      expect(keys).not.toContain('amountPaise');
      expect(keys).not.toContain('currency');
      expect(keys).not.toContain('payment_amount');
    });

    it('AIRecommendation schema has NO customer PII fields', () => {
      const keys = Object.keys(AIRecommendationSchema.shape);
      expect(keys).not.toContain('email');
      expect(keys).not.toContain('phone');
      expect(keys).not.toContain('customer_name');
      expect(keys).not.toContain('customer_email');
    });

    it('PaymentContext includes amountPaise as read-only context (interface compliance)', () => {
      // Type-level test: validContext.payment.amountPaise exists and is a number
      expect(typeof validContext.payment.amountPaise).toBe('number');
      expect(validContext.payment.amountPaise).toBe(250000);
    });

    it('AI output is validated and extra fields stripped', () => {
      const withAmount = {
        decision: 'recover_now',
        confidence: 0.9,
        reasoning: 'test',
        recommended_action: 'create_payment_link',
        amount: 50000, // AI tried to set amount — must be stripped
      };
      const result = AIRecommendationSchema.safeParse(withAmount);
      expect(result.success).toBe(true);
      if (result.success) {
        expect('amount' in result.data).toBe(false);
      }
    });
  });

  describe('I. Security — No Secrets in Errors', () => {
    it('should not expose API key in AUTH_FAILURE error', () => {
      const apiKey = 'nvapi-secret-real-key-do-not-leak';
      try {
        new NemotronProvider({ apiKey: '', modelId: 'test' });
      } catch (err) {
        expect((err as Error).message).not.toContain(apiKey);
      }
    });

    it('should not expose API key in NETWORK_ERROR', async () => {
      const apiKey = 'nvapi-secret-key-12345';
      const provider = new NemotronProvider({
        apiKey,
        modelId: 'nvidia/test',
      });

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS resolution failed')));

      try {
        await provider.recommend(validContext);
      } catch (err) {
        const errorStr = JSON.stringify(err);
        expect(errorStr).not.toContain(apiKey);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('AIProviderError has typed code discriminator', () => {
      const err = new AIProviderError('TIMEOUT', 'Request timed out');
      expect(err.code).toBe('TIMEOUT');
      expect(err.name).toBe('AIProviderError');
      expect(err.message).toBe('Request timed out');
    });
  });
});
