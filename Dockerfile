# syntax=docker/dockerfile:1

# Build the static site. public/*.json is whatever the build context has: the committed
# snapshot locally, or a fresh one when the release workflow runs `pnpm data` first.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Serve it with the small dependency-free Node server, which also pings the Minecraft server
# live for /api/minecraft.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/data/normalize.ts ./src/data/normalize.ts
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.ts"]
