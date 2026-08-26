import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseClient } from '../database/client.js';
import { MetricsService } from '../metrics/service.js';
import { authMiddleware } from '../middleware/auth.js';

/**
 * Metrics Routes — Phase 12 (§8.1)
 *
 * GET /api/v1/metrics/summary — Aggregate recovery metrics
 *
 * Query parameters:
 *   from (optional): ISO date string, start of period
 *   to (optional): ISO date string, end of period
 *
 * Response: MetricsSummary (§8.1)
 *
 * Read-only: These queries do NOT modify any state.
 */

export interface MetricsRouteOptions {
  dbClient: DatabaseClient;
}

export const metricsRoutes = (options: MetricsRouteOptions): FastifyPluginAsync => {
  return async (app) => {
    const metricsService = new MetricsService(options.dbClient.db);

    // Apply auth middleware to all routes in this plugin
    app.addHook('onRequest', authMiddleware);

    app.get('/api/v1/metrics/summary', async (req, reply) => {
      const query = req.query as { from?: string; to?: string };

      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to ? new Date(query.to) : undefined;

      // Validate date parameters
      if (from && Number.isNaN(from.getTime())) {
        return reply.status(400).send({ status: 'error', message: 'Invalid "from" date parameter' });
      }
      if (to && Number.isNaN(to.getTime())) {
        return reply.status(400).send({ status: 'error', message: 'Invalid "to" date parameter' });
      }
      if (from && to && from >= to) {
        return reply.status(400).send({ status: 'error', message: '"from" must be before "to"' });
      }

      const summary = await metricsService.getSummary(from, to);
      return reply.status(200).send(summary);
    });
  };
};
