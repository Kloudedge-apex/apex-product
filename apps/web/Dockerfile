FROM node:20-slim AS base
RUN corepack enable pnpm

# ── Build stage ──────────────────────────────────────────
FROM base AS builder
WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/db/ packages/db/
COPY apps/web/ apps/web/
COPY apps/api/ apps/api/

# Generate Prisma client (needed by web too)
RUN cd packages/db && npx prisma generate

# Build args for Next.js (baked into the client bundle at build time)
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL=/login
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL=/signup
ARG NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
ARG NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/onboarding
ARG NEXT_PUBLIC_API_URL

ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_URL
ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_URL
ENV NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL
ENV NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Build the Next.js app (produces .next/standalone)
RUN pnpm --filter @apex/web build

# ── Production stage ─────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Copy standalone server (includes all needed node_modules)
COPY --from=builder /app/apps/web/.next/standalone ./

# Copy static assets and public folder that standalone doesn't include
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000

# The standalone output produces a self-contained server.js
CMD ["node", "apps/web/server.js"]
