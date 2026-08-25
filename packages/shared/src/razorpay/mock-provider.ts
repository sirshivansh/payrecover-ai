import {
  type CreatePaymentLinkParams,
  type IRazorpayClient,
  RazorpayNotFoundError,
  type RazorpayPayment,
  type RazorpayPaymentLink,
} from './types.js';

export class MockPaymentProvider implements IRazorpayClient {
  private payments = new Map<string, RazorpayPayment>();
  private paymentLinks = new Map<string, RazorpayPaymentLink>();
  private simulatedError: Error | null = null;

  /**
   * Seed a mock payment object for testing (§18.2, §23)
   */
  addMockPayment(payment: RazorpayPayment): void {
    this.payments.set(payment.id, payment);
  }

  /**
   * Seed a mock payment link object for testing
   */
  addMockPaymentLink(link: RazorpayPaymentLink): void {
    this.paymentLinks.set(link.id, link);
  }

  /**
   * Set a simulated error to be thrown on next API call
   */
  setSimulatedError(error: Error | null): void {
    this.simulatedError = error;
  }

  /**
   * Clear all seed data and simulated errors
   */
  reset(): void {
    this.payments.clear();
    this.paymentLinks.clear();
    this.simulatedError = null;
  }

  /**
   * Retrieve all created payment links
   */
  getCreatedPaymentLinks(): RazorpayPaymentLink[] {
    return Array.from(this.paymentLinks.values());
  }

  async getPayment(paymentId: string): Promise<RazorpayPayment> {
    if (this.simulatedError) {
      const err = this.simulatedError;
      this.simulatedError = null;
      throw err;
    }

    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new RazorpayNotFoundError('Payment', paymentId);
    }

    return { ...payment };
  }

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<RazorpayPaymentLink> {
    if (this.simulatedError) {
      const err = this.simulatedError;
      this.simulatedError = null;
      throw err;
    }

    const id = `plink_mock_${Math.random().toString(36).substring(2, 10)}`;
    const link: RazorpayPaymentLink = {
      id,
      entity: 'payment_link',
      amount: params.amount,
      currency: params.currency,
      status: 'created',
      short_url: `https://rzp.io/i/${id}`,
      customer: params.customer,
      expire_by: params.expire_by,
      notes: params.notes,
      created_at: Math.floor(Date.now() / 1000),
    };

    this.paymentLinks.set(id, link);
    return link;
  }

  async getPaymentLink(linkId: string): Promise<RazorpayPaymentLink> {
    if (this.simulatedError) {
      const err = this.simulatedError;
      this.simulatedError = null;
      throw err;
    }

    const link = this.paymentLinks.get(linkId);
    if (!link) {
      throw new RazorpayNotFoundError('Payment Link', linkId);
    }

    return { ...link };
  }
}
