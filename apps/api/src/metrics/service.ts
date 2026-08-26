import type { Database } from '@payrecover/shared';
import { RecoveryStatus } from '@payrecover/shared';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * MetricsService — Phase 12 Observability (§3, §18)
 *
 * Computes authoritative financial and recovery metrics from PostgreSQL.
 * ALL calculations use exact integer paise arithmetic (BigInt).
 * AI output NEVER determines financial values.
 *
 * Metric Definitions (§18.1):
 * - Revenue at Risk (RaR): SUM of amount_paise for unique payments in period (deduplicated by payment_id)
 * - Recovered Revenue: SUM of amount_paise for unique recovered payments in period (deduplicated by payment_id)
 * - Recovery Rate: recoveredRevenue / revenueAtRisk * 100
 * - Attempt Success Rate: succeededAttempts / executedAttempts * 100
 *
 * Attribution Rules (§18.2):
 * 1. Unique Payment Basis: Each razorpay_payment_id counted once per period
 * 2. Recovery Attribution: Payment recovered if paid_at >= MIN(recovery_attempts.started_at)
 * 3. Self-Recovery Exclusion: Payment captured before any recovery action executes → not recovered
 * 4. Refunds: Excluded from both RaR and Recovered Revenue
 *
 * Determinism: Identical DB state + identical query params = identical results.
 * Read-Only: Queries do NOT modify payment state, recovery state, jobs, or external APIs.
 */

/** MetricsSummary schema matching spec §8.1 */
export interface MetricsSummary {
  revenueAtRiskPaise: number;
  recoveredRevenuePaise: number;
  recoveryRatePct: number;
  attemptSuccessRatePct: number;
  totalAttempts: number;
  succeededAttempts: number;
  stoppedAttempts: number;
  escalatedAttempts: number;
  period: {
    from: string;
    to: string;
  };
}

/** Detailed metrics for internal observability queries */
export interface DetailedMetrics {
  summary: MetricsSummary;
  statusBreakdown: Record<string, number>;
  policyStats: {
    approved: number;
    rejected: number;
    approvedWithModifications: number;
  };
  aiStats: {
    recoverNow: number;
    stop: number;
    escalate: number;
    failures: number;
    avgConfidence: number;
  };
  actionStats: {
    executed: number;
    failed: number;
    outcomeUnknown: number;
  };
  jobStats: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    retried: number;
  };
  durationStats: {
    avgDurationMs: number | null;
    minDurationMs: number | null;
    maxDurationMs: number | null;
  };
}

export class MetricsService {
  constructor(private db: Kysely<Database>) {}

