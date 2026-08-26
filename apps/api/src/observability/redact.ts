/**
 * Sensitive Data Redaction Utility — Phase 12 Observability (§16, §17)
 *
 * Redacts raw PII and secrets from objects before audit log insertion or API responses.
 * Retains HMAC-SHA256 pseudonyms (email_hash, phone_hash, customer_name_hash).
 *
 * NON-NEGOTIABLE: No raw email, phone, customer name, API keys, authorization headers,
 * Razorpay secrets, NVIDIA API keys, Redis credentials, or lock owner tokens
 * in audit input/output/error, metric labels, or console logs.
 */

/** Known secret field names (case-insensitive check) */
const SECRET_FIELD_NAMES = new Set([
  'authorization',
  'x-razorpay-signature',
  'razorpay_key_secret',
  'razorpay_webhook_secret',
  'nvidia_api_key',
  'api_key',
  'apikey',
  'api_secret',
  'secret',
  'password',
  'token',
  'credential',
  'redis_url',
  'database_url',
  'pii_hmac_secret',
  'merchant_api_key',
  'x-merchant-key',
  'cookie',
]);

/** Regex patterns for values that look like secrets or raw PII */
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // Razorpay key IDs (must remain test mode — rzp_test_*)
  /rzp_(?:test|live)_[A-Za-z0-9]+/,
  // NVIDIA API keys
  /nvapi-[A-Za-z0-9_-]+/,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9._-]+/i,
  // Redis URLs with credentials
  /redis:\/\/[^@]+@/,
  // PostgreSQL URLs with credentials
  /postgres(?:ql)?:\/\/[^@]+@/,
];

/** Regex for raw email detection */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/** Regex for raw phone detection (Indian +91 or 10-digit) */
const PHONE_PATTERN = /(?:\+91[\s-]?)?[6-9]\d{9}/;

const REDACTED = '[REDACTED]';

/**
 * Check if a field name is a known secret field.
 */
function isSecretFieldName(key: string): boolean {
  return SECRET_FIELD_NAMES.has(key.toLowerCase());
}

/**
 * Check if a string value contains a secret pattern.
 */
function containsSecretPattern(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Check if a string value contains raw PII (email or phone).
 */
function containsRawPII(value: string): boolean {
  return EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value);
}

/**
 * Safe field names that should NOT be redacted even if they contain PII-like patterns.
 * e.g., email_hash, phone_hash are HMAC pseudonyms — safe.
 */
const SAFE_HASH_FIELDS = new Set([
  'email_hash',
  'phone_hash',
  'customer_name_hash',
  'has_email',
  'has_phone',
  'has_customer_name',
  'hasEmail',
  'hasPhone',
  'hasCustomerName',
]);

/**
 * Deep-clone and redact sensitive data from an object.
 * Returns a new object with secrets and raw PII replaced by '[REDACTED]'.
 *
 * Preserves:
 * - HMAC pseudonyms (email_hash, phone_hash, customer_name_hash)
 * - Boolean flags (has_email, has_phone)
 * - Non-sensitive business data
 */
export function redactSensitiveData<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    if (containsSecretPattern(obj) || containsRawPII(obj)) {
      return REDACTED as unknown as T;
    }
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // Skip redaction on known safe hash fields
    if (SAFE_HASH_FIELDS.has(key)) {
      result[key] = value;
      continue;
    }

    // Redact known secret field names
    if (isSecretFieldName(key)) {
      result[key] = REDACTED;
      continue;
    }

    // Recursively redact nested objects
    if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveData(value);
      continue;
    }

    // Redact string values containing secret patterns or raw PII
    if (typeof value === 'string') {
      if (containsSecretPattern(value) || containsRawPII(value)) {
        result[key] = REDACTED;
      } else {
        result[key] = value;
      }
      continue;
    }

    result[key] = value;
  }

  return result as T;
}
