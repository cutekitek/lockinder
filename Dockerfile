FROM oven/bun:1.4.0-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --network-concurrency 8

FROM dependencies AS build
COPY . .
RUN bun run lint && bun run test && bun run build

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --network-concurrency 8

FROM base AS web
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 DATABASE_PATH=/data/lockinder.db NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=bun:bun /app/.next/standalone ./
COPY --from=build --chown=bun:bun /app/.next/static ./.next/static
COPY --from=build --chown=bun:bun /app/public ./public
COPY --from=build --chown=bun:bun /app/migrations ./migrations
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
CMD ["bun", "server.js"]

FROM base AS worker
ENV NODE_ENV=production DATABASE_PATH=/data/lockinder.db
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun migrations ./migrations
RUN mkdir -p /data && chown bun:bun /data
USER bun
CMD ["bun", "scripts/worker.ts"]
