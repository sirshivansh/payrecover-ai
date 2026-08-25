import { InvalidStateTransitionError, RecoveryStatus } from '@payrecover/shared';
import { describe, expect, it } from 'vitest';
import { canTransition, validateTransition } from '../recovery/state-machine.js';

describe('Phase 4 — RecoveryStateMachine Transition Rules', () => {
  describe('Valid State Transitions (§6.1, v2.1.1 §6.1)', () => {
    it('should allow valid PENDING transitions', () => {
      expect(canTransition(RecoveryStatus.PENDING, RecoveryStatus.ANALYZING)).toBe(true);
      expect(canTransition(RecoveryStatus.PENDING, RecoveryStatus.STOPPED)).toBe(true);
      expect(canTransition(RecoveryStatus.PENDING, RecoveryStatus.SUCCEEDED)).toBe(true); // payment.captured
    });

    it('should allow valid ANALYZING transitions', () => {
      expect(canTransition(RecoveryStatus.ANALYZING, RecoveryStatus.POLICY_CHECK)).toBe(true);
      expect(canTransition(RecoveryStatus.ANALYZING, RecoveryStatus.STOPPED)).toBe(true);
      expect(canTransition(RecoveryStatus.ANALYZING, RecoveryStatus.SUCCEEDED)).toBe(true);
    });

    it('should allow valid POLICY_CHECK transitions (v2.1.1 §6.1 corrected escalation)', () => {
      expect(canTransition(RecoveryStatus.POLICY_CHECK, RecoveryStatus.EXECUTING)).toBe(true);
      expect(canTransition(RecoveryStatus.POLICY_CHECK, RecoveryStatus.STOPPED)).toBe(true);
      expect(canTransition(RecoveryStatus.POLICY_CHECK, RecoveryStatus.ESCALATED)).toBe(true);
      expect(canTransition(RecoveryStatus.POLICY_CHECK, RecoveryStatus.SUCCEEDED)).toBe(true);
    });

    it('should allow valid EXECUTING transitions', () => {
      expect(canTransition(RecoveryStatus.EXECUTING, RecoveryStatus.VERIFYING)).toBe(true);
      expect(canTransition(RecoveryStatus.EXECUTING, RecoveryStatus.SUCCEEDED)).toBe(true);
      expect(canTransition(RecoveryStatus.EXECUTING, RecoveryStatus.ACTION_OUTCOME_UNKNOWN)).toBe(true);
      expect(canTransition(RecoveryStatus.EXECUTING, RecoveryStatus.FAILED)).toBe(true);
      expect(canTransition(RecoveryStatus.EXECUTING, RecoveryStatus.STOPPED)).toBe(true);
    });

    it('should allow valid ACTION_OUTCOME_UNKNOWN transitions', () => {
      expect(canTransition(RecoveryStatus.ACTION_OUTCOME_UNKNOWN, RecoveryStatus.SUCCEEDED)).toBe(true);
      expect(canTransition(RecoveryStatus.ACTION_OUTCOME_UNKNOWN, RecoveryStatus.VERIFYING)).toBe(true);
      expect(canTransition(RecoveryStatus.ACTION_OUTCOME_UNKNOWN, RecoveryStatus.ESCALATED)).toBe(true);
      expect(canTransition(RecoveryStatus.ACTION_OUTCOME_UNKNOWN, RecoveryStatus.STOPPED)).toBe(true);
    });

    it('should allow valid VERIFYING transitions', () => {
      expect(canTransition(RecoveryStatus.VERIFYING, RecoveryStatus.SUCCEEDED)).toBe(true);
      expect(canTransition(RecoveryStatus.VERIFYING, RecoveryStatus.PENDING)).toBe(true);
      expect(canTransition(RecoveryStatus.VERIFYING, RecoveryStatus.STOPPED)).toBe(true);
    });

    it('should allow valid FAILED transitions', () => {
      expect(canTransition(RecoveryStatus.FAILED, RecoveryStatus.PENDING)).toBe(true);
      expect(canTransition(RecoveryStatus.FAILED, RecoveryStatus.STOPPED)).toBe(true);
      expect(canTransition(RecoveryStatus.FAILED, RecoveryStatus.SUCCEEDED)).toBe(true);
    });
  });

  describe('Invalid State Transitions & Terminal Sinks (§6.1 Invariant 5)', () => {
    it('should reject transitions from terminal state SUCCEEDED', () => {
      expect(canTransition(RecoveryStatus.SUCCEEDED, RecoveryStatus.PENDING)).toBe(false);
      expect(canTransition(RecoveryStatus.SUCCEEDED, RecoveryStatus.EXECUTING)).toBe(false);
      expect(canTransition(RecoveryStatus.SUCCEEDED, RecoveryStatus.STOPPED)).toBe(false);

      expect(() => {
        validateTransition(RecoveryStatus.SUCCEEDED, RecoveryStatus.EXECUTING);
      }).toThrow(InvalidStateTransitionError);
    });

    it('should reject transitions from terminal state STOPPED', () => {
      expect(canTransition(RecoveryStatus.STOPPED, RecoveryStatus.PENDING)).toBe(false);
      expect(canTransition(RecoveryStatus.STOPPED, RecoveryStatus.ANALYZING)).toBe(false);

      expect(() => {
        validateTransition(RecoveryStatus.STOPPED, RecoveryStatus.PENDING);
      }).toThrow(InvalidStateTransitionError);
    });

    it('should reject transitions from terminal state ESCALATED', () => {
      expect(canTransition(RecoveryStatus.ESCALATED, RecoveryStatus.EXECUTING)).toBe(false);
      expect(canTransition(RecoveryStatus.ESCALATED, RecoveryStatus.VERIFYING)).toBe(false);

      expect(() => {
        validateTransition(RecoveryStatus.ESCALATED, RecoveryStatus.EXECUTING);
      }).toThrow(InvalidStateTransitionError);
    });

    it('should reject invalid non-terminal transitions', () => {
      // Direct jump PENDING -> EXECUTING without ANALYZING & POLICY_CHECK
      expect(canTransition(RecoveryStatus.PENDING, RecoveryStatus.EXECUTING)).toBe(false);
      expect(() => {
        validateTransition(RecoveryStatus.PENDING, RecoveryStatus.EXECUTING);
      }).toThrow(InvalidStateTransitionError);

      // Direct jump PENDING -> VERIFYING
      expect(canTransition(RecoveryStatus.PENDING, RecoveryStatus.VERIFYING)).toBe(false);
    });
  });
});
