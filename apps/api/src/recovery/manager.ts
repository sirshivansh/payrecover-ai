import crypto from 'node:crypto';
import {
  AuditActor,
  ConcurrentRecoveryError,
  type CreateAttemptParams,
  DEFAULT_MERCHANT_CONFIG_JSON,
  type Database,
  RecoveryAttemptNotFoundError,
  type RecoveryAttemptRow,
  type RecoveryAttemptUpdate,
  RecoveryStatus,
  type TransitionAttemptParams,
  isTerminalPaymentStatus,
  isTerminalRecoveryStatus,
} from '@payrecover/shared';
import type { Kysely } from 'kysely';
import type { PaymentStateService } from '../payments/state-service.js';
import { validateTransition } from './state-machine.js';

export class RecoveryManager {
  constructor(
    private db: Kysely<Database>,
    private paymentStateService?: PaymentStateService,
  ) {}

  public getPaymentStateService(): PaymentStateService | undefined {
    return this.paymentStateService;
  }

  /**
   * Ensure traceId is a valid UUID for audit logging
   */
  private ensureUuidTraceId(traceId?: string): string {
    if (traceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(traceId)) {
      return traceId;
    }
    return crypto.randomUUID();
  }

  /**
   * Create a new recovery attempt atomically with PostgreSQL row-locking & UNIQUE constraint handling (§4.1, §6, §13.2)
   */
  async createAttempt(params: CreateAttemptParams): Promise<RecoveryAttemptRow> {
    const traceId = this.ensureUuidTraceId(params.traceId);

    return await this.db.transaction().execute(async (trx) => {
      // 1. Lock payment row to serialize concurrent createAttempt calls (§13.2)
      const payment = await trx
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', params.paymentId)
        .forUpdate()
        .executeTakeFirst();

      if (!payment) {
        throw new Error(`Payment with ID '${params.paymentId}' was not found`);
      }

      // 2. Reject attempt creation if payment is already in terminal state (§5)
      if (isTerminalPaymentStatus(payment.status)) {
        throw new Error(`Cannot start recovery for payment in terminal status '${payment.status}'`);
      }

      // 3. Query existing attempts for this payment (§6, §13.2)
      const existingAttempts = await trx
        .selectFrom('recovery_attempts')
        .selectAll()
        .where('payment_id', '=', params.paymentId)
        .orderBy('attempt_number', 'desc')
        .forUpdate()
        .execute();

      // Check if there is already an active non-terminal attempt
      const activeAttempt = existingAttempts.find((att) => !isTerminalRecoveryStatus(att.status));
      if (activeAttempt) {
        return activeAttempt;
      }

      // 4. Calculate sequential attempt_number
      const latestAttempt = existingAttempts[0];
      const attemptNumber = latestAttempt ? latestAttempt.attempt_number + 1 : 1;

      // 5. Determine revenue_at_risk_paise
      const revenueAtRiskPaise = params.revenueAtRiskPaise ?? payment.amount_paise;
      const policySnapshot = params.policySnapshot ?? DEFAULT_MERCHANT_CONFIG_JSON;

      // 6. Insert new attempt row with PENDING status
      let createdAttempt: RecoveryAttemptRow;
      try {
        createdAttempt = await trx
          .insertInto('recovery_attempts')
          .values({
            payment_id: payment.id,
            attempt_number: attemptNumber,
            status: RecoveryStatus.PENDING,
            revenue_at_risk_paise: String(revenueAtRiskPaise),
            policy_snapshot: policySnapshot,
            started_at: new Date(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error: unknown) {
        const errObj = error as { code?: string; message?: string };
        if (errObj.code === '23505' || errObj.message?.includes('duplicate key')) {
          throw new ConcurrentRecoveryError(`Concurrent attempt creation conflict for payment '${params.paymentId}'`);
        }
        throw error;
      }

      // 7. Write audit log entry (§17)
      await trx
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: createdAttempt.id,
          payment_id: payment.id,
          actor: AuditActor.SCHEDULER,
          action: 'recovery_attempt_created',
          input: {
            payment_id: payment.id,
            attempt_number: attemptNumber,
            revenue_at_risk_paise: String(revenueAtRiskPaise),
          },
          output: {
            attempt_id: createdAttempt.id,
            status: RecoveryStatus.PENDING,
          },
          error: null,
          trace_id: traceId,
          created_at: new Date(),
        })
        .execute();

      return createdAttempt;
    });
  }

  /**
   * Retrieve recovery attempt by ID
   */
  async getAttempt(id: string): Promise<RecoveryAttemptRow | undefined> {
    return await this.db.selectFrom('recovery_attempts').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Retrieve latest recovery attempt for a payment
   */
  async getLatestAttemptForPayment(paymentId: string): Promise<RecoveryAttemptRow | undefined> {
    return await this.db
      .selectFrom('recovery_attempts')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .orderBy('attempt_number', 'desc')
      .executeTakeFirst();
  }

  /**
   * List all recovery attempts for a payment in chronological order
   */
  async listAttemptsForPayment(paymentId: string): Promise<RecoveryAttemptRow[]> {
    return await this.db
      .selectFrom('recovery_attempts')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .orderBy('attempt_number', 'asc')
      .execute();
  }

  /**
   * Execute state transition on a recovery attempt (§6, §6.1)
   */
  async transitionAttempt(params: TransitionAttemptParams): Promise<RecoveryAttemptRow> {
    const traceId = this.ensureUuidTraceId(params.traceId);

    return await this.db.transaction().execute(async (trx) => {
      const attempt = await trx
        .selectFrom('recovery_attempts')
        .selectAll()
        .where('id', '=', params.attemptId)
        .forUpdate()
        .executeTakeFirst();

      if (!attempt) {
        throw new RecoveryAttemptNotFoundError(params.attemptId);
      }

      // Enforce state transition rules (§6.1)
      validateTransition(attempt.status, params.targetStatus);

      const isTerminal = isTerminalRecoveryStatus(params.targetStatus);
      const completedAt = isTerminal ? new Date() : undefined;

      const updateValues: RecoveryAttemptUpdate = {
        status: params.targetStatus,
        completed_at: completedAt,
      };

      if (params.aiRecommendation !== undefined) updateValues.ai_recommendation = params.aiRecommendation;
      if (params.aiDecision !== undefined) updateValues.ai_decision = params.aiDecision;
      if (params.aiConfidence !== undefined) updateValues.ai_confidence = String(params.aiConfidence);
      if (params.aiReasoning !== undefined) updateValues.ai_reasoning = params.aiReasoning;
      if (params.policyDecision !== undefined) updateValues.policy_decision = params.policyDecision;
      if (params.policyReason !== undefined) updateValues.policy_reason = params.policyReason;
      if (params.policyModifications !== undefined) updateValues.policy_modifications = params.policyModifications;
      if (params.actionType !== undefined) updateValues.action_type = params.actionType;
      if (params.actionPayload !== undefined) updateValues.action_payload = params.actionPayload;
      if (params.actionResult !== undefined) updateValues.action_result = params.actionResult;
      if (params.nextRetryAt !== undefined) updateValues.next_retry_at = params.nextRetryAt;
      if (params.errorMessage !== undefined) updateValues.error_message = params.errorMessage;

      const updated = await trx
        .updateTable('recovery_attempts')
        .set(updateValues)
        .where('id', '=', params.attemptId)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Write audit log entry for transition (§17)
      await trx
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: updated.id,
          payment_id: updated.payment_id,
          actor: AuditActor.VERIFIER,
          action: `recovery_transition_${params.targetStatus.toLowerCase()}`,
          input: {
            from_status: attempt.status,
            to_status: params.targetStatus,
          },
          output: {
            attempt_id: updated.id,
            status: params.targetStatus,
            completed_at: updated.completed_at,
          },
          error: params.errorMessage ?? null,
          trace_id: traceId,
          created_at: new Date(),
        })
        .execute();

      return updated;
    });
  }

  /**
   * Stop recovery for a payment by transitioning active attempt to STOPPED (§6.1)
   */
  async stopRecovery(paymentId: string, reason: string, traceId?: string): Promise<RecoveryAttemptRow> {
    const active = await this.getLatestAttemptForPayment(paymentId);
    if (!active) {
      throw new Error(`No recovery attempt found for payment '${paymentId}'`);
    }

    if (isTerminalRecoveryStatus(active.status)) {
      return active;
    }

    return await this.transitionAttempt({
      attemptId: active.id,
      targetStatus: RecoveryStatus.STOPPED,
      errorMessage: reason,
      traceId,
    });
  }
}
