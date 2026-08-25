import crypto from 'node:crypto';
import {
  AuditActor,
  type Database,
  MockPaymentProvider,
  PolicyDecisionType,
  RazorpayAPIError,
  RazorpayNetworkError,
  RazorpayTimeoutError,
  RecoveryActionType,
  RecoveryStatus,
} from '@payrecover/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../actions/executor.js';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { RecoveryManager } from '../recovery/manager.js';
import { IdempotencyService } from '../services/idempotency.service.js';

describe('Phase 8 — ActionExecutor & Bounded Tools (§12, v2.1.1 §12, §30)', () => {
  const env = loadEnv();
  const { db, close } = createDatabaseClient(env);
  let mockRazorpay: MockPaymentProvider;
  let idemService: IdempotencyService;
  let recoveryManager: RecoveryManager;
  let executor: ActionExecutor;

  const traceId = '11111111-2222-3333-4444-555555555555';

  afterAll(async () => {
    await close();
  });

  let createdPaymentIds: string[] = [];

  beforeEach(async () => {
    mockRazorpay = new MockPaymentProvider();
    idemService = new IdempotencyService(null, db);
    recoveryManager = new RecoveryManager(db);
    executor = new ActionExecutor(mockRazorpay, db, idemService, recoveryManager);
    createdPaymentIds = [];
  });

  async function createTestPaymentAndAttempt(overrides?: {
    amountPaise?: number;
    currency?: string;
    policyDecision?: PolicyDecisionType;
    policyReason?: string;
    status?: RecoveryStatus;
  }) {
    const paymentId = crypto.randomUUID();
    createdPaymentIds.push(paymentId);
    const razorpayPaymentId = `pay_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const amountPaise = overrides?.amountPaise ?? 250000; // ₹2,500
    const currency = overrides?.currency ?? 'INR';

    await db
      .insertInto('payments')
      .values({
        id: paymentId,
        razorpay_payment_id: razorpayPaymentId,
        amount_paise: String(amountPaise),
        currency,
        status: 'failed',
        failure_code: 'BAD_REQUEST_ERROR',
        failure_reason: 'Card declined',
        email_hash: 'mock_email_hash',
        phone_hash: 'mock_phone_hash',
      })
      .execute();

    // Register with mock Razorpay provider so pre-action verification works
    mockRazorpay.addMockPayment({
      id: razorpayPaymentId,
      entity: 'payment',
      amount: amountPaise,
      currency,
      status: 'failed',
      created_at: Math.floor(Date.now() / 1000),
    });

    const attempt = await recoveryManager.createAttempt({
      paymentId,
      revenueAtRiskPaise: amountPaise,
      traceId,
    });

    // Transition PENDING -> ANALYZING (§6.1)
    await recoveryManager.transitionAttempt({
      attemptId: attempt.id,
      targetStatus: RecoveryStatus.ANALYZING,
      traceId,
    });

    // Transition ANALYZING -> POLICY_CHECK state with policy decision (§6.1)
    const policyDecision = overrides?.policyDecision ?? PolicyDecisionType.APPROVED;
    const policyReason = overrides?.policyReason ?? 'All checks passed';

    const updatedAttempt = await recoveryManager.transitionAttempt({
      attemptId: attempt.id,
      targetStatus: overrides?.status ?? RecoveryStatus.POLICY_CHECK,
      policyDecision,
      policyReason,
      traceId,
    });

    return { paymentId, razorpayPaymentId, attempt: updatedAttempt, amountPaise, currency };
  }

  describe('1. Successful CREATE_PAYMENT_LINK Bounded Tool Execution', () => {
    it('should create payment link using authoritative PostgreSQL amount & currency', async () => {
      const { attempt, amountPaise, currency } = await createTestPaymentAndAttempt({
        amountPaise: 49900, // ₹499
        currency: 'INR',
      });

      const result = await executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId);

      expect(result.success).toBe(true);
      expect(result.paymentLinkId).toBeDefined();
      expect(result.paymentLinkUrl).toBeDefined();
      expect(result.actionType).toBe(RecoveryActionType.CREATE_PAYMENT_LINK);

      // Verify Razorpay provider received authoritative amount from DB
      const createdLinks = mockRazorpay.getCreatedPaymentLinks();
      expect(createdLinks.length).toBe(1);
      expect(createdLinks[0]?.amount).toBe(amountPaise);
      expect(createdLinks[0]?.currency).toBe(currency);
      expect(createdLinks[0]?.notes?.recovery_attempt_id).toBe(attempt.id);

      // Verify Recovery Attempt state updated to VERIFYING
      const updatedAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(updatedAttempt?.status).toBe(RecoveryStatus.VERIFYING);
      expect(updatedAttempt?.action_result).toBeDefined();

      // Verify Audit Log entry created with actor EXECUTOR
      const auditEntries = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('action', '=', 'action_executed')
        .execute();

      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0]?.actor).toBe(AuditActor.EXECUTOR);
      expect(auditEntries[0]?.trace_id).toBe(traceId);
    });
  });

  describe('2. Policy Gate Verification', () => {
    it('should block execution if policy decision is REJECTED', async () => {
      const { attempt } = await createTestPaymentAndAttempt({
        policyDecision: PolicyDecisionType.REJECTED,
        policyReason: 'Amount exceeds maximum threshold',
      });

      await expect(executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId)).rejects.toThrow(
        'Action execution blocked: Policy decision is not APPROVED',
      );

      // Verify attempt remains in POLICY_CHECK status
      const currentAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(currentAttempt?.status).toBe(RecoveryStatus.POLICY_CHECK);
    });
  });

  describe('3. Pre-Action Verification Gate (Race Condition Protection)', () => {
    it('should skip link creation if payment was already captured/paid', async () => {
      const { attempt, razorpayPaymentId } = await createTestPaymentAndAttempt();

      // Mark payment captured on Razorpay
      mockRazorpay.addMockPayment({
        id: razorpayPaymentId,
        entity: 'payment',
        amount: 250000,
        currency: 'INR',
        status: 'captured',
        captured: true,
        created_at: Math.floor(Date.now() / 1000),
      });

      const result = await executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('already_paid');

      // Verify no payment link was created
      expect(mockRazorpay.getCreatedPaymentLinks().length).toBe(0);

      // Verify Recovery Attempt state transitioned directly to SUCCEEDED
      const currentAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(currentAttempt?.status).toBe(RecoveryStatus.SUCCEEDED);
    });
  });

  describe('4. Action Idempotency & Duplicate Prevention', () => {
    it('should return cached result for duplicate action requests without executing twice', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      // First execution
      const firstResult = await executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId);
      expect(firstResult.success).toBe(true);
      expect(firstResult.cached).toBeUndefined();

      // Second execution (duplicate)
      const secondResult = await executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId);

      expect(secondResult.success).toBe(true);
      expect(secondResult.cached).toBe(true);
      expect(secondResult.paymentLinkId).toBe(firstResult.paymentLinkId);

      // Verify only 1 payment link was created on Razorpay provider
      expect(mockRazorpay.getCreatedPaymentLinks().length).toBe(1);
    });

    it('should fail closed when idempotency check returns FAIL_CLOSED', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      // Mock idempotency service to return FAIL_CLOSED
      vi.spyOn(idemService, 'checkAndSetActionIdempotency').mockResolvedValueOnce('FAIL_CLOSED');

      await expect(executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId)).rejects.toThrow(
        'Action execution blocked: Idempotency check returned FAIL_CLOSED',
      );

      // Verify no payment link created
      expect(mockRazorpay.getCreatedPaymentLinks().length).toBe(0);
    });
  });

  describe('5. STOP_RECOVERY Bounded Tool Execution', () => {
    it('should execute STOP_RECOVERY and transition attempt to STOPPED', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      const result = await executor.execute(attempt.id, RecoveryActionType.STOP_RECOVERY, traceId);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe(RecoveryActionType.STOP_RECOVERY);

      const currentAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(currentAttempt?.status).toBe(RecoveryStatus.STOPPED);
    });
  });

  describe('6. Error Handling & ACTION_OUTCOME_UNKNOWN', () => {
    it('should mark attempt ACTION_OUTCOME_UNKNOWN on Razorpay timeout', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      // Mock createPaymentLink to throw RazorpayTimeoutError
      vi.spyOn(mockRazorpay, 'createPaymentLink').mockRejectedValueOnce(new RazorpayTimeoutError(5000));

      const result = await executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId);

      expect(result.success).toBe(false);
      expect(result.outcomeUnknown).toBe(true);
      expect(result.error).toContain('Payment link creation timeout');

      // Verify attempt status transitioned to ACTION_OUTCOME_UNKNOWN
      const currentAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(currentAttempt?.status).toBe(RecoveryStatus.ACTION_OUTCOME_UNKNOWN);

      // Verify audit log recorded action_outcome_unknown
      const auditEntries = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('action', '=', 'action_outcome_unknown')
        .execute();

      expect(auditEntries.length).toBe(1);
    });

    it('should mark attempt ACTION_OUTCOME_UNKNOWN on Razorpay network error', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      vi.spyOn(mockRazorpay, 'createPaymentLink').mockRejectedValueOnce(new RazorpayNetworkError('ECONNRESET'));

      const result = await executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId);

      expect(result.success).toBe(false);
      expect(result.outcomeUnknown).toBe(true);

      const currentAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(currentAttempt?.status).toBe(RecoveryStatus.ACTION_OUTCOME_UNKNOWN);
    });

    it('should write audit log and rethrow on Razorpay API error', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      vi.spyOn(mockRazorpay, 'createPaymentLink').mockRejectedValueOnce(new RazorpayAPIError('BAD_REQUEST', 400));

      await expect(executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId)).rejects.toThrow(
        'BAD_REQUEST',
      );

      const auditEntries = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('action', '=', 'action_failed')
        .execute();

      expect(auditEntries.length).toBe(1);
    });
  });

  describe('7. Security & Secret Leakage Prevention', () => {
    it('should not contain secrets or credentials in audit logs', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      await executor.execute(attempt.id, RecoveryActionType.CREATE_PAYMENT_LINK, traceId);

      const auditEntries = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .execute();

      for (const entry of auditEntries) {
        const str = JSON.stringify(entry);
        expect(str).not.toContain('rzp_test_');
        expect(str).not.toContain('Authorization');
        expect(str).not.toContain('secret');
      }
    });
  });
});
