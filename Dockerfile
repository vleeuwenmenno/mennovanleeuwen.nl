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
COPY src/data/normalize.ts src/data/code.ts src/data/zip.ts src/data/tar.ts src/data/archive.ts src/data/agentsPrompt.ts src/data/notifySources.ts src/data/gitTypes.ts ./src/data/
# Empires At War multiplayer: names and messages now, the battle itself for refereeing matches.
COPY src/apps/games/empires ./src/apps/games/empires
# Games by their direct link (/play/<game>): the game list, for each page's title and link preview.
COPY src/apps/games/catalog.ts ./src/apps/games/
# The agents: the shell's parser (to tell read-only command lines apart) and its reference (the msh skill).
COPY src/data/mshReference.ts ./src/data/
COPY src/terminal/msh/parse.ts ./src/terminal/msh/
# Tasks: its settings, which the server's reminders read.
COPY src/data/taskPrefs.ts ./src/data/
# Mail: the remote-content rules (mode and allowed senders), which the server applies.
COPY src/data/mailRemote.ts ./src/data/
# Agents shared links (/s/<token>): the Markdown parser and code colours, to render the page.
COPY src/data/markdown/parse.ts src/data/markdown/highlight.ts ./src/data/markdown/
# Notes linked to calendar events: how a link is kept, and the meeting note's template.
COPY src/data/noteEvents.ts ./src/data/
# Sign-in sessions, linked instances and synced notes live here (a volume in compose.yml).
RUN mkdir -p /app/data && chown node:node /app/data
ENV DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.ts"]
