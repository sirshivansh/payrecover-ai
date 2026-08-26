import crypto from 'node:crypto';
import type { Database, NewNotification, NotificationRequest, NotificationResult } from '@payrecover/shared';
import { AuditActor, NotificationProviderError, NotificationStatus } from '@payrecover/shared';
import type Redis from 'ioredis';
import type { Kysely } from 'kysely';
import { AuditLogger } from '../observability/audit.js';
import { redactSensitiveData } from '../observability/redact.js';
import { isRedisHealthy } from '../services/redis.service.js';
import type { NotificationProvider } from './provider.js';

export class NotificationService {
  private auditLogger: AuditLogger;

  constructor(
    private db: Kysely<Database>,
    private redis: Redis | null,
    private provider: NotificationProvider,
    auditLogger?: AuditLogger,
  ) {
    this.auditLogger = auditLogger ?? new AuditLogger(db);
  }

  /**
   * Dispatch a notification idempotently (§14).
   *
   * Dual-layer idempotency:
   * 1. Redis fast-path check
   * 2. PostgreSQL durable check
   *
   * Security & Audit:
   * - Redacts sensitive data from notification payloads and audit inputs (§17)
   * - Preserves trace_id correlation
   * - Writes audit events via AuditLogger (actor: 'notification')
   * - Never mutates recovery attempt state or payment status
   */
  async sendNotification(req: NotificationRequest): Promise<NotificationResult> {
    const idempotencyKey = req.idempotencyKey || crypto.randomUUID();
    const traceId = req.traceId || crypto.randomUUID();
    const maxAttempts = req.maxAttempts ?? 3;

    // 1. Redact input payload for security (§17)
    const redactedPayload = redactSensitiveData(req.payload ?? {});

    // Log request event
    await this.auditLogger.log({
      recoveryAttemptId: req.recoveryAttemptId,
      paymentId: req.paymentId,
      actor: AuditActor.NOTIFICATION,
      action: 'notification_requested',
      input: {
        idempotencyKey,
        channel: req.channel,
        eventType: req.eventType,
        recipient: req.recipient,
        payload: redactedPayload,
      },
      traceId,
    });

    // 2. Dual-Layer Idempotency Check (Redis Fast-Path + PostgreSQL Durable Truth)
    const redisKey = `notification:idempotency:${idempotencyKey}`;
    const redisTtlSeconds = 86400; // 24 hours

    if (isRedisHealthy(this.redis)) {
      try {
        const setRes = await this.redis?.set(redisKey, '1', 'EX', redisTtlSeconds, 'NX');
        if (setRes !== 'OK') {
          // Redis indicated key already exists. Check durable DB for final status.
          const dbCheck = await this.db
            .selectFrom('notifications')
            .select(['id', 'status', 'error_message'])
            .where('idempotency_key', '=', idempotencyKey)
            .executeTakeFirst();

          if (dbCheck) {
            await this.auditLogger.log({
              recoveryAttemptId: req.recoveryAttemptId,
              paymentId: req.paymentId,
              actor: AuditActor.NOTIFICATION,
              action: 'notification_suppressed',
              input: { idempotencyKey, reason: 'duplicate_fast_path' },
              traceId,
            });

            return {
              notificationId: dbCheck.id,
              idempotencyKey,
              status: NotificationStatus.SUPPRESSED,
              suppressedReason: 'duplicate_notification',
              error: dbCheck.error_message,
            };
          }
        }
      } catch (err) {
        console.warn('[NotificationService] Redis idempotency check failed, falling back to PostgreSQL:', err);
      }
    }

    // PostgreSQL Durable Check
    const existingNotif = await this.db
      .selectFrom('notifications')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();

    if (existingNotif) {
      if (existingNotif.status === NotificationStatus.SENT) {
        await this.auditLogger.log({
          recoveryAttemptId: req.recoveryAttemptId,
          paymentId: req.paymentId,
          actor: AuditActor.NOTIFICATION,
          action: 'notification_suppressed',
          input: { idempotencyKey, reason: 'already_sent_db' },
          traceId,
        });

        return {
          notificationId: existingNotif.id,
          idempotencyKey,
          status: NotificationStatus.SUPPRESSED,
          deliveredAt: existingNotif.sent_at ? new Date(existingNotif.sent_at).toISOString() : undefined,
          suppressedReason: 'duplicate_notification',
        };
      }

      if (existingNotif.status === NotificationStatus.SUPPRESSED) {
        return {
          notificationId: existingNotif.id,
          idempotencyKey,
          status: NotificationStatus.SUPPRESSED,
          suppressedReason: 'already_suppressed',
        };
      }

      if (existingNotif.attempts >= existingNotif.max_attempts) {
        return {
          notificationId: existingNotif.id,
          idempotencyKey,
          status: NotificationStatus.FAILED,
          error: existingNotif.error_message || 'Max notification retry attempts reached',
          retryable: false,
        };
      }
    }

    // 3. Create or Update DB record in 'pending' status
    let notificationId: string;
    let currentAttempts = 1;

    if (existingNotif) {
      notificationId = existingNotif.id;
      currentAttempts = existingNotif.attempts + 1;
      await this.db
        .updateTable('notifications')
        .set({
          attempts: currentAttempts,
          status: NotificationStatus.PENDING,
          trace_id: traceId,
        })
        .where('id', '=', notificationId)
        .execute();
    } else {
      const newRecord: NewNotification = {
        recovery_attempt_id: req.recoveryAttemptId ?? null,
        payment_id: req.paymentId ?? null,
        channel: req.channel,
        event_type: req.eventType,
        recipient: req.recipient,
        status: NotificationStatus.PENDING,
        idempotency_key: idempotencyKey,
        payload: redactedPayload,
        attempts: 1,
        max_attempts: maxAttempts,
        trace_id: traceId,
      };

      const inserted = await this.db
        .insertInto('notifications')
        .values(newRecord)
        .returning('id')
        .executeTakeFirstOrThrow();
      notificationId = inserted.id;
    }

    // 4. Dispatch to NotificationProvider
    try {
      const providerRes = await this.provider.send({
        ...req,
        idempotencyKey,
        payload: redactedPayload,
        traceId,
      });

      // Handle malformed provider response
      if (!providerRes || (providerRes.status as string) === 'malformed_invalid') {
        throw new NotificationProviderError('Malformed response from notification provider', false);
      }

      const deliveredAt = new Date();

      // Update DB record to 'sent'
      await this.db
        .updateTable('notifications')
        .set({
          status: NotificationStatus.SENT,
          sent_at: deliveredAt,
          error_message: null,
        })
        .where('id', '=', notificationId)
        .execute();

      // Write audit record
      await this.auditLogger.log({
        recoveryAttemptId: req.recoveryAttemptId,
        paymentId: req.paymentId,
        actor: AuditActor.NOTIFICATION,
        action: 'notification_sent',
        output: {
          notificationId,
          idempotencyKey,
          deliveredAt: deliveredAt.toISOString(),
        },
        traceId,
      });

      return {
        notificationId,
        idempotencyKey,
        status: NotificationStatus.SENT,
        deliveredAt: deliveredAt.toISOString(),
      };
    } catch (err) {
      const isRetryable = err instanceof NotificationProviderError ? err.retryable : true;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (isRetryable && currentAttempts < maxAttempts) {
        // Schedule retry
        await this.db
          .updateTable('notifications')
          .set({
            status: NotificationStatus.PENDING,
            error_message: errorMsg,
          })
          .where('id', '=', notificationId)
          .execute();

        await this.auditLogger.log({
          recoveryAttemptId: req.recoveryAttemptId,
          paymentId: req.paymentId,
          actor: AuditActor.NOTIFICATION,
          action: 'notification_retry_scheduled',
          output: {
            notificationId,
            attempts: currentAttempts,
            maxAttempts,
          },
          error: errorMsg,
          traceId,
        });

        return {
          notificationId,
          idempotencyKey,
          status: NotificationStatus.PENDING,
          error: errorMsg,
          retryable: true,
        };
      }

      // Terminal failure
      await this.db
        .updateTable('notifications')
        .set({
          status: NotificationStatus.FAILED,
          error_message: errorMsg,
        })
        .where('id', '=', notificationId)
        .execute();

      await this.auditLogger.log({
        recoveryAttemptId: req.recoveryAttemptId,
        paymentId: req.paymentId,
        actor: AuditActor.NOTIFICATION,
        action: 'notification_failed',
        error: errorMsg,
        traceId,
      });

      return {
        notificationId,
        idempotencyKey,
        status: NotificationStatus.FAILED,
        error: errorMsg,
        retryable: false,
      };
    }
  }
}
