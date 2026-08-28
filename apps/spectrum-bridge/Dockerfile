# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-slim

WORKDIR /app
ENV NODE_ENV=production

# Railway builds this Dockerfile with the repository root as its context.
# Keep the bridge image independent from the monorepo workspace lockfile so a
# clean Linux build installs only the runtime dependencies this service needs.
COPY apps/spectrum-bridge/package.json ./package.json
RUN bun install --production
COPY apps/spectrum-bridge/src ./src

USER bun
EXPOSE 3000
CMD ["bun", "src/index.ts"]
