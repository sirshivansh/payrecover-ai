import crypto from 'node:crypto';
import type {
  AIProvider,
  AIRecommendation,
  AgentContext,
  Database,
  MerchantConfig,
  PolicyContext,
  RecoveryJobRow,
} from '@payrecover/shared';
import {
  AIDecisionType,
  AuditActor,
  JobStatus as JobStatusEnum,
  JobType,
  PolicyDecisionType,
  RecoveryActionType,
  RecoveryStatus,
} from '@payrecover/shared';
import type { Kysely } from 'kysely';
import type { ActionExecutor } from '../actions/executor.js';
import type { PaymentStateService } from '../payments/state-service.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { RecoveryManager } from '../recovery/manager.js';
import { canTransition } from '../recovery/state-machine.js';
import type { JobScheduler } from './scheduler.js';

export interface WorkerOptions {
  workerId?: string;
  leaseTimeoutMs?: number;
}

export class RecoveryJobWorker {
  readonly workerId: string;
  private readonly leaseTimeoutMs: number;

  constructor(
    private db: Kysely<Database>,
    private paymentStateService: PaymentStateService,
    private recoveryManager: RecoveryManager,
    private aiProvider: AIProvider,
    private policyEngine: PolicyEngine,
    private actionExecutor: ActionExecutor,
    private jobScheduler: JobScheduler,
    options?: WorkerOptions,
  ) {
    this.workerId = options?.workerId ?? `worker-${crypto.randomUUID().substring(0, 8)}`;
    this.leaseTimeoutMs = options?.leaseTimeoutMs ?? 300_000; // 5 minutes default lease
  }

  /**
   * Atomic claim of due job using PostgreSQL SELECT ... FOR UPDATE SKIP LOCKED (§4, §13.2)
   */
  async claimNextJob(): Promise<RecoveryJobRow | undefined> {
    const now = new Date();
    const expiredCutoff = new Date(now.getTime() - this.leaseTimeoutMs);

    return await this.db.transaction().execute(async (trx) => {
      const job = await trx
        .selectFrom('recovery_jobs')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', JobStatusEnum.PENDING), eb('run_at', '<=', now)]),
            eb.and([eb('status', '=', JobStatusEnum.CLAIMED), eb('locked_at', '<=', expiredCutoff)]),
          ]),
        )
        .orderBy('run_at', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!job) {
        return undefined;
      }

