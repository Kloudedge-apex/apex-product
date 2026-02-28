FROM node:20-slim AS base

# Install openssl for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/db/ packages/db/
COPY apps/api/ apps/api/

# Generate Prisma client
RUN cd packages/db && npx prisma generate

# Build API
RUN pnpm --filter @apex/api build

EXPOSE 4000

# Use node directly to avoid pnpm overhead
CMD ["node", "apps/api/dist/main.js"]
