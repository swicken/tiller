# Spike: does the tiller daemon run on Linux, and does its UI work from a
# non-loopback origin? Terminal nodes only: no agent CLIs, no credentials.
FROM node:24-bookworm

# node-pty ships no Linux prebuild, so it compiles from source here.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run ui:build

# createUpdater runs `git rev-parse HEAD` unguarded at startup, so the daemon
# refuses to boot outside a git checkout. Give it a minimal one.
RUN git init -q -b main . \
    && git config user.email spike@example.invalid \
    && git config user.name spike \
    && git add -A && git commit -q -m 'spike image'

ENV TL_HOME=/data TL_PORT=7788 TL_BIND=0.0.0.0
EXPOSE 7788
CMD ["node_modules/.bin/tsx", "src/daemon/index.ts"]
