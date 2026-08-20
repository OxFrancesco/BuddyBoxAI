FROM oven/bun:1.3.14-slim

WORKDIR /app
ENV NODE_ENV=production

COPY apps/xchat-bridge/package.json ./package.json
RUN bun install --production
COPY apps/xchat-bridge/src ./src

USER bun
EXPOSE 3000
CMD ["bun", "src/index.ts"]
