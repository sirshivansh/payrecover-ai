/**
 * Razorpay API Types & Error Definitions (§18, §12)
 */

export class RazorpayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RazorpayError';
  }
}

export class RazorpayAuthError extends RazorpayError {
  constructor(message = 'Invalid or non-Test Mode Razorpay API credentials') {
    super(message);
    this.name = 'RazorpayAuthError';
  }
}

export class RazorpayNotFoundError extends RazorpayError {
  constructor(entity: string, id: string) {
    super(`${entity} with ID '${id}' was not found on Razorpay`);
    this.name = 'RazorpayNotFoundError';
  }
}

export class RazorpayAPIError extends RazorpayError {
  public readonly statusCode: number;
  public readonly errorCode?: string;

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message);
    this.name = 'RazorpayAPIError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export class RazorpayTimeoutError extends RazorpayError {
  constructor(timeoutMs: number) {
    super(`Razorpay API request timed out after ${timeoutMs}ms`);
    this.name = 'RazorpayTimeoutError';
  }
}

export class RazorpayNetworkError extends RazorpayError {
  constructor(cause: string) {
    super(`Razorpay network error: ${cause}`);
    this.name = 'RazorpayNetworkError';
  }
}

export interface RazorpayClientOptions {
  keyId?: string;
  keySecret?: string;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface RazorpayPayment {
  id: string;
  entity: 'payment';
  amount: number; // paise
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id?: string | null;
  invoice_id?: string | null;
  international?: boolean;
  method?: string | null;
  amount_refunded?: number;
  refund_status?: string | null;
  captured?: boolean;
  description?: string | null;
  card_id?: string | null;
  bank?: string | null;
  wallet?: string | null;
  vpa?: string | null;
  email?: string | null;
  contact?: string | null;
  notes?: Record<string, string>;
  fee?: number | null;
  tax?: number | null;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  attempts?: number;
  created_at: number; // Unix timestamp
}

export interface RazorpayPaymentLink {
  id: string;
  entity: 'payment_link';
  amount: number;
  currency: string;
  status: 'created' | 'partially_paid' | 'paid' | 'expired' | 'cancelled';
  short_url: string;
  customer?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  expire_by?: number;
  notes?: Record<string, string>;
  created_at?: number;
}

export interface CreatePaymentLinkParams {
  amount: number;
  currency: string;
  description?: string;
  customer?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  expire_by?: number;
  notify?: {
    email?: boolean;
    sms?: boolean;
  };
  reminder_enable?: boolean;
  notes?: Record<string, string>;
}

export interface IRazorpayClient {
  getPayment(paymentId: string): Promise<RazorpayPayment>;
  createPaymentLink(params: CreatePaymentLinkParams): Promise<RazorpayPaymentLink>;
  getPaymentLink(linkId: string): Promise<RazorpayPaymentLink>;
}
