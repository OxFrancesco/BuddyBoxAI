FROM docker.io/cloudflare/sandbox:0.12.6

WORKDIR /opt/ichef-agent-runner
COPY runner/package.json ./package.json
RUN bun install
RUN bun x playwright install --with-deps chromium
COPY runner/src ./src

WORKDIR /workspace
EXPOSE 4173 8790