      const updatedJob = await trx
        .updateTable('recovery_jobs')
        .set({
          status: JobStatusEnum.CLAIMED,
          locked_at: now,
          locked_by: this.workerId,
          attempts: job.attempts + 1,
          updated_at: now,
        })
        .where('id', '=', job.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      return updatedJob;
    });
  }

  /**
   * Process a claimed job by ID (§4.1 - §4.4)
   */
  async processJob(jobId: string, traceIdInput?: string): Promise<RecoveryJobRow> {
    const traceId = traceIdInput ?? crypto.randomUUID();

    // 1. Retrieve job record
    let job = await this.db.selectFrom('recovery_jobs').selectAll().where('id', '=', jobId).executeTakeFirst();

    if (!job) {
      throw new Error(`Recovery job with ID '${jobId}' was not found`);
    }

    // 2. Ensure job is claimed by this worker
    const isNewClaim = job.status !== JobStatusEnum.CLAIMED || job.locked_by !== this.workerId;
    job = await this.db
      .updateTable('recovery_jobs')
      .set({
        status: JobStatusEnum.CLAIMED,
        locked_at: new Date(),
        locked_by: this.workerId,
        attempts: isNewClaim ? job.attempts + 1 : job.attempts,
        updated_at: new Date(),
      })
      .where('id', '=', jobId)
      .returningAll()
      .executeTakeFirstOrThrow();

    try {
      switch (job.job_type) {
        case JobType.ANALYZE:
          await this.processAnalyzeJob(job, traceId);
          break;
        case JobType.EXECUTE:
          await this.processExecuteJob(job, traceId);
          break;
        case JobType.VERIFY:
          await this.processVerifyJob(job, traceId);
          break;
        case JobType.RECONCILE:
          await this.processReconcileJob(job, traceId);
          break;
        default:
          throw new Error(`Unknown job_type: ${job.job_type}`);
      }

      return await this.markJobCompleted(job.id);
    } catch (error: unknown) {
      return await this.handleJobError(job, error, traceId);
    }
  }

  /**
   * Claim and process next available job in single call (§4)
   */
  async processNextJob(traceId?: string): Promise<RecoveryJobRow | undefined> {
    const claimed = await this.claimNextJob();
    if (!claimed) {
      return undefined;
    }
    return await this.processJob(claimed.id, traceId);
  }

  // ─── Private Workflow Handlers ─────────────────────────────────────

  /**
   * Process ANALYZE Job (§4.2)
   */
  private async processAnalyzeJob(job: RecoveryJobRow, traceId: string): Promise<void> {
    const attempt = await this.recoveryManager.getAttempt(job.recovery_attempt_id);
    if (!attempt) {
      throw new Error(`Recovery attempt '${job.recovery_attempt_id}' not found`);
    }

    const payment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', attempt.payment_id)
      .executeTakeFirst();

    if (!payment) {
      throw new Error(`Payment '${attempt.payment_id}' not found`);
    }

    // Pre-condition: Check terminal state
    if (payment.status === 'paid' || payment.status === 'refunded' || payment.status === 'cancelled') {
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.STOPPED,
        errorMessage: `Payment in terminal status '${payment.status}'`,
        traceId,
      });
      return;
    }

    // 1. Transition attempt PENDING -> ANALYZING
    if (attempt.status === RecoveryStatus.PENDING) {
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ANALYZING,
        traceId,
      });
    }

    // 2. Build sanitized AgentContext (§10.1, v2.1.1 §10.1)
    const agentContext: AgentContext = {
      payment: {
        razorpayPaymentId: payment.razorpay_payment_id,
        amountPaise: Number(payment.amount_paise), // Read-only context
        currency: payment.currency,
        method: payment.method ?? 'card',
        failureCode: payment.failure_code,
        failureReason: payment.failure_reason,
        hasEmail: Boolean(payment.email_hash),
        hasPhone: Boolean(payment.phone_hash),
        hasCustomerName: Boolean(payment.customer_name_hash),
        createdAt: payment.created_at instanceof Date ? payment.created_at.toISOString() : String(payment.created_at),
      },
      policy: attempt.policy_snapshot as unknown as AgentContext['policy'],
      attemptNumber: attempt.attempt_number,
      previousAttempts: [],
      customerHistory: {
        totalPayments: 1,
        successfulPayments: 0,
        failedPayments: 1,
        recoveredPayments: 0,
        avgTimeToRecoveryHours: null,
      },
      allowedActions: [RecoveryActionType.CREATE_PAYMENT_LINK, RecoveryActionType.STOP_RECOVERY],
      isBusinessHours: true,
      currentTime: new Date().toISOString(),
    };

    // 3. Call AIProvider (§10)
    const recommendation: AIRecommendation = await this.aiProvider.recommend(agentContext);

    // 4. Transition ANALYZING -> POLICY_CHECK & store AI recommendation
    await this.recoveryManager.transitionAttempt({
      attemptId: attempt.id,
      targetStatus: RecoveryStatus.POLICY_CHECK,
      aiRecommendation: recommendation as unknown as Record<string, unknown>,
      aiDecision: recommendation.decision,
      aiConfidence: recommendation.confidence,
      aiReasoning: recommendation.reasoning,
      traceId,
    });

    // 5. Evaluate Policy Engine (§11)
    const policyContext: PolicyContext = {
      attemptNumber: attempt.attempt_number,
      lastAttemptAt:
        attempt.attempt_number > 1
          ? attempt.started_at instanceof Date
            ? attempt.started_at
            : new Date(attempt.started_at)
          : null,
      hasEmail: Boolean(payment.email_hash),
      hasPhone: Boolean(payment.phone_hash),
      isBusinessHours: true,
      paymentAmountPaise: BigInt(payment.amount_paise),
    };

    const evalNow = new Date();
    const snapshotConfig = parseSnapshotConfig(attempt.policy_snapshot as Record<string, unknown>);
    const policyResult = this.policyEngine.evaluate(recommendation, policyContext, snapshotConfig, evalNow);

    // Audit log policy decision
    await this.db
      .insertInto('audit_log')
      .values({
        recovery_attempt_id: attempt.id,
        payment_id: payment.id,
        actor: AuditActor.POLICY,
        action: `policy_${policyResult.decision.toLowerCase()}`,
        input: { recommendation },
        output: sanitizeForJson(policyResult) as Record<string, unknown>,
        error: null,
        trace_id: traceId,
        created_at: new Date(),
      })
      .execute();

    // 6. Decision Routing (§4.2)
    if (recommendation.decision === AIDecisionType.ESCALATE && policyResult.decision === PolicyDecisionType.APPROVED) {
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ESCALATED,
        policyDecision: policyResult.decision,
        policyReason: policyResult.reason,
        traceId,
      });
      return;
    }

    if (policyResult.decision === PolicyDecisionType.REJECTED) {
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.STOPPED,
        policyDecision: policyResult.decision,
        policyReason: policyResult.reason,
        errorMessage: policyResult.reason,
        traceId,
      });
      return;
    }

    if (
      policyResult.decision === PolicyDecisionType.APPROVED ||
      policyResult.decision === PolicyDecisionType.APPROVED_WITH_MODIFICATIONS
    ) {
      // Policy Approved -> Transition to EXECUTING & Schedule EXECUTE Job
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.EXECUTING,
        policyDecision: policyResult.decision,
        policyReason: policyResult.reason,
        actionType: policyResult.approvedAction ?? RecoveryActionType.CREATE_PAYMENT_LINK,
        traceId,
      });

      await this.jobScheduler.scheduleExecute(attempt.id, undefined, traceId);
    }
  }

  /**
   * Process EXECUTE Job (§4.3)
   */
  private async processExecuteJob(job: RecoveryJobRow, traceId: string): Promise<void> {
    const attempt = await this.recoveryManager.getAttempt(job.recovery_attempt_id);
    if (!attempt) {
      throw new Error(`Recovery attempt '${job.recovery_attempt_id}' not found`);
    }

    const actionType = attempt.action_type ?? RecoveryActionType.CREATE_PAYMENT_LINK;
    const result = await this.actionExecutor.execute(attempt.id, actionType, traceId);

    if (result.skipped) {
      await this.jobScheduler.cancelPendingJobsForAttempt(attempt.id, traceId);
      return;
    }

    if (result.success && actionType === RecoveryActionType.CREATE_PAYMENT_LINK) {
      await this.jobScheduler.scheduleVerify(attempt.id, undefined, traceId);
    }

    if (result.outcomeUnknown) {
      // Schedule RECONCILE job for outcome unknown
      await this.jobScheduler.scheduleReconcile(attempt.id, undefined, traceId);
    }
  }

  /**
   * Process VERIFY Job (§4.4)
   */
  private async processVerifyJob(job: RecoveryJobRow, traceId: string): Promise<void> {
    const attempt = await this.recoveryManager.getAttempt(job.recovery_attempt_id);
    if (!attempt) {
      throw new Error(`Recovery attempt '${job.recovery_attempt_id}' not found`);
    }

    const payment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', attempt.payment_id)
      .executeTakeFirst();

    if (!payment) {
      throw new Error(`Payment '${attempt.payment_id}' not found`);
    }

    // Check fresh status on PaymentStateService / Razorpay API using razorpay_payment_id
    const freshPayment = await this.paymentStateService.getPayment(payment.razorpay_payment_id, {
      forceRefresh: true,
      traceId,
    });

    if (freshPayment && (freshPayment.status === 'paid' || freshPayment.paid_at !== null)) {
      // Payment Succeeded!
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.SUCCEEDED,
        traceId,
      });

      await this.jobScheduler.cancelPendingJobsForAttempt(attempt.id, traceId);

      await this.db
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: attempt.id,
          payment_id: payment.id,
          actor: AuditActor.VERIFIER,
          action: 'recovery_verified_succeeded',
          input: { attempt_id: attempt.id },
          output: { status: RecoveryStatus.SUCCEEDED },
          error: null,
          trace_id: traceId,
          created_at: new Date(),
        })
        .execute();
      return;
    }

    // If payment still failed: check retry eligibility
    const snapshot = attempt.policy_snapshot as unknown as AgentContext['policy'];
    const maxAttempts = snapshot?.maxAttempts ?? 3;

    if (attempt.attempt_number < maxAttempts) {
      // Retry eligible -> create new attempt & schedule ANALYZE (§4.4)
      const newAttempt = await this.recoveryManager.createAttempt({
        paymentId: payment.id,
        revenueAtRiskPaise: Number(payment.amount_paise),
        policySnapshot: snapshot as unknown as Record<string, unknown>,
        traceId,
      });

      await this.jobScheduler.scheduleAnalyze(newAttempt.id, undefined, traceId);
    } else {
      // Exceeded max attempts -> STOPPED
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.STOPPED,
        errorMessage: 'Max recovery attempts reached',
        traceId,
      });
    }
  }

  /**
   * Process RECONCILE Job (§4.4, v2.1.1 §12.3)
   */
  private async processReconcileJob(job: RecoveryJobRow, traceId: string): Promise<void> {
    const attempt = await this.recoveryManager.getAttempt(job.recovery_attempt_id);
    if (!attempt) {
      throw new Error(`Recovery attempt '${job.recovery_attempt_id}' not found`);
    }

    if (attempt.status === RecoveryStatus.ACTION_OUTCOME_UNKNOWN) {
      // Conservative reconciliation per v2.1.1 §12.3: escalate if outcome cannot be proven
      await this.recoveryManager.transitionAttempt({
        attemptId: attempt.id,
        targetStatus: RecoveryStatus.ESCALATED,
        errorMessage: 'Outcome unknown after reconciliation',
        traceId,
      });

      await this.db
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: attempt.id,
          payment_id: attempt.payment_id,
          actor: AuditActor.RECONCILER,
          action: 'reconciliation_failed_escalated',
          input: { attempt_id: attempt.id },
          output: { status: RecoveryStatus.ESCALATED },
          error: 'Outcome unknown after reconciliation',
          trace_id: traceId,
          created_at: new Date(),
        })
        .execute();
    }
  }

  /**
   * Mark job completed (§4)
   */
  private async markJobCompleted(jobId: string): Promise<RecoveryJobRow> {
    return await this.db
      .updateTable('recovery_jobs')
      .set({
        status: JobStatusEnum.COMPLETED,
        completed_at: new Date(),
        locked_at: null,
        locked_by: null,
        updated_at: new Date(),
      })
      .where('id', '=', jobId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Handle job error & retry logic (§4, §13.2)
   */
  private async handleJobError(job: RecoveryJobRow, error: unknown, traceId: string): Promise<RecoveryJobRow> {
    const errMessage = error instanceof Error ? error.message : String(error);
    const now = new Date();

    if (job.attempts < job.max_attempts) {
      // Retryable -> Exponential backoff run_at
      const backoffMs = 2 ** job.attempts * 1000;
      const nextRunAt = new Date(now.getTime() + backoffMs);

      const retryJob = await this.db
        .updateTable('recovery_jobs')
        .set({
          status: JobStatusEnum.PENDING,
          run_at: nextRunAt,
          locked_at: null,
          locked_by: null,
          error_message: errMessage,
          updated_at: now,
        })
        .where('id', '=', job.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.db
        .insertInto('audit_log')
        .values({
          recovery_attempt_id: job.recovery_attempt_id,
          actor: AuditActor.SCHEDULER,
          action: 'job_retry_scheduled',
          input: { job_id: job.id, attempts: job.attempts },
          output: { next_run_at: nextRunAt.toISOString() },
          error: errMessage,
          trace_id: traceId,
          created_at: now,
        })
        .execute();

      return retryJob;
    }

    // Retries exhausted -> Permanent Job Failure
    const failedJob = await this.db
      .updateTable('recovery_jobs')
      .set({
        status: JobStatusEnum.FAILED,
        completed_at: now,
        locked_at: null,
        locked_by: null,
        error_message: errMessage,
        updated_at: now,
      })
      .where('id', '=', job.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const attempt = await this.recoveryManager.getAttempt(job.recovery_attempt_id);
    const targetStatus =
      attempt && canTransition(attempt.status, RecoveryStatus.ESCALATED)
        ? RecoveryStatus.ESCALATED
        : RecoveryStatus.STOPPED;

    await this.recoveryManager.transitionAttempt({
      attemptId: job.recovery_attempt_id,
      targetStatus,
      errorMessage: `Job execution failed after ${job.attempts} attempts: ${errMessage}`,
      traceId,
    });

    await this.db
      .insertInto('audit_log')
      .values({
        recovery_attempt_id: job.recovery_attempt_id,
        actor: AuditActor.SCHEDULER,
        action: 'job_failed_max_retries',
        input: { job_id: job.id, max_attempts: job.max_attempts },
        output: { status: JobStatusEnum.FAILED },
        error: errMessage,
        trace_id: traceId,
        created_at: now,
      })
      .execute();

    return failedJob;
  }
}

interface SnapshotLike {
  maxAttempts?: number | string;
  cooldownHours?: number | string;
  allowedActions?: RecoveryActionType[];
  minAmountPaise?: number | string | bigint;
  maxAmountPaise?: number | string | bigint;
  businessHoursStart?: number | string;
  businessHoursEnd?: number | string;
  timezone?: string;
  confidenceThreshold?: number | string;
}

/**
 * Safely parse policy snapshot JSONB into a typed MerchantConfig with BigInt amounts
 */
function parseSnapshotConfig(snapshot: Record<string, unknown>): MerchantConfig {
  const s = snapshot as SnapshotLike;
  return {
    maxAttempts: Number(s.maxAttempts ?? 3),
    cooldownHours: Number(s.cooldownHours ?? 24),
    allowedActions: s.allowedActions ?? [RecoveryActionType.CREATE_PAYMENT_LINK, RecoveryActionType.STOP_RECOVERY],
    minAmountPaise: BigInt(String(s.minAmountPaise ?? 10000)),
    maxAmountPaise: BigInt(String(s.maxAmountPaise ?? 10000000)),
    businessHoursStart: Number(s.businessHoursStart ?? 9),
    businessHoursEnd: Number(s.businessHoursEnd ?? 21),
    timezone: String(s.timezone ?? 'Asia/Kolkata'),
    confidenceThreshold: Number(s.confidenceThreshold ?? 0.6),
  };
}

/**
 * Recursively convert BigInt values to strings so object can be safely JSON.stringify'd
 */
function sanitizeForJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeForJson);
  if (typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      res[key] = sanitizeForJson(value);
    }
    return res;
  }
  return obj;
}
