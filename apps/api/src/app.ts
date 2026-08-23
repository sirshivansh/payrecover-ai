import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { AppEnv } from './config/env.js';

export interface AppOptions {
  env: AppEnv;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: {
      level: options.env.LOG_LEVEL,
      transport:
        options.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    },
    // Required for webhook HMAC verification in later phases
    // Raw body will be needed for signature verification
  });

  // CORS — allow frontend dev server
  await app.register(cors, {
    origin: options.env.CORS_ORIGIN,
    credentials: true,
  });

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
