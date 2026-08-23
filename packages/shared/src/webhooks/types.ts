export interface WebhookProcessResult {
  status: 'processed' | 'duplicate' | 'error';
  eventId: string;
  eventType: string;
  razorpayPaymentId: string;
  paymentRecordId?: string;
  message?: string;
}

export interface WebhookVerificationOptions {
  rawBody: string;
  signature: string;
  secret: string;
}
