FROM docker.io/cloudflare/sandbox:0.12.6

WORKDIR /opt/buddybox-pi-prototype
COPY runner/package.json ./package.json
RUN bun install
COPY runner/src ./src

WORKDIR /workspace
EXPOSE 4173 8790
