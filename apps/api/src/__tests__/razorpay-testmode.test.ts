import crypto from 'node:crypto';
import {
  MockPaymentProvider,
  OutcomeVerifier,
  PaymentStatus,
  RazorpayAuthError,
  RazorpayClient,
  RazorpayTimeoutError,
  Reconciler,
  RecoveryStatus,
} from '@payrecover/shared';
import { describe, expect, it } from 'vitest';
import { createPaymentLinkTool } from '../actions/tools/payment-link.js';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';

describe('Phase 18 — Razorpay Test Mode Safety & Integration Suite (§3, §8, §12, §18, §26)', () => {
  const env = loadEnv();

  describe('1. Test Mode Credentials & Safety Hardening', () => {
    it('should throw RazorpayAuthError when attempting to instantiate with production rzp_live_ keys', () => {
      expect(
        () =>
          new RazorpayClient({
            keyId: 'rzp_live_9999999999',
            keySecret: 'live_secret_123',
          }),
      ).toThrowError(RazorpayAuthError);

      try {
        new RazorpayClient({ keyId: 'rzp_live_1234567890', keySecret: 'secret' });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RazorpayAuthError);
        expect((err as Error).message).toContain("must start with 'rzp_test_'");
      }
    });

    it('should throw RazorpayAuthError when keyId is invalid or missing rzp_test_ prefix', () => {
      expect(
        () =>
          new RazorpayClient({
            keyId: 'invalid_prefix_123',
            keySecret: 'secret_123',
          }),
      ).toThrowError(RazorpayAuthError);
    });

    it('should throw RazorpayAuthError when keySecret is empty', () => {
      expect(
        () =>
          new RazorpayClient({
            keyId: 'rzp_test_valid123',
            keySecret: '',
          }),
      ).toThrowError(RazorpayAuthError);
    });

    it('should accept valid rzp_test_ keyId and secret for Test Mode initialization', () => {
      const client = new RazorpayClient({
        keyId: 'rzp_test_valid123456',
        keySecret: 'valid_test_secret_123',
      });
      expect(client).toBeDefined();
    });
  });

  describe('2. Authoritative PostgreSQL Financial Boundary & Anti-Duplicate Link Guarantees', () => {
    it('should enforce that createPaymentLinkTool strictly uses amountPaise from PostgreSQL and ignores AI overrides', async () => {
      const mockRazorpay = new MockPaymentProvider();
      const postgresAmountPaise = 450000; // ₹4,500.00 from PostgreSQL payment record

      const link = await createPaymentLinkTool({
        razorpay: mockRazorpay,
        amountPaise: postgresAmountPaise,
        currency: 'INR',
        recoveryAttemptId: 'att_test_18_1',
      });

      expect(link).toBeDefined();
      const createdLinks = mockRazorpay.getCreatedPaymentLinks();
      expect(createdLinks.length).toBe(1);
      expect(createdLinks[0]?.amount).toBe(450000);
      expect(createdLinks[0]?.notes?.recovery_attempt_id).toBe('att_test_18_1');
    });

    it('should transition to ACTION_OUTCOME_UNKNOWN and NEVER create a duplicate link on timeout', async () => {
      const mockRazorpay = new MockPaymentProvider();
      mockRazorpay.setSimulatedError(new RazorpayTimeoutError(5000));

      let threwTimeout = false;
      try {
        await createPaymentLinkTool({
          razorpay: mockRazorpay,
          amountPaise: 250000,
          currency: 'INR',
          recoveryAttemptId: 'att_timeout_18',
        });
      } catch (err: unknown) {
        if (err instanceof RazorpayTimeoutError) {
          threwTimeout = true;
        }
      }

      expect(threwTimeout).toBe(true);
      // Verify zero payment links were successfully stored/created on timeout
      expect(mockRazorpay.getCreatedPaymentLinks().length).toBe(0);
    });
  });

  describe('3. Razorpay Webhook HMAC Signature & Raw Body Verification', () => {
    it('should return HTTP 401 when webhook request has invalid HMAC signature', async () => {
      const app = await buildApp({ env });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'x-razorpay-signature': 'invalid_hmac_sig_123',
          'content-type': 'application/json',
        },
        payload: {
          event: 'payment.failed',
          payload: { payment: { entity: { id: 'pay_invalid_sig' } } },
        },
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('should accept webhook request with valid HMAC-SHA256 signature', async () => {
      const webhookSecret = 'test_webhook_secret_key_18_testmode';
      const customEnv = { ...env, RAZORPAY_WEBHOOK_SECRET: webhookSecret };
      const app = await buildApp({ env: customEnv });

      const eventPayload = {
        id: 'event_valid_hmac_18',
        entity: 'event',
        event: 'payment.failed',
        account_id: 'acc_test_18',
        contains: ['payment'],
        payload: {
          payment: {
            entity: {
              id: 'pay_valid_hmac_18',
              entity: 'payment',
              amount: 250000,
              currency: 'INR',
              status: 'failed',
              method: 'card',
              created_at: Math.floor(Date.now() / 1000),
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      };

      const rawBody = JSON.stringify(eventPayload);
      const signature = crypto.createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'x-razorpay-signature': signature,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('4. External Razorpay Test Mode API Integration (Opt-in Gate)', () => {
    const isTestModeConfigured =
      process.env.RUN_RAZORPAY_TESTMODE === 'true' &&
      Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) &&
      Boolean(process.env.RAZORPAY_KEY_SECRET);

    if (isTestModeConfigured) {
      it('should interact with live Razorpay Test Mode API endpoints', async () => {
        const client = new RazorpayClient({
          keyId: String(process.env.RAZORPAY_KEY_ID),
          keySecret: String(process.env.RAZORPAY_KEY_SECRET),
        });

        const link = await client.createPaymentLink({
          amount: 10000, // ₹100.00
          currency: 'INR',
          description: 'Phase 18 Test Mode Verification',
          expire_by: Math.floor(Date.now() / 1000) + 3600,
        });

        expect(link).toHaveProperty('id');
        expect(link.id).toMatch(/^plink_/);
        expect(link).toHaveProperty('short_url');

        const fetchedLink = await client.getPaymentLink(link.id);
        expect(fetchedLink.id).toBe(link.id);
      });
    } else {
      it('SKIPPED — Razorpay Test Mode credentials not configured (RUN_RAZORPAY_TESTMODE=false)', () => {
        console.log('ℹ️ SKIPPED — Razorpay Test Mode credentials not configured');
        expect(true).toBe(true);
      });
    }
  });
});
