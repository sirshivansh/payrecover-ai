import { z } from 'zod';

/**
 * Environment variable schema.
 *
 * Phase 0: Most variables are optional with safe defaults.
 * Later phases will require specific variables (e.g., DATABASE_URL, REDIS_URL).
 *
 * Security: Real credentials MUST be in .env.local (gitignored).
 * This file defines structure only — no secrets.
 */
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Database (Phase 1+)
  DATABASE_URL: z.string().optional(),

  // Redis (Phase 2+)
  REDIS_URL: z.string().optional(),

  // Razorpay (Phase 3+)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // NVIDIA AI (Phase 9+)
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_MODEL_ID: z.string().default('nvidia/nemotron-3-ultra-550b-a55b'),

  // Authentication (Phase 2+)
  MERCHANT_API_KEY: z.string().optional(),

  // PII (Phase 2+)
  PII_HMAC_SECRET: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Load and validate environment variables.
 * Throws on validation failure with descriptive errors.
 */
export function loadEnv(): AppEnv {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Environment validation failed:\n${formatted}`);
  }

  return result.data;
}
