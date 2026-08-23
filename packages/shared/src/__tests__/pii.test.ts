import { describe, expect, it } from 'vitest';
import { hmacPII } from '../utils/pii.js';

describe('PII HMAC-SHA256 Hashing Utility', () => {
  const testSecret = 'secret_key_12345';

  it('should generate consistent 64-character hex hash for email', () => {
    const email = 'user@example.com';
    const hash1 = hmacPII(testSecret, email);
    const hash2 = hmacPII(testSecret, '  USER@EXAMPLE.COM  ');

    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
  });

  it('should return empty string for null or empty input', () => {
    expect(hmacPII(testSecret, '')).toBe('');
    expect(hmacPII(testSecret, null)).toBe('');
    expect(hmacPII(testSecret, '   ')).toBe('');
  });

  it('should produce different hashes for different secret keys', () => {
    const email = 'customer@merchant.com';
    const hash1 = hmacPII('secret1', email);
    const hash2 = hmacPII('secret2', email);

    expect(hash1).not.toBe(hash2);
  });
});
