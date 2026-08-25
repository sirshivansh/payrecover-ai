import {
  type CreatePaymentLinkParams,
  type IRazorpayClient,
  RazorpayAPIError,
  RazorpayAuthError,
  type RazorpayClientOptions,
  RazorpayNetworkError,
  RazorpayNotFoundError,
  type RazorpayPayment,
  type RazorpayPaymentLink,
  RazorpayTimeoutError,
} from './types.js';

export class RazorpayClient implements IRazorpayClient {
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: RazorpayClientOptions = {}) {
    // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
    const keyId = options.keyId ?? process.env['RAZORPAY_KEY_ID'] ?? '';
    // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
    const keySecret = options.keySecret ?? process.env['RAZORPAY_KEY_SECRET'] ?? '';

    // Test Mode assertion (§18.2, §2.5)
    if (!keyId.startsWith('rzp_test_')) {
      throw new RazorpayAuthError(
        "Razorpay key ID must start with 'rzp_test_' for Test Mode. Live keys or missing credentials are strictly prohibited.",
      );
    }

    if (!keySecret) {
      throw new RazorpayAuthError('Razorpay key secret is required');
    }

    this.keyId = keyId;
    this.keySecret = keySecret;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.baseUrl = options.baseUrl ?? 'https://api.razorpay.com/v1';
  }

  /**
   * Internal HTTP helper with timeout, Basic Auth, and error mapping (§18.2)
   */
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const authHeader = `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;

    const headers: Record<string, string> = {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers as Record<string, string>),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorBody: { error?: { code?: string; description?: string } } = {};
        try {
          errorBody = (await response.json()) as typeof errorBody;
        } catch {
          // Ignore JSON parse failure for error response
        }

        const statusCode = response.status;
        const errorCode = errorBody.error?.code;
        const errorDesc = errorBody.error?.description || response.statusText;

        if (statusCode === 401) {
          throw new RazorpayAuthError('Razorpay API authentication failed (401 Unauthorized)');
        }

        if (statusCode === 404) {
          throw new RazorpayNotFoundError('Resource', path);
        }

        throw new RazorpayAPIError(`Razorpay API error (${statusCode}): ${errorDesc}`, statusCode, errorCode);
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (
        error instanceof RazorpayAPIError ||
        error instanceof RazorpayAuthError ||
        error instanceof RazorpayNotFoundError
      ) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new RazorpayTimeoutError(this.timeoutMs);
      }

      const causeMessage = error instanceof Error ? error.message : String(error);
      throw new RazorpayNetworkError(causeMessage);
    }
  }

  /**
   * Fetch payment entity by ID: GET /v1/payments/{id} (§18.2)
   */
  async getPayment(paymentId: string): Promise<RazorpayPayment> {
    if (!paymentId || typeof paymentId !== 'string') {
      throw new Error('Payment ID must be a non-empty string');
    }
    return this.request<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
    });
  }

  /**
   * Create payment link: POST /v1/payment_links (§12.2, §18.2)
   */
  async createPaymentLink(params: CreatePaymentLinkParams): Promise<RazorpayPaymentLink> {
    if (!params.amount || params.amount <= 0) {
      throw new Error('Payment link amount must be a positive integer in paise');
    }
    if (!params.currency) {
      throw new Error('Payment link currency is required');
    }

    return this.request<RazorpayPaymentLink>('/payment_links', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /**
   * Fetch payment link entity by ID: GET /v1/payment_links/{id} (§12.3, §14.2)
   */
  async getPaymentLink(linkId: string): Promise<RazorpayPaymentLink> {
    if (!linkId || typeof linkId !== 'string') {
      throw new Error('Payment Link ID must be a non-empty string');
    }
    return this.request<RazorpayPaymentLink>(`/payment_links/${encodeURIComponent(linkId)}`, {
      method: 'GET',
    });
  }
}
