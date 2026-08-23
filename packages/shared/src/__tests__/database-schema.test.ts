import { describe, expect, it } from 'vitest';
import {
  AIDecisionType,
  AuditActor,
  JobStatus,
  JobType,
  PaymentStatus,
  PolicyDecisionType,
  RecoveryActionType,
  RecoveryStatus,
} from '../domain/enums.js';

describe('Database Domain Enums Alignment', () => {
  it('should match spec values for PaymentStatus', () => {
    expect(PaymentStatus.CREATED).toBe('created');
    expect(PaymentStatus.ATTEMPTED).toBe('attempted');
    expect(PaymentStatus.PAID).toBe('paid');
    expect(PaymentStatus.FAILED).toBe('failed');
    expect(PaymentStatus.REFUNDED).toBe('refunded');
    expect(PaymentStatus.CANCELLED).toBe('cancelled');
  });

  it('should match spec values for RecoveryStatus', () => {
    expect(RecoveryStatus.PENDING).toBe('pending');
    expect(RecoveryStatus.ANALYZING).toBe('analyzing');
    expect(RecoveryStatus.POLICY_CHECK).toBe('policy_check');
    expect(RecoveryStatus.EXECUTING).toBe('executing');
    expect(RecoveryStatus.ACTION_OUTCOME_UNKNOWN).toBe('action_outcome_unknown');
    expect(RecoveryStatus.VERIFYING).toBe('verifying');
    expect(RecoveryStatus.SUCCEEDED).toBe('succeeded');
    expect(RecoveryStatus.FAILED).toBe('failed');
    expect(RecoveryStatus.STOPPED).toBe('stopped');
    expect(RecoveryStatus.ESCALATED).toBe('escalated');
  });

  it('should match spec values for RecoveryActionType', () => {
    expect(RecoveryActionType.CREATE_PAYMENT_LINK).toBe('create_payment_link');
    expect(RecoveryActionType.STOP_RECOVERY).toBe('stop_recovery');
  });

  it('should match spec values for AIDecisionType', () => {
    expect(AIDecisionType.RECOVER_NOW).toBe('recover_now');
    expect(AIDecisionType.STOP).toBe('stop');
    expect(AIDecisionType.ESCALATE).toBe('escalate');
  });

  it('should match spec values for PolicyDecisionType', () => {
    expect(PolicyDecisionType.APPROVED).toBe('approved');
    expect(PolicyDecisionType.REJECTED).toBe('rejected');
    expect(PolicyDecisionType.APPROVED_WITH_MODIFICATIONS).toBe('approved_with_modifications');
  });

  it('should match spec values for JobType', () => {
    expect(JobType.ANALYZE).toBe('analyze');
    expect(JobType.EXECUTE).toBe('execute');
    expect(JobType.VERIFY).toBe('verify');
    expect(JobType.RECONCILE).toBe('reconcile');
  });

  it('should match spec values for JobStatus', () => {
    expect(JobStatus.PENDING).toBe('pending');
    expect(JobStatus.CLAIMED).toBe('claimed');
    expect(JobStatus.COMPLETED).toBe('completed');
    expect(JobStatus.FAILED).toBe('failed');
    expect(JobStatus.CANCELLED).toBe('cancelled');
  });

  it('should match spec values for AuditActor', () => {
    expect(AuditActor.WEBHOOK).toBe('webhook');
    expect(AuditActor.AI).toBe('ai');
    expect(AuditActor.POLICY).toBe('policy');
    expect(AuditActor.EXECUTOR).toBe('executor');
    expect(AuditActor.VERIFIER).toBe('verifier');
    expect(AuditActor.SCHEDULER).toBe('scheduler');
    expect(AuditActor.RECONCILER).toBe('reconciler');
  });
});
