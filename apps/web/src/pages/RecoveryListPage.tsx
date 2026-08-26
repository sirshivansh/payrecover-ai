import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchRecoveries } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import type { PaginatedRecoveryAttempts } from '../types/api';
import { formatDate, formatRupees } from '../utils/format';

export function RecoveryListPage() {
  const [data, setData] = useState<PaginatedRecoveryAttempts | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filter & Pagination state
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const limit = 15;

  const loadData = useCallback(async (status?: string, p = 1) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchRecoveries(status || undefined, p, limit);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch recovery attempts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(selectedStatus, page);
  }, [loadData, selectedStatus, page]);

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedStatus(val);
    setPage(1); // Reset to page 1 on filter change
  };

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h2 className="page-title">Recovery Attempts</h2>
        <p className="page-subtitle">Monitor and inspect all payment recovery workflows in real time</p>
      </div>

      {/* Filter Bar */}
      <div className="control-bar">
        <div className="input-group">
          <label htmlFor="status-filter">Filter by Status:</label>
          <select id="status-filter" className="select-field" value={selectedStatus} onChange={handleStatusChange}>
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="analyzing">Analyzing</option>
            <option value="policy_check">Policy Check</option>
            <option value="executing">Executing</option>
            <option value="action_outcome_unknown">Outcome Unknown</option>
            <option value="verifying">Verifying</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="stopped">Stopped</option>
            <option value="escalated">Escalated</option>
          </select>
        </div>

        {data && (
          <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            Showing {data.data.length} of {data.pagination.total} attempts
          </div>
        )}
      </div>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {loading ? (
        <div className="state-box">
          <div className="loading-spinner" />
          <p style={{ marginTop: '1rem' }}>Loading recovery attempts...</p>
        </div>
      ) : data && data.data.length > 0 ? (
        <>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Attempt ID</th>
                  <th>Payment ID</th>
                  <th>Attempt #</th>
                  <th>Status</th>
                  <th>Revenue at Risk</th>
                  <th>AI Recommendation</th>
                  <th>Action</th>
                  <th>Started At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link
                        to={`/recoveries/${item.id}`}
                        style={{ color: '#60a5fa', textDecoration: 'none', fontFamily: 'monospace' }}
                      >
                        {item.id.substring(0, 8)}...
                      </Link>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {item.paymentId.substring(0, 8)}...
                    </td>
                    <td>#{item.attemptNumber}</td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td style={{ fontWeight: 600 }}>{formatRupees(item.revenueAtRiskPaise)}</td>
                    <td style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                      {item.aiDecision ? item.aiDecision.toUpperCase() : '—'}
                      {item.aiConfidence !== null && ` (${Math.round(item.aiConfidence * 100)}%)`}
                    </td>
                    <td style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                      {item.actionType ? item.actionType : '—'}
                    </td>
                    <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{formatDate(item.createdAt)}</td>
                    <td>
                      <Link
                        to={`/recoveries/${item.id}`}
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', textDecoration: 'none' }}
                      >
                        View Detail
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          <div className="pagination-bar">
            <div>
              Page {data.pagination.page} of {data.pagination.totalPages || 1}
            </div>
            <div className="pagination-buttons">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Previous
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={page >= data.pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="state-box">No recovery attempts found matching the selected criteria.</div>
      )}
    </div>
  );
}
