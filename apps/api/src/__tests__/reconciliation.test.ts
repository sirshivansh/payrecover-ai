import crypto from 'node:crypto';
import { AuditActor, MockPaymentProvider, PaymentStatus, RecoveryStatus } from '@payrecover/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { JobScheduler } from '../jobs/scheduler.js';
import { PaymentStateService } from '../payments/state-service.js';
import { RecoveryManager } from '../recovery/manager.js';
import { Reconciler } from '../verification/reconciler.js';

loadEnv();

describe('Phase 11 — External Reconciliation (§14, v2.1.1 §12.3)', () => {
  let db: ReturnType<typeof createDatabaseClient>;
  let mockPaymentProvider: MockPaymentProvider;
  let paymentStateService: PaymentStateService;
  let recoveryManager: RecoveryManager;
  let scheduler: JobScheduler;
  let reconciler: Reconciler;
  const traceId = 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e';

  beforeAll(async () => {
    const env = loadEnv();
    db = createDatabaseClient(env).db;
  });

  beforeEach(async () => {
    mockPaymentProvider = new MockPaymentProvider();
    paymentStateService = new PaymentStateService(db, mockPaymentProvider);
    recoveryManager = new RecoveryManager(db);
    scheduler = new JobScheduler(db);
    reconciler = new Reconciler(db, paymentStateService, recoveryManager, scheduler, mockPaymentProvider);
  });

  async function createTestPaymentAndAttempt(initialStatus: PaymentStatus = PaymentStatus.FAILED) {
    const paymentId = crypto.randomUUID();
    const razorpayPaymentId = `pay_recon_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const payment = await db
      .insertInto('payments')
      .values({
        id: paymentId,
        razorpay_payment_id: razorpayPaymentId,
        amount_paise: '250000',
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
      revenueAtRiskPaise: 250000,
      traceId,
    });

    return { payment, attempt, razorpayPaymentId };
  }

  describe('1. ACTION_OUTCOME_UNKNOWN Handling', () => {
    it('should conservatively escalate ACTION_OUTCOME_UNKNOWN when no payment link ID exists', async () => {
      const { attempt } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);

      // Transition to ACTION_OUTCOME_UNKNOWN
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
        errorMessage: 'Timeout — response lost',
        traceId,
      });

      await reconciler.reconcile(attempt.id, traceId);

      const reconciledAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(reconciledAttempt?.status).toBe(RecoveryStatus.ESCALATED);

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('action', '=', 'reconciliation_failed_escalated')
        .executeTakeFirst();

      expect(audit).toBeDefined();
      expect(audit?.actor).toBe(AuditActor.RECONCILER);
    });

    it('should reconcile to SUCCEEDED when fresh payment state proves payment was captured', async () => {
      const { payment, attempt, razorpayPaymentId } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);

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
        errorMessage: 'Timeout — response lost',
        traceId,
      });

      // Seed captured payment in mock provider
      mockPaymentProvider.addMockPayment({
        id: razorpayPaymentId,
        entity: 'payment',
        amount: 250000,
        currency: 'INR',
        status: 'captured',
        created_at: Math.floor(Date.now() / 1000),
      });

      await reconciler.reconcile(attempt.id, traceId);

      const reconciledAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(reconciledAttempt?.status).toBe(RecoveryStatus.SUCCEEDED);

      const updatedPayment = await db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', payment.id)
        .executeTakeFirst();
      expect(updatedPayment?.status).toBe(PaymentStatus.PAID);
    });
  });

  describe('2. Payment Link Query Verification', () => {
    it('should transition to VERIFYING when payment link query confirms active created link', async () => {
      const { attempt } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);
      const linkId = `plink_test_${Date.now()}`;

      mockPaymentProvider.addMockPaymentLink({
        id: linkId,
        entity: 'payment_link',
        amount: 250000,
        currency: 'INR',
        status: 'created',
        short_url: `https://rzp.io/i/${linkId}`,
      });

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
        actionResult: { paymentLinkId: linkId },
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ACTION_OUTCOME_UNKNOWN,
        actionResult: { paymentLinkId: linkId },
        traceId,
      });

      await reconciler.reconcile(attempt.id, traceId);

      const reconciledAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(reconciledAttempt?.status).toBe(RecoveryStatus.VERIFYING);

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('action', '=', 'reconciliation_verified_link_active')
        .executeTakeFirst();

      expect(audit).toBeDefined();
    });

    it('should transition to STOPPED when payment link query confirms link was expired or cancelled', async () => {
      const { attempt } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);
      const linkId = `plink_expired_${Date.now()}`;

      mockPaymentProvider.addMockPaymentLink({
        id: linkId,
        entity: 'payment_link',
        amount: 250000,
        currency: 'INR',
        status: 'expired',
        short_url: `https://rzp.io/i/${linkId}`,
      });

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
        actionResult: { paymentLinkId: linkId },
        traceId,
      });
      await recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ACTION_OUTCOME_UNKNOWN,
        actionResult: { paymentLinkId: linkId },
        traceId,
      });

      await reconciler.reconcile(attempt.id, traceId);

      const reconciledAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(reconciledAttempt?.status).toBe(RecoveryStatus.STOPPED);
    });
  });

  describe('3. Terminal State Immutability Protection', () => {
    it('should preserve terminal state and reject reopening SUCCEEDED attempts', async () => {
      const { attempt } = await createTestPaymentAndAttempt(PaymentStatus.FAILED);

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

      await reconciler.reconcile(attempt.id, traceId);

      const terminalAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(terminalAttempt?.status).toBe(RecoveryStatus.SUCCEEDED);
    });
  });
});
