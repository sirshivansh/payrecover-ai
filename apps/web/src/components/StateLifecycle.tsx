import type { RecoveryStatus } from '@payrecover/shared';

export interface StateLifecycleProps {
  currentStatus: RecoveryStatus | string;
}

const LIFECYCLE_STEPS = [
  { key: 'pending', label: 'Pending' },
  { key: 'analyzing', label: 'Analyzing' },
  { key: 'policy_check', label: 'Policy Check' },
  { key: 'executing', label: 'Executing' },
  { key: 'verifying', label: 'Verifying' },
];

export function StateLifecycle({ currentStatus }: StateLifecycleProps) {
  const isTerminalSucceeded = currentStatus === 'succeeded';
  const isTerminalFailed = currentStatus === 'failed';
  const isTerminalStopped = currentStatus === 'stopped';
  const isTerminalEscalated = currentStatus === 'escalated';
  const isOutcomeUnknown = currentStatus === 'action_outcome_unknown';

  return (
    <div className="lifecycle-flow">
      {LIFECYCLE_STEPS.map((step, idx) => {
        const isActive = currentStatus === step.key;
        return (
          <div key={step.key} style={{ display: 'flex', alignItems: 'center' }}>
            <div className={`lifecycle-step ${isActive ? 'active' : ''}`}>
              <div className="step-circle">{idx + 1}</div>
              <div className="step-label">{step.label}</div>
            </div>
            {idx < LIFECYCLE_STEPS.length - 1 && <div className="step-connector" />}
          </div>
        );
      })}

      <div className="step-connector" />

      {/* Terminal Outcome Step */}
      <div
        className={`lifecycle-step ${
          isTerminalSucceeded
            ? 'terminal-succeeded'
            : isTerminalFailed || isTerminalStopped || isTerminalEscalated
              ? 'terminal-failed'
              : isOutcomeUnknown
                ? 'active'
                : ''
        }`}
      >
        <div className="step-circle">
          {isTerminalSucceeded
            ? '✓'
            : isTerminalFailed
              ? '✕'
              : isTerminalStopped
                ? '⏹'
                : isTerminalEscalated
                  ? '⚠'
                  : '?'}
        </div>
        <div className="step-label">
          {isTerminalSucceeded
            ? 'Succeeded'
            : isTerminalFailed
              ? 'Failed'
              : isTerminalStopped
                ? 'Stopped'
                : isTerminalEscalated
                  ? 'Escalated'
                  : isOutcomeUnknown
                    ? 'Unknown'
                    : 'Terminal'}
        </div>
      </div>
    </div>
  );
}
