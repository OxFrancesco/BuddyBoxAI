# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-slim

WORKDIR /app
ENV NODE_ENV=production

# Railway builds this Dockerfile with the repository root as its context.
COPY . .
RUN bun install --frozen-lockfile --production --filter @buddybox/spectrum-bridge

USER bun
EXPOSE 3000
CMD ["bun", "apps/spectrum-bridge/src/index.ts"]
