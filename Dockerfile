# syntax=docker/dockerfile:1

# Build the static site. public/*.json is whatever the build context has: the committed
# snapshot locally, or a fresh one when the release workflow runs `pnpm data` first.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# The release workflow passes these; the system menu and /api/version show them.
ARG APP_VERSION=""
ARG APP_COMMIT=""
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
RUN pnpm build

# Serve it with the small dependency-free Node server, which also pings the Minecraft server
# live for /api/minecraft.
FROM node:24-alpine
ARG APP_VERSION=""
ARG APP_COMMIT=""
WORKDIR /app
ENV NODE_ENV=production PORT=8080 APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/data/normalize.ts src/data/code.ts ./src/data/
# Sign-in sessions, linked instances and synced notes live here (a volume in compose.yml).
RUN mkdir -p /app/data && chown node:node /app/data
ENV DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.ts"]
