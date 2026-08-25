import type { EvaluationInput, EvaluationResult } from '@payrecover/shared';
import { AIDecisionType, PaymentStatus, PolicyDecisionType, RecoveryStatus } from '@payrecover/shared';

/**
 * Pure, deterministic outcome evaluation engine (§12, §19, v2.1.1 §12.3)
 *
 * Rules:
 * 1. Pure function: No DB, no Redis, no network, no AI calls, no system-clock dependency when `now` is supplied.
 * 2. Integer paise / BigInt financial boundary: Validates amount & currency without floating point.
 * 3. PaymentState authority: 'paid' => SUCCEEDED, 'refunded'/'cancelled' => STOPPED.
 * 4. v2.1.1 §12.3 Reconciliation rule: ACTION_OUTCOME_UNKNOWN conservatively escalates to ESCALATED.
 * 5. Terminal state protection: Returns appropriate targetRecoveryStatus.
 */
export function evaluateOutcome(input: EvaluationInput, now?: Date): EvaluationResult {
  const evalDate = now ?? new Date();
  const isoTime = evalDate.toISOString();

  // Financial sanity check (Authoritative DB check)
  const financialMatch = input.amountPaise > 0n && typeof input.currency === 'string' && input.currency.length === 3;

  // 1. Authoritative Payment State — Payment Captured / Paid (§5, §12)
  if (input.paymentStatus === PaymentStatus.PAID || input.paymentStatus === 'paid') {
    return {
      outcome: 'succeeded',
      isRecovered: true,
      isTerminal: true,
      targetRecoveryStatus: RecoveryStatus.SUCCEEDED,
      reason: 'Payment successfully captured',
      financialMatch,
      requiresReconciliation: false,
      evaluatedAt: isoTime,
    };
  }

  // 2. Authoritative Payment State — Refunded / Cancelled (§5, §12)
  if (
    input.paymentStatus === PaymentStatus.REFUNDED ||
    input.paymentStatus === 'refunded' ||
    input.paymentStatus === PaymentStatus.CANCELLED ||
    input.paymentStatus === 'cancelled'
  ) {
    return {
      outcome: 'stopped',
      isRecovered: false,
      isTerminal: true,
      targetRecoveryStatus: RecoveryStatus.STOPPED,
      reason: `Payment is in terminal status '${input.paymentStatus}'`,
      financialMatch,
      requiresReconciliation: false,
      evaluatedAt: isoTime,
    };
  }

  // 3. Conservative Unknown External Outcome Rule (v2.1.1 §12.3)
  if (
    input.recoveryAttemptStatus === RecoveryStatus.ACTION_OUTCOME_UNKNOWN ||
    input.recoveryAttemptStatus === 'action_outcome_unknown' ||
    Boolean(input.actionResult?.outcomeUnknown)
  ) {
    return {
      outcome: 'action_outcome_unknown',
      isRecovered: false,
      isTerminal: true,
      targetRecoveryStatus: RecoveryStatus.ESCALATED,
      reason: 'Outcome unknown after execution; conservatively escalating per specification v2.1.1 §12.3',
      financialMatch,
      requiresReconciliation: true,
      evaluatedAt: isoTime,
    };
  }

  // 4. Policy Rejection / AI Escalation Rule (§6.1, v2.1.1 §6.1)
  if (input.policyDecision === PolicyDecisionType.REJECTED || input.policyDecision === 'rejected') {
    return {
      outcome: 'stopped',
      isRecovered: false,
      isTerminal: true,
      targetRecoveryStatus: RecoveryStatus.STOPPED,
      reason: input.errorMessage ?? 'Policy evaluation rejected action',
      financialMatch,
      requiresReconciliation: false,
      evaluatedAt: isoTime,
    };
  }

  if (
    (input.aiDecision === AIDecisionType.ESCALATE || input.aiDecision === 'escalate') &&
    (input.policyDecision === PolicyDecisionType.APPROVED || input.policyDecision === 'approved')
  ) {
    return {
      outcome: 'escalated',
      isRecovered: false,
      isTerminal: true,
      targetRecoveryStatus: RecoveryStatus.ESCALATED,
      reason: 'AI recommended escalation and policy approved',
      financialMatch,
      requiresReconciliation: false,
      evaluatedAt: isoTime,
    };
  }

  // 5. Retry Exhaustion / Max Attempts Exceeded (§4.4)
  if (input.attemptNumber >= input.maxAttempts) {
    return {
      outcome: 'stopped',
      isRecovered: false,
      isTerminal: true,
      targetRecoveryStatus: RecoveryStatus.STOPPED,
      reason: `Maximum recovery attempts reached (${input.attemptNumber}/${input.maxAttempts})`,
      financialMatch,
      requiresReconciliation: false,
      evaluatedAt: isoTime,
    };
  }

  // 6. Active Payment Failed / Eligible for Retry (§4.4)
  return {
    outcome: 'failed',
    isRecovered: false,
    isTerminal: false,
    targetRecoveryStatus: RecoveryStatus.VERIFYING,
    reason: 'Payment remains unpaid; eligible for retry attempt',
    financialMatch,
    requiresReconciliation: false,
    evaluatedAt: isoTime,
  };
}
