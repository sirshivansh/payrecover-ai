import crypto from 'node:crypto';
import {
  AIDecisionType,
  AuditActor,
  type Database,
  JobStatus,
  JobType,
  MockAIProvider,
  MockPaymentProvider,
  PolicyDecisionType,
  RecoveryActionType,
  RecoveryStatus,
} from '@payrecover/shared';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../actions/executor.js';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { JobScheduler } from '../jobs/scheduler.js';
import { RecoveryJobWorker } from '../jobs/worker.js';
import { PaymentStateService } from '../payments/state-service.js';
import { PolicyEngine } from '../policy/engine.js';
import { RecoveryManager } from '../recovery/manager.js';
import { IdempotencyService } from '../services/idempotency.service.js';

describe('Phase 9 — Recovery Job Worker & Async Orchestration (§4, §13.2)', () => {
  const env = loadEnv();
  const { db, close } = createDatabaseClient(env);

  let mockRazorpay: MockPaymentProvider;
  let mockAi: MockAIProvider;
  let paymentStateService: PaymentStateService;
  let recoveryManager: RecoveryManager;
  let policyEngine: PolicyEngine;
  let idemService: IdempotencyService;
  let actionExecutor: ActionExecutor;
  let scheduler: JobScheduler;
  let worker: RecoveryJobWorker;

  const traceId = '99999999-8888-7777-6666-555555555555';
  let createdPaymentIds: string[] = [];

  beforeAll(() => {
    mockRazorpay = new MockPaymentProvider();
    mockAi = new MockAIProvider();
    paymentStateService = new PaymentStateService(db, mockRazorpay);
    recoveryManager = new RecoveryManager(db, paymentStateService);
    policyEngine = new PolicyEngine();
    idemService = new IdempotencyService(null, db);
    actionExecutor = new ActionExecutor(mockRazorpay, db, idemService, recoveryManager, paymentStateService);
    scheduler = new JobScheduler(db);
    worker = new RecoveryJobWorker(
      db,
      paymentStateService,
      recoveryManager,
      mockAi,
      policyEngine,
      actionExecutor,
      scheduler,
      { workerId: 'worker-test-1' },
    );
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    mockAi.setScenario('recover_now');
    mockRazorpay.reset();
    createdPaymentIds = [];

    await db.deleteFrom('recovery_jobs').execute();
    await db.deleteFrom('audit_log').execute();
    await db.deleteFrom('recovery_attempts').execute();
    await db.deleteFrom('payments').execute();
  });

  async function createTestPaymentAndAttempt(amountPaise = 250000) {
    const paymentId = crypto.randomUUID();
    createdPaymentIds.push(paymentId);
    const razorpayPaymentId = `pay_test_job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    await db
      .insertInto('payments')
      .values({
        id: paymentId,
        razorpay_payment_id: razorpayPaymentId,
        amount_paise: String(amountPaise),
        currency: 'INR',
        status: 'failed',
        failure_code: 'BAD_REQUEST_ERROR',
        failure_reason: 'Card declined',
        email_hash: 'mock_email_hash',
        phone_hash: 'mock_phone_hash',
      })
      .execute();

    mockRazorpay.addMockPayment({
      id: razorpayPaymentId,
      entity: 'payment',
      amount: amountPaise,
      currency: 'INR',
      status: 'failed',
      created_at: Math.floor(Date.now() / 1000),
    });

    const attempt = await recoveryManager.createAttempt({
      paymentId,
      revenueAtRiskPaise: amountPaise,
      traceId,
    });

    return { paymentId, razorpayPaymentId, attempt };
  }

  describe('1. Job Scheduling & Creation', () => {
    it('should schedule ANALYZE, EXECUTE, VERIFY, and RECONCILE jobs', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      const analyzeJob = await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);
      expect(analyzeJob.job_type).toBe(JobType.ANALYZE);
      expect(analyzeJob.status).toBe(JobStatus.PENDING);

      const executeJob = await scheduler.scheduleExecute(attempt.id, undefined, traceId);
      expect(executeJob.job_type).toBe(JobType.EXECUTE);

      const verifyJob = await scheduler.scheduleVerify(attempt.id, undefined, traceId);
      expect(verifyJob.job_type).toBe(JobType.VERIFY);

      const reconcileJob = await scheduler.scheduleReconcile(attempt.id, undefined, traceId);
      expect(reconcileJob.job_type).toBe(JobType.RECONCILE);
    });

    it('should cancel pending jobs for an attempt', async () => {
      const { attempt } = await createTestPaymentAndAttempt();
      await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);
      await scheduler.scheduleExecute(attempt.id, undefined, traceId);

      const cancelledCount = await scheduler.cancelPendingJobsForAttempt(attempt.id, traceId);
      expect(cancelledCount).toBe(2);

      const jobs = await db
        .selectFrom('recovery_jobs')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .execute();

      expect(jobs.every((j) => j.status === JobStatus.CANCELLED)).toBe(true);
    });
  });

  describe('2. Job Claiming & Lease Safety', () => {
    it('should claim next due job atomically', async () => {
      const { attempt } = await createTestPaymentAndAttempt();
      const scheduledJob = await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);

      const claimedJob = await worker.claimNextJob();
      expect(claimedJob).toBeDefined();
      expect(claimedJob?.id).toBe(scheduledJob.id);
      expect(claimedJob?.status).toBe(JobStatus.CLAIMED);
      expect(claimedJob?.locked_by).toBe(worker.workerId);
      expect(claimedJob?.attempts).toBe(1);
    });

    it('should allow another worker to claim expired lease job', async () => {
      const { attempt } = await createTestPaymentAndAttempt();
      const scheduledJob = await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);

      // Worker 1 claims job
      const claimedByWorker1 = await worker.claimNextJob();
      expect(claimedByWorker1?.id).toBe(scheduledJob.id);

      // Simulate expired lease (locked_at 10 minutes ago)
      const tenMinsAgo = new Date(Date.now() - 600_000);
      await db.updateTable('recovery_jobs').set({ locked_at: tenMinsAgo }).where('id', '=', scheduledJob.id).execute();

      // Worker 2 claims expired job
      const worker2 = new RecoveryJobWorker(
        db,
        paymentStateService,
        recoveryManager,
        mockAi,
        policyEngine,
        actionExecutor,
        scheduler,
        { workerId: 'worker-test-2' },
      );

      const claimedByWorker2 = await worker2.claimNextJob();
      expect(claimedByWorker2).toBeDefined();
      expect(claimedByWorker2?.id).toBe(scheduledJob.id);
      expect(claimedByWorker2?.locked_by).toBe('worker-test-2');
      expect(claimedByWorker2?.attempts).toBe(2);
    });
  });

  describe('3. End-to-End Async Recovery Workflow Orchestration', () => {
    it('should orchestrate ANALYZE job -> AI recommendation -> Policy -> enqueue EXECUTE job', async () => {
      const { attempt } = await createTestPaymentAndAttempt();
      const analyzeJob = await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);

      const processedJob = await worker.processJob(analyzeJob.id, traceId);
      expect(processedJob.status).toBe(JobStatus.COMPLETED);

      // Verify recovery attempt updated to EXECUTING
      const updatedAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(updatedAttempt?.status).toBe(RecoveryStatus.EXECUTING);
      expect(updatedAttempt?.ai_decision).toBe(AIDecisionType.RECOVER_NOW);
      expect(updatedAttempt?.policy_decision).toBe(PolicyDecisionType.APPROVED);
      expect(updatedAttempt?.action_type).toBe(RecoveryActionType.CREATE_PAYMENT_LINK);

      // Verify EXECUTE job was automatically enqueued
      const jobs = await db
        .selectFrom('recovery_jobs')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('job_type', '=', JobType.EXECUTE)
        .execute();

      expect(jobs.length).toBe(1);
      expect(jobs[0]?.status).toBe(JobStatus.PENDING);
    });

    it('should orchestrate EXECUTE job -> ActionExecutor -> Razorpay link creation -> VERIFY job', async () => {
      const { attempt } = await createTestPaymentAndAttempt();
      await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);

      // Step 1: Process ANALYZE
      const nextJob1 = await worker.claimNextJob();
      expect(nextJob1?.job_type).toBe(JobType.ANALYZE);
      await worker.processJob(nextJob1?.id, traceId);

      // Step 2: Process EXECUTE
      const nextJob2 = await worker.claimNextJob();
      expect(nextJob2?.job_type).toBe(JobType.EXECUTE);
      const executeJobResult = await worker.processJob(nextJob2?.id, traceId);
      expect(executeJobResult.status).toBe(JobStatus.COMPLETED);

      // Verify attempt status updated to VERIFYING
      const verifyingAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(verifyingAttempt?.status).toBe(RecoveryStatus.VERIFYING);
      expect(verifyingAttempt?.action_result).toBeDefined();

      // Verify payment link created on mock provider
      expect(mockRazorpay.getCreatedPaymentLinks().length).toBe(1);

      // Verify VERIFY job enqueued
      const verifyJobs = await db
        .selectFrom('recovery_jobs')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .where('job_type', '=', JobType.VERIFY)
        .execute();

      expect(verifyJobs.length).toBeGreaterThan(0);
    });

    it('should orchestrate VERIFY job -> payment succeeded -> transition SUCCEEDED', async () => {
      const { attempt, razorpayPaymentId } = await createTestPaymentAndAttempt();
      await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);

      // Run ANALYZE & EXECUTE
      await worker.processNextJob(traceId);
      await worker.processNextJob(traceId);

      // Mark payment paid on Razorpay mock
      mockRazorpay.addMockPayment({
        id: razorpayPaymentId,
        entity: 'payment',
        amount: 250000,
        currency: 'INR',
        status: 'captured',
        captured: true,
        created_at: Math.floor(Date.now() / 1000),
      });

      // Process VERIFY job
      const verifyJob = await worker.claimNextJob();
      expect(verifyJob?.job_type).toBe(JobType.VERIFY);
      const verifyResult = await worker.processJob(verifyJob?.id, traceId);
      expect(verifyResult.status).toBe(JobStatus.COMPLETED);

      // Verify recovery attempt transitioned to SUCCEEDED
      const succeededAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(succeededAttempt?.status).toBe(RecoveryStatus.SUCCEEDED);
    });
  });

  describe('4. Retry Semantics & Failure Handling', () => {
    it('should schedule retry with backoff on retryable worker error', async () => {
      const { attempt } = await createTestPaymentAndAttempt();
      const job = await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);

      // Mock AI provider error
      vi.spyOn(mockAi, 'recommend').mockRejectedValueOnce(new Error('Temporary AI service glitch'));

      const resultJob = await worker.processJob(job.id, traceId);

      // Job scheduled for retry (PENDING)
      expect(resultJob.status).toBe(JobStatus.PENDING);
      expect(resultJob.error_message).toContain('Temporary AI service glitch');
    });

    it('should fail job after reaching max attempts', async () => {
      const { attempt } = await createTestPaymentAndAttempt();

      // Insert job with attempts = 3, max_attempts = 3
      const job = await db
        .insertInto('recovery_jobs')
        .values({
          recovery_attempt_id: attempt.id,
          job_type: JobType.ANALYZE,
          run_at: new Date(),
          status: JobStatus.PENDING,
          attempts: 3,
          max_attempts: 3,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Force AI provider execution error
      vi.spyOn(mockAi, 'recommend').mockRejectedValueOnce(new Error('Fatal AI Model API Error'));

      const failedJob = await worker.processJob(job.id, traceId);

      expect(failedJob.status).toBe(JobStatus.FAILED);
      expect(failedJob.error_message).toContain('Fatal AI Model API Error');

      // Verify attempt transitioned to terminal STOPPED state
      const terminalAttempt = await recoveryManager.getAttempt(attempt.id);
      expect(terminalAttempt?.status).toBe(RecoveryStatus.STOPPED);
    });
  });

  describe('5. Audit Trail & Secret Protection', () => {
    it('should log audit entries with trace_id and no secrets', async () => {
      const { attempt } = await createTestPaymentAndAttempt();
      await scheduler.scheduleAnalyze(attempt.id, undefined, traceId);

      await worker.processNextJob(traceId);

      const auditEntries = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('recovery_attempt_id', '=', attempt.id)
        .execute();

      expect(auditEntries.length).toBeGreaterThan(0);
      for (const entry of auditEntries) {
        expect(entry.trace_id).toBe(traceId);
        const json = JSON.stringify(entry);
        expect(json).not.toContain('rzp_test_');
        expect(json).not.toContain('Authorization');
      }
    });
  });
});
