/**
 * PayRecover AI — AI Recommendation Schema Validation (§10.4)
 *
 * Zod schema for validating AI model output into a typed AIRecommendation.
 * Rejects malformed or hallucinated output before it can reach the PolicyEngine.
 */

import { z } from 'zod';
import { AIDecisionType, RecoveryActionType } from '../domain/enums.js';

/**
 * Zod schema matching the AIRecommendation interface (§10.1, v2.1.1 §10.1)
 *
 * Validates:
 * - decision: must be a valid AIDecisionType
 * - confidence: number between 0.0 and 1.0
 * - reasoning: string, max 2000 characters
 * - recommended_action: must be a valid RecoveryActionType
 */
export const AIRecommendationSchema = z.object({
  decision: z.nativeEnum(AIDecisionType),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(2000),
  recommended_action: z.nativeEnum(RecoveryActionType),
});

export type ValidatedAIRecommendation = z.infer<typeof AIRecommendationSchema>;
