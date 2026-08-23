import crypto from 'node:crypto';
import {
  AuditActor,
  type Database,
  PaymentStatus,
  RazorpayWebhookSchema,
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
  mapPaymentStatus(event: string, statusStr: string): PaymentStatus {
    if (event === 'payment.captured' || statusStr === 'captured' || statusStr === 'paid') {
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
    const paymentEntity = payload.payload.payment.entity;
    const razorpayPaymentId = paymentEntity.id;

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
    const emailHash = paymentEntity.email ? hmacPII(piiSecret, paymentEntity.email) : null;
    const phoneHash = paymentEntity.contact ? hmacPII(piiSecret, paymentEntity.contact) : null;
    const nameHash = paymentEntity.description ? hmacPII(piiSecret, paymentEntity.description) : null;

    const domainStatus = this.mapPaymentStatus(eventType, paymentEntity.status);
    const amountPaise = paymentEntity.amount;
    const currency = paymentEntity.currency.toUpperCase();
    const createdAtDate = new Date(paymentEntity.created_at * 1000);

    // 5. Durable Storage — Upsert Payment Record in PostgreSQL (§7.2, §13.1)
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
        recovery_attempt_id: null,
        payment_id: paymentRecord.id,
        actor: AuditActor.WEBHOOK,
        action: 'webhook_received',
        input: {
          event_id: eventId,
          event_type: eventType,
          razorpay_payment_id: razorpayPaymentId,
          amount_paise: amountPaise,
          currency,
          has_email: Boolean(paymentEntity.email),
          has_phone: Boolean(paymentEntity.contact),
          email_hash: emailHash,
          phone_hash: phoneHash,
        },
        output: {
          payment_id: paymentRecord.id,
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
      paymentRecordId: paymentRecord.id,
      message: 'Webhook processed successfully',
    };
  }
}
