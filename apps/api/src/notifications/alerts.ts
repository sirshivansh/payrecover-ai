import { NotificationChannel, NotificationType } from '@payrecover/shared';
import type { PaymentRow, RecoveryAttemptRow } from '@payrecover/shared';
import type { NotificationService } from './service.js';

export interface AlertTriggerOptions {
  recipient?: string;
}

export class MerchantAlertsDispatcher {
  constructor(private notificationService: NotificationService) {}

  /**
   * Alert merchant when recovery succeeds (§14).
   */
  async notifyRecoverySucceeded(
    attempt: RecoveryAttemptRow,
    payment: PaymentRow,
    traceId: string,
    options?: AlertTriggerOptions,
  ) {
    const idempotencyKey = `alert:succeeded:${attempt.id}`;
    return await this.notificationService.sendNotification({
      idempotencyKey,
      recoveryAttemptId: attempt.id,
      paymentId: payment.id,
      channel: NotificationChannel.MERCHANT_ALERT,
      eventType: NotificationType.RECOVERY_SUCCEEDED,
      recipient: options?.recipient ?? 'merchant@example.com',
      payload: {
        amount_paise: payment.amount_paise,
        currency: payment.currency,
        attemptNumber: attempt.attempt_number,
        razorpayPaymentId: payment.razorpay_payment_id,
        actionType: attempt.action_type,
      },
      traceId,
    });
  }

  /**
   * Alert merchant when recovery is stopped (§14).
   */
  async notifyRecoveryStopped(
    attempt: RecoveryAttemptRow,
    payment: PaymentRow,
    reason: string,
    traceId: string,
    options?: AlertTriggerOptions,
  ) {
    const idempotencyKey = `alert:stopped:${attempt.id}`;
    return await this.notificationService.sendNotification({
      idempotencyKey,
      recoveryAttemptId: attempt.id,
      paymentId: payment.id,
      channel: NotificationChannel.MERCHANT_ALERT,
      eventType: NotificationType.RECOVERY_STOPPED,
      recipient: options?.recipient ?? 'merchant@example.com',
      payload: {
        reason,
        attemptNumber: attempt.attempt_number,
        razorpayPaymentId: payment.razorpay_payment_id,
      },
      traceId,
    });
  }

  /**
   * Alert merchant when recovery is escalated for manual review (§14).
   */
  async notifyRecoveryEscalated(
    attempt: RecoveryAttemptRow,
    payment: PaymentRow,
    reason: string,
    traceId: string,
    options?: AlertTriggerOptions,
  ) {
    const idempotencyKey = `alert:escalated:${attempt.id}`;
    return await this.notificationService.sendNotification({
      idempotencyKey,
      recoveryAttemptId: attempt.id,
      paymentId: payment.id,
      channel: NotificationChannel.MERCHANT_ALERT,
      eventType: NotificationType.RECOVERY_ESCALATED,
      recipient: options?.recipient ?? 'merchant@example.com',
      payload: {
        reason,
        attemptNumber: attempt.attempt_number,
        razorpayPaymentId: payment.razorpay_payment_id,
        aiConfidence: attempt.ai_confidence,
      },
      traceId,
    });
  }

  /**
   * Alert merchant when action outcome is unknown (§14).
   */
  async notifyOutcomeUnknown(
    attempt: RecoveryAttemptRow,
    payment: PaymentRow,
    traceId: string,
    options?: AlertTriggerOptions,
  ) {
    const idempotencyKey = `alert:outcome_unknown:${attempt.id}`;
    return await this.notificationService.sendNotification({
      idempotencyKey,
      recoveryAttemptId: attempt.id,
      paymentId: payment.id,
      channel: NotificationChannel.MERCHANT_ALERT,
      eventType: NotificationType.ACTION_OUTCOME_UNKNOWN,
      recipient: options?.recipient ?? 'merchant@example.com',
      payload: {
        attemptNumber: attempt.attempt_number,
        razorpayPaymentId: payment.razorpay_payment_id,
        actionType: attempt.action_type,
      },
      traceId,
    });
  }

  /**
   * Alert merchant when recovery attempt fails (§14).
   */
  async notifyRecoveryFailed(
    attempt: RecoveryAttemptRow,
    payment: PaymentRow,
    reason: string,
    traceId: string,
    options?: AlertTriggerOptions,
  ) {
    const idempotencyKey = `alert:failed:${attempt.id}`;
    return await this.notificationService.sendNotification({
      idempotencyKey,
      recoveryAttemptId: attempt.id,
      paymentId: payment.id,
      channel: NotificationChannel.MERCHANT_ALERT,
      eventType: NotificationType.RECOVERY_FAILED,
      recipient: options?.recipient ?? 'merchant@example.com',
      payload: {
        reason,
        attemptNumber: attempt.attempt_number,
        razorpayPaymentId: payment.razorpay_payment_id,
      },
      traceId,
    });
  }
}
