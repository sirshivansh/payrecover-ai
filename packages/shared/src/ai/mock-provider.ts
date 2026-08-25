/**
 * PayRecover AI — Mock AI Provider (§10.5, v2.1.1 §24, §30)
 *
 * Deterministic mock provider for testing, local development,
 * offline execution, and synthetic evaluation.
 *
 * Implements the same AIProvider interface as NemotronProvider.
 * Works without network access or NVIDIA credentials.
 */

import { AIDecisionType, RecoveryActionType } from '../domain/enums.js';
import type { AIRecommendation } from '../domain/policy.js';
import type { AIProvider, AgentContext } from './provider.js';
import { AIProviderError } from './provider.js';

export type MockAIScenario =
  | 'recover_now'
  | 'stop'
  | 'escalate'
  | 'low_confidence'
  | 'invalid_action'
  | 'invalid_json'
  | 'timeout';

export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  private scenario: MockAIScenario = 'recover_now';

  setScenario(s: MockAIScenario): void {
    this.scenario = s;
  }

  getScenario(): MockAIScenario {
    return this.scenario;
  }

  async recommend(_context: AgentContext): Promise<AIRecommendation> {
    const base: AIRecommendation = {
      decision: AIDecisionType.RECOVER_NOW,
      confidence: 0.9,
      reasoning: 'Mock recommendation for testing',
      recommended_action: RecoveryActionType.CREATE_PAYMENT_LINK,
    };

    switch (this.scenario) {
      case 'recover_now':
        return { ...base, decision: AIDecisionType.RECOVER_NOW };

      case 'stop':
        return {
          ...base,
          decision: AIDecisionType.STOP,
          recommended_action: RecoveryActionType.STOP_RECOVERY,
          reasoning: 'Mock: Low probability of recovery',
        };

      case 'escalate':
        return {
          ...base,
          decision: AIDecisionType.ESCALATE,
          recommended_action: RecoveryActionType.STOP_RECOVERY,
          reasoning: 'Mock: High value, complex failure needing human review',
        };

      case 'low_confidence':
        return {
          ...base,
          decision: AIDecisionType.RECOVER_NOW,
          confidence: 0.3,
          reasoning: 'Mock: Low confidence recommendation',
        };

      case 'invalid_action':
        return {
          ...base,
          decision: AIDecisionType.RECOVER_NOW,
          recommended_action: 'invalid_action' as unknown as RecoveryActionType,
          reasoning: 'Mock: Invalid action type for testing',
        };

      case 'invalid_json':
        throw new AIProviderError('PARSE_ERROR', 'MOCK_INVALID_JSON: Simulated invalid JSON response');

      case 'timeout':
        throw new AIProviderError('TIMEOUT', 'MOCK_TIMEOUT: Simulated provider timeout');
    }
  }
}
