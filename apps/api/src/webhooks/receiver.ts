import crypto from 'node:crypto';
import {
  AuditActor,
  type Database,
  PaymentStatus,
  RazorpayWebhookSchema,
  RecoveryStatus,
  type WebhookProcessResult,
  hmacPII,
} from '@payrecover/shared';
import type { Kysely } from 'kysely';
import type { AppEnv } from '../config/env.js';
import type { IdempotencyService } from '../services/idempotency.service.js';

export class WebhookReceiver {
  constructor(
    private env: AppEnv,
    private db: Kysely<Database>,
    private idempotency: IdempotencyService,
  ) {}

  /**
   * Constant-time HMAC-SHA256 signature verification over raw request body (§8.2, §16).
   */
  verifySignature(rawBody: string, signature: string, secret: string | undefined): boolean {
    if (!signature || !secret) {
      return false;
    }

    try {
      const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
      const actualBuffer = Buffer.from(signature, 'utf8');

      if (expectedBuffer.length !== actualBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Map Razorpay status string to domain PaymentStatus enum (§5).
   */
  mapPaymentStatus(event: string, statusStr?: string): PaymentStatus {
    if (
      event === 'payment.captured' ||
      event === 'payment_link.paid' ||
      statusStr === 'captured' ||
      statusStr === 'paid'
    ) {
      return PaymentStatus.PAID;
    }
    if (event === 'payment.refunded' || statusStr === 'refunded') {
      return PaymentStatus.REFUNDED;
    }
    if (statusStr === 'cancelled') {
      return PaymentStatus.CANCELLED;
    }
    if (statusStr === 'attempted' || event === 'payment.failed') {
      return PaymentStatus.FAILED;
    }
    return PaymentStatus.CREATED;
  }

  /**
   * Ingest and process a Razorpay webhook (§9.1, §9.2, §13.1, §17).
   */
  async processWebhook(
    rawBody: string,
    signature: string,
    payloadRaw: unknown,
    traceId: string,
  ): Promise<WebhookProcessResult & { statusCode: number }> {
    const webhookSecret = this.env.RAZORPAY_WEBHOOK_SECRET;

    // 1. HMAC Signature Verification (§8.2, §16)
    const isValidSig = this.verifySignature(rawBody, signature, webhookSecret);
    if (!isValidSig) {
      return {
        statusCode: 401,
        status: 'error',
        eventId: '',
        eventType: '',
        razorpayPaymentId: '',
        message: 'Invalid webhook signature',
      };
    }

    // 2. Validate Payload with Zod (§9.2)
    const parseResult = RazorpayWebhookSchema.safeParse(payloadRaw);
    if (!parseResult.success) {
      const formattedErr = parseResult.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return {
        statusCode: 400,
        status: 'error',
        eventId: '',
        eventType: '',
        razorpayPaymentId: '',
        message: `Invalid webhook payload format: ${formattedErr}`,
      };
    }

    const payload = parseResult.data;
    const eventId = payload.id;
    const eventType = payload.event;
    const paymentEntity = payload.payload.payment?.entity;
    const paymentLinkEntity = payload.payload.payment_link?.entity;

    const razorpayPaymentId = paymentEntity?.id || paymentLinkEntity?.id || '';

    // 3. Idempotency Check (Dual-layer Redis + PostgreSQL) (§13.1)
    const idempotencyResult = await this.idempotency.checkAndSetWebhookIdempotency(eventId);

    if (idempotencyResult === 'DUPLICATE') {
      return {
        statusCode: 200,
        status: 'duplicate',
        eventId,
        eventType,
        razorpayPaymentId,
        message: 'Duplicate webhook event already processed',
      };
    }

    if (idempotencyResult === 'FAIL_CLOSED') {
      return {
        statusCode: 409,
        status: 'error',
        eventId,
        eventType,
        razorpayPaymentId,
        message: 'Idempotency verification unavailable (Redis & DB error)',
      };
    }

    // 4. PII Pseudonymization (HMAC-SHA256) (§17)
    const piiSecret = this.env.PII_HMAC_SECRET || 'dev_pii_secret_key';
    const emailHash = paymentEntity?.email ? hmacPII(piiSecret, paymentEntity.email) : null;
    const phoneHash = paymentEntity?.contact ? hmacPII(piiSecret, paymentEntity.contact) : null;
    const nameHash = paymentEntity?.description ? hmacPII(piiSecret, paymentEntity.description) : null;

    const domainStatus = this.mapPaymentStatus(eventType, paymentEntity?.status || paymentLinkEntity?.status);
    const amountPaise = paymentEntity?.amount ?? paymentLinkEntity?.amount ?? 0;
    const currency = (paymentEntity?.currency || paymentLinkEntity?.currency || 'INR').toUpperCase();
    const createdAtDate = paymentEntity?.created_at ? new Date(paymentEntity.created_at * 1000) : new Date();

    let targetPaymentId: string | null = null;
    let targetAttemptId: string | null = null;

    // 5. Handle Payment Link Paid Event OR Standard Webhook
    if (eventType === 'payment_link.paid' || (paymentLinkEntity && paymentLinkEntity.status === 'paid')) {
      const notes = {
        ...(paymentLinkEntity?.notes as Record<string, unknown> | undefined),
        ...(paymentEntity?.notes as Record<string, unknown> | undefined),
      };

      // biome-ignore lint/complexity/useLiteralKeys: dynamic notes lookup
      const originalDbPaymentId = typeof notes['payment_id'] === 'string' ? (notes['payment_id'] as string) : null;
      const originalRzpPaymentId =
        // biome-ignore lint/complexity/useLiteralKeys: dynamic notes lookup
        typeof notes['razorpay_payment_id'] === 'string' ? (notes['razorpay_payment_id'] as string) : null;
      const plinkId = paymentLinkEntity?.id;

      if (originalDbPaymentId) {
        const p = await this.db
          .selectFrom('payments')
          .select('id')
          .where('id', '=', originalDbPaymentId)
          .executeTakeFirst();
        if (p) targetPaymentId = p.id;
      }

      if (!targetPaymentId && originalRzpPaymentId) {
        const p = await this.db
          .selectFrom('payments')
          .select('id')
          .where('razorpay_payment_id', '=', originalRzpPaymentId)
          .executeTakeFirst();
        if (p) targetPaymentId = p.id;
      }

      if (!targetPaymentId && plinkId) {
        const allAttempts = await this.db
          .selectFrom('recovery_attempts')
          .select(['id', 'payment_id', 'action_result'])
          .execute();

        for (const att of allAttempts) {
          const arStr = JSON.stringify(att.action_result ?? {});
          if (arStr.includes(plinkId)) {
            targetPaymentId = att.payment_id;
            targetAttemptId = att.id;
            break;
          }
        }
      }

      if (!targetPaymentId && razorpayPaymentId) {
        const p = await this.db
          .selectFrom('payments')
          .select('id')
          .where('razorpay_payment_id', '=', razorpayPaymentId)
          .executeTakeFirst();
        if (p) targetPaymentId = p.id;
      }

      if (targetPaymentId) {
        // Financial Safety: Update status to PAID authoritatively on the existing PostgreSQL payment record
        await this.db
          .updateTable('payments')
          .set({
            status: PaymentStatus.PAID,
            paid_at: new Date(),
            updated_at: new Date(),
          })
          .where('id', '=', targetPaymentId)
          .execute();

        // Update matching recovery attempts to SUCCEEDED
        const matchingAttempts = await this.db
          .selectFrom('recovery_attempts')
          .select('id')
          .where('payment_id', '=', targetPaymentId)
          .where('status', 'in', [
            RecoveryStatus.VERIFYING,
            RecoveryStatus.ACTION_OUTCOME_UNKNOWN,
            RecoveryStatus.PENDING,
            RecoveryStatus.ANALYZING,
            RecoveryStatus.POLICY_CHECK,
            RecoveryStatus.EXECUTING,
          ])
          .execute();

        for (const att of matchingAttempts) {
          await this.db
            .updateTable('recovery_attempts')
            .set({
              status: RecoveryStatus.SUCCEEDED,
              completed_at: new Date(),
            })
            .where('id', '=', att.id)
            .execute();
          targetAttemptId = att.id;
        }
      } else if (paymentEntity) {
        // Upsert new payment record if no existing record was matched
        const inserted = await this.db
          .insertInto('payments')
          .values({
            razorpay_payment_id: razorpayPaymentId,
            razorpay_order_id: paymentEntity.order_id || null,
            razorpay_customer_id: paymentEntity.customer_id || null,
            amount_paise: String(amountPaise),
            currency,
            status: domainStatus,
            failure_reason: paymentEntity.error_description || null,
            failure_code: paymentEntity.error_code || null,
            method: paymentEntity.method || null,
            email_hash: emailHash,
            phone_hash: phoneHash,
            customer_name_hash: nameHash,
            attempts: paymentEntity.attempts || 0,
            created_at: createdAtDate,
            updated_at: new Date(),
            paid_at: domainStatus === PaymentStatus.PAID ? new Date() : null,
          })
          .onConflict((oc) =>
            oc.column('razorpay_payment_id').doUpdateSet({
              status: domainStatus,
              updated_at: new Date(),
              paid_at: domainStatus === PaymentStatus.PAID ? new Date() : undefined,
            }),
          )
          .returning(['id'])
          .executeTakeFirstOrThrow();

        targetPaymentId = inserted.id;
      }
    } else if (paymentEntity) {
      // Standard Payment Event (payment.failed, payment.captured, payment.refunded)
      const paymentRecord = await this.db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayPaymentId,
          razorpay_order_id: paymentEntity.order_id || null,
          razorpay_customer_id: paymentEntity.customer_id || null,
          amount_paise: String(amountPaise),
          currency,
          status: domainStatus,
          failure_reason: paymentEntity.error_description || null,
          failure_code: paymentEntity.error_code || null,
          method: paymentEntity.method || null,
          email_hash: emailHash,
          phone_hash: phoneHash,
          customer_name_hash: nameHash,
          attempts: paymentEntity.attempts || 0,
          created_at: createdAtDate,
          updated_at: new Date(),
          paid_at: domainStatus === PaymentStatus.PAID ? new Date() : null,
        })
        .onConflict((oc) =>
          oc.column('razorpay_payment_id').doUpdateSet({
            status: domainStatus,
            failure_reason: paymentEntity.error_description || null,
            failure_code: paymentEntity.error_code || null,
            attempts: paymentEntity.attempts || 0,
            updated_at: new Date(),
            paid_at: domainStatus === PaymentStatus.PAID ? new Date() : undefined,
          }),
        )
        .returning(['id', 'razorpay_payment_id', 'status'])
        .executeTakeFirstOrThrow();

      targetPaymentId = paymentRecord.id;
    }

    // 6. Record Webhook Event (§7.2)
    await this.db
      .insertInto('webhook_events')
      .values({
        event_id: eventId,
        event_type: eventType,
        razorpay_payment_id: razorpayPaymentId,
        received_at: new Date(),
        processed: true,
      })
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();

    // 7. Audit Log Entry (Pseudonymized PII, no raw PII in audit) (§17)
    await this.db
      .insertInto('audit_log')
      .values({
        recovery_attempt_id: targetAttemptId,
        payment_id: targetPaymentId,
        actor: AuditActor.WEBHOOK,
        action: 'webhook_received',
        input: {
          event_id: eventId,
          event_type: eventType,
          razorpay_payment_id: razorpayPaymentId,
          payment_link_id: paymentLinkEntity?.id || null,
          has_email: Boolean(paymentEntity?.email),
          has_phone: Boolean(paymentEntity?.contact),
          email_hash: emailHash,
          phone_hash: phoneHash,
        },
        output: {
          payment_id: targetPaymentId,
          recovery_attempt_id: targetAttemptId,
          status: domainStatus,
        },
        error: null,
        trace_id: traceId,
        created_at: new Date(),
      })
      .execute();

    return {
      statusCode: 200,
      status: 'processed',
      eventId,
      eventType,
      razorpayPaymentId,
      paymentRecordId: targetPaymentId || undefined,
      message: 'Webhook processed successfully',
    };
  }
}
