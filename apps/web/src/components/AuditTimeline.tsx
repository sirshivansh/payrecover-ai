import type { AuditLogEntry } from '../types/api';
import { formatDate } from '../utils/format';

export interface AuditTimelineProps {
  logs: AuditLogEntry[];
}

export function AuditTimeline({ logs }: AuditTimelineProps) {
  if (!logs || logs.length === 0) {
    return <div className="state-box">No audit records found for this recovery attempt.</div>;
  }

  return (
    <div className="timeline">
      {logs.map((log) => (
        <div key={log.id} className="timeline-item">
          <div className="timeline-node">{getActorIcon(log.actor)}</div>
          <div className="timeline-content">
            <div className="timeline-header">
              <span className="timeline-action">{formatActionName(log.action)}</span>
              <span className="timeline-time">{formatDate(log.createdAt)}</span>
            </div>
            <div className="timeline-actor">Actor: {log.actor}</div>

            {log.error && (
              <div style={{ color: '#f87171', fontSize: '0.8rem', marginTop: '0.25rem', marginBottom: '0.5rem' }}>
                Error: {log.error}
              </div>
            )}

            {log.input && Object.keys(log.input).length > 0 && (
              <div style={{ marginTop: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Input Payload:</span>
                <pre className="timeline-code">{JSON.stringify(log.input, null, 2)}</pre>
              </div>
            )}

            {log.output && Object.keys(log.output).length > 0 && (
              <div style={{ marginTop: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Output Result:</span>
                <pre className="timeline-code">{JSON.stringify(log.output, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function getActorIcon(actor: string): string {
  switch (actor) {
    case 'webhook':
      return '⚡';
    case 'scheduler':
      return '⏱';
    case 'ai':
      return '🤖';
    case 'policy':
      return '🛡';
    case 'executor':
      return '⚙';
    case 'verifier':
      return '🔍';
    case 'reconciler':
      return '⚖';
    default:
      return '📝';
  }
}

function formatActionName(action: string): string {
  return action.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}
