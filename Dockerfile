# Multi-stage Dockerfile — PayRecover AI Container Deployment (§19, §26 Phase 19)

# 1. Base Node environment
FROM node:20-alpine AS base
WORKDIR /app

# 2. Dependencies stage
FROM base AS dependencies
COPY package.json package-lock.json turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci

# 3. Build stage
FROM dependencies AS builder
COPY . .
RUN npm run build

# 4. Production API runner stage
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

EXPOSE 3000

CMD ["node", "apps/api/dist/main.js"]
