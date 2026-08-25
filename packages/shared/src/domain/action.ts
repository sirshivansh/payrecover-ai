import type { RecoveryActionType } from './enums.js';

/**
 * Result returned by ActionExecutor and bounded tools (§12, v2.1.1 §12)
 */
export interface ActionResult {
  success: boolean;
  skipped?: boolean;
  cached?: boolean;
  outcomeUnknown?: boolean;
  reason?: string;
  paymentLinkId?: string;
  paymentLinkUrl?: string;
  actionType?: RecoveryActionType;
  error?: string;
  result?: Record<string, unknown>;
}

/**
 * Base ActionExecutor error
 */
export class ActionExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionExecutorError';
  }
}

/**
 * Thrown when policy decision is not APPROVED
 */
export class ActionExecutorPolicyError extends ActionExecutorError {
  constructor(message = 'Action execution blocked by policy decision') {
    super(message);
    this.name = 'ActionExecutorPolicyError';
  }
}

/**
 * Thrown when action idempotency check fails (FAIL_CLOSED)
 */
export class ActionExecutorIdempotencyError extends ActionExecutorError {
  constructor(message = 'Action execution blocked by idempotency check') {
    super(message);
    this.name = 'ActionExecutorIdempotencyError';
  }
}
