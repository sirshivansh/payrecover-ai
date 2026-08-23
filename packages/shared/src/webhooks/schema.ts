import { z } from 'zod';

/**
 * Zod schema for validating incoming Razorpay webhook payloads.
 * Strictly checks supported event types ('payment.failed', 'payment.captured', 'payment.refunded').
 *
 * Per Specification §9.2.
 */
export const RazorpayWebhookSchema = z.object({
  id: z.string().min(1),
  entity: z.literal('event'),
  event: z.enum(['payment.failed', 'payment.captured', 'payment.refunded']),
  account_id: z.string().min(1),
  contains: z.array(z.unknown()),
  payload: z.object({
    payment: z.object({
      entity: z.object({
        id: z.string().min(1),
        entity: z.literal('payment'),
        amount: z.number().int().nonnegative(),
        currency: z.string().length(3),
        status: z.string(),
        order_id: z.string().nullable().optional(),
        invoice_id: z.string().nullable().optional(),
        international: z.boolean().optional(),
        method: z.string().nullable().optional(),
        amount_refunded: z.number().int().nonnegative().optional(),
        refund_status: z.string().nullable().optional(),
        captured: z.boolean().optional(),
        description: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        contact: z.string().nullable().optional(),
        customer_id: z.string().nullable().optional(),
        error_code: z.string().nullable().optional(),
        error_description: z.string().nullable().optional(),
        created_at: z.number().int().positive(),
        attempts: z.number().int().nonnegative().optional(),
      }),
    }),
  }),
  created_at: z.number().int().positive(),
});

export type RazorpayWebhookPayload = z.infer<typeof RazorpayWebhookSchema>;
export type RazorpayPaymentEntity = RazorpayWebhookPayload['payload']['payment']['entity'];
