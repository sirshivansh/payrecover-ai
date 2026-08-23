import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppEnv } from '../config/env.js';
import type { DatabaseClient } from '../database/client.js';
import { IdempotencyService } from '../services/idempotency.service.js';
import { getRedisClient } from '../services/redis.service.js';
import { WebhookReceiver } from '../webhooks/receiver.js';

export interface WebhookRouteOptions {
  env: AppEnv;
  dbClient: DatabaseClient;
}

export const webhookRoutes = (options: WebhookRouteOptions): FastifyPluginAsync => {
  return async (app) => {
    const redis = getRedisClient(options.env);
    const idempotency = new IdempotencyService(redis, options.dbClient.db);
    const receiver = new WebhookReceiver(options.env, options.dbClient.db, idempotency);

    app.post('/webhooks/razorpay', async (req, reply) => {
      const signature = (req.headers['x-razorpay-signature'] as string) || '';
      const rawBody = (req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body);
      const traceId = crypto.randomUUID();

      try {
        const result = await receiver.processWebhook(rawBody, signature, req.body, traceId);

        return reply.status(result.statusCode).send({
          status: result.status,
          eventId: result.eventId,
          eventType: result.eventType,
          razorpayPaymentId: result.razorpayPaymentId,
          message: result.message,
        });
      } catch (err) {
        req.log.error(err, 'Unhandled error processing Razorpay webhook');
        return reply.status(500).send({
          status: 'error',
          message: 'Internal server error processing webhook',
        });
      }
    });
  };
};
