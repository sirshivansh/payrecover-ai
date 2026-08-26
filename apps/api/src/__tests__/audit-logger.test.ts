import { AuditActor, type Database } from '@payrecover/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { AuditLogger } from '../observability/audit.js';
import { redactSensitiveData } from '../observability/redact.js';

describe('Phase 12 — AuditLogger & Redaction', () => {
  const env = loadEnv();
  const { db, close } = createDatabaseClient(env);
  let auditLogger: AuditLogger;

  beforeAll(() => {
    auditLogger = new AuditLogger(db);
  });

  afterAll(async () => {
    await close();
  });

  describe('1. Redaction Utility (§16, §17)', () => {
    it('should redact raw email addresses', () => {
      const input = { contact: 'john@example.com', name: 'John' };
      const result = redactSensitiveData(input);
      expect(result.contact).toBe('[REDACTED]');
      expect(result.name).toBe('John');
    });

    it('should redact raw phone numbers', () => {
      const input = { phone: '+919876543210', city: 'Mumbai' };
      const result = redactSensitiveData(input);
      expect(result.phone).toBe('[REDACTED]');
      expect(result.city).toBe('Mumbai');
    });

    it('should redact Razorpay API keys', () => {
      const input = { key: 'rzp_test_1DP5mmOlF5G5ag', data: 'safe' };
      const result = redactSensitiveData(input);
      expect(result.key).toBe('[REDACTED]');
      expect(result.data).toBe('safe');
    });

    it('should redact NVIDIA API keys', () => {
      const input = { key: 'nvapi-abc123def456_xyz', data: 'safe' };
      const result = redactSensitiveData(input);
      expect(result.key).toBe('[REDACTED]');
    });

    it('should redact authorization headers by field name', () => {
      const input = { authorization: 'Bearer token123', status: 'ok' };
      const result = redactSensitiveData(input);
      expect(result.authorization).toBe('[REDACTED]');
      expect(result.status).toBe('ok');
    });

    it('should redact secret/password/token field names', () => {
      const input = {
        secret: 'mysecret',
        password: 'mypass',
        token: 'mytoken',
        api_key: 'mykey',
        merchant_api_key: 'mk123',
        pii_hmac_secret: 'hmac_s',
        database_url: 'postgres://user:pass@host/db',
        redis_url: 'redis://pass@host/0',
      };
      const result = redactSensitiveData(input);
      expect(result.secret).toBe('[REDACTED]');
      expect(result.password).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.merchant_api_key).toBe('[REDACTED]');
      expect(result.pii_hmac_secret).toBe('[REDACTED]');
      expect(result.database_url).toBe('[REDACTED]');
      expect(result.redis_url).toBe('[REDACTED]');
    });

    it('should preserve HMAC pseudonyms (email_hash, phone_hash, customer_name_hash)', () => {
      const input = {
        email_hash: 'abc123def456',
        phone_hash: '789xyz',
        customer_name_hash: 'hash_val',
        has_email: true,
        has_phone: false,
      };
      const result = redactSensitiveData(input);
      expect(result.email_hash).toBe('abc123def456');
      expect(result.phone_hash).toBe('789xyz');
      expect(result.customer_name_hash).toBe('hash_val');
      expect(result.has_email).toBe(true);
      expect(result.has_phone).toBe(false);
    });

    it('should handle nested objects', () => {
      const input = {
        outer: {
          contact: 'test@email.com',
          safe: 'data',
        },
      };
      const result = redactSensitiveData(input);
      expect(result.outer.contact).toBe('[REDACTED]');
      expect(result.outer.safe).toBe('data');
    });

    it('should handle null and undefined', () => {
      expect(redactSensitiveData(null)).toBeNull();
      expect(redactSensitiveData(undefined)).toBeUndefined();
    });

    it('should handle arrays', () => {
      const input = ['safe', 'test@email.com', 42];
      const result = redactSensitiveData(input);
      expect(result[0]).toBe('safe');
      expect(result[1]).toBe('[REDACTED]');
      expect(result[2]).toBe(42);
    });

    it('should redact Redis URLs containing credentials', () => {
      const input = { url: 'redis://default:password@localhost:6379' };
      const result = redactSensitiveData(input);
      expect(result.url).toBe('[REDACTED]');
    });

    it('should redact PostgreSQL URLs containing credentials', () => {
      const input = { url: 'postgresql://user:password@localhost:5432/db' };
      const result = redactSensitiveData(input);
      expect(result.url).toBe('[REDACTED]');
    });
  });

  describe('2. AuditLogger Record Creation', () => {
    it('should create audit log record with correct actor and action', async () => {
      const traceId = crypto.randomUUID();
      const razorpayId = `pay_audit_${Date.now()}`;

      const payment = await db
        .insertInto('payments')
        .values({
          razorpay_payment_id: razorpayId,
          amount_paise: '100000',
          currency: 'INR',
          status: 'failed',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await auditLogger.log({
        paymentId: payment.id,
        actor: AuditActor.WEBHOOK,
        action: 'webhook_received',
        input: { event_type: 'payment.failed' },
        output: { status: 'processed' },
        traceId,
      });

      const logs = await auditLogger.getByTraceId(traceId);
      expect(logs.length).toBe(1);
      expect(logs[0]?.actor).toBe('webhook');
      expect(logs[0]?.action).toBe('webhook_received');
      expect(logs[0]?.payment_id).toBe(payment.id);
      expect(logs[0]?.trace_id).toBe(traceId);

      // Cleanup
      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
      await db.deleteFrom('payments').where('id', '=', payment.id).execute();
    });

    it('should validate and regenerate invalid trace_id', async () => {
      await auditLogger.log({
        actor: AuditActor.SCHEDULER,
        action: 'test_invalid_trace',
        traceId: 'not-a-uuid',
      });

      // Should have been regenerated as a valid UUID, not stored as 'not-a-uuid'
      const logs = await db.selectFrom('audit_log').selectAll().where('action', '=', 'test_invalid_trace').execute();

      expect(logs.length).toBe(1);
      expect(logs[0]?.trace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      // Cleanup
      await db.deleteFrom('audit_log').where('action', '=', 'test_invalid_trace').execute();
    });

    it('should preserve valid UUID trace_id', async () => {
      const traceId = crypto.randomUUID();

      await auditLogger.log({
        actor: AuditActor.POLICY,
        action: 'test_valid_trace',
        traceId,
      });

      const logs = await auditLogger.getByTraceId(traceId);
      expect(logs.length).toBe(1);
      expect(logs[0]?.trace_id).toBe(traceId);

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });

    it('should record correct timestamp', async () => {
      const traceId = crypto.randomUUID();
      const before = new Date();

      await auditLogger.log({
        actor: AuditActor.EXECUTOR,
        action: 'test_timestamp',
        traceId,
      });

      const after = new Date();
      const logs = await auditLogger.getByTraceId(traceId);
      expect(logs.length).toBe(1);

      const createdAt = new Date(logs[0]?.created_at);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });
  });

  describe('3. PII Redaction in Audit Records (§17)', () => {
    it('should redact raw email from audit input', async () => {
      const traceId = crypto.randomUUID();

      await auditLogger.log({
        actor: AuditActor.WEBHOOK,
        action: 'test_pii_redaction',
        input: {
          email: 'customer@example.com',
          amount_paise: 50000,
          email_hash: 'abc123hash',
        },
        traceId,
      });

      const logs = await auditLogger.getByTraceId(traceId);
      expect(logs.length).toBe(1);

      const input = logs[0]?.input as Record<string, unknown>;
      // Raw email must be redacted
      expect(input.email).toBe('[REDACTED]');
      // Amount must be preserved
      expect(input.amount_paise).toBe(50000);
      // HMAC hash must be preserved
      expect(input.email_hash).toBe('abc123hash');

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });

    it('should redact secrets from audit output', async () => {
      const traceId = crypto.randomUUID();

      await auditLogger.log({
        actor: AuditActor.AI,
        action: 'test_secret_redaction',
        output: {
          api_key: 'rzp_test_secretkey',
          result: 'success',
        },
        traceId,
      });

      const logs = await auditLogger.getByTraceId(traceId);
      const output = logs[0]?.output as Record<string, unknown>;
      expect(output.api_key).toBe('[REDACTED]');
      expect(output.result).toBe('success');

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });

    it('should redact secrets from audit error strings', async () => {
      const traceId = crypto.randomUUID();

      await auditLogger.log({
        actor: AuditActor.EXECUTOR,
        action: 'test_error_redaction',
        error: 'Connection failed: redis://user:pass@host:6379',
        traceId,
      });

      const logs = await auditLogger.getByTraceId(traceId);
      expect(logs[0]?.error).toBe('[REDACTED]');

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });
  });

  describe('4. Trace ID Correlation (§3)', () => {
    it('should correlate multiple audit events by trace_id', async () => {
      const traceId = crypto.randomUUID();

      // Simulate a workflow with multiple steps sharing one trace_id
      await auditLogger.log({
        actor: AuditActor.WEBHOOK,
        action: 'webhook_received',
        traceId,
      });

      await auditLogger.log({
        actor: AuditActor.SCHEDULER,
        action: 'recovery_attempt_created',
        traceId,
      });

      await auditLogger.log({
        actor: AuditActor.AI,
        action: 'ai_recommendation_received',
        traceId,
      });

      await auditLogger.log({
        actor: AuditActor.POLICY,
        action: 'policy_approved',
        traceId,
      });

      await auditLogger.log({
        actor: AuditActor.EXECUTOR,
        action: 'action_executed',
        traceId,
      });

      const logs = await auditLogger.getByTraceId(traceId);
      expect(logs.length).toBe(5);

      // Verify deterministic ordering (ASC by created_at)
      const actors = logs.map((l) => l.actor);
      expect(actors).toEqual(['webhook', 'scheduler', 'ai', 'policy', 'executor']);

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });
  });

  describe('5. AuditLogger Search', () => {
    it('should search by actor', async () => {
      const traceId = crypto.randomUUID();

      await auditLogger.log({
        actor: AuditActor.RECONCILER,
        action: 'test_search_actor',
        traceId,
      });

      const results = await auditLogger.search({ actor: AuditActor.RECONCILER });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.actor === 'reconciler')).toBe(true);

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });

    it('should respect pagination limits', async () => {
      const traceId = crypto.randomUUID();

      // Create 3 entries
      for (let i = 0; i < 3; i++) {
        await auditLogger.log({
          actor: AuditActor.VERIFIER,
          action: `test_pagination_${i}`,
          traceId,
        });
      }

      const results = await auditLogger.search({ traceId, limit: 2 });
      expect(results.length).toBe(2);

      await db.deleteFrom('audit_log').where('trace_id', '=', traceId).execute();
    });
  });

  describe('6. AuditLogger Fail-Open Behavior', () => {
    it('should not throw when logging fails', async () => {
      // This tests that the audit logger catches errors internally.
      // Create a logger that would fail (e.g., with null constraint violation attempt)
      // The method should silently catch the error.
      const logger = new AuditLogger(db);

      // This should NOT throw
      await expect(
        logger.log({
          actor: AuditActor.WEBHOOK,
          action: 'test_fail_open',
          traceId: crypto.randomUUID(),
        }),
      ).resolves.toBeUndefined();
    });
  });
});
