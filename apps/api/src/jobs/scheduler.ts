import type { Database } from '@payrecover/shared';
import { AuditActor, JobStatus, JobType, type RecoveryJobRow } from '@payrecover/shared';
import type { Kysely } from 'kysely';

export interface ScheduleJobParams {
  recoveryAttemptId: string;
  jobType: JobType;
  runAt?: Date;
  maxAttempts?: number;
  traceId?: string;
}

export class JobScheduler {
  constructor(private db: Kysely<Database>) {}

  /**
   * Schedule a recovery job in PostgreSQL database (§4, §13.2)
   */
  async scheduleJob(params: ScheduleJobParams): Promise<RecoveryJobRow> {
    const runAt = params.runAt ?? new Date();
    const maxAttempts = params.maxAttempts ?? 3;

    return await this.db.transaction().execute(async (trx) => {
      const job = await trx
        .insertInto('recovery_jobs')
        .values({
          recovery_attempt_id: params.recoveryAttemptId,
          job_type: params.jobType,
          run_at: runAt,
          status: JobStatus.PENDING,
          attempts: 0,
          max_attempts: maxAttempts,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      if (params.traceId) {
        await trx
          .insertInto('audit_log')
          .values({
            recovery_attempt_id: params.recoveryAttemptId,
            actor: AuditActor.SCHEDULER,
            action: `job_scheduled_${params.jobType.toLowerCase()}`,
            input: {
              job_id: job.id,
              job_type: params.jobType,
              run_at: runAt.toISOString(),
            },
            output: { job_id: job.id, status: JobStatus.PENDING },
            error: null,
            trace_id: params.traceId,
            created_at: new Date(),
          })
          .execute();
      }

      return job;
    });
  }

  /**
   * Schedule AI Analysis Job (ANALYZE) (§4.1)
   */
  async scheduleAnalyze(recoveryAttemptId: string, runAt?: Date, traceId?: string): Promise<RecoveryJobRow> {
    return await this.scheduleJob({
      recoveryAttemptId,
      jobType: JobType.ANALYZE,
      runAt,
      traceId,
    });
  }

  /**
   * Schedule Action Execution Job (EXECUTE) (§4.2)
   */
  async scheduleExecute(recoveryAttemptId: string, runAt?: Date, traceId?: string): Promise<RecoveryJobRow> {
    return await this.scheduleJob({
      recoveryAttemptId,
      jobType: JobType.EXECUTE,
      runAt,
      traceId,
    });
  }

  /**
   * Schedule Outcome Verification Job (VERIFY) (§4.3)
   */
  async scheduleVerify(recoveryAttemptId: string, runAt?: Date, traceId?: string): Promise<RecoveryJobRow> {
    return await this.scheduleJob({
      recoveryAttemptId,
      jobType: JobType.VERIFY,
      runAt,
      traceId,
    });
  }

  /**
   * Schedule External Reconciliation Job (RECONCILE) (§4.4)
   */
  async scheduleReconcile(recoveryAttemptId: string, runAt?: Date, traceId?: string): Promise<RecoveryJobRow> {
    return await this.scheduleJob({
      recoveryAttemptId,
      jobType: JobType.RECONCILE,
      runAt,
      traceId,
    });
  }

  /**
   * Cancel all pending recovery jobs for a given attempt (§4.4)
   */
  async cancelPendingJobsForAttempt(recoveryAttemptId: string, traceId?: string): Promise<number> {
    return await this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('recovery_jobs')
        .set({
          status: JobStatus.CANCELLED,
          updated_at: new Date(),
        })
        .where('recovery_attempt_id', '=', recoveryAttemptId)
        .where('status', '=', JobStatus.PENDING)
        .executeTakeFirst();

      const count = Number(result.numUpdatedRows);

      if (count > 0 && traceId) {
        await trx
          .insertInto('audit_log')
          .values({
            recovery_attempt_id: recoveryAttemptId,
            actor: AuditActor.SCHEDULER,
            action: 'pending_jobs_cancelled',
            input: { count },
            output: { cancelled_count: count },
            error: null,
            trace_id: traceId,
            created_at: new Date(),
          })
          .execute();
      }

      return count;
    });
  }
}
