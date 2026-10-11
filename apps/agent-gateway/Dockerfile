FROM docker.io/cloudflare/sandbox:0.12.6 AS deps

WORKDIR /opt/buddybox-agent-runner
COPY runner/package.json ./package.json
RUN bun install --production

FROM docker.io/cloudflare/sandbox:0.12.6

WORKDIR /opt/buddybox-agent-runner
COPY runner/package.json ./package.json
COPY --from=deps /opt/buddybox-agent-runner/node_modules ./node_modules
# The Lite instance has a 2 GB disk for image + workspace. Headless launches only need
# the headless shell; xvfb (and the LLVM/Mesa stack it pulls in) is only for headed mode.
# apt caches must be removed in the same layer to stay small.
RUN ./node_modules/.bin/playwright install --with-deps --only-shell chromium \
  && apt-get purge -y --auto-remove xvfb \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/*
COPY runner/src ./src

WORKDIR /workspace
EXPOSE 4173 8790
