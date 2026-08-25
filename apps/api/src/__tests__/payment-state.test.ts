import {
  MockPaymentProvider,
  type PaymentRow,
  PaymentStatus,
  RazorpayAPIError,
  RazorpayNotFoundError,
} from '@payrecover/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { PaymentNotFoundError, PaymentStateService } from '../payments/state-service.js';

describe('Phase 3 — PaymentStateService', () => {
  const env = loadEnv();
  const { db, close } = createDatabaseClient(env);
  let mockRazorpay: MockPaymentProvider;
  let stateService: PaymentStateService;

  beforeAll(() => {
    mockRazorpay = new MockPaymentProvider();
    stateService = new PaymentStateService(db, mockRazorpay, env.PII_HMAC_SECRET || 'test_pii_secret');
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    mockRazorpay.reset();
  });

  describe('Status Mapping & Staleness Logic', () => {
    it('should correctly map Razorpay status strings to PaymentStatus enum', () => {
      expect(stateService.mapPaymentStatus('captured')).toBe(PaymentStatus.PAID);
      expect(stateService.mapPaymentStatus('paid')).toBe(PaymentStatus.PAID);
      expect(stateService.mapPaymentStatus('refunded')).toBe(PaymentStatus.REFUNDED);
      expect(stateService.mapPaymentStatus('cancelled')).toBe(PaymentStatus.CANCELLED);
      expect(stateService.mapPaymentStatus('failed')).toBe(PaymentStatus.FAILED);
      expect(stateService.mapPaymentStatus('attempted')).toBe(PaymentStatus.FAILED);
      expect(stateService.mapPaymentStatus('created')).toBe(PaymentStatus.CREATED);
    });

    it('should classify terminal payment states as never stale', () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

      const paidPayment = { status: PaymentStatus.PAID, updated_at: tenDaysAgo } as unknown as PaymentRow;
      const refundedPayment = { status: PaymentStatus.REFUNDED, updated_at: tenDaysAgo } as unknown as PaymentRow;
      const cancelledPayment = { status: PaymentStatus.CANCELLED, updated_at: tenDaysAgo } as unknown as PaymentRow;

      expect(stateService.isStale(paidPayment)).toBe(false);
      expect(stateService.isStale(refundedPayment)).toBe(false);
      expect(stateService.isStale(cancelledPayment)).toBe(false);
    });

    it('should classify non-terminal states as stale if older than maxAgeMs', () => {
      const freshDate = new Date(Date.now() - 60 * 1000); // 1 min ago
      const staleDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago

      const freshFailed = { status: PaymentStatus.FAILED, updated_at: freshDate } as unknown as PaymentRow;
      const staleFailed = { status: PaymentStatus.FAILED, updated_at: staleDate } as unknown as PaymentRow;

      expect(stateService.isStale(freshFailed, 5 * 60 * 1000)).toBe(false);
      expect(stateService.isStale(staleFailed, 5 * 60 * 1000)).toBe(true);
    });
  });

  describe('Payment State Fetching & Synchronization', () => {
    it('should return local payment from DB if state is fresh without calling Razorpay API', async () => {
      const razorpayId = `pay_fresh_${Date.now()}`;

      // Insert fresh payment in DB
      const inserted = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '250000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const getSpy = vi.spyOn(mockRazorpay, 'getPayment');

      const result = await stateService.getPayment(razorpayId);

      expect(result.id).toBe(inserted.id);
      expect(result.status).toBe(PaymentStatus.FAILED);
      expect(getSpy).not.toHaveBeenCalled();

      // Clean up
      await db.deleteFrom('payments').where('id', '=', inserted.id).execute();
    });

    it('should fetch from Razorpay and insert into DB if payment record is missing locally', async () => {
      const razorpayId = `pay_missing_${Date.now()}`;

      mockRazorpay.addMockPayment({
        id: razorpayId,
        entity: 'payment',
        amount: 350000,
        currency: 'INR',
        status: 'failed',
        error_code: 'BAD_REQUEST_PAYMENT_DECLINED',
        error_description: 'Issuer declined card',
        attempts: 1,
        created_at: Math.floor(Date.now() / 1000),
      });

      const result = await stateService.getPayment(razorpayId);

      expect(result).toBeDefined();
      expect(result.razorpay_payment_id).toBe(razorpayId);
      expect(String(result.amount_paise)).toBe('350000');
      expect(result.status).toBe(PaymentStatus.FAILED);
      expect(result.failure_reason).toBe('Issuer declined card');

      // Verify audit log entry
      const audit = await db.selectFrom('audit_log').selectAll().where('payment_id', '=', result.id).executeTakeFirst();

      expect(audit).toBeDefined();
      expect(audit?.action).toBe('payment_state_refreshed');

      // Clean up
      await db.deleteFrom('payments').where('id', '=', result.id).execute();
    });

    it('should throw PaymentNotFoundError if payment is missing locally and on Razorpay', async () => {
      await expect(stateService.getPayment('pay_completely_unknown')).rejects.toThrow(PaymentNotFoundError);
    });

    it('should refresh stale payment state via Razorpay and update DB', async () => {
      const razorpayId = `pay_stale_${Date.now()}`;
      const staleDate = new Date(Date.now() - 15 * 60 * 1000); // 15 mins ago

      // Seed DB with stale FAILED payment
      const initial = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '100000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
          updated_at: staleDate,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Seed Razorpay mock with updated state (PAID / captured)
      mockRazorpay.addMockPayment({
        id: razorpayId,
        entity: 'payment',
        amount: 100000,
        currency: 'INR',
        status: 'captured',
        created_at: Math.floor(Date.now() / 1000),
      });

      const result = await stateService.getPayment(razorpayId, { maxAgeMs: 5 * 60 * 1000 });

      expect(result.id).toBe(initial.id);
      expect(result.status).toBe(PaymentStatus.PAID);
      expect(result.paid_at).toBeDefined();

      // Clean up
      await db.deleteFrom('payments').where('id', '=', initial.id).execute();
    });

    it('should force refresh when forceRefresh: true is passed even if local state is fresh', async () => {
      const razorpayId = `pay_force_${Date.now()}`;

      // Insert fresh FAILED in DB
      const initial = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '120000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Razorpay mock updated to captured
      mockRazorpay.addMockPayment({
        id: razorpayId,
        entity: 'payment',
        amount: 120000,
        currency: 'INR',
        status: 'captured',
        created_at: Math.floor(Date.now() / 1000),
      });

      const result = await stateService.getPayment(razorpayId, { forceRefresh: true });

      expect(result.status).toBe(PaymentStatus.PAID);

      // Clean up
      await db.deleteFrom('payments').where('id', '=', initial.id).execute();
    });

    it('should fallback gracefully to local DB state if Razorpay API fails during refresh of stale state', async () => {
      const razorpayId = `pay_err_fallback_${Date.now()}`;
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);

      // Insert stale record in DB
      const initial = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '50000',
          currency: 'INR',
          status: PaymentStatus.FAILED,
          updated_at: staleDate,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Simulate network error on Razorpay mock
      mockRazorpay.setSimulatedError(new RazorpayAPIError('Razorpay internal error', 500));

      const result = await stateService.getPayment(razorpayId, { maxAgeMs: 5 * 60 * 1000 });

      // Should return local DB state without crashing
      expect(result.id).toBe(initial.id);
      expect(result.status).toBe(PaymentStatus.FAILED);

      // Clean up
      await db.deleteFrom('payments').where('id', '=', initial.id).execute();
    });
  });
});
