import 'dotenv/config';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

async function main(): Promise<void> {
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
