/**
 * Domain Types for Idempotency & Distributed Locking Infrastructure (§13)
 */

export type WebhookIdempotencyResult = 'NEW' | 'DUPLICATE' | 'FAIL_CLOSED';

export type ActionIdempotencyResult = 'NEW' | 'DUPLICATE' | 'FAIL_CLOSED';

export interface LockAcquisitionResult {
  acquired: boolean;
  ownerToken: string | null;
  isFallback: boolean;
}

export interface LockReleaseResult {
  released: boolean;
  reason?: string;
}
