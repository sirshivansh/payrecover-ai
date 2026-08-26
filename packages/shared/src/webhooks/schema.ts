import { z } from 'zod';

export const RazorpayPaymentEntitySchema = z.object({
  id: z.string().min(1),
  entity: z.literal('payment').optional(),
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
  created_at: z.number().int().positive().optional(),
  attempts: z.number().int().nonnegative().optional(),
  notes: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const RazorpayPaymentLinkEntitySchema = z.object({
  id: z.string().min(1),
  entity: z.string().optional(),
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  status: z.string(),
  short_url: z.string().optional(),
  notes: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * Zod schema for validating incoming Razorpay webhook payloads.
 * Supports event types: 'payment.failed', 'payment.captured', 'payment.refunded', 'payment_link.paid'.
 *
 * Per Specification §9.2.
 */
export const RazorpayWebhookSchema = z
  .object({
    id: z.string().min(1),
    entity: z.literal('event'),
    event: z.enum(['payment.failed', 'payment.captured', 'payment.refunded', 'payment_link.paid']),
    account_id: z.string().min(1),
    contains: z.array(z.unknown()),
    payload: z.object({
      payment: z
        .object({
          entity: RazorpayPaymentEntitySchema,
        })
        .optional(),
      payment_link: z
        .object({
          entity: RazorpayPaymentLinkEntitySchema,
        })
        .optional(),
    }),
    created_at: z.number().int().positive(),
  })
  .refine((data) => Boolean(data.payload.payment?.entity || data.payload.payment_link?.entity), {
    message: 'Webhook payload must contain either payment or payment_link entity',
  });

export type RazorpayWebhookPayload = z.infer<typeof RazorpayWebhookSchema>;
export type RazorpayPaymentEntity = z.infer<typeof RazorpayPaymentEntitySchema>;
export type RazorpayPaymentLinkEntity = z.infer<typeof RazorpayPaymentLinkEntitySchema>;
