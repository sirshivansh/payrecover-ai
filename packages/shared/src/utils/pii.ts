import crypto from 'node:crypto';

/**
 * Pseudonymizes PII data (email, phone, name) using HMAC-SHA256.
 *
 * Per Specification §17: Raw PII MUST NEVER be stored in audit logs or AI prompts.
 * Hashes are deterministic for lookup while protecting customer identity.
 *
 * @param secret HMAC secret key (PII_HMAC_SECRET)
 * @param value Raw PII string to hash
 * @returns 64-character hex string (HMAC-SHA256) or empty string if input is empty
 */
export function hmacPII(secret: string, value: string | null | undefined): string {
  if (!value || !value.trim()) {
    return '';
  }
  const key = secret || 'default_pii_hmac_secret_for_dev_only';
  return crypto.createHmac('sha256', key).update(value.toLowerCase().trim()).digest('hex');
}
