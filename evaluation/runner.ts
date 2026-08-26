import { fileURLToPath } from 'node:url';
import { RecoveryStatus } from '@payrecover/shared';
import { SYNTHETIC_SCENARIOS } from './cases.js';
import type { EvaluationReport, SyntheticCaseResult } from './types.js';

/**
 * Executes all synthetic evaluation scenarios in isolation (§15).
 */
export async function runEvaluation(): Promise<EvaluationReport> {
  const startTime = Date.now();
  const results: SyntheticCaseResult[] = [];

  for (const scenario of SYNTHETIC_SCENARIOS) {
    try {
      const res = await scenario.run();
      results.push(res);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        passed: false,
        expected: { attemptStatus: RecoveryStatus.SUCCEEDED },
        actual: { error: errMsg },
        details: `Exception thrown during execution: ${errMsg}`,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  const totalCases = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = totalCases - passedCount;
  const verdict: 'PASS' | 'FAIL' = failedCount === 0 ? 'PASS' : 'FAIL';

  return {
    timestamp: new Date().toISOString(),
    totalCases,
    passedCount,
    failedCount,
    durationMs,
    verdict,
    results,
  };
}

// CLI entry point
const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
  runEvaluation()
    .then((report) => {
      console.log('\n==================================================');
      console.log('PAYRECOVER AI — SYNTHETIC EVALUATION REPORT');
      console.log('==================================================\n');

      for (const res of report.results) {
        const badge = res.passed ? '✅ PASS' : '❌ FAIL';
        console.log(`${badge} | Case ${res.id.toString().padStart(2, '0')}: ${res.name}`);
        if (!res.passed) {
          console.log(`   └ Expected:    ${JSON.stringify(res.expected)}`);
          console.log(`   └ Actual:      ${JSON.stringify(res.actual)}`);
          if (res.traceId) console.log(`   └ Trace ID:    ${res.traceId}`);
          if (res.details) console.log(`   └ Details:     ${res.details}`);
          if (res.scenarioDiagnostics) {
            console.log(`   └ Diagnostics: ${JSON.stringify(res.scenarioDiagnostics)}`);
          }
        }
      }

      console.log('\n--------------------------------------------------');
      console.log(`Total Cases: ${report.totalCases}`);
      console.log(`Passed:      ${report.passedCount}`);
      console.log(`Failed:      ${report.failedCount}`);
      console.log(`Duration:    ${report.durationMs}ms`);
      console.log(`Verdict:     ${report.verdict}`);
      console.log('==================================================\n');

      if (report.verdict !== 'PASS') {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('Fatal evaluation error:', err);
      process.exit(1);
    });
}