  /**
   * Get aggregate recovery metrics summary (§18, §8.1).
   *
   * Uses [from, to) semantics for time windows.
   * Returns MetricsSummary matching spec §8.1 schema.
   *
   * Financial safety:
   * - All amounts from PostgreSQL payment records
   * - BigInt arithmetic internally, number output for JSON
   * - No floating-point for money calculations
   * - DISTINCT on payment_id prevents double-counting
   */
  async getSummary(from?: Date, to?: Date): Promise<MetricsSummary> {
    const periodFrom = from ?? new Date('2000-01-01');
    const periodTo = to ?? new Date('2099-12-31');

    // 1. Revenue at Risk: SUM of distinct payment amounts for eligible payments (§18.1)
    // Identity-based deduplication by payment_id (NOT by amount value)
    const subqueryRar = this.db
      .selectFrom('payments as p')
      .innerJoin('recovery_attempts as ra', 'ra.payment_id', 'p.id')
      .select(['p.id as payment_id', sql<string>`p.amount_paise`.as('amount_paise')])
      .where('ra.started_at', '>=', periodFrom)
      .where('ra.started_at', '<', periodTo)
      .where(sql<boolean>`CAST(ra.revenue_at_risk_paise AS BIGINT) > 0`)
      .where(sql<boolean>`p.status != 'refunded'`)
      .groupBy(['p.id', 'p.amount_paise']);

    const rarResult = await this.db
      .selectFrom(subqueryRar.as('sub'))
      .select(sql<string>`COALESCE(SUM(CAST(sub.amount_paise AS BIGINT)), 0)`.as('total'))
      .executeTakeFirstOrThrow();

    const revenueAtRiskPaise = Number(rarResult.total);

    // 2. Recovered Revenue: SUM of distinct payment amounts for recovered payments (§18.1, §18.2)
    // Identity-based deduplication by payment_id (NOT by amount value)
    const subqueryRec = this.db
      .selectFrom('payments as p')
      .innerJoin('recovery_attempts as ra', 'ra.payment_id', 'p.id')
      .select(['p.id as payment_id', sql<string>`p.amount_paise`.as('amount_paise')])
      .where('ra.started_at', '>=', periodFrom)
      .where('ra.started_at', '<', periodTo)
      .where(sql<boolean>`CAST(ra.revenue_at_risk_paise AS BIGINT) > 0`)
      .where(sql<boolean>`p.status = 'paid'`)
      .where(sql<boolean>`p.status != 'refunded'`)
      .where(
        sql<boolean>`p.paid_at >= (SELECT MIN(ra2.started_at) FROM recovery_attempts ra2 WHERE ra2.payment_id = p.id)`,
      )
      .groupBy(['p.id', 'p.amount_paise']);

    const recResult = await this.db
      .selectFrom(subqueryRec.as('sub'))
      .select(sql<string>`COALESCE(SUM(CAST(sub.amount_paise AS BIGINT)), 0)`.as('total'))
      .executeTakeFirstOrThrow();

    const recoveredRevenuePaise = Number(recResult.total);

    // 3. Attempt status counts (§18.1)
    const statusRows = await this.db
      .selectFrom('recovery_attempts')
      .select(['status', sql<string>`COUNT(*)`.as('count')])
      .where('started_at', '>=', periodFrom)
      .where('started_at', '<', periodTo)
      .groupBy('status')
      .execute();

    const counts: Record<string, number> = {};
    for (const row of statusRows) {
      counts[row.status] = Number(row.count);
    }

    const totalAttempts = Object.values(counts).reduce((sum, c) => sum + c, 0);
    const succeededAttempts = counts[RecoveryStatus.SUCCEEDED] ?? 0;
    const stoppedAttempts = counts[RecoveryStatus.STOPPED] ?? 0;
    const escalatedAttempts = counts[RecoveryStatus.ESCALATED] ?? 0;

    // executedAttempts = attempts that reached EXECUTING or beyond
    const executedAttempts =
      (counts[RecoveryStatus.EXECUTING] ?? 0) +
      (counts[RecoveryStatus.VERIFYING] ?? 0) +
      (counts[RecoveryStatus.ACTION_OUTCOME_UNKNOWN] ?? 0) +
      succeededAttempts +
      (counts[RecoveryStatus.FAILED] ?? 0) +
      stoppedAttempts;

    // 4. Computed rates (§18.1)
    const recoveryRatePct = revenueAtRiskPaise > 0 ? (recoveredRevenuePaise / revenueAtRiskPaise) * 100 : 0;
    const attemptSuccessRatePct = executedAttempts > 0 ? (succeededAttempts / executedAttempts) * 100 : 0;

    return {
      revenueAtRiskPaise,
      recoveredRevenuePaise,
      recoveryRatePct: Math.round(recoveryRatePct * 100) / 100,
      attemptSuccessRatePct: Math.round(attemptSuccessRatePct * 100) / 100,
      totalAttempts,
      succeededAttempts,
      stoppedAttempts,
      escalatedAttempts,
      period: {
        from: periodFrom.toISOString(),
        to: periodTo.toISOString(),
      },
    };
  }

