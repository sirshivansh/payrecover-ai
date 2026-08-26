import { describe, expect, it } from 'vitest';
import { SYNTHETIC_SCENARIOS } from '../cases.js';
import { runEvaluation } from '../runner.js';

describe('Phase 15 — Evaluation Harness & Scenarios', () => {
  it('should execute full evaluation runner with 26/26 passing scenarios', async () => {
    const report = await runEvaluation();
    expect(report.verdict).toBe('PASS');
    expect(report.totalCases).toBe(26);
    expect(report.passedCount).toBe(26);
    expect(report.failedCount).toBe(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.results.length).toBe(26);
  });

  it('should contain all required synthetic scenario IDs from 1 to 26', () => {
    const ids = SYNTHETIC_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
  });

  it('should execute notification delivery synthetic case (#22)', async () => {
    const case22 = SYNTHETIC_SCENARIOS.find((s) => s.id === 22);
    expect(case22).toBeDefined();
    const result = await case22?.run();
    expect(result?.passed).toBe(true);
    expect(result?.expected.notificationStatus).toBe('sent');
  });

  it('should execute financial metrics deduplication synthetic case (#25)', async () => {
    const case25 = SYNTHETIC_SCENARIOS.find((s) => s.id === 25);
    expect(case25).toBeDefined();
    const result = await case25?.run();
    expect(result?.passed).toBe(true);
    expect(result?.actual.metricsVerified).toBe(true);
  });

  it('should execute terminal state immutability synthetic case (#26)', async () => {
    const case26 = SYNTHETIC_SCENARIOS.find((s) => s.id === 26);
    expect(case26).toBeDefined();
    const result = await case26?.run();
    expect(result?.passed).toBe(true);
  });
});
