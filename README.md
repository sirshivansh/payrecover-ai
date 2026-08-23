# PayRecover AI

**AI-Assisted Revenue Recovery for Failed Payments**

Razorpay AI Buildathon — Track 3: AI Revenue Recovery

---

## Overview

PayRecover AI is an intelligent payment recovery system that uses AI-assisted recommendations, deterministic policy guardrails, and bounded actions to recover revenue from failed payments. The system processes Razorpay webhook events, analyzes failed payments using NVIDIA Nemotron, applies merchant-configurable policy rules, and executes recovery actions (payment link creation) within strict safety boundaries.

### Key Architecture Principles

- **Modular Monolith**: Single Fastify service with clear internal boundaries
- **PostgreSQL = Source of Truth**: All financial state, recovery state, audit, jobs
- **Redis = Ephemeral Optimization**: Webhook deduplication, action locks, fast-path idempotency
- **AI Advisory Only**: AI recommends → Policy validates → Executor acts
- **Zero Paid Dependencies**: Local PostgreSQL/Redis, NVIDIA Build free tier, Razorpay Test Mode

## Repository Structure

```
payrecover-ai/
├── apps/
│   ├── api/                    # Fastify backend (port 3000)
│   │   └── src/
│   │       ├── main.ts         # App bootstrap
│   │       ├── app.ts          # Fastify app factory
│   │       └── config/         # Environment validation (Zod)
│   └── web/                    # React Dashboard (port 5173)
│       └── src/
│           ├── main.tsx        # React entry point
│           └── App.tsx         # Router shell
├── packages/
│   └── shared/                 # Shared types, providers, utilities
│       └── src/
│           └── index.ts        # Barrel export
├── database/                   # Schema & migrations (Phase 1)
├── evaluation/                 # Synthetic evaluation (Phase 16)
├── docs/
│   ├── MASTER_SPECIFICATION_2.1.md
│   └── MASTER_SPECIFICATION_2.1.1.md
├── docker-compose.yml          # PostgreSQL 16 + Redis 7
├── .env.example                # Environment variable template
├── package.json                # Turborepo workspace root
├── turbo.json                  # Pipeline configuration
├── tsconfig.json               # Base TypeScript (strict)
├── biome.json                  # Linting & formatting
├── vitest.config.ts            # Test runner configuration
├── README.md
└── AGENTS.md
```

## Prerequisites

- **Node.js** ≥ 20.x
- **npm** ≥ 10.x
- **Docker** and **Docker Compose** (for PostgreSQL and Redis)
- **Git**

## Environment Setup

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd payrecover-ai
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create environment file:**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` with your values. For Phase 0, defaults work without changes.

4. **Start infrastructure:**
   ```bash
   docker compose up -d
   ```
   This starts PostgreSQL (host port 5433 -> container port 5432) and Redis (port 6379).

5. **Verify infrastructure health:**
   ```bash
   docker compose ps
   ```
   Both `payrecover-db` and `payrecover-redis` should show `healthy`.

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start API + Web with hot reload (Turborepo) |
| `npm run build` | Build all packages |
| `npm run test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint all code (Biome) |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Format all code (Biome) |
| `npm run type-check` | TypeScript type checking |
| `npm run db:migrate` | Run database migrations to latest schema |
| `npm run db:rollback` | Rollback latest database migration |
| `npm run clean` | Clean build artifacts |

## Docker Setup

```bash
# Start PostgreSQL and Redis
docker compose up -d

# Check health status
docker compose ps

# View logs
docker compose logs -f db
docker compose logs -f redis

# Stop infrastructure
docker compose down

# Stop and remove volumes (full reset)
docker compose down -v
```

### Connection Details

| Service | Host | Port | Credentials |
|---------|------|------|-------------|
| PostgreSQL | localhost | 5433 | `postgres` / `postgres` / DB: `payrecover` |
| Redis | localhost | 6379 | No auth |

## Testing

```bash
# Run all tests
npm run test

# Run with coverage
npx vitest run --coverage

# Run specific package tests
cd apps/api && npm test
cd packages/shared && npm test
```

## Build

```bash
# Build all packages (respects dependency graph)
npm run build

# Build specific package
cd packages/shared && npm run build
cd apps/api && npm run build
```

## Current Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 0** | ✅ Complete | Repository & Tooling |
| **Phase 1** | ✅ Complete | Database schema & Kysely |
| Phase 2 | ⬜ Not started | Webhook ingestion |
| Phase 3 | ⬜ Not started | Payment state service |
| Phase 4 | ⬜ Not started | Recovery state machine |
| Phase 5-19 | ⬜ Not started | See specification §26 |

## Specification

The complete specification is in `docs/`:
- `MASTER_SPECIFICATION_2.1.md` — Base specification
- `MASTER_SPECIFICATION_2.1.1.md` — Corrections (takes precedence)

## License

Private — Razorpay AI Buildathon submission.
