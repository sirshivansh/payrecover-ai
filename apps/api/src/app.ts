import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { AppEnv } from './config/env.js';
import { type DatabaseClient, createDatabaseClient } from './database/client.js';
import { webhookRoutes } from './routes/webhooks.js';

export interface AppOptions {
  env: AppEnv;
  dbClient?: DatabaseClient;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: {
      level: options.env.LOG_LEVEL,
      transport:
        options.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    },
  });

  // CORS — allow frontend dev server
  await app.register(cors, {
    origin: options.env.CORS_ORIGIN,
    credentials: true,
  });

  // Raw body parser for webhook HMAC signature verification (§8.2)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    try {
      const json = JSON.parse(body || '{}');
      (req as unknown as { rawBody: string }).rawBody = body;
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Database client
  const dbClient = options.dbClient || createDatabaseClient(options.env);

  // Register Webhook Routes (§8.2)
  await app.register(webhookRoutes({ env: options.env, dbClient }));

  // Health check endpoint
  app.get('/health', async (_request, _reply) => {
    return {
      status: 'ok',
      service: 'payrecover-api',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    };
  });

  return app;
}
