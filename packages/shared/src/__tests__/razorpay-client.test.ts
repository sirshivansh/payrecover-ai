import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MockPaymentProvider,
  RazorpayAPIError,
  RazorpayAuthError,
  RazorpayClient,
  RazorpayNotFoundError,
  RazorpayTimeoutError,
} from '../index.js';

describe('Phase 3 — Razorpay Client & Provider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('Test Mode & Credential Enforcement', () => {
    it('should throw RazorpayAuthError if keyId does not start with rzp_test_', () => {
      expect(() => {
        new RazorpayClient({ keyId: 'rzp_live_1234567890', keySecret: 'secret123' });
      }).toThrow(RazorpayAuthError);

      expect(() => {
        new RazorpayClient({ keyId: 'invalid_key', keySecret: 'secret123' });
      }).toThrow("Razorpay key ID must start with 'rzp_test_'");
    });

    it('should throw RazorpayAuthError if keySecret is missing', () => {
      expect(() => {
        new RazorpayClient({ keyId: 'rzp_test_1234567890', keySecret: '' });
      }).toThrow(RazorpayAuthError);
    });

    it('should initialize successfully with valid test mode key prefix', () => {
      const client = new RazorpayClient({
        keyId: 'rzp_test_1234567890',
        keySecret: 'secret123',
      });
      expect(client).toBeDefined();
    });
  });

  describe('API Requests & Error Handling', () => {
    it('should fetch payment details with proper Basic Auth header', async () => {
      const mockResponse = {
        id: 'pay_test_100',
        entity: 'payment',
        amount: 250000,
        currency: 'INR',
        status: 'failed',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Card declined',
        created_at: 1700000000,
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const client = new RazorpayClient({
        keyId: 'rzp_test_key_id',
        keySecret: 'rzp_test_secret',
      });

      const payment = await client.getPayment('pay_test_100');

      expect(payment.id).toBe('pay_test_100');
      expect(payment.amount).toBe(250000);
      expect(payment.status).toBe('failed');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.razorpay.com/v1/payments/pay_test_100',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('rzp_test_key_id:rzp_test_secret').toString('base64')}`,
          }),
        }),
      );
    });

    it('should handle 401 Unauthorized by throwing RazorpayAuthError', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid API key' } }),
      });

      const client = new RazorpayClient({
        keyId: 'rzp_test_invalid',
        keySecret: 'secret',
      });

      await expect(client.getPayment('pay_123')).rejects.toThrow(RazorpayAuthError);
    });

    it('should handle 404 Not Found by throwing RazorpayNotFoundError', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'Payment not found' } }),
      });

      const client = new RazorpayClient({
        keyId: 'rzp_test_valid',
        keySecret: 'secret',
      });

      await expect(client.getPayment('pay_nonexistent')).rejects.toThrow(RazorpayNotFoundError);
    });

    it('should handle request timeout by throwing RazorpayTimeoutError', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      global.fetch = vi.fn().mockRejectedValue(abortError);

      const client = new RazorpayClient({
        keyId: 'rzp_test_valid',
        keySecret: 'secret',
        timeoutMs: 100,
      });

      await expect(client.getPayment('pay_123')).rejects.toThrow(RazorpayTimeoutError);
    });

    it('should create payment link successfully', async () => {
      const mockLinkResponse = {
        id: 'plink_100',
        entity: 'payment_link',
        amount: 250000,
        currency: 'INR',
        status: 'created',
        short_url: 'https://rzp.io/i/plink_100',
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockLinkResponse,
      });

      const client = new RazorpayClient({
        keyId: 'rzp_test_valid',
        keySecret: 'secret',
      });

      const link = await client.createPaymentLink({
        amount: 250000,
        currency: 'INR',
        description: 'Payment Recovery',
      });

      expect(link.id).toBe('plink_100');
      expect(link.short_url).toBe('https://rzp.io/i/plink_100');
    });

    it('should never expose key secret in thrown error messages', async () => {
      const secretKey = 'super_secret_key_12345';
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        json: async () => ({ error: { description: 'Server failure' } }),
      });

      const client = new RazorpayClient({
        keyId: 'rzp_test_valid',
        keySecret: secretKey,
      });

      try {
        await client.getPayment('pay_123');
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).not.toContain(secretKey);
      }
    });
  });

  describe('MockPaymentProvider', () => {
    it('should support offline payment fetching and link creation', async () => {
      const provider = new MockPaymentProvider();
      provider.addMockPayment({
        id: 'pay_mock_1',
        entity: 'payment',
        amount: 50000,
        currency: 'INR',
        status: 'failed',
        created_at: 1700000000,
      });

      const payment = await provider.getPayment('pay_mock_1');
      expect(payment.id).toBe('pay_mock_1');
      expect(payment.amount).toBe(50000);

      const link = await provider.createPaymentLink({
        amount: 50000,
        currency: 'INR',
        description: 'Mock link',
      });

      expect(link.id).toBeDefined();
      expect(link.short_url).toContain('https://rzp.io/i/');
      expect(provider.getCreatedPaymentLinks().length).toBe(1);
    });

    it('should throw RazorpayNotFoundError for missing mock payments', async () => {
      const provider = new MockPaymentProvider();
      await expect(provider.getPayment('missing_id')).rejects.toThrow(RazorpayNotFoundError);
    });

    it('should simulate errors when configured', async () => {
      const provider = new MockPaymentProvider();
      provider.setSimulatedError(new RazorpayAPIError('Simulated server error', 500));

      await expect(provider.getPayment('pay_123')).rejects.toThrow('Simulated server error');
    });
  });
});
