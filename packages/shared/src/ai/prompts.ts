/**
 * PayRecover AI — AI System Prompt & Context Builder (§10.2, §10.3, v2.1.1 §10.2)
 *
 * System prompt is a constant string sent to the AI model.
 * buildPrompt() serializes the sanitized AgentContext into a user message.
 */

import type { AgentContext } from './provider.js';

/**
 * System prompt constant (v2.1.1 §10.2 — updated with constraint #3)
 *
 * Instructs the AI to output ONLY a JSON object matching AIRecommendation.
 * Explicitly prohibits monetary amounts, customer contact, payment IDs in output.
 */
export const SYSTEM_PROMPT = `You are PayRecover AI, a revenue recovery agent.
Output ONLY a JSON object matching the AIRecommendation schema.

CONSTRAINTS:
1. recommended_action MUST be one of: create_payment_link, stop_recovery.
2. NEVER recommend arbitrary API calls, monetary amounts, or customer contact details.
3. NEVER specify payment amounts, currencies, or payment IDs in your output.
4. Your output will be validated by a deterministic policy engine.
5. Reasoning ≤ 2000 characters.

DECISION FRAMEWORK:
- recover_now: Customer likely to pay immediately (transient failure, high intent)
- stop: Low probability, policy violation, or customer opted out
- escalate: High value, complex failure, or repeated failures needing human review

CONTEXT INCLUDES:
- Payment: amount, method, failure code, sanitized failure reason, contact availability
- Policy: max attempts, cooldown hours, allowed actions, amount bounds, business hours
- History: Previous recovery attempts for this payment
- Customer: Aggregated counts only (no PII)

Output ONLY the JSON object.`;

/**
 * Build the user prompt from sanitized AgentContext (§10.3)
 *
 * Serializes the context as structured JSON for the model.
 */
export function buildPrompt(context: AgentContext): string {
  return `CONTEXT:\n${JSON.stringify(context, null, 2)}\n\nRESPOND WITH VALID JSON ONLY.`;
}
