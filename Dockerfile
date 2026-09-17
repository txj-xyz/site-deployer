# syntax=docker/dockerfile:1

# The deployer is a *client* of the host's Docker daemon, so this image needs
# more than node: the deploy saga shells out to `git` (server/git/source.ts) and
# to the `docker` CLI (server/docker/build.ts, which uses the CLI on purpose to
# get BuildKit and native .dockerignore handling).

FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles from source whenever no prebuilt binary matches the
# platform; this is what node-gyp needs when it falls back to doing that.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json vite.config.ts ./
COPY server ./server
COPY web ./web

# `npm run build` is tsc -> dist/ plus vite -> dist-web/; index.js looks for the
# SPA at ../dist-web relative to itself, so both land beside each other in /app.
RUN npm run build && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# git + openssh-client: cloning site repos, including over SSH.
# docker-ce-cli + buildx: the build-image step. No daemon here - it drives the
# host's daemon through the mounted socket.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git openssh-client \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce-cli docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-web ./dist-web
COPY package.json ./

# DATA_DIR holds the SQLite db, the secret key, the git workspaces and the
# Prometheus target file - everything that must outlive the container.
ENV DATA_DIR=/data \
    PROMETHEUS_TARGETS_DIR=/data/prometheus-targets
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/index.js"]
