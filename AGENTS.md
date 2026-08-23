# AGENTS.md — PayRecover AI Development Rules

## Project Context

PayRecover AI is an AI-assisted revenue recovery system for failed payments. See `docs/MASTER_SPECIFICATION_2.1.md` (base) and `docs/MASTER_SPECIFICATION_2.1.1.md` (corrections, takes precedence) for the complete specification.

## Critical Rules

1. **PostgreSQL is the durable source of truth.** Redis is an optimization layer only.
2. **AI is advisory only.** AI MUST NOT determine/modify/return/authorize monetary amounts, call external APIs, modify the database, or bypass policy.
3. **ActionExecutor obtains amount and currency from the PostgreSQL payment record.** Never from AI output.
4. **PolicyEngine is deterministic and independent of model judgment.** Pure function, 7 ordered rules.
5. **Razorpay Test Mode only.** Assert `rzp_test_*` key prefix at runtime. No real-money transactions.
6. **Gemini is a developer assistant only.** No runtime dependency, no API keys in code.
7. **Nemotron runs via NVIDIA hosted inference only.** Never attempt local inference on this hardware.
8. **MockAIProvider and MockPaymentProvider must support full offline development and testing.**
9. **The 21 synthetic evaluation cases are genuine acceptance tests.** Never weaken, remove, bypass, or hard-code tests.
10. **₹0 mandatory project cost.** No paid services required.

## Architecture

- **Monorepo:** Turborepo with `apps/api`, `apps/web`, `packages/shared`
- **Backend:** Fastify (single service, modular monolith)
- **Frontend:** React + Vite
- **Database:** PostgreSQL 16 via Kysely
- **Cache:** Redis 7 via ioredis (fast-path only)
- **Validation:** Zod schemas
- **Testing:** Vitest
- **Linting:** Biome

## Code Standards

- TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess: true`)
- No `any` in domain code
- Parameterized queries only (Kysely)
- All secrets via environment variables — never hard-coded
- PII: HMAC-SHA256 pseudonymization, never raw PII in prompts/audit

## State Machines

- **Payment:** created → attempted → paid/failed/refunded/cancelled (Razorpay authoritative)
- **Recovery:** PENDING → ANALYZING → POLICY_CHECK → EXECUTING → VERIFYING/ACTION_OUTCOME_UNKNOWN → SUCCEEDED/FAILED/STOPPED/ESCALATED
- **Jobs:** PENDING → CLAIMED → COMPLETED/FAILED/CANCELLED

## Implementation Phases

Follow the phased implementation order defined in specification §26 (Phase 0 through Phase 19). Each phase has explicit dependencies and acceptance criteria. Do not skip phases or implement out of order.

## Environment Variables

All defined in `.env.example`. Required variables vary by phase. Never commit `.env` or `.env.local`.
