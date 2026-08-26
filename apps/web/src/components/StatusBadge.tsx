import type { RecoveryStatus } from '@payrecover/shared';
import { getStatusLabel } from '../utils/format';

export interface StatusBadgeProps {
  status: RecoveryStatus | string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = getStatusLabel(status);

  let className = 'badge badge-in-progress';
  if (status === 'succeeded') {
    className = 'badge badge-succeeded';
  } else if (status === 'failed') {
    className = 'badge badge-failed';
  } else if (status === 'stopped') {
    className = 'badge badge-stopped';
  } else if (status === 'escalated') {
    className = 'badge badge-escalated';
  }

  return <span className={className}>{label}</span>;
}
