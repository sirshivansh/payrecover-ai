import crypto from 'node:crypto';
import {
  AuditActor,
  type Database,
  type IRazorpayClient,
  type PaymentRow,
  PaymentStatus,
  RazorpayNotFoundError,
  hmacPII,
} from '@payrecover/shared';
import type { Kysely } from 'kysely';

export interface GetPaymentOptions {
  forceRefresh?: boolean;
  maxAgeMs?: number;
  traceId?: string;
}

export class PaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Payment with ID '${paymentId}' was not found`);
    this.name = 'PaymentNotFoundError';
  }
}

export class PaymentStateService {
  private readonly defaultMaxAgeMs = 5 * 60 * 1000; // 5 minutes (§3, §5)

  constructor(
    private db: Kysely<Database>,
    private razorpay?: IRazorpayClient,
    private piiSecret?: string,
  ) {}

  /**
   * Map Razorpay status string to domain PaymentStatus enum (§5)
   */
  public mapPaymentStatus(statusStr: string): PaymentStatus {
    const s = statusStr.toLowerCase();
    if (s === 'captured' || s === 'paid') {
      return PaymentStatus.PAID;
    }
    if (s === 'refunded') {
      return PaymentStatus.REFUNDED;
    }
    if (s === 'cancelled') {
      return PaymentStatus.CANCELLED;
    }
    if (s === 'failed' || s === 'attempted') {
      return PaymentStatus.FAILED;
    }
    return PaymentStatus.CREATED;
  }

  /**
   * Determine if a local payment record is stale (§3, §5)
   * Terminal states (PAID, REFUNDED, CANCELLED) are NEVER stale.
   * Non-terminal states are stale if updated_at is older than maxAgeMs.
   */
  public isStale(payment: PaymentRow, maxAgeMs = this.defaultMaxAgeMs): boolean {
    if (
      payment.status === PaymentStatus.PAID ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.CANCELLED
    ) {
      return false;
    }

    const updatedAtTime = new Date(payment.updated_at).getTime();
    const age = Date.now() - updatedAtTime;
    return age > maxAgeMs;
  }

  /**
   * Helper to ensure traceId is a valid UUID for database audit logging
   */
  private ensureUuidTraceId(traceId?: string): string {
    if (traceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(traceId)) {
      return traceId;
    }
    return crypto.randomUUID();
  }

  /**
   * Get payment state — checks local PostgreSQL cache first, refreshes via Razorpay API if stale or requested (§3, §5)
   */
  async getPayment(razorpayPaymentId: string, options: GetPaymentOptions = {}): Promise<PaymentRow> {
    const traceId = this.ensureUuidTraceId(options.traceId);
    const maxAgeMs = options.maxAgeMs ?? this.defaultMaxAgeMs;

    // 1. Fetch from local PostgreSQL cache (§5)
    const localPayment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('razorpay_payment_id', '=', razorpayPaymentId)
      .executeTakeFirst();

    if (localPayment) {
      const needsRefresh = options.forceRefresh || this.isStale(localPayment, maxAgeMs);

      if (!needsRefresh || !this.razorpay) {
        return localPayment;
      }

      // Try refreshing stale state via Razorpay API (§3)
      try {
        return await this.refreshPaymentState(razorpayPaymentId, traceId);
      } catch (error) {
        // Fallback to local PostgreSQL state on external API failure
        return localPayment;
      }
    }

    // 2. Local record missing — fetch from Razorpay API if client available
    if (!this.razorpay) {
      throw new PaymentNotFoundError(razorpayPaymentId);
    }

    try {
      return await this.refreshPaymentState(razorpayPaymentId, traceId);
    } catch (error) {
      if (error instanceof RazorpayNotFoundError) {
        throw new PaymentNotFoundError(razorpayPaymentId);
      }
      throw error;
    }
  }

  /**
   * Explicitly fetch fresh payment state from Razorpay API and update PostgreSQL (§3, §5)
   */
  async refreshPaymentState(razorpayPaymentId: string, traceId?: string): Promise<PaymentRow> {
    const validTraceId = this.ensureUuidTraceId(traceId);
    if (!this.razorpay) {
      throw new Error('RazorpayClient is unavailable to refresh payment state');
    }

    // 1. Query external Razorpay API (authoritative source)
    const fresh = await this.razorpay.getPayment(razorpayPaymentId);
    const domainStatus = this.mapPaymentStatus(fresh.status);

    // 2. Hash PII if customer fields present (§17)
    let emailHash: string | null = null;
    let phoneHash: string | null = null;
    let nameHash: string | null = null;

    if (this.piiSecret) {
      emailHash = fresh.email ? hmacPII(this.piiSecret, fresh.email) : null;
      phoneHash = fresh.contact ? hmacPII(this.piiSecret, fresh.contact) : null;
      nameHash = fresh.description ? hmacPII(this.piiSecret, fresh.description) : null;
    }

    const amountPaise = fresh.amount;
    const currency = fresh.currency.toUpperCase();
    const createdAtDate = new Date(fresh.created_at * 1000);

    // 3. Upsert fresh payment record into PostgreSQL (§5, §7.2)
    const updatedPayment = await this.db
      .insertInto('payments')
      .values({
        razorpay_payment_id: fresh.id,
        razorpay_order_id: fresh.order_id || null,
        razorpay_customer_id: null,
        amount_paise: String(amountPaise),
        currency,
        status: domainStatus,
        failure_reason: fresh.error_description || null,
        failure_code: fresh.error_code || null,
        method: fresh.method || null,
        email_hash: emailHash,
        phone_hash: phoneHash,
        customer_name_hash: nameHash,
        attempts: fresh.attempts || 0,
        created_at: createdAtDate,
        updated_at: new Date(),
        paid_at: domainStatus === PaymentStatus.PAID ? new Date() : null,
      })
      .onConflict((oc) =>
        oc.column('razorpay_payment_id').doUpdateSet({
          status: domainStatus,
          failure_reason: fresh.error_description || null,
          failure_code: fresh.error_code || null,
          attempts: fresh.attempts || 0,
          updated_at: new Date(),
          paid_at: domainStatus === PaymentStatus.PAID ? new Date() : undefined,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    // 4. Record Audit Log entry for payment state refresh (§17)
    await this.db
      .insertInto('audit_log')
      .values({
        recovery_attempt_id: null,
        payment_id: updatedPayment.id,
        actor: AuditActor.VERIFIER,
        action: 'payment_state_refreshed',
        input: {
          razorpay_payment_id: razorpayPaymentId,
          trace_id: validTraceId,
        },
        output: {
          payment_id: updatedPayment.id,
          status: domainStatus,
          amount_paise: amountPaise,
        },
        error: null,
        trace_id: validTraceId,
        created_at: new Date(),
      })
      .execute();

    return updatedPayment;
  }
}
