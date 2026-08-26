import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchRecoveryDetail } from '../api/client';
import { AuditTimeline } from '../components/AuditTimeline';
import { StateLifecycle } from '../components/StateLifecycle';
import { StatusBadge } from '../components/StatusBadge';
import type { RecoveryAttemptDetail } from '../types/api';
import { formatDate, formatRupees } from '../utils/format';

export function RecoveryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RecoveryAttemptDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    fetchRecoveryDetail(id)
      .then((data) => setDetail(data))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load recovery detail'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="state-box">
        <div className="loading-spinner" />
        <p style={{ marginTop: '1rem' }}>Loading recovery attempt details...</p>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div>
        <Link
          to="/recoveries"
          className="btn btn-secondary"
          style={{ marginBottom: '1rem', textDecoration: 'none', display: 'inline-block' }}
        >
          ← Back to Recovery List
        </Link>
        <div className="error-banner">⚠️ {error || 'Recovery attempt not found'}</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header & Navigation */}
      <div
        style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <Link
            to="/recoveries"
            className="btn btn-secondary"
            style={{ marginBottom: '0.75rem', textDecoration: 'none', display: 'inline-block', fontSize: '0.875rem' }}
          >
            ← Back to Recoveries
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h2 className="page-title" style={{ margin: 0 }}>
              Attempt #{detail.attemptNumber}
            </h2>
            <StatusBadge status={detail.status} />
          </div>
          <p
            style={{ color: 'var(--text-muted)', fontSize: '0.875rem', fontFamily: 'monospace', marginTop: '0.25rem' }}
          >
            ID: {detail.id}
          </p>
        </div>

        {detail.paymentLinkUrl && (
          <a
            href={detail.paymentLinkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
            style={{ textDecoration: 'none', background: 'linear-gradient(135deg, #10b981, #059669)' }}
          >
            🔗 View Generated Payment Link
          </a>
        )}
      </div>

      {/* Lifecycle Flow Visualizer */}
      <div className="detail-card" style={{ marginBottom: '2rem' }}>
        <h3>Recovery Lifecycle Progress</h3>
        <StateLifecycle currentStatus={detail.status} />
      </div>

      {/* Info Cards Grid */}
      <div className="detail-grid">
        {/* Payment Summary Card */}
        <div className="detail-card">
          <h3>Payment Summary</h3>
          {detail.payment ? (
            <>
              <div className="detail-row">
                <span>Amount</span>
                <span style={{ color: 'var(--accent-success)', fontWeight: 700 }}>
                  {formatRupees(detail.payment.amountPaise)}
                </span>
              </div>
              <div className="detail-row">
                <span>Razorpay Payment ID</span>
                <span style={{ fontFamily: 'monospace' }}>{detail.payment.razorpayPaymentId}</span>
              </div>
              <div className="detail-row">
                <span>Payment Status</span>
                <span>{detail.payment.status.toUpperCase()}</span>
              </div>
              <div className="detail-row">
                <span>Payment Method</span>
                <span>{detail.payment.method || 'Unknown'}</span>
              </div>
              <div className="detail-row">
                <span>Failure Reason</span>
                <span>{detail.payment.failureReason || 'N/A'}</span>
              </div>
              <div className="detail-row">
                <span>Customer Contact</span>
                <span>
                  {detail.payment.hasEmail && detail.payment.hasPhone
                    ? 'Email & Phone Available'
                    : detail.payment.hasEmail
                      ? 'Email Available'
                      : detail.payment.hasPhone
                        ? 'Phone Available'
                        : 'No Contact Info'}
                </span>
              </div>
              <div className="detail-row">
                <span>Created At</span>
                <span>{formatDate(detail.payment.createdAt)}</span>
              </div>
              <div className="detail-row">
                <span>Paid At</span>
                <span>{formatDate(detail.payment.paidAt)}</span>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>Payment data unavailable</div>
          )}
        </div>

        {/* Policy & AI Decision Card */}
        <div className="detail-card">
          <h3>Decision & Action Trail</h3>
          <div className="detail-row">
            <span>AI Recommendation</span>
            <span>{detail.aiDecision ? detail.aiDecision.toUpperCase() : '—'}</span>
          </div>
          <div className="detail-row">
            <span>AI Confidence</span>
            <span>{detail.aiConfidence !== null ? `${Math.round(detail.aiConfidence * 100)}%` : '—'}</span>
          </div>
          <div className="detail-row">
            <span>Policy Decision</span>
            <span
              style={{
                color:
                  detail.policyDecision?.decision === 'approved' ? 'var(--accent-success)' : 'var(--accent-warning)',
              }}
            >
              {detail.policyDecision ? detail.policyDecision.decision.toUpperCase() : '—'}
            </span>
          </div>
          <div className="detail-row">
            <span>Policy Reason</span>
            <span>{detail.policyDecision?.reason || '—'}</span>
          </div>
          <div className="detail-row">
            <span>Approved Action</span>
            <span>{detail.actionType || '—'}</span>
          </div>
          <div className="detail-row">
            <span>Started At</span>
            <span>{formatDate(detail.createdAt)}</span>
          </div>
          <div className="detail-row">
            <span>Completed At</span>
            <span>{formatDate(detail.completedAt)}</span>
          </div>
        </div>
      </div>

      {/* Audit & Trace Log Timeline */}
      <div className="detail-card">
        <h3>Audit & Workflow Trace History</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>
          Chronological system audit trail with sanitized inputs, outputs, and trace markers
        </p>
        <AuditTimeline logs={detail.auditLogs} />
      </div>
    </div>
  );
}
