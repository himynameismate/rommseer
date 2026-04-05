FROM node:20-slim AS base

# Install OpenSSL (required by Prisma), p7zip-full + unar (for ROM archive extraction including RAR)
RUN apt-get update -y && apt-get install -y openssl p7zip-full unar gosu && rm -rf /var/lib/apt/lists/*

# Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* .npmrc* ./
COPY prisma ./prisma/
RUN npm ci

# Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# Runner
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p .next

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy Prisma engine binaries needed for db push at runtime
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# Copy bcryptjs for seed script
COPY --from=deps /app/node_modules/bcryptjs ./node_modules/bcryptjs

# Copy seed script
COPY prisma/seed.js ./prisma/seed.js

# Copy entrypoint script
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Create data directory for SQLite and set ownership
RUN mkdir -p /app/data

# Create non-root user for running the application
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nextjs && \
    chown -R nextjs:nodejs /app

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_URL="file:/app/data/rommseer.db"

# Entrypoint runs as root to fix volume permissions, then execs as nextjs (UID 1001)
ENTRYPOINT ["./entrypoint.sh"]
