import type { RecoveryStatus } from '@payrecover/shared';

/**
 * Format integer paise into a human-readable Rupee currency string.
 * e.g., 250000 paise -> "₹2,500.00"
 *
 * Exact integer math: paise / 100 with 2 decimal places.
 */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/**
 * Format ISO date string into a friendly localized date & time string.
 */
export function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

/**
 * Format percentage rate.
 * e.g. 75.25 -> "75.3%"
 */
export function formatPercentage(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/**
 * Check if a recovery status is terminal (§6.1).
 */
export function isTerminalStatus(status: RecoveryStatus | string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'stopped' || status === 'escalated';
}

/**
 * Friendly label for recovery statuses.
 */
export function getStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'analyzing':
      return 'Analyzing';
    case 'policy_check':
      return 'Policy Check';
    case 'executing':
      return 'Executing';
    case 'action_outcome_unknown':
      return 'Outcome Unknown';
    case 'verifying':
      return 'Verifying';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    case 'escalated':
      return 'Escalated';
    default:
      return status;
  }
}
