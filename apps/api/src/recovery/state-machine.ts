import { InvalidStateTransitionError, RecoveryStatus, isTerminalRecoveryStatus } from '@payrecover/shared';

/**
 * Allowed state transitions mapping table (§6.1, v2.1.1 §6.1)
 */
const ALLOWED_TRANSITIONS: Record<RecoveryStatus, Set<RecoveryStatus>> = {
  [RecoveryStatus.PENDING]: new Set([
    RecoveryStatus.ANALYZING,
    RecoveryStatus.STOPPED,
    RecoveryStatus.SUCCEEDED, // payment.captured webhook during recovery
  ]),
  [RecoveryStatus.ANALYZING]: new Set([
    RecoveryStatus.POLICY_CHECK,
    RecoveryStatus.STOPPED,
    RecoveryStatus.SUCCEEDED, // payment.captured webhook during recovery
  ]),
  [RecoveryStatus.POLICY_CHECK]: new Set([
    RecoveryStatus.EXECUTING,
    RecoveryStatus.STOPPED,
    RecoveryStatus.ESCALATED,
    RecoveryStatus.SUCCEEDED, // payment.captured webhook during recovery
  ]),
  [RecoveryStatus.EXECUTING]: new Set([
    RecoveryStatus.VERIFYING,
    RecoveryStatus.SUCCEEDED,
    RecoveryStatus.ACTION_OUTCOME_UNKNOWN,
    RecoveryStatus.FAILED,
    RecoveryStatus.STOPPED,
  ]),
  [RecoveryStatus.ACTION_OUTCOME_UNKNOWN]: new Set([
    RecoveryStatus.SUCCEEDED,
    RecoveryStatus.VERIFYING,
    RecoveryStatus.ESCALATED,
    RecoveryStatus.STOPPED,
  ]),
  [RecoveryStatus.VERIFYING]: new Set([RecoveryStatus.SUCCEEDED, RecoveryStatus.PENDING, RecoveryStatus.STOPPED]),
  [RecoveryStatus.FAILED]: new Set([RecoveryStatus.PENDING, RecoveryStatus.STOPPED, RecoveryStatus.SUCCEEDED]),
  // Terminal sinks (§6.1 Invariant 5) — no outbound transitions permitted
  [RecoveryStatus.SUCCEEDED]: new Set(),
  [RecoveryStatus.STOPPED]: new Set(),
  [RecoveryStatus.ESCALATED]: new Set(),
};

/**
 * Determine if a state transition is valid (§6.1)
 */
export function canTransition(current: RecoveryStatus, target: RecoveryStatus): boolean {
  if (isTerminalRecoveryStatus(current)) {
    return false;
  }
  const allowedTargets = ALLOWED_TRANSITIONS[current];
  return allowedTargets?.has(target) ?? false;
}

/**
 * Validate state transition or throw InvalidStateTransitionError (§6.1)
 */
export function validateTransition(current: RecoveryStatus, target: RecoveryStatus): void {
  if (!canTransition(current, target)) {
    if (isTerminalRecoveryStatus(current)) {
      throw new InvalidStateTransitionError(
        current,
        target,
        `Cannot transition from terminal state '${current}' to '${target}'`,
      );
    }
    throw new InvalidStateTransitionError(current, target);
  }
}
