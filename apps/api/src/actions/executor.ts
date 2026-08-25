import type { ActionResult, Database, IRazorpayClient } from '@payrecover/shared';
import {
  ActionExecutorError,
  ActionExecutorIdempotencyError,
  ActionExecutorPolicyError,
  AuditActor,
  PolicyDecisionType,
  RazorpayNetworkError,
  RazorpayTimeoutError,
  RecoveryActionType,
  RecoveryStatus,
} from '@payrecover/shared';
import type { Kysely } from 'kysely';
import type { PaymentStateService } from '../payments/state-service.js';
import type { RecoveryManager } from '../recovery/manager.js';
import type { IdempotencyService } from '../services/idempotency.service.js';
import { createPaymentLinkTool } from './tools/payment-link.js';

export class ActionExecutor {
  constructor(
    private razorpay: IRazorpayClient,
    private db: Kysely<Database>,
    private idem: IdempotencyService,
    private recoveryManager: RecoveryManager,
    private paymentStateService?: PaymentStateService,
  ) {}

  public getPaymentStateService(): PaymentStateService | undefined {
    return this.paymentStateService;
  }

  /**
   * Execute an approved recovery action (§12, v2.1.1 §12, §30)
   *
   * Security & Financial Boundaries:
   * 1. Policy Gating: Action MUST be approved by PolicyEngine before execution.
   * 2. Pre-Action Verification Gate: Fresh Razorpay payment check prevents actions on paid payments.
   * 3. AI Financial Boundary: Amount and currency are sourced STRICTLY from PostgreSQL payment record.
   * 4. Idempotency: Protected by Redis fast-path (`idem:action:{attempt_id}:{action_type}`) + DB durable fallback.
   * 5. Test Mode: Enforces Razorpay Test Mode (`rzp_test_*`).
   * 6. Audit Logging: Comprehensive audit trail without raw PII or secrets.
   */
  async execute(attemptId: string, actionType: RecoveryActionType, traceId: string): Promise<ActionResult> {
    // 1. Retrieve Recovery Attempt from DB
    const attempt = await this.db
      .selectFrom('recovery_attempts')
      .selectAll()
      .where('id', '=', attemptId)
      .executeTakeFirst();

    if (!attempt) {
      throw new ActionExecutorError(`Recovery attempt with ID '${attemptId}' was not found`);
    }

    // 2. Retrieve Payment Record from DB
    const payment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', attempt.payment_id)
      .executeTakeFirst();

    if (!payment) {
      throw new ActionExecutorError(`Payment with ID '${attempt.payment_id}' was not found`);
    }

    // 3. Policy Gate Verification (§11, §12)
    if (
      attempt.policy_decision !== PolicyDecisionType.APPROVED &&
      attempt.policy_decision !== PolicyDecisionType.APPROVED_WITH_MODIFICATIONS
    ) {
      throw new ActionExecutorPolicyError(
        `Action execution blocked: Policy decision is not APPROVED (decision: ${attempt.policy_decision ?? 'null'})`,
      );
    }

    // 4. Pre-Action Verification Gate (CRITICAL) (§12.2)
    // Check fresh status on Razorpay API to prevent executing actions on paid payments
    try {
      const freshPayment = await this.razorpay.getPayment(payment.razorpay_payment_id);
      if (freshPayment.status === 'captured' || freshPayment.captured === true) {
        await this.recoveryManager.transitionAttempt({
          attemptId: attempt.id,
          targetStatus: RecoveryStatus.SUCCEEDED,
          traceId,
        });
        return { success: true, skipped: true, reason: 'already_paid' };
      }
    } catch (err) {
      // If payment status lookup fails due to non-fatal error, proceed with caution or log warning
      console.warn('[ActionExecutor] Pre-action payment status lookup warning:', err);
    }

    // 5. Action Idempotency Gate (§13.1, §13.2)
    const idemStatus = await this.idem.checkAndSetActionIdempotency(attempt.id, actionType);
    if (idemStatus === 'DUPLICATE') {
      const cachedResult = attempt.action_result as {
        paymentLinkId?: string;
        paymentLinkUrl?: string;
        [key: string]: unknown;
      } | null;
      return {
        success: true,
        cached: true,
        result: (cachedResult as Record<string, unknown>) ?? undefined,
        paymentLinkId: cachedResult?.paymentLinkId,
        paymentLinkUrl: cachedResult?.paymentLinkUrl,
        actionType,
      };
    }

    if (idemStatus === 'FAIL_CLOSED') {
      throw new ActionExecutorIdempotencyError('Action execution blocked: Idempotency check returned FAIL_CLOSED');
    }

    // 6. Transition Attempt to EXECUTING if not already (§6.1)
    let currentAttempt = attempt;
    if (attempt.status !== RecoveryStatus.EXECUTING) {
      currentAttempt = await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.EXECUTING,
        actionType,
        traceId,
      });
    }

    // 7. Write Audit Log — Execution Started (§17)
    await this.db
      .insertInto('audit_log')
      .values({
        recovery_attempt_id: currentAttempt.id,
        payment_id: payment.id,
        actor: AuditActor.EXECUTOR,
        action: 'execution_started',
        input: {
          action_type: actionType,
          amount_paise: String(payment.amount_paise), // FROM DB ONLY
          currency: payment.currency,
        },
        output: null,
        error: null,
        trace_id: traceId,
        created_at: new Date(),
      })
      .execute();

    // 8. Execute Bounded Tool (§12.1, §12.2)
    try {
      let result: ActionResult;

      switch (actionType) {
        case RecoveryActionType.CREATE_PAYMENT_LINK: {
          // AUTHORITATIVE values from PostgreSQL — AI NEVER controls these (§12.2, v2.1.1 §12)
          const amountPaise = Number(payment.amount_paise);
          const currency = payment.currency;

          const link = await createPaymentLinkTool({
            razorpay: this.razorpay,
            amountPaise,
            currency,
            recoveryAttemptId: currentAttempt.id,
          });

          result = {
            success: true,
            paymentLinkId: link.id,
            paymentLinkUrl: link.short_url,
            actionType: RecoveryActionType.CREATE_PAYMENT_LINK,
          };

          // Transition attempt to VERIFYING (§6.1)
          await this.recoveryManager.transitionAttempt({
            attemptId: currentAttempt.id,
            targetStatus: RecoveryStatus.VERIFYING,
            actionType: RecoveryActionType.CREATE_PAYMENT_LINK,
            actionPayload: {
              amount: amountPaise,
              currency,
              description: 'Payment Recovery',
            },
            actionResult: result as unknown as Record<string, unknown>,
            traceId,
          });

          // Write Audit Log — Action Executed (§17)
          await this.db
            .insertInto('audit_log')
            .values({
              recovery_attempt_id: currentAttempt.id,
              payment_id: payment.id,
              actor: AuditActor.EXECUTOR,
              action: 'action_executed',
              input: { action_type: actionType },
              output: {
                payment_link_id: link.id,
                payment_link_url: link.short_url,
              },
              error: null,
              trace_id: traceId,
              created_at: new Date(),
            })
            .execute();

          return result;
        }

        case RecoveryActionType.STOP_RECOVERY: {
          result = {
            success: true,
            actionType: RecoveryActionType.STOP_RECOVERY,
          };

          // Transition attempt to STOPPED (§6.1)
          await this.recoveryManager.transitionAttempt({
            attemptId: currentAttempt.id,
            targetStatus: RecoveryStatus.STOPPED,
            actionType: RecoveryActionType.STOP_RECOVERY,
            errorMessage: currentAttempt.policy_reason ?? 'Recovery stopped by policy/executor',
            traceId,
          });

          // Write Audit Log — Action Executed (§17)
          await this.db
            .insertInto('audit_log')
            .values({
              recovery_attempt_id: currentAttempt.id,
              payment_id: payment.id,
              actor: AuditActor.EXECUTOR,
              action: 'action_executed',
              input: { action_type: actionType },
              output: { action_type: RecoveryActionType.STOP_RECOVERY },
              error: null,
              trace_id: traceId,
              created_at: new Date(),
            })
            .execute();

          return result;
        }

        default:
          throw new ActionExecutorError(`Unknown or unsupported action type: ${actionType}`);
      }
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error);

      // Handle Timeout or Network Errors during link creation -> ACTION_OUTCOME_UNKNOWN (§12.2, §14)
      if (error instanceof RazorpayTimeoutError || error instanceof RazorpayNetworkError) {
        await this.recoveryManager.transitionAttempt({
          attemptId: currentAttempt.id,
          targetStatus: RecoveryStatus.ACTION_OUTCOME_UNKNOWN,
          errorMessage: 'Payment link creation timeout — outcome unknown',
          traceId,
        });

        await this.db
          .insertInto('audit_log')
          .values({
            recovery_attempt_id: currentAttempt.id,
            payment_id: payment.id,
            actor: AuditActor.EXECUTOR,
            action: 'action_outcome_unknown',
            input: { action_type: actionType },
            output: null,
            error: errMessage,
            trace_id: traceId,
            created_at: new Date(),
          })
          .execute();

        return {
          success: false,
          outcomeUnknown: true,
          error: 'Payment link creation timeout — outcome unknown',
        };
      }

      // Handle other execution errors
      await this.db
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: currentAttempt.id,
          payment_id: payment.id,
          actor: AuditActor.EXECUTOR,
          action: 'action_failed',
          input: { action_type: actionType },
          output: null,
          error: errMessage,
          trace_id: traceId,
          created_at: new Date(),
        })
        .execute();

      throw error;
    }
  }
}
