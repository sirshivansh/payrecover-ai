/**
 * @payrecover/shared — Shared types, providers, and utilities
 */

export const PACKAGE_NAME = '@payrecover/shared';
export const PACKAGE_VERSION = '0.1.0';

// Domain Enums & Recovery Types
export * from './domain/enums.js';
export * from './domain/recovery.js';
export * from './domain/idempotency.js';
export * from './domain/policy.js';
export * from './domain/action.js';
export * from './domain/evaluation.js';
export * from './domain/notification.js';

// Database Types
export * from './database/types.js';

// Webhook Schemas & Types
export * from './webhooks/schema.js';
export * from './webhooks/types.js';

// Razorpay Client & Provider
export * from './razorpay/types.js';
export * from './razorpay/client.js';
export * from './razorpay/mock-provider.js';

// AI Provider Abstraction (§10, v2.1.1 §10)
export * from './ai/provider.js';
export * from './ai/schemas.js';
export * from './ai/prompts.js';
export * from './ai/nemotron-provider.js';
export * from './ai/mock-provider.js';

// Utilities
export * from './utils/pii.js';
