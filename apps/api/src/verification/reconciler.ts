import crypto from 'node:crypto';
import type { Database, IRazorpayClient } from '@payrecover/shared';
import { AuditActor, PaymentStatus, RecoveryStatus, isTerminalRecoveryStatus } from '@payrecover/shared';
import type { Kysely } from 'kysely';
import type { JobScheduler } from '../jobs/scheduler.js';
import type { PaymentStateService } from '../payments/state-service.js';
import type { RecoveryManager } from '../recovery/manager.js';

export class Reconciler {
  constructor(
    private db: Kysely<Database>,
    private paymentStateService: PaymentStateService,
    private recoveryManager: RecoveryManager,
    private jobScheduler: JobScheduler,
    private razorpay?: IRazorpayClient,
  ) {}

  /**
   * Reconcile unknown external outcomes conservatively (§14, v2.1.1 §12.3)
   */
  async reconcile(attemptId: string, traceIdInput?: string): Promise<void> {
    const traceId = traceIdInput ?? crypto.randomUUID();
    const attempt = await this.recoveryManager.getAttempt(attemptId);

    // Terminal state immutability invariant (§6.1)
    if (!attempt || isTerminalRecoveryStatus(attempt.status)) {
      return;
    }

    if (attempt.status !== RecoveryStatus.ACTION_OUTCOME_UNKNOWN) {
      return;
    }

    const payment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', attempt.payment_id)
      .executeTakeFirst();

    if (!payment) {
      await this.escalate(attemptId, null, 'Payment record not found', traceId);
      return;
    }

    // 1. Check fresh authoritative payment state on PaymentStateService (§14.2)
    const freshPayment = await this.paymentStateService.getPayment(payment.razorpay_payment_id, {
      forceRefresh: true,
      traceId,
    });

    if (freshPayment && (freshPayment.status === PaymentStatus.PAID || freshPayment.paid_at !== null)) {
      // Payment was paid despite action timeout -> Mark SUCCEEDED (§14.2)
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.SUCCEEDED,
        traceId,
      });

      await this.db
        .updateTable('payments')
        .set({
          status: PaymentStatus.PAID,
          paid_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', payment.id)
        .execute();

      await this.jobScheduler.cancelPendingJobsForAttempt(attempt.id, traceId);

      await this.db
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: attempt.id,
          payment_id: payment.id,
          actor: AuditActor.RECONCILER,
          action: 'reconciliation_succeeded',
          input: { attempt_id: attempt.id },
          output: { status: RecoveryStatus.SUCCEEDED },
          error: null,
          trace_id: traceId,
          created_at: new Date(),
        })
        .execute();
      return;
    }

    // 2. Check payment link outcome if paymentLinkId exists in action_result
    const actionResult = attempt.action_result as Record<string, unknown> | null;
    // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
    const paymentLinkId = typeof actionResult?.['paymentLinkId'] === 'string' ? actionResult['paymentLinkId'] : null;

    if (paymentLinkId) {
      const link =
        (await this.paymentStateService.getPaymentLink(paymentLinkId)) ??
        (this.razorpay ? await this.razorpay.getPaymentLink(paymentLinkId).catch(() => null) : null);

      if (link) {
        if (link.status === 'paid') {
          // Payment link was captured/paid
          await this.recoveryManager.transitionAttempt({
            attemptId: attempt.id,
            targetStatus: RecoveryStatus.SUCCEEDED,
            traceId,
          });

          await this.db
            .updateTable('payments')
            .set({
              status: PaymentStatus.PAID,
              paid_at: new Date(),
              updated_at: new Date(),
            })
            .where('id', '=', payment.id)
            .execute();

          await this.jobScheduler.cancelPendingJobsForAttempt(attempt.id, traceId);

          await this.db
            .insertInto('audit_log')
            .values({
              recovery_attempt_id: attempt.id,
              payment_id: payment.id,
              actor: AuditActor.RECONCILER,
              action: 'reconciliation_succeeded_payment_link_paid',
              input: { attempt_id: attempt.id, payment_link_id: paymentLinkId },
              output: { status: RecoveryStatus.SUCCEEDED, link_status: link.status },
              error: null,
              trace_id: traceId,
              created_at: new Date(),
            })
            .execute();
          return;
        }

        if (link.status === 'created' || link.status === 'partially_paid') {
          // Link was successfully created on Razorpay! Transition to VERIFYING
          await this.recoveryManager.transitionAttempt({
            attemptId: attempt.id,
            targetStatus: RecoveryStatus.VERIFYING,
            traceId,
          });

          await this.jobScheduler.scheduleVerify(attempt.id, undefined, traceId);

          await this.db
            .insertInto('audit_log')
            .values({
              recovery_attempt_id: attempt.id,
              payment_id: payment.id,
              actor: AuditActor.RECONCILER,
              action: 'reconciliation_verified_link_active',
              input: { attempt_id: attempt.id, payment_link_id: paymentLinkId },
              output: { status: RecoveryStatus.VERIFYING, link_status: link.status },
              error: null,
              trace_id: traceId,
              created_at: new Date(),
            })
            .execute();
          return;
        }

        if (link.status === 'expired' || link.status === 'cancelled') {
          // Link expired or was cancelled
          await this.recoveryManager.transitionAttempt({
            attemptId: attempt.id,
            targetStatus: RecoveryStatus.STOPPED,
            errorMessage: `Payment link ${link.status}`,
            traceId,
          });

          await this.db
            .insertInto('audit_log')
            .values({
              recovery_attempt_id: attempt.id,
              payment_id: payment.id,
              actor: AuditActor.RECONCILER,
              action: 'reconciliation_stopped_link_inactive',
              input: { attempt_id: attempt.id, payment_link_id: paymentLinkId },
              output: { status: RecoveryStatus.STOPPED, link_status: link.status },
              error: null,
              trace_id: traceId,
              created_at: new Date(),
            })
            .execute();
          return;
        }
      }
    }

    // 3. Unprovable outcome -> Conservative Escalation per v2.1.1 §12.3
    await this.escalate(
      attempt.id,
      payment.id,
      'Payment link outcome unknown; no verified reconciliation mechanism available',
      traceId,
    );
  }

  private async escalate(attemptId: string, paymentId: string | null, reason: string, traceId: string): Promise<void> {
    await this.recoveryManager.transitionAttempt({
      attemptId,
      targetStatus: RecoveryStatus.ESCALATED,
      errorMessage: reason,
      traceId,
    });

    await this.db
      .insertInto('audit_log')
      .values({
        recovery_attempt_id: attemptId,
        payment_id: paymentId,
        actor: AuditActor.RECONCILER,
        action: 'reconciliation_failed_escalated',
        input: { attempt_id: attemptId },
        output: { status: RecoveryStatus.ESCALATED },
        error: reason,
        trace_id: traceId,
        created_at: new Date(),
      })
      .execute();
  }
}
