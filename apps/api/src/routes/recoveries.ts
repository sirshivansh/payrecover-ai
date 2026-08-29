import { RecoveryStatus } from '@payrecover/shared';
import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type { DatabaseClient } from '../database/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuditLogger } from '../observability/audit.js';

const ALLOWED_RECOVERY_STATUSES = new Set<string>(Object.values(RecoveryStatus));

/**
 * Recoveries Routes — Phase 12 (§8.1)
 *
 * GET /api/v1/recoveries — List recovery attempts (paginated, filterable by status)
 * GET /api/v1/recoveries/:id — Get recovery attempt detail with payment & audit trail
 *
 * Response schemas match §8.1 RecoveryAttemptSummary, RecoveryAttemptDetail, Payment, AuditLogEntry.
 *
 * Read-only: These queries do NOT modify any state.
 * PII: Returns has_email/has_phone booleans, never raw PII.
 */

export interface RecoveriesRouteOptions {
  dbClient: DatabaseClient;
}

export const recoveriesRoutes = (options: RecoveriesRouteOptions): FastifyPluginAsync => {
  return async (app) => {
    const db = options.dbClient.db;
    const auditLogger = new AuditLogger(db);

    // Apply auth middleware
    app.addHook('onRequest', authMiddleware);

    /**
     * GET /api/v1/recoveries — Paginated list of recovery attempts (§8.1)
     */
    app.get('/api/v1/recoveries', async (req, reply) => {
      const query = req.query as { status?: string; page?: string; limit?: string };

      if (query.status && !ALLOWED_RECOVERY_STATUSES.has(query.status)) {
        return reply.status(400).send({
          status: 'error',
          message: `Invalid status filter parameter: "${query.status}". Allowed values: ${Array.from(ALLOWED_RECOVERY_STATUSES).join(', ')}`,
        });
      }

      const page = Math.max(1, Number(query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
      const offset = (page - 1) * limit;

      let baseQuery = db.selectFrom('recovery_attempts').selectAll();

      if (query.status) {
        baseQuery = baseQuery.where('status', '=', query.status as RecoveryStatus);
      }

      // Count total for pagination
      let countQuery = db.selectFrom('recovery_attempts').select(sql<string>`COUNT(*)`.as('total'));

      if (query.status) {
        countQuery = countQuery.where('status', '=', query.status as RecoveryStatus);
      }

      const [rows, countResult] = await Promise.all([
        baseQuery.orderBy('started_at', 'desc').limit(limit).offset(offset).execute(),
        countQuery.executeTakeFirstOrThrow(),
      ]);

      const total = Number(countResult.total);

      const data = rows.map((r) => ({
        id: r.id,
        paymentId: r.payment_id,
        attemptNumber: r.attempt_number,
        status: r.status,
        revenueAtRiskPaise: Number(r.revenue_at_risk_paise),
        aiDecision: r.ai_decision ?? null,
        aiConfidence: r.ai_confidence ? Number(r.ai_confidence) : null,
        actionType: r.action_type ?? null,
        createdAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
        completedAt: r.completed_at
          ? r.completed_at instanceof Date
            ? r.completed_at.toISOString()
            : String(r.completed_at)
          : null,
      }));

      return reply.status(200).send({
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    });

    /**
     * GET /api/v1/recoveries/:id — Recovery attempt detail with payment & audit trail (§8.1)
     */
    app.get('/api/v1/recoveries/:id', async (req, reply) => {
      const params = req.params as { id: string };
      const attemptId = params.id;

      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
        return reply.status(400).send({ status: 'error', message: 'Invalid recovery attempt ID format' });
      }

      const attempt = await db
        .selectFrom('recovery_attempts')
        .selectAll()
        .where('id', '=', attemptId)
        .executeTakeFirst();

      if (!attempt) {
        return reply.status(404).send({ status: 'error', message: 'Recovery attempt not found' });
      }

      // Fetch payment (no raw PII — return booleans per §8.1 Payment schema)
      const payment = await db
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', attempt.payment_id)
        .executeTakeFirst();

      // Fetch audit trail for this attempt
      const auditLogs = await auditLogger.getByRecoveryAttemptId(attemptId, 200);

      // Build response matching §8.1 RecoveryAttemptDetail
      const response = {
        id: attempt.id,
        paymentId: attempt.payment_id,
        attemptNumber: attempt.attempt_number,
        status: attempt.status,
        revenueAtRiskPaise: Number(attempt.revenue_at_risk_paise),
        aiDecision: attempt.ai_decision ?? null,
        aiConfidence: attempt.ai_confidence ? Number(attempt.ai_confidence) : null,
        actionType: attempt.action_type ?? null,
        createdAt: attempt.started_at instanceof Date ? attempt.started_at.toISOString() : String(attempt.started_at),
        completedAt: attempt.completed_at
          ? attempt.completed_at instanceof Date
            ? attempt.completed_at.toISOString()
            : String(attempt.completed_at)
          : null,
        // Detail fields
        payment: payment
          ? {
              id: payment.id,
              razorpayPaymentId: payment.razorpay_payment_id,
              amountPaise: Number(payment.amount_paise),
              currency: payment.currency,
              status: payment.status,
              failureReason: payment.failure_reason ?? null,
              method: payment.method ?? '',
              hasEmail: Boolean(payment.email_hash),
              hasPhone: Boolean(payment.phone_hash),
              createdAt:
                payment.created_at instanceof Date ? payment.created_at.toISOString() : String(payment.created_at),
              paidAt: payment.paid_at
                ? payment.paid_at instanceof Date
                  ? payment.paid_at.toISOString()
                  : String(payment.paid_at)
                : null,
            }
          : null,
        aiRecommendation: attempt.ai_recommendation ?? null,
        policyDecision: attempt.policy_decision
          ? {
              decision: attempt.policy_decision,
              reason: attempt.policy_reason ?? null,
            }
          : null,
        policyModifications: attempt.policy_modifications ?? null,
        actionResult: attempt.action_result ?? null,
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        paymentLinkUrl: (attempt.action_result as Record<string, unknown> | null)?.['paymentLinkUrl'] ?? null,
        auditLogs: auditLogs.map((log) => ({
          id: log.id,
          actor: log.actor,
          action: log.action,
          input: log.input ?? {},
          output: log.output ?? {},
          error: log.error ?? null,
          createdAt: log.created_at instanceof Date ? log.created_at.toISOString() : String(log.created_at),
        })),
      };

      return reply.status(200).send(response);
    });
  };
};
