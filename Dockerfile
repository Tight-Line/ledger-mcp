# syntax=docker/dockerfile:1

# --- build -------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# git, because upstream is a git dependency pinned to a commit: npm clones it, installs its
# dev dependencies and runs its `prepare` (tsc) to produce the dist/ this server imports.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# npm records a GitHub dependency in the lockfile as git+ssh whatever package.json says, and
# a build has no SSH key. Rewritten to https, which needs none for a public repository.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src src
COPY test test
RUN npm run build && npm prune --omit=dev

# --- runtime -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist/src dist/src
# This repo's license and the notice for what it redistributes. Upstream's own LICENSE ships
# inside node_modules/@qboapi/qbo-mcp-server/, where npm puts it.
COPY package.json LICENSE NOTICE ./

# The token store lives on a volume mounted here; nothing else in the image is written to.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
CMD ["node", "dist/src/main.js"]
