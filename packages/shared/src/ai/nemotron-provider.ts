/**
 * PayRecover AI — Nemotron Provider (§10.4, v2.1.1 §10, §24, §30)
 *
 * NVIDIA Build API integration for Nemotron-3-Ultra inference.
 * Uses hosted inference only — never attempts local model execution.
 *
 * Includes fallback JSON parser for model output that may be wrapped
 * in markdown code fences or contain extra text.
 *
 * Security:
 * - Never logs API keys or authorization headers
 * - Never exposes secrets in error messages
 * - AI is advisory only — output is validated by Zod schema
 */

import type { AIRecommendation } from '../domain/policy.js';
import { SYSTEM_PROMPT, buildPrompt } from './prompts.js';
import type { AIProvider, AgentContext } from './provider.js';
import { AIProviderError } from './provider.js';
import { AIRecommendationSchema } from './schemas.js';

const NVIDIA_BUILD_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 2048;

export interface NemotronProviderConfig {
  apiKey: string;
  modelId: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

export class NemotronProvider implements AIProvider {
  readonly name = 'nemotron';
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(config: NemotronProviderConfig) {
    if (!config.apiKey) {
      throw new AIProviderError('AUTH_FAILURE', 'NVIDIA API key is required for NemotronProvider');
    }
    this.apiKey = config.apiKey;
    this.modelId = config.modelId;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async recommend(context: AgentContext): Promise<AIRecommendation> {
    const prompt = buildPrompt(context);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(NVIDIA_BUILD_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: this.temperature,
          max_tokens: this.maxTokens,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AIProviderError('TIMEOUT', `NVIDIA API request timed out after ${this.timeoutMs}ms`, error);
      }
      throw new AIProviderError('NETWORK_ERROR', 'Failed to connect to NVIDIA API', error);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIProviderError('AUTH_FAILURE', `NVIDIA API authentication failed (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new AIProviderError('API_ERROR', `NVIDIA API returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AIProviderError('API_ERROR', 'Failed to parse NVIDIA API response as JSON');
    }

    const raw = extractContent(body);
    const parsed = parseJsonFallback(raw);
    return validateRecommendation(parsed);
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────

interface NvidiaChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

/**
 * Extract the assistant message content from the NVIDIA API response.
 */
function extractContent(body: unknown): string {
  const response = body as NvidiaChatCompletionResponse;
  const content = response.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    throw new AIProviderError('API_ERROR', 'NVIDIA API response has empty or missing content');
  }
  return content;
}

/**
 * Fallback JSON parser (§10.4)
 *
 * Tries in order:
 * 1. Direct JSON.parse of the raw string
 * 2. Extract from markdown code fence (```json ... ``` or ``` ... ```)
 * 3. Extract first { ... } brace match
 *
 * Throws AIProviderError with code PARSE_ERROR if all fail.
 */
export function parseJsonFallback(raw: string): unknown {
  // 1. Direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // Continue to fallback strategies
  }

  // 2. Markdown code fence
  const mdMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (mdMatch?.[1]) {
    try {
      return JSON.parse(mdMatch[1]);
    } catch {
      // Continue
    }
  }

  // 3. Brace extraction
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch?.[0]) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // Fall through to error
    }
  }

  throw new AIProviderError('PARSE_ERROR', 'No valid JSON found in model response');
}

/**
 * Validate parsed output against the AIRecommendation Zod schema.
 */
function validateRecommendation(parsed: unknown): AIRecommendation {
  const result = AIRecommendationSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new AIProviderError('SCHEMA_VALIDATION', `AI output schema validation failed: ${errors}`);
  }
  return result.data;
}
