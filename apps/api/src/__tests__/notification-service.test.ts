import {
  AuditActor,
  NotificationChannel,
  NotificationStatus,
  NotificationType,
  PaymentStatus,
  RecoveryStatus,
} from '@payrecover/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { MerchantAlertsDispatcher } from '../notifications/alerts.js';
import { MockNotificationProvider } from '../notifications/mock-provider.js';
import { NotificationService } from '../notifications/service.js';
import { AuditLogger } from '../observability/audit.js';

describe('Phase 14 — Notification & Merchant Alerts Service', () => {
  const env = loadEnv();
  const { db, close } = createDatabaseClient(env);
  let mockProvider: MockNotificationProvider;
  let auditLogger: AuditLogger;
  let notificationService: NotificationService;
  let alertsDispatcher: MerchantAlertsDispatcher;

  let testPaymentId: string;
  let testAttemptId: string;

  beforeAll(async () => {
    mockProvider = new MockNotificationProvider();
    auditLogger = new AuditLogger(db);
    // Initialize NotificationService with null Redis to test PostgreSQL durable fallback path by default
    notificationService = new NotificationService(db, null, mockProvider, auditLogger);
    alertsDispatcher = new MerchantAlertsDispatcher(notificationService);

    // Create test payment & recovery attempt fixtures
    const razorpayId = `pay_notif_${Date.now()}`;
    const payment = await db
      .insertInto('payments')
      .values({
        razorpay_payment_id: razorpayId,
        amount_paise: '250000',
        currency: 'INR',
        status: PaymentStatus.FAILED,
        email_hash: 'email_hash_notif',
        phone_hash: 'phone_hash_notif',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    testPaymentId = payment.id;

    const attempt = await db
      .insertInto('recovery_attempts')
      .values({
        payment_id: payment.id,
        attempt_number: 1,
        status: RecoveryStatus.SUCCEEDED,
        revenue_at_risk_paise: '250000',
        policy_snapshot: {},
        started_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    testAttemptId = attempt.id;
  });

  afterAll(async () => {
    // Cleanup in correct FK order
    await db.deleteFrom('audit_log').where('payment_id', '=', testPaymentId).execute();
    await db.deleteFrom('notifications').where('payment_id', '=', testPaymentId).execute();
    await db.deleteFrom('recovery_attempts').where('id', '=', testAttemptId).execute();
    await db.deleteFrom('payments').where('id', '=', testPaymentId).execute();
    await close();
  });

  beforeEach(() => {
    mockProvider.clear();
  });

  describe('1. Idempotency & Deduplication (§14)', () => {
    it('should send new notification on first request', async () => {
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_1_${Date.now()}`;

      const result = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_SUCCEEDED,
        recipient: 'merchant@example.com',
        payload: { amount_paise: 250000 },
        traceId,
      });

      expect(result.status).toBe(NotificationStatus.SENT);
      expect(result.notificationId).toBeDefined();
      expect(mockProvider.sentNotifications.length).toBe(1);
    });

    it('should suppress duplicate notification request with same idempotency_key', async () => {
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_dup_${Date.now()}`;

      // First request -> SENT
      const res1 = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_SUCCEEDED,
        recipient: 'merchant@example.com',
        payload: { amount_paise: 250000 },
        traceId,
      });

      expect(res1.status).toBe(NotificationStatus.SENT);
      expect(mockProvider.sentNotifications.length).toBe(1);

      // Second duplicate request -> SUPPRESSED
      const res2 = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_SUCCEEDED,
        recipient: 'merchant@example.com',
        payload: { amount_paise: 250000 },
        traceId,
      });

      expect(res2.status).toBe(NotificationStatus.SUPPRESSED);
      expect(res2.suppressedReason).toBe('duplicate_notification');

      // Provider MUST NOT have been called a second time
      expect(mockProvider.sentNotifications.length).toBe(1);
    });

    it('should fall back to PostgreSQL durable check when Redis is unavailable', async () => {
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_fallback_${Date.now()}`;

      // Service initialized with null Redis client
      const res1 = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_STOPPED,
        recipient: 'merchant@example.com',
        payload: { reason: 'max_attempts_exceeded' },
        traceId,
      });

      expect(res1.status).toBe(NotificationStatus.SENT);

      // Subsequent call falls back to PostgreSQL check
      const res2 = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_STOPPED,
        recipient: 'merchant@example.com',
        payload: { reason: 'max_attempts_exceeded' },
        traceId,
      });

      expect(res2.status).toBe(NotificationStatus.SUPPRESSED);
    });
  });

  describe('2. Provider Scenarios & Error Handling (§14)', () => {
    it('should schedule retry for provider timeout (retryable 5xx)', async () => {
      mockProvider.setFailureScenario('timeout');
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_timeout_${Date.now()}`;

      const res = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_ESCALATED,
        recipient: 'merchant@example.com',
        payload: { reason: 'low_confidence' },
        traceId,
      });

      expect(res.status).toBe(NotificationStatus.PENDING);
      expect(res.retryable).toBe(true);
      expect(res.error).toContain('timed out');
    });

    it('should schedule retry for network failure', async () => {
      mockProvider.setFailureScenario('network');
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_net_${Date.now()}`;

      const res = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.ACTION_OUTCOME_UNKNOWN,
        recipient: 'merchant@example.com',
        payload: { actionType: 'create_payment_link' },
        traceId,
      });

      expect(res.status).toBe(NotificationStatus.PENDING);
      expect(res.retryable).toBe(true);
    });

    it('should fail permanently without retry for 4xx client errors', async () => {
      mockProvider.setFailureScenario('permanent_4xx');
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_4xx_${Date.now()}`;

      const res = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_FAILED,
        recipient: 'merchant@example.com',
        payload: { reason: 'invalid_recipient' },
        traceId,
      });

      expect(res.status).toBe(NotificationStatus.FAILED);
      expect(res.retryable).toBe(false);
    });

    it('should fail permanently on malformed provider response', async () => {
      mockProvider.setFailureScenario('malformed');
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_malformed_${Date.now()}`;

      const res = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_FAILED,
        recipient: 'merchant@example.com',
        payload: { test: 'malformed' },
        traceId,
      });

      expect(res.status).toBe(NotificationStatus.FAILED);
      expect(res.retryable).toBe(false);
    });
  });

  describe('3. Max Attempts & Retry Lifecycle (§14)', () => {
    it('should enforce max_attempts and transition to terminal FAILED status', async () => {
      mockProvider.setFailureScenario('retryable_5xx');
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_max_${Date.now()}`;

      // Attempt 1 -> PENDING (retryable)
      const res1 = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_FAILED,
        recipient: 'merchant@example.com',
        payload: { attempt: 1 },
        traceId,
        maxAttempts: 2,
      });
      expect(res1.status).toBe(NotificationStatus.PENDING);

      // Attempt 2 (Max attempts reached) -> FAILED
      const res2 = await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_FAILED,
        recipient: 'merchant@example.com',
        payload: { attempt: 2 },
        traceId,
        maxAttempts: 2,
      });
      expect(res2.status).toBe(NotificationStatus.FAILED);
      expect(res2.retryable).toBe(false);
    });
  });

  describe('4. Security & PII / Secret Protection (§16, §17)', () => {
    it('should redact sensitive secrets from notification payload and audit records', async () => {
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_sec_${Date.now()}`;

      // Payload containing raw secrets
      const sensitivePayload = {
        api_key: 'rzp_test_secret_key_123',
        authorization: 'Bearer token_secret',
        nvapi_key: 'nvapi-secret_token',
        database_url: 'postgres://user:pass@localhost:5432/db',
        safe_amount_paise: 250000,
      };

      await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_SUCCEEDED,
        recipient: 'merchant@example.com',
        payload: sensitivePayload,
        traceId,
      });

      // 1. Verify provider received redacted payload
      expect(mockProvider.sentNotifications.length).toBe(1);
      const sentPayload = mockProvider.sentNotifications[0]?.payload ?? {};
      // biome-ignore lint/complexity/useLiteralKeys: Dynamic payload key testing
      expect(sentPayload['api_key']).toBe('[REDACTED]');
      // biome-ignore lint/complexity/useLiteralKeys: Dynamic payload key testing
      expect(sentPayload['authorization']).toBe('[REDACTED]');
      // biome-ignore lint/complexity/useLiteralKeys: Dynamic payload key testing
      expect(sentPayload['nvapi_key']).toBe('[REDACTED]');
      // biome-ignore lint/complexity/useLiteralKeys: Dynamic payload key testing
      expect(sentPayload['database_url']).toBe('[REDACTED]');
      // biome-ignore lint/complexity/useLiteralKeys: Dynamic payload key testing
      expect(sentPayload['safe_amount_paise']).toBe(250000);

      // 2. Verify audit logs contain zero raw secrets
      const auditLogs = await auditLogger.getByTraceId(traceId);
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);

      for (const log of auditLogs) {
        const inputStr = JSON.stringify(log.input || {});
        expect(inputStr).not.toContain('rzp_test_secret_key_123');
        expect(inputStr).not.toContain('Bearer token_secret');
        expect(inputStr).not.toContain('nvapi-secret_token');
        expect(inputStr).not.toContain('postgres://user:pass');
      }
    });

    it('should log audit entries with actor "notification" and correlation trace_id', async () => {
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_actor_${Date.now()}`;

      await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_SUCCEEDED,
        recipient: 'merchant@example.com',
        payload: { test: true },
        traceId,
      });

      const logs = await auditLogger.getByTraceId(traceId);
      expect(logs.length).toBeGreaterThanOrEqual(2);
      expect(logs.every((l) => l.actor === AuditActor.NOTIFICATION)).toBe(true);
      expect(logs.some((l) => l.action === 'notification_requested')).toBe(true);
      expect(logs.some((l) => l.action === 'notification_sent')).toBe(true);
    });
  });

  describe('5. State Safety (§14)', () => {
    it('should NOT mutate payment status or recovery attempt status on notification delivery', async () => {
      const traceId = crypto.randomUUID();
      const idempotencyKey = `idem_notif_safety_${Date.now()}`;

      // Get payment and attempt state before notification
      const paymentBefore = await db
        .selectFrom('payments')
        .select(['status', 'paid_at'])
        .where('id', '=', testPaymentId)
        .executeTakeFirstOrThrow();

      const attemptBefore = await db
        .selectFrom('recovery_attempts')
        .select(['status', 'completed_at'])
        .where('id', '=', testAttemptId)
        .executeTakeFirstOrThrow();

      // Send notification (even when provider fails)
      mockProvider.setFailureScenario('permanent_4xx');
      await notificationService.sendNotification({
        idempotencyKey,
        recoveryAttemptId: testAttemptId,
        paymentId: testPaymentId,
        channel: NotificationChannel.MERCHANT_ALERT,
        eventType: NotificationType.RECOVERY_FAILED,
        recipient: 'merchant@example.com',
        payload: { error: 'test' },
        traceId,
      });

      // Verify payment and attempt state remained untouched
      const paymentAfter = await db
        .selectFrom('payments')
        .select(['status', 'paid_at'])
        .where('id', '=', testPaymentId)
        .executeTakeFirstOrThrow();

      const attemptAfter = await db
        .selectFrom('recovery_attempts')
        .select(['status', 'completed_at'])
        .where('id', '=', testAttemptId)
        .executeTakeFirstOrThrow();

      expect(paymentAfter.status).toBe(paymentBefore.status);
      expect(paymentAfter.paid_at).toEqual(paymentBefore.paid_at);
      expect(attemptAfter.status).toBe(attemptBefore.status);
      expect(attemptAfter.completed_at).toEqual(attemptBefore.completed_at);
    });
  });

  describe('6. Merchant Alerts Dispatcher (§14)', () => {
    it('should dispatch recovery succeeded alert', async () => {
      const traceId = crypto.randomUUID();
      const payment = await db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', testPaymentId)
        .executeTakeFirstOrThrow();

      const attempt = await db
        .selectFrom('recovery_attempts')
        .selectAll()
        .where('id', '=', testAttemptId)
        .executeTakeFirstOrThrow();

      const res = await alertsDispatcher.notifyRecoverySucceeded(attempt, payment, traceId);
      expect(res.status).toBe(NotificationStatus.SENT);
      expect(mockProvider.sentNotifications.length).toBe(1);
      expect(mockProvider.sentNotifications[0]?.eventType).toBe(NotificationType.RECOVERY_SUCCEEDED);
    });

    it('should dispatch recovery stopped alert', async () => {
      const traceId = crypto.randomUUID();
      const payment = await db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', testPaymentId)
        .executeTakeFirstOrThrow();

      const attempt = await db
        .selectFrom('recovery_attempts')
        .selectAll()
        .where('id', '=', testAttemptId)
        .executeTakeFirstOrThrow();

      const res = await alertsDispatcher.notifyRecoveryStopped(attempt, payment, 'Max attempts reached', traceId);
      expect(res.status).toBe(NotificationStatus.SENT);
      expect(mockProvider.sentNotifications[0]?.eventType).toBe(NotificationType.RECOVERY_STOPPED);
    });

    it('should dispatch recovery escalated alert', async () => {
      const traceId = crypto.randomUUID();
      const payment = await db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', testPaymentId)
        .executeTakeFirstOrThrow();

      const attempt = await db
        .selectFrom('recovery_attempts')
        .selectAll()
        .where('id', '=', testAttemptId)
        .executeTakeFirstOrThrow();

      const res = await alertsDispatcher.notifyRecoveryEscalated(attempt, payment, 'Low confidence', traceId);
      expect(res.status).toBe(NotificationStatus.SENT);
      expect(mockProvider.sentNotifications[0]?.eventType).toBe(NotificationType.RECOVERY_ESCALATED);
    });
  });
});
