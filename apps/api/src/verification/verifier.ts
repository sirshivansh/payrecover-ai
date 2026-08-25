import crypto from 'node:crypto';
import type { Database, EvaluationInput, EvaluationResult } from '@payrecover/shared';
import { AuditActor, PaymentStatus, isTerminalRecoveryStatus } from '@payrecover/shared';
import type { Kysely } from 'kysely';
import type { JobScheduler } from '../jobs/scheduler.js';
import type { PaymentStateService } from '../payments/state-service.js';
import type { RecoveryManager } from '../recovery/manager.js';
import { evaluateOutcome } from './evaluator.js';

export interface VerifierOptions {
  now?: Date;
}

export class OutcomeVerifier {
  constructor(
    private db: Kysely<Database>,
    private paymentStateService: PaymentStateService,
    private recoveryManager: RecoveryManager,
    private jobScheduler: JobScheduler,
  ) {}

  /**
   * Evaluate a recovery attempt purely without modifying external state (§12, §19)
   */
  async evaluateAttempt(attemptId: string, now?: Date): Promise<EvaluationResult> {
    const attempt = await this.recoveryManager.getAttempt(attemptId);
    if (!attempt) {
      throw new Error(`Recovery attempt '${attemptId}' not found`);
    }

    const payment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', attempt.payment_id)
      .executeTakeFirst();

    if (!payment) {
      throw new Error(`Payment '${attempt.payment_id}' not found`);
    }

    const snapshot = attempt.policy_snapshot as Record<string, unknown> | null;
    const maxAttempts = getMaxAttempts(snapshot);

    const input: EvaluationInput = {
      paymentStatus: payment.status,
      recoveryAttemptStatus: attempt.status,
      amountPaise: BigInt(payment.amount_paise),
      currency: payment.currency,
      attemptNumber: attempt.attempt_number,
      maxAttempts,
      actionResult: attempt.action_result as EvaluationInput['actionResult'],
      policyDecision: attempt.policy_decision,
      aiDecision: attempt.ai_decision,
      errorMessage: attempt.error_message,
    };

    return evaluateOutcome(input, now);
  }

  /**
   * Authoritatively verify payment state and process outcome transitions (§12, v2.1.1 §12.3)
   */
  async verifyAndProcessAttempt(
    attemptId: string,
    traceIdInput?: string,
    options?: VerifierOptions,
  ): Promise<EvaluationResult> {
    const traceId = traceIdInput ?? crypto.randomUUID();
    const evalNow = options?.now ?? new Date();

    const attempt = await this.recoveryManager.getAttempt(attemptId);
    if (!attempt) {
      throw new Error(`Recovery attempt '${attemptId}' not found`);
    }

    const payment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', attempt.payment_id)
      .executeTakeFirst();

    if (!payment) {
      throw new Error(`Payment '${attempt.payment_id}' not found`);
    }

    // Preserve terminal state immutability (§6.1)
    if (isTerminalRecoveryStatus(attempt.status)) {
      return await this.evaluateAttempt(attemptId, evalNow);
    }

    // Fetch fresh authoritative payment state from Razorpay / PaymentStateService
    const freshPayment = await this.paymentStateService.getPayment(payment.razorpay_payment_id, {
      forceRefresh: true,
      traceId,
    });

    const snapshot = attempt.policy_snapshot as Record<string, unknown> | null;
    const maxAttempts = getMaxAttempts(snapshot);

    const input: EvaluationInput = {
      paymentStatus: freshPayment?.status ?? payment.status,
      recoveryAttemptStatus: attempt.status,
      amountPaise: BigInt(payment.amount_paise),
      currency: payment.currency,
      attemptNumber: attempt.attempt_number,
      maxAttempts,
      actionResult: attempt.action_result as EvaluationInput['actionResult'],
      policyDecision: attempt.policy_decision,
      aiDecision: attempt.ai_decision,
      errorMessage: attempt.error_message,
    };

    const result = evaluateOutcome(input, evalNow);

    // Transition attempt using RecoveryManager state machine (§6.1) if status changes
    if (attempt.status !== result.targetRecoveryStatus) {
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: result.targetRecoveryStatus,
        errorMessage: result.reason,
        traceId,
      });
    }

    if (result.outcome === 'succeeded') {
      // Mark payment paid in DB
      await this.db
        .updateTable('payments')
        .set({
          status: PaymentStatus.PAID,
          paid_at: evalNow,
          updated_at: evalNow,
        })
        .where('id', '=', payment.id)
        .execute();

      // Cancel pending jobs
      await this.jobScheduler.cancelPendingJobsForAttempt(attempt.id, traceId);
    } else if (result.outcome === 'failed' && attempt.attempt_number < maxAttempts) {
      // Eligible for retry -> Create attempt #n+1 and schedule ANALYZE job
      const newAttempt = await this.recoveryManager.createAttempt({
        paymentId: payment.id,
        revenueAtRiskPaise: Number(payment.amount_paise),
        policySnapshot: snapshot ?? undefined,
        traceId,
      });

      await this.jobScheduler.scheduleAnalyze(newAttempt.id, undefined, traceId);
    }

    // Insert structured audit log
    await this.db
      .insertInto('audit_log')
      .values({
        recovery_attempt_id: attempt.id,
        payment_id: payment.id,
        actor: AuditActor.VERIFIER,
        action: `outcome_verified_${result.outcome}`,
        input: { attempt_id: attempt.id, payment_id: payment.id },
        output: {
          outcome: result.outcome,
          target_status: result.targetRecoveryStatus,
          is_recovered: result.isRecovered,
          financial_match: result.financialMatch,
        },
        error: result.outcome === 'succeeded' ? null : result.reason,
        trace_id: traceId,
        created_at: evalNow,
      })
      .execute();

    return result;
  }
}

function getMaxAttempts(snapshot: Record<string, unknown> | null): number {
  if (!snapshot) return 3;
  // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
  const val = snapshot['maxAttempts'];
  return typeof val === 'number' || typeof val === 'string' ? Number(val) : 3;
}
