import crypto from 'node:crypto';
import type { AuditActor, AuditLogRow, Database, NewAuditLog } from '@payrecover/shared';
import type { Kysely, Transaction } from 'kysely';
import { redactSensitiveData } from './redact.js';

/**
 * Centralized Audit Logger — Phase 12 Observability (§3, §7.2, §17)
 *
 * Provides a consistent mechanism for recording important system events
 * to the `audit_log` PostgreSQL table.
 *
 * Every audit record preserves: actor, action, input, output, trace_id, timestamp.
 *
 * Security:
 * - All input/output/error values are redacted before insertion (§17)
 * - PII is HMAC-pseudonymized, never raw (§17)
 * - Secrets are never stored in audit records (§16)
 *
 * Failure semantics: Audit insertion failures are logged but do NOT propagate
 * to crash the calling business logic (fail-open for observability).
 */

export interface AuditLogParams {
  recoveryAttemptId?: string | null;
  paymentId?: string | null;
  actor: AuditActor | string;
  action: string;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: string | null;
  traceId: string;
  createdAt?: Date;
}

export interface AuditSearchParams {
  traceId?: string;
  paymentId?: string;
  recoveryAttemptId?: string;
  actor?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Validate that a string is a valid UUID v4 format.
 */
function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export class AuditLogger {
  constructor(private db: Kysely<Database>) {}

  /**
   * Log an audit event. Redacts input/output/error before insertion.
   * Validates trace_id as UUID. Fails open (catches insertion errors).
   *
   * @param params Audit log parameters
   * @param trx Optional Kysely transaction to participate in
   */
  async log(params: AuditLogParams, trx?: Transaction<Database>): Promise<void> {
    const executor = trx ?? this.db;

    // Validate and ensure trace_id is a valid UUID
    const traceId = isValidUUID(params.traceId) ? params.traceId : crypto.randomUUID();

    // Redact sensitive data from input/output/error (§17)
    const redactedInput = params.input ? redactSensitiveData(params.input) : null;
    const redactedOutput = params.output ? redactSensitiveData(params.output) : null;
    const redactedError = params.error ? redactSensitiveData(params.error) : null;

    const values: NewAuditLog = {
      recovery_attempt_id: params.recoveryAttemptId ?? null,
      payment_id: params.paymentId ?? null,
      actor: params.actor,
      action: params.action,
      input: redactedInput,
      output: redactedOutput,
      error: redactedError,
      trace_id: traceId,
      created_at: params.createdAt ?? new Date(),
    };

    try {
      await executor.insertInto('audit_log').values(values).execute();
    } catch (err) {
      // Fail-open: Audit failures must not crash business logic
      console.error('[AuditLogger] Failed to write audit log entry:', err);
    }
  }

  /**
   * Retrieve audit logs by trace_id for workflow correlation (§3).
   * Returns deterministically ordered by created_at ASC.
   */
  async getByTraceId(traceId: string): Promise<AuditLogRow[]> {
    if (!isValidUUID(traceId)) return [];

    return await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('trace_id', '=', traceId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * Retrieve audit logs by payment_id.
   */
  async getByPaymentId(paymentId: string, limit = 100): Promise<AuditLogRow[]> {
    return await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
  }

  /**
   * Retrieve audit logs by recovery_attempt_id.
   */
  async getByRecoveryAttemptId(recoveryAttemptId: string, limit = 100): Promise<AuditLogRow[]> {
    return await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('recovery_attempt_id', '=', recoveryAttemptId)
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
  }

  /**
   * Search audit logs with optional filters and pagination.
   * Results are deterministically ordered by created_at ASC.
   */
  async search(params: AuditSearchParams): Promise<AuditLogRow[]> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    let query = this.db.selectFrom('audit_log').selectAll();

    if (params.traceId) {
      query = query.where('trace_id', '=', params.traceId);
    }
    if (params.paymentId) {
      query = query.where('payment_id', '=', params.paymentId);
    }
    if (params.recoveryAttemptId) {
      query = query.where('recovery_attempt_id', '=', params.recoveryAttemptId);
    }
    if (params.actor) {
      query = query.where('actor', '=', params.actor);
    }
    if (params.from) {
      query = query.where('created_at', '>=', params.from);
    }
    if (params.to) {
      query = query.where('created_at', '<', params.to);
    }

    return await query.orderBy('created_at', 'asc').limit(limit).offset(offset).execute();
  }
}
