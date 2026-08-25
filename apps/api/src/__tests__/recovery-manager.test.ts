import {
  AIDecisionType,
  InvalidStateTransitionError,
  PaymentStatus,
  PolicyDecisionType,
  type RecoveryAttemptRow,
  RecoveryStatus,
} from '@payrecover/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { RecoveryManager } from '../recovery/manager.js';

describe('Phase 4 — RecoveryManager & recovery_attempts CRUD', () => {
  const env = loadEnv();
  const { db, close } = createDatabaseClient(env);
  let manager: RecoveryManager;

  beforeAll(() => {
    manager = new RecoveryManager(db);
  });

  afterAll(async () => {
    await close();
  });

  describe('Recovery Attempt Creation & Attempt Numbering', () => {
    it('should create initial recovery attempt with attempt_number 1 and status PENDING', async () => {
      const razorpayId = `pay_rec_1_${Date.now()}`;

      // Insert test payment in DB
      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '250000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const attempt = await manager.createAttempt({
        paymentId: payment.id,
        revenueAtRiskPaise: '250000',
      });

      expect(attempt).toBeDefined();
      expect(attempt.payment_id).toBe(payment.id);
      expect(attempt.attempt_number).toBe(1);
      expect(attempt.status).toBe(RecoveryStatus.PENDING);
      expect(String(attempt.revenue_at_risk_paise)).toBe('250000');

      // Verify audit log entry
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .executeTakeFirst();

      expect(audit).toBeDefined();
      expect(audit?.action).toBe('recovery_attempt_created');
      expect(audit?.actor).toBe('scheduler');

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });

    it('should increment attempt_number sequentially for subsequent attempts', async () => {
      const razorpayId = `pay_seq_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '300000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Create attempt #1 and stop it
      const attempt1 = await manager.createAttempt({ paymentId: payment.id });
      expect(attempt1.attempt_number).toBe(1);

      await manager.transitionAttempt({
        attemptId: attempt1.id,
        targetStatus: RecoveryStatus.STOPPED,
        errorMessage: 'Cooldown elapsed',
      });

      // Create attempt #2
      const attempt2 = await manager.createAttempt({ paymentId: payment.id });
      expect(attempt2.attempt_number).toBe(2);
      expect(attempt2.status).toBe(RecoveryStatus.PENDING);

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });

    it('should safely handle concurrent createAttempt calls on the same payment', async () => {
      const razorpayId = `pay_race_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '500000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Fire 2 concurrent createAttempt calls simultaneously
      const results = await Promise.allSettled([
        manager.createAttempt({ paymentId: payment.id }),
        manager.createAttempt({ paymentId: payment.id }),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<RecoveryAttemptRow> => r.status === 'fulfilled',
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Verify database state: exactly 1 attempt created, attempt_number = 1
      const attemptsInDb = await manager.listAttemptsForPayment(payment.id);
      expect(attemptsInDb.length).toBe(1);
      expect(attemptsInDb[0]?.attempt_number).toBe(1);

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });

    it('should reject recovery attempt creation on payments in terminal state (PAID)', async () => {
      const razorpayId = `pay_term_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '100000',
          currency: 'INR',
          status: PaymentStatus.PAID,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await expect(manager.createAttempt({ paymentId: payment.id })).rejects.toThrow(
        "Cannot start recovery for payment in terminal status 'paid'",
      );

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });
  });

  describe('Recovery Attempt Transitions & Retrieval', () => {
    it('should transition attempt through state machine and set completed_at on terminal transition', async () => {
      const razorpayId = `pay_trans_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '400000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 1. Create PENDING attempt
      const attempt = await manager.createAttempt({ paymentId: payment.id });
      expect(attempt.status).toBe(RecoveryStatus.PENDING);
      expect(attempt.completed_at).toBeNull();

      // 2. PENDING -> ANALYZING
      const step1 = await manager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ANALYZING,
      });
      expect(step1.status).toBe(RecoveryStatus.ANALYZING);

      // 3. ANALYZING -> POLICY_CHECK
      const step2 = await manager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.POLICY_CHECK,
        aiDecision: AIDecisionType.RECOVER_NOW,
        aiConfidence: 0.9,
        aiReasoning: 'High intent customer',
      });
      expect(step2.status).toBe(RecoveryStatus.POLICY_CHECK);
      expect(step2.ai_decision).toBe(AIDecisionType.RECOVER_NOW);

      // 4. POLICY_CHECK -> EXECUTING
      const step3 = await manager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.EXECUTING,
        policyDecision: PolicyDecisionType.APPROVED,
        policyReason: 'All checks passed',
      });
      expect(step3.status).toBe(RecoveryStatus.EXECUTING);

      // 5. EXECUTING -> SUCCEEDED (Terminal)
      const finalStep = await manager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.SUCCEEDED,
      });
      expect(finalStep.status).toBe(RecoveryStatus.SUCCEEDED);
      expect(finalStep.completed_at).toBeDefined();
      expect(finalStep.completed_at).not.toBeNull();

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });

    it('should reject state transitions from terminal states', async () => {
      const razorpayId = `pay_term_sink_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '200000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const attempt = await manager.createAttempt({ paymentId: payment.id });

      // Transition to terminal STOPPED status
      await manager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.STOPPED,
        errorMessage: 'Manual stop',
      });

      // Attempt invalid transition out of STOPPED
      await expect(
        manager.transitionAttempt({
          attemptId: attempt.id,
          targetStatus: RecoveryStatus.EXECUTING,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });

    it('should stop recovery for payment via stopRecovery helper', async () => {
      const razorpayId = `pay_stop_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '150000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await manager.createAttempt({ paymentId: payment.id });

      const stopped = await manager.stopRecovery(payment.id, 'Merchant requested stop');

      expect(stopped.status).toBe(RecoveryStatus.STOPPED);
      expect(stopped.error_message).toBe('Merchant requested stop');

      // Clean up
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });
  });
});
