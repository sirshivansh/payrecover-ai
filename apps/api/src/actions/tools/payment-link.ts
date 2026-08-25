import type { IRazorpayClient, RazorpayPaymentLink } from '@payrecover/shared';

export interface CreatePaymentLinkToolParams {
  razorpay: IRazorpayClient;
  amountPaise: number; // FROM POSTGRESQL DB — AUTHORITATIVE (NEVER FROM AI)
  currency: string; // FROM POSTGRESQL DB — AUTHORITATIVE (NEVER FROM AI)
  recoveryAttemptId: string;
}

/**
 * Bounded Tool: CREATE_PAYMENT_LINK (§12.1, §12.2, v2.1.1 §12, §30)
 *
 * Creates a Razorpay Payment Link in Test Mode.
 *
 * Security & Financial Boundary:
 * - Amount and currency are sourced STRICTLY from PostgreSQL payment record.
 * - AI output NEVER controls monetary amounts or API parameters.
 * - Customer contact fields are omitted per v2.1.1 §12.1/§12.2 (Test Mode link works without customer object).
 */
export async function createPaymentLinkTool(params: CreatePaymentLinkToolParams): Promise<RazorpayPaymentLink> {
  const expireBy = Math.floor(Date.now() / 1000) + 86400; // 24 hours per spec §12.2

  return await params.razorpay.createPaymentLink({
    amount: params.amountPaise,
    currency: params.currency,
    description: 'Payment Recovery',
    expire_by: expireBy,
    notify: { email: false, sms: false },
    reminder_enable: false,
    notes: { recovery_attempt_id: params.recoveryAttemptId },
  });
}
