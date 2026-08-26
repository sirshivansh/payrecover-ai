import { useCallback, useEffect, useState } from 'react';
import { fetchMetricsSummary } from '../api/client';
import type { MetricsSummary } from '../types/api';
import { formatDate, formatPercentage, formatRupees } from '../utils/format';

export function OverviewPage() {
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Date controls state
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const loadMetrics = useCallback(async (from?: string, to?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMetricsSummary(from, to);
      setMetrics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recovery metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const handleApplyFilter = (e: React.FormEvent) => {
    e.preventDefault();
    if (fromDate && toDate && fromDate >= toDate) {
      setError('"From" date must be earlier than "To" date');
      return;
    }
    loadMetrics(fromDate || undefined, toDate || undefined);
  };

  const handleResetFilter = () => {
    setFromDate('');
    setToDate('');
    loadMetrics();
  };

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h2 className="page-title">Recovery Operations Overview</h2>
        <p className="page-subtitle">Authoritative real-time metrics for AI-assisted payment recovery</p>
      </div>

      {/* Date Filter Bar */}
      <form className="control-bar" onSubmit={handleApplyFilter}>
        <div className="date-controls">
          <div className="input-group">
            <label htmlFor="from-date">From:</label>
            <input
              id="from-date"
              type="date"
              className="input-field"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label htmlFor="to-date">To:</label>
            <input
              id="to-date"
              type="date"
              className="input-field"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          <button type="submit" className="btn">
            Apply Period Filter
          </button>
          {(fromDate || toDate) && (
            <button type="button" className="btn btn-secondary" onClick={handleResetFilter}>
              Reset
            </button>
          )}
        </div>

        {metrics && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Period: {formatDate(metrics.period.from)} – {formatDate(metrics.period.to)}
          </div>
        )}
      </form>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {loading ? (
        <div className="state-box">
          <div className="loading-spinner" />
          <p style={{ marginTop: '1rem' }}>Loading recovery metrics...</p>
        </div>
      ) : metrics ? (
        <>
          {/* Main Financial Metric Cards */}
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Revenue at Risk</div>
              <div className="metric-value">{formatRupees(metrics.revenueAtRiskPaise)}</div>
              <div className="metric-subtext">Total amount of failed payments evaluated</div>
            </div>

            <div className="metric-card">
              <div className="metric-label">Recovered Revenue</div>
              <div className="metric-value success">{formatRupees(metrics.recoveredRevenuePaise)}</div>
              <div className="metric-subtext">Successfully recovered payment volume</div>
            </div>

            <div className="metric-card">
              <div className="metric-label">Recovery Rate</div>
              <div className="metric-value success">{formatPercentage(metrics.recoveryRatePct)}</div>
              <div className="metric-subtext">Recovered vs. total revenue at risk</div>
            </div>

            <div className="metric-card">
              <div className="metric-label">Attempt Success Rate</div>
              <div className="metric-value warning">{formatPercentage(metrics.attemptSuccessRatePct)}</div>
              <div className="metric-subtext">Succeeded attempts vs. executed attempts</div>
            </div>
          </div>

          {/* Secondary Attempt Breakdown Cards */}
          <h3 style={{ marginBottom: '1rem' }}>Attempt Status Breakdown</h3>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Total Attempts</div>
              <div className="metric-value">{metrics.totalAttempts}</div>
              <div className="metric-subtext">Recovery attempts initiated</div>
            </div>

            <div className="metric-card">
              <div className="metric-label">Succeeded</div>
              <div className="metric-value success">{metrics.succeededAttempts}</div>
              <div className="metric-subtext">Payments successfully captured</div>
            </div>

            <div className="metric-card">
              <div className="metric-label">Stopped</div>
              <div className="metric-value" style={{ color: 'var(--text-muted)' }}>
                {metrics.stoppedAttempts}
              </div>
              <div className="metric-subtext">Halted by policy or max attempts</div>
            </div>

            <div className="metric-card">
              <div className="metric-label">Escalated</div>
              <div className="metric-value warning">{metrics.escalatedAttempts}</div>
              <div className="metric-subtext">Flagged for manual merchant review</div>
            </div>
          </div>
        </>
      ) : (
        <div className="state-box">No metric data available for the selected period.</div>
      )}
    </div>
  );
}
