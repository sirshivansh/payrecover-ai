-- ==============================================================================
-- PAYRECOVER AI — MASTER POSTGRESQL SCHEMA (v2.1 / v2.1.1 Aligned)
-- ==============================================================================

-- Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------------------------
-- Enumerations
-- ------------------------------------------------------------------------------

CREATE TYPE payment_status AS ENUM (
    'created', 'attempted', 'paid', 'failed', 'refunded', 'cancelled'
);

CREATE TYPE recovery_status AS ENUM (
    'pending', 'analyzing', 'policy_check', 'executing', 
    'action_outcome_unknown', 'verifying', 'succeeded', 'failed', 'stopped', 'escalated'
);

CREATE TYPE recovery_action_type AS ENUM (
    'create_payment_link', 'stop_recovery'
);

CREATE TYPE ai_decision_type AS ENUM (
    'recover_now', 'stop', 'escalate'
);

CREATE TYPE policy_decision_type AS ENUM (
    'approved', 'rejected', 'approved_with_modifications'
);

CREATE TYPE job_type AS ENUM (
    'analyze', 'execute', 'verify', 'reconcile'
);

CREATE TYPE job_status AS ENUM (
    'pending', 'claimed', 'completed', 'failed', 'cancelled'
);

CREATE TYPE audit_actor AS ENUM (
    'webhook', 'ai', 'policy', 'executor', 'verifier', 'scheduler', 'reconciler'
);

-- ------------------------------------------------------------------------------
-- Tables & Indexes
-- ------------------------------------------------------------------------------

-- 1. Payments Table
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    razorpay_payment_id VARCHAR(64) NOT NULL UNIQUE,
    razorpay_order_id VARCHAR(64),
    razorpay_customer_id VARCHAR(64),
    amount_paise BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status payment_status NOT NULL DEFAULT 'created',
    failure_reason VARCHAR(255),
    failure_code VARCHAR(64),
    method VARCHAR(32),
    email_hash VARCHAR(64),           -- HMAC-SHA256(secret, email)
    phone_hash VARCHAR(64),           -- HMAC-SHA256(secret, phone)
    customer_name_hash VARCHAR(64),   -- HMAC-SHA256(secret, name)
    attempts INT NOT NULL DEFAULT 0,  -- From Razorpay
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_payments_razorpay_id ON payments(razorpay_payment_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_customer ON payments(razorpay_customer_id);
CREATE INDEX idx_payments_created_at ON payments(created_at);

-- 2. Recovery Attempts Table
CREATE TABLE recovery_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL DEFAULT 1,
    status recovery_status NOT NULL DEFAULT 'pending',
    revenue_at_risk_paise BIGINT NOT NULL,
    ai_recommendation JSONB,
    ai_decision ai_decision_type,
    ai_confidence DECIMAL(3,2),
    ai_reasoning TEXT,
    policy_decision policy_decision_type,
    policy_reason TEXT,
    policy_modifications JSONB,
    action_type recovery_action_type,
    action_payload JSONB,
    action_result JSONB,
    idempotency_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    policy_snapshot JSONB NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    error_message TEXT
);

CREATE INDEX idx_recovery_payment ON recovery_attempts(payment_id);
CREATE INDEX idx_recovery_status ON recovery_attempts(status);
CREATE INDEX idx_recovery_idempotency ON recovery_attempts(idempotency_key);
CREATE INDEX idx_recovery_payment_status ON recovery_attempts(payment_id, status);
CREATE INDEX idx_recovery_next_retry ON recovery_attempts(next_retry_at) WHERE next_retry_at IS NOT NULL;

-- 3. Webhook Events Table
CREATE TABLE webhook_events (
    event_id VARCHAR(128) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    razorpay_payment_id VARCHAR(64),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_webhook_events_payment ON webhook_events(razorpay_payment_id);
CREATE INDEX idx_webhook_events_received ON webhook_events(received_at);

-- 4. Recovery Jobs Table
CREATE TABLE recovery_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recovery_attempt_id UUID NOT NULL REFERENCES recovery_attempts(id) ON DELETE CASCADE,
    job_type job_type NOT NULL,
    run_at TIMESTAMPTZ NOT NULL,
    status job_status NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(128),
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recovery_jobs_due ON recovery_jobs(run_at, status) WHERE status = 'pending';
CREATE INDEX idx_recovery_jobs_attempt ON recovery_jobs(recovery_attempt_id, job_type);
CREATE INDEX idx_recovery_jobs_locked ON recovery_jobs(locked_by) WHERE locked_by IS NOT NULL;

-- 5. Audit Log Table
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recovery_attempt_id UUID REFERENCES recovery_attempts(id) ON DELETE SET NULL,
    payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    actor VARCHAR(32) NOT NULL,
    action VARCHAR(64) NOT NULL,
    input JSONB,
    output JSONB,
    error TEXT,
    trace_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_recovery ON audit_log(recovery_attempt_id);
CREATE INDEX idx_audit_payment ON audit_log(payment_id);
CREATE INDEX idx_audit_trace ON audit_log(trace_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- 6. Merchant Config Table (Single-Row MVP)
CREATE TABLE merchant_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO merchant_config (id, config_json) VALUES (gen_random_uuid(), '{}') 
ON CONFLICT DO NOTHING;
