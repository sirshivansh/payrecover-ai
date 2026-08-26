import type { NotificationChannel, NotificationStatus, NotificationType } from './enums.js';

export interface NotificationRequest {
  idempotencyKey: string;
  recoveryAttemptId?: string | null;
  paymentId?: string | null;
  channel: NotificationChannel | string;
  eventType: NotificationType | string;
  recipient: string;
  payload: Record<string, unknown>;
  traceId: string;
  maxAttempts?: number;
}

export interface NotificationResult {
  notificationId?: string;
  idempotencyKey: string;
  status: NotificationStatus | string;
  deliveredAt?: Date | string | null;
  error?: string | null;
  retryable?: boolean;
  suppressedReason?: string | null;
}

export class NotificationProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = true,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'NotificationProviderError';
  }
}
