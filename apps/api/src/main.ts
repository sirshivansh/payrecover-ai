import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({
  path: [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '../../.env.local'),
    path.resolve(process.cwd(), '../.env.local'),
    '.env',
  ],
  override: true,
});

async function main(): Promise<void> {
  const { loadEnv } = await import('./config/env.js');
  const { buildApp } = await import('./app.js');
  const env = loadEnv();

  const app = await buildApp({ env });

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`PayRecover API running on http://localhost:${env.PORT}`);
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