  /**
   * Get detailed metrics breakdown for internal observability.
   * Still read-only, still deterministic.
   */
  async getDetailedMetrics(from?: Date, to?: Date): Promise<DetailedMetrics> {
    const summary = await this.getSummary(from, to);

    const periodFrom = from ?? new Date('2000-01-01');
    const periodTo = to ?? new Date('2099-12-31');

    // Status breakdown (reuse summary counts)
    const statusRows = await this.db
      .selectFrom('recovery_attempts')
      .select(['status', sql<string>`COUNT(*)`.as('count')])
      .where('started_at', '>=', periodFrom)
      .where('started_at', '<', periodTo)
      .groupBy('status')
      .execute();

    const statusBreakdown: Record<string, number> = {};
    for (const row of statusRows) {
      statusBreakdown[row.status] = Number(row.count);
    }

    // Policy stats
    const policyRows = await this.db
      .selectFrom('recovery_attempts')
      .select(['policy_decision', sql<string>`COUNT(*)`.as('count')])
      .where('started_at', '>=', periodFrom)
      .where('started_at', '<', periodTo)
      .where('policy_decision', 'is not', null)
      .groupBy('policy_decision')
      .execute();

    const policyCounts: Record<string, number> = {};
    for (const row of policyRows) {
      if (row.policy_decision) {
        policyCounts[row.policy_decision] = Number(row.count);
      }
    }

    // AI stats
    const aiRows = await this.db
      .selectFrom('recovery_attempts')
      .select(['ai_decision', sql<string>`COUNT(*)`.as('count')])
      .where('started_at', '>=', periodFrom)
      .where('started_at', '<', periodTo)
      .where('ai_decision', 'is not', null)
      .groupBy('ai_decision')
      .execute();

    const aiCounts: Record<string, number> = {};
    for (const row of aiRows) {
      if (row.ai_decision) {
        aiCounts[row.ai_decision] = Number(row.count);
      }
    }

    const aiConfRow = await this.db
      .selectFrom('recovery_attempts')
      .select(sql<string>`AVG(CAST(ai_confidence AS NUMERIC))`.as('avg_confidence'))
      .where('started_at', '>=', periodFrom)
      .where('started_at', '<', periodTo)
      .where('ai_confidence', 'is not', null)
      .executeTakeFirst();

    const aiFailures = await this.db
      .selectFrom('audit_log')
      .select(sql<string>`COUNT(*)`.as('count'))
      .where('action', 'in', ['ai_recommendation_invalid', 'ai_provider_failure'])
      .where('created_at', '>=', periodFrom)
      .where('created_at', '<', periodTo)
      .executeTakeFirst();

    // Action stats from audit log
    const actionExecuted = await this.db
      .selectFrom('audit_log')
      .select(sql<string>`COUNT(*)`.as('count'))
      .where('action', '=', 'action_executed')
      .where('created_at', '>=', periodFrom)
      .where('created_at', '<', periodTo)
      .executeTakeFirst();

    const actionFailed = await this.db
      .selectFrom('audit_log')
      .select(sql<string>`COUNT(*)`.as('count'))
      .where('action', '=', 'action_failed')
      .where('created_at', '>=', periodFrom)
      .where('created_at', '<', periodTo)
      .executeTakeFirst();

    const actionUnknown = await this.db
      .selectFrom('audit_log')
      .select(sql<string>`COUNT(*)`.as('count'))
      .where('action', '=', 'action_outcome_unknown')
      .where('created_at', '>=', periodFrom)
      .where('created_at', '<', periodTo)
      .executeTakeFirst();

    // Job stats
    const jobRows = await this.db
      .selectFrom('recovery_jobs')
      .select(['status', sql<string>`COUNT(*)`.as('count')])
      .where('created_at', '>=', periodFrom)
      .where('created_at', '<', periodTo)
      .groupBy('status')
      .execute();

    const jobCounts: Record<string, number> = {};
    for (const row of jobRows) {
      jobCounts[row.status] = Number(row.count);
    }

    const retriedJobs = await this.db
      .selectFrom('recovery_jobs')
      .select(sql<string>`COUNT(*)`.as('count'))
      .where('created_at', '>=', periodFrom)
      .where('created_at', '<', periodTo)
      .where('attempts', '>', 1)
      .executeTakeFirst();

    // Duration stats: avg/min/max time from started_at to completed_at
    const durationRow = await this.db
      .selectFrom('recovery_attempts')
      .select([
        sql<string>`AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)`.as('avg_ms'),
        sql<string>`MIN(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)`.as('min_ms'),
        sql<string>`MAX(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)`.as('max_ms'),
      ])
      .where('started_at', '>=', periodFrom)
      .where('started_at', '<', periodTo)
      .where('completed_at', 'is not', null)
      .executeTakeFirst();

    return {
      summary,
      statusBreakdown,
      policyStats: {
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        approved: policyCounts['approved'] ?? 0,
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        rejected: policyCounts['rejected'] ?? 0,
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        approvedWithModifications: policyCounts['approved_with_modifications'] ?? 0,
      },
      aiStats: {
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        recoverNow: aiCounts['recover_now'] ?? 0,
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        stop: aiCounts['stop'] ?? 0,
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        escalate: aiCounts['escalate'] ?? 0,
        failures: Number(aiFailures?.count ?? 0),
        avgConfidence: aiConfRow?.avg_confidence ? Number(aiConfRow.avg_confidence) : 0,
      },
      actionStats: {
        executed: Number(actionExecuted?.count ?? 0),
        failed: Number(actionFailed?.count ?? 0),
        outcomeUnknown: Number(actionUnknown?.count ?? 0),
      },
      jobStats: {
        total: Object.values(jobCounts).reduce((s, c) => s + c, 0),
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        completed: jobCounts['completed'] ?? 0,
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        failed: jobCounts['failed'] ?? 0,
        // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
        cancelled: jobCounts['cancelled'] ?? 0,
        retried: Number(retriedJobs?.count ?? 0),
      },
      durationStats: {
        avgDurationMs: durationRow?.avg_ms ? Math.round(Number(durationRow.avg_ms)) : null,
        minDurationMs: durationRow?.min_ms ? Math.round(Number(durationRow.min_ms)) : null,
        maxDurationMs: durationRow?.max_ms ? Math.round(Number(durationRow.max_ms)) : null,
      },
    };
  }
}
