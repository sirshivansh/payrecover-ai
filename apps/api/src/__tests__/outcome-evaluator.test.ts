import {
  AIDecisionType,
  AuditActor,
  MockPaymentProvider,
  PaymentStatus,
  PolicyDecisionType,
  type RazorpayClient,
  RecoveryStatus,
} from '@payrecover/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { JobScheduler } from '../jobs/scheduler.js';
import { PaymentStateService } from '../payments/state-service.js';
import { RecoveryManager } from '../recovery/manager.js';
import { evaluateOutcome } from '../verification/evaluator.js';
import { Reconciler } from '../verification/reconciler.js';
import { OutcomeVerifier } from '../verification/verifier.js';

describe('Phase 10 — Evaluation Engine & Deterministic Outcome Verification (§12, §14, §19)', () => {
  const env = loadEnv();
  const { db, close } = createDatabaseClient(env);

  // ─── 1. Pure Deterministic Evaluator Tests (§19.2) ──────────────────

  describe('1. Pure Deterministic Evaluator (evaluateOutcome)', () => {
    const fixedNow = new Date('2026-08-25T12:00:00.000Z');

    it('should deterministically return SUCCEEDED when payment is PAID', () => {
      const result = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.PAID,
          recoveryAttemptStatus: RecoveryStatus.VERIFYING,
          amountPaise: 250000n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
        },
        fixedNow,
      );

      expect(result.outcome).toBe('succeeded');
      expect(result.isRecovered).toBe(true);
      expect(result.isTerminal).toBe(true);
      expect(result.targetRecoveryStatus).toBe(RecoveryStatus.SUCCEEDED);
      expect(result.financialMatch).toBe(true);
      expect(result.evaluatedAt).toBe(fixedNow.toISOString());
    });

    it('should return STOPPED when payment is REFUNDED or CANCELLED', () => {
      const refundedResult = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.REFUNDED,
          recoveryAttemptStatus: RecoveryStatus.VERIFYING,
          amountPaise: 100000n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
        },
        fixedNow,
      );

      expect(refundedResult.outcome).toBe('stopped');
      expect(refundedResult.isRecovered).toBe(false);
      expect(refundedResult.isTerminal).toBe(true);
      expect(refundedResult.targetRecoveryStatus).toBe(RecoveryStatus.STOPPED);

      const cancelledResult = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.CANCELLED,
          recoveryAttemptStatus: RecoveryStatus.VERIFYING,
          amountPaise: 100000n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
        },
        fixedNow,
      );

      expect(cancelledResult.outcome).toBe('stopped');
      expect(cancelledResult.targetRecoveryStatus).toBe(RecoveryStatus.STOPPED);
    });

    it('should conservatively return ESCALATED for ACTION_OUTCOME_UNKNOWN (v2.1.1 §12.3)', () => {
      const result = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.FAILED,
          recoveryAttemptStatus: RecoveryStatus.ACTION_OUTCOME_UNKNOWN,
          amountPaise: 500000n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
          actionResult: { outcomeUnknown: true },
        },
        fixedNow,
      );

      expect(result.outcome).toBe('action_outcome_unknown');
      expect(result.isRecovered).toBe(false);
      expect(result.isTerminal).toBe(true);
      expect(result.targetRecoveryStatus).toBe(RecoveryStatus.ESCALATED);
      expect(result.requiresReconciliation).toBe(true);
    });

    it('should return STOPPED when policy decision is REJECTED', () => {
      const result = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.FAILED,
          recoveryAttemptStatus: RecoveryStatus.POLICY_CHECK,
          amountPaise: 250000n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
          policyDecision: PolicyDecisionType.REJECTED,
          errorMessage: 'Amount exceeds merchant maximum threshold',
        },
        fixedNow,
      );

      expect(result.outcome).toBe('stopped');
      expect(result.isTerminal).toBe(true);
      expect(result.targetRecoveryStatus).toBe(RecoveryStatus.STOPPED);
      expect(result.reason).toContain('Amount exceeds merchant maximum threshold');
    });

    it('should return ESCALATED when AI recommends ESCALATE and policy approves', () => {
      const result = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.FAILED,
          recoveryAttemptStatus: RecoveryStatus.POLICY_CHECK,
          amountPaise: 1500000n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
          aiDecision: AIDecisionType.ESCALATE,
          policyDecision: PolicyDecisionType.APPROVED,
        },
        fixedNow,
      );

      expect(result.outcome).toBe('escalated');
      expect(result.isTerminal).toBe(true);
      expect(result.targetRecoveryStatus).toBe(RecoveryStatus.ESCALATED);
    });

    it('should return STOPPED when attemptNumber >= maxAttempts', () => {
      const result = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.FAILED,
          recoveryAttemptStatus: RecoveryStatus.VERIFYING,
          amountPaise: 200000n,
          currency: 'INR',
          attemptNumber: 3,
          maxAttempts: 3,
        },
        fixedNow,
      );

      expect(result.outcome).toBe('stopped');
      expect(result.isTerminal).toBe(true);
      expect(result.targetRecoveryStatus).toBe(RecoveryStatus.STOPPED);
      expect(result.reason).toContain('Maximum recovery attempts reached');
    });

    it('should return VERIFYING when attempt is eligible for retry (attemptNumber < maxAttempts)', () => {
      const result = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.FAILED,
          recoveryAttemptStatus: RecoveryStatus.VERIFYING,
          amountPaise: 200000n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
        },
        fixedNow,
      );

      expect(result.outcome).toBe('failed');
      expect(result.isTerminal).toBe(false);
      expect(result.targetRecoveryStatus).toBe(RecoveryStatus.VERIFYING);
    });

    it('should enforce BigInt financial authority without floating point inaccuracies', () => {
      const result = evaluateOutcome(
        {
          paymentStatus: PaymentStatus.PAID,
          recoveryAttemptStatus: RecoveryStatus.VERIFYING,
          amountPaise: 999999999999999n,
          currency: 'INR',
          attemptNumber: 1,
          maxAttempts: 3,
        },
        fixedNow,
      );

      expect(result.financialMatch).toBe(true);
    });
  });

  // ─── 2. Integration Tests (OutcomeVerifier & Reconciler) ─────────────

  describe('2. OutcomeVerifier & Reconciler Integration', () => {
    let mockPaymentProvider: MockPaymentProvider;
    let razorpayClient: RazorpayClient;
    let paymentStateService: PaymentStateService;
    let recoveryManager: RecoveryManager;
    let scheduler: JobScheduler;
    let verifier: OutcomeVerifier;
    let reconciler: Reconciler;
    const traceId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';

    beforeEach(async () => {
      mockPaymentProvider = new MockPaymentProvider();
      paymentStateService = new PaymentStateService(db, mockPaymentProvider);
      recoveryManager = new RecoveryManager(db);
      scheduler = new JobScheduler(db);
      verifier = new OutcomeVerifier(db, paymentStateService, recoveryManager, scheduler);
      reconciler = new Reconciler(db, paymentStateService, recoveryManager, scheduler);
    });

    async function createTestPaymentAndAttempt(initialStatus: PaymentStatus = PaymentStatus.FAILED) {
      const paymentId = crypto.randomUUID();
      const razorpayPaymentId = `pay_eval_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const payment = await db
        .insertInto('payments')
        .values({
          id: paymentId,
          razorpay_payment_id: razorpayPaymentId,
          amount_paise: '350000',
          currency: 'INR',
          status: initialStatus,
          failure_code: 'BAD_REQUEST_ERROR',
          failure_reason: 'Card declined',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const attempt = await recoveryManager.createAttempt({
        paymentId: payment.id,
        revenueAtRiskPaise: 350000,
        traceId,
      });

      return { payment, attempt, razorpayPaymentId };
    }

    it('should authoritatively update payment to PAID and attempt to SUCCEEDED when Razorpay confirms payment', async () => {
      const { payment, attempt, razorpayPaymentId } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);

      // Transition attempt through valid state machine path: PENDING -> ANALYZING -> POLICY_CHECK -> EXECUTING -> VERIFYING
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ANALYZING,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.POLICY_CHECK,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.EXECUTING,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.VERIFYING,
        traceId,
      });

      // Seed captured payment in mock payment provider
      mockPaymentProvider.addMockPayment({
        id: razorpayPaymentId,
        entity: 'payment',
        amount: 350000,
        currency: 'INR',
        status: 'captured',
        method: 'card',
        email: 'eval@example.com',
        contact: '+919876543210',
        created_at: Math.floor(Date.now() / 1000),
      });

      const evalResult = await verifier.verifyAndProcessAttempt(attempt.id, traceId);

      expect(evalResult.outcome).toBe('succeeded');
      expect(evalResult.targetRecoveryStatus).toBe(RecoveryStatus.SUCCEEDED);

      // Verify DB attempt status
      const updatedAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(updatedAttempt?.status).toBe(RecoveryStatus.SUCCEEDED);

      // Verify DB payment status
      const updatedPayment = await db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', payment.id)
        .executeTakeFirst();
      expect(updatedPayment?.status).toBe(PaymentStatus.PAID);

      // Verify Audit Log entry
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('action', '=', 'outcome_verified_succeeded')
        .executeTakeFirst();

      expect(audit).toBeDefined();
      expect(audit?.action).toBe('outcome_verified_succeeded');
      expect(audit?.trace_id).toBe(traceId);
    });

    it('should conservatively escalate ACTION_OUTCOME_UNKNOWN during reconciliation (v2.1.1 §12.3)', async () => {
      const { attempt } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);

      // Transition attempt through valid state machine path: PENDING -> ANALYZING -> POLICY_CHECK -> EXECUTING -> ACTION_OUTCOME_UNKNOWN
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ANALYZING,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.POLICY_CHECK,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.EXECUTING,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ACTION_OUTCOME_UNKNOWN,
        errorMessage: 'Razorpay API request timed out',
        traceId,
      });

      // Run Reconciler
      await reconciler.reconcile(attempt.id, traceId);

      const escalatedAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(escalatedAttempt?.status).toBe(RecoveryStatus.ESCALATED);

      // Verify Audit Log entry for reconciler
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('actor', '=', AuditActor.RECONCILER)
        .executeTakeFirst();

      expect(audit).toBeDefined();
      expect(audit?.action).toBe('reconciliation_failed_escalated');
    });

    it('should preserve terminal state immutability when verifying an already SUCCEEDED attempt', async () => {
      const { attempt } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);

      // Transition attempt to terminal SUCCEEDED state via valid path
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ANALYZING,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.POLICY_CHECK,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.EXECUTING,
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.SUCCEEDED,
        traceId,
      });

      // Call verifier on already terminal attempt
      const result = await verifier.verifyAndProcessAttempt(attempt.id, traceId);

      expect(result.outcome).toBe('failed'); // Payment in mock still unpaid, but attempt status remains SUCCEEDED
      const terminalAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(terminalAttempt?.status).toBe(RecoveryStatus.SUCCEEDED); // Intact!
    });
  });
});
