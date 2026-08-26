import { RecoveryStatus } from '@payrecover/shared';
import { describe, expect, it } from 'vitest';
import { formatDate, formatPercentage, formatRupees, getStatusLabel, isTerminalStatus } from '../utils/format';

describe('Phase 13 — Frontend Utilities & Formatters', () => {
  describe('formatRupees', () => {
    it('should format integer paise correctly as Indian Rupees (INR)', () => {
      // 250000 paise = ₹2,500.00
      expect(formatRupees(250000)).toContain('2,500.00');
      // 100000 paise = ₹1,000.00
      expect(formatRupees(100000)).toContain('1,000.00');
      // 0 paise = ₹0.00
      expect(formatRupees(0)).toContain('0.00');
    });

    it('should maintain exact 2 decimal places without rounding drift', () => {
      expect(formatRupees(500050)).toContain('5,000.50');
    });
  });

  describe('formatDate', () => {
    it('should format ISO date strings', () => {
      const iso = '2026-08-26T10:00:00.000Z';
      const formatted = formatDate(iso);
      expect(formatted).not.toBe('—');
      expect(formatted.length).toBeGreaterThan(0);
    });

    it('should return dash for null or undefined dates', () => {
      expect(formatDate(null)).toBe('—');
      expect(formatDate(undefined)).toBe('—');
    });
  });

  describe('formatPercentage', () => {
    it('should format percentage to 1 decimal place', () => {
      expect(formatPercentage(85.543)).toBe('85.5%');
      expect(formatPercentage(100)).toBe('100.0%');
      expect(formatPercentage(0)).toBe('0.0%');
    });
  });

  describe('isTerminalStatus', () => {
    it('should identify terminal recovery statuses', () => {
      expect(isTerminalStatus(RecoveryStatus.SUCCEEDED)).toBe(true);
      expect(isTerminalStatus(RecoveryStatus.FAILED)).toBe(true);
      expect(isTerminalStatus(RecoveryStatus.STOPPED)).toBe(true);
      expect(isTerminalStatus(RecoveryStatus.ESCALATED)).toBe(true);
    });

    it('should identify non-terminal recovery statuses', () => {
      expect(isTerminalStatus(RecoveryStatus.PENDING)).toBe(false);
      expect(isTerminalStatus(RecoveryStatus.ANALYZING)).toBe(false);
      expect(isTerminalStatus(RecoveryStatus.EXECUTING)).toBe(false);
      expect(isTerminalStatus(RecoveryStatus.VERIFYING)).toBe(false);
      expect(isTerminalStatus(RecoveryStatus.ACTION_OUTCOME_UNKNOWN)).toBe(false);
    });
  });

  describe('getStatusLabel', () => {
    it('should return human readable status labels', () => {
      expect(getStatusLabel('succeeded')).toBe('Succeeded');
      expect(getStatusLabel('failed')).toBe('Failed');
      expect(getStatusLabel('action_outcome_unknown')).toBe('Outcome Unknown');
    });
  });
});
