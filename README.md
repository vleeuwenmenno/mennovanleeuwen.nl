# mennovanleeuwen.nl

My CV as a tiny operating system: a sticky note, a terminal that actually works, and a dock
with apps for projects, contributions, recent activity, the CV itself and contact details.

Built with Vite, React and TypeScript. The CV runs entirely in the browser; a small dependency-free
Node server adds live status, GitHub sign-in for the owner and synced notes (see below).

## Develop

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm typecheck
pnpm build        # static site in dist/
```

## Look and themes

The design follows Omarchy: square windows with a 2px accent border on the active one, a solid
bar, one monospace face, and colours from Omarchy's own theme palettes
([`src/os/omarchyThemes.ts`](src/os/omarchyThemes.ts), generated from
`/usr/share/omarchy/themes/*/colors.toml`). Day is Flexoki Light, night is Tokyo Night, and
"auto" follows the OS. The sun/moon button in the bar toggles; right-click it (or the desktop)
for every Omarchy theme and accent overrides. `theme list` / `theme <name>` in the terminal too.

## Editing content

Everything the site says lives in [`src/data/profile.ts`](src/data/profile.ts): headlines on the
sticky note, projects, contributions, skills and experience. The terminal's filesystem
(`~/cv.md`, `~/projects/*/README.md`, ...) is generated from the same file.

## Data snapshots

`pnpm data` (`scripts/fetch-data.ts`) writes two files the site reads at runtime:

- `public/recents.json`: recent activity. The Activity app and `recent` merge it with the live
  GitHub events API (fetched from the browser, cached in `sessionStorage` for 10 minutes).
  Pepper's activity on git.mvl.sh only arrives this way, because Forgejo sends no CORS headers.
- `public/contributions.json`: a year of daily contributions for the graph in the Activity app
  and `heatmap`. GitHub's count comes from its contribution calendar; git.mvl.sh's is counted
  from the activity feed (commits, repos, releases, PRs, issues) because Forgejo's own heatmap
  also counts mirror syncs of GitHub repos, which would double count.

Refresh both before each deploy (`pnpm build:full` does it), or on a schedule in CI. Set
`GITHUB_TOKEN` there to avoid the anonymous API rate limit.

Live from the browser: GitHub events and stars, DNS lookups (Cloudflare DNS-over-HTTPS) and the
Minecraft server status for cloud.mvl.sh (mcstatus.io).

## Terminal

Commands live in [`src/terminal/commands.ts`](src/terminal/commands.ts). The filesystem is
read-only and in memory; only `/tmp` accepts writes (`echo hi > /tmp/x`), and those vanish on
reload. Pipes, `;`, `&&`, `$VARS`, tab completion and history all work. `ps` and `kill` operate
on the open windows.

Real tools live in [`src/terminal/extra.ts`](src/terminal/extra.ts) and run from the visitor's
browser: `curl`/`wget` (any site that allows cross-origin requests, e.g. `curl wttr.in/Amsterdam`,
never the visitor's own network), `whois` (RDAP), `git log`/`git show` on the real repos,
`htop`, `watch`, `cmatrix`, `df`/`free`/`nproc`/`lscpu`/`xrandr`/`ip` with the numbers the browser
shares, `jq`, `sha*sum`/`md5sum`, `figlet` and `lolcat`.

`go <alias>` follows a link through the visitor's own [golinks](https://git.mvl.sh/vleeuwenmenno/golinks)
account (by default on https://mvl.sh). `go set <search url>` saves the account once: the
`…/r/%s?token=…` URL golinks shows after creating a token (a redirect URL for any alias, a site plus
a token, or a bare mvl.sh token work too). It is kept in localStorage, and synced like notes when
signed in ([`src/data/golinks.ts`](src/data/golinks.ts)). `go` alone shows the account, `go unset`
forgets it.

`pepper` ([`src/terminal/pepper.ts`](src/terminal/pepper.ts)) simulates the Pepper CLI against a
pretend lab cluster (3 masters, 4 minions). Its grammar, outcome names and output layout follow
the real CLI; the cluster, states and timings are invented, and applies only last for the session.

Pressing P during the boot log lets the boot finish but stops short of the desktop, logging in
on a text console on "tty1" instead (the same shell, without a window manager); `exit` starts the
desktop. `/?newtab` is for using the site as a browser home or new tab page: it skips the boot log, closes
the terminals the last tab left open, and starts with one fresh terminal in front of the rest of the
saved desk. `reboot` and `shutdown` play the systemd
shutdown log ([`src/os/Power.tsx`](src/os/Power.tsx)); a reboot starts from the opening layout again.

## Notes, launchers and sign-in (home page mode)

Anyone can write notes and add launchers: **Notebook** (dock) lists every note in Markdown, and
each one can sit on the desktop as a sticky (right-click the desktop → *New sticky note*). Stickies
get a random tilt and colour, both changeable from the sticky's hover bar or menu. **Settings**
(system menu) adds desktop launchers: a URL, a name and an optional emoji (otherwise the site's own
favicon). Notes, launchers, desktop icons, the dock order and the open windows are kept per browser
in localStorage ([`src/os/synced.ts`](src/os/synced.ts)), with one window layout for phones and one
for bigger screens.

Signing in with GitHub (system menu → *Sign in with GitHub*) syncs all of that through the server
and turns Spotlight into a code search over GitHub and any linked Gitea/Forgejo instances
([`server/search.ts`](server/search.ts)):

| Query | Finds |
|-------|-------|
| `bolt` | your repositories (and from three letters, issues and PRs) |
| `#123` | issue or PR 123 in the repos you pushed to last |
| `repo#123`, `owner/repo#123` | that issue or PR, also outside your own repos |
| `#text`, `repo#text`, `repo#` | issues and PRs matching text (half-typed words too), or a repo's open ones |
| `repo@text`, `@text` | branches, with their last commit and pull request |

Tab completes the highlighted result (`owner/repo`, then type `#` or `@`); Ctrl+Enter copies a
clone command, link or branch name.

Signed in, the dock is yours too ([`src/os/dockItems.ts`](src/os/dockItems.ts)): right-click a
dock icon to remove it, and right-click (or Shift+Enter) an app, launcher or repository in
Spotlight or All apps to pin it. Settings → Dock lists what was taken off, to add it back, and
restores the default dock. Everyone can still drag dock icons to reorder them.

Only GitHub logins in `ALLOWED_USERS` (default `vleeuwenmenno`) can sign in; everyone else keeps
the CV. Gitea/Forgejo instances are linked in Settings with a personal access token (read access to
repository, issue, user and organization). Tokens are stored encrypted (AES-256-GCM) in SQLite
(`node:sqlite`, no extra dependency) under `DATA_DIR` (default `./data`, a volume in compose).

Setup:

1. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps) with callback
   URL `https://<your site>/api/auth/github/callback`. Local dev needs its own app with
   `http://localhost:5173/api/auth/github/callback`.
2. Put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`. Optional: `ALLOWED_USERS`
   (comma-separated logins), `PUBLIC_URL` (when the reverse proxy doesn't send `Host` and
   `X-Forwarded-Proto`), `SESSION_SECRET` (otherwise a random key is generated once into
   `DATA_DIR/secret.key`), `GITHUB_SCOPES` (default `read:user repo read:org`; `repo` is what
   lets Spotlight see private repositories).

Without the OAuth settings, sign-in is simply off and everything else works as before.

**Google Calendar** attaches to the GitHub sign-in (system menu or Settings → Calendar) for the
Agenda widget: read-only access to your calendars, shared ones included, with Google's refresh
token stored encrypted next to the Gitea tokens ([`server/google.ts`](server/google.ts)). It needs
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google Cloud OAuth client (type *Web
application*) with the Calendar API enabled, the scope `calendar.readonly` (plus `openid` and
`email`), and the redirect URI `https://<your site>/api/google/callback` (and
`http://localhost:5173/api/google/callback` for development). Publish the consent screen to *In
production*: in *Testing*, Google expires the access after seven days.

The **Code inbox** widget lists pull requests waiting for your review, your own open pull requests
and issues assigned to you, on GitHub and linked Gitea/Forgejo instances
([`server/inbox.ts`](server/inbox.ts)), with the access sign-in and linking already give.

## Widgets

Widgets sit on the desktop like sticky notes: no title bar, tape on top, a sway when dragged, a
right-click menu. Add them from the desktop's menu (*Add widget*), All apps → Widgets or Spotlight.
Today there are four: **Sticky note** (one of your notes, with checklists you can tick),
**Weather** (now, the next hours and three days from [Open-Meteo](https://open-meteo.com), for the
browser's location or a city you pick; your pick syncs, the browser's location stays on that
device), **Agenda** (Google Calendar, see below) and **Code inbox**.

The framework lives in [`src/widgets`](src/widgets). A widget is one `WidgetDef`
([`types.ts`](src/widgets/types.ts)): a name, a glyph, a size, its component, and optional hooks
for its frame colours and tilt (`useFrame`), its own menu items (`useMenu`) and how a new one is
made (`create`). List it in [`registry.tsx`](src/widgets/registry.tsx) and it gets the frame,
dragging, the menus and an *Add widget* entry everywhere. Per-widget settings go through
[`config.ts`](src/widgets/config.ts) (`useWidgetConfig` / `setWidgetConfig`), which syncs like
notes; where a widget sits is part of the synced window layout.

## Installable app

The site is a PWA: [`public/manifest.webmanifest`](public/manifest.webmanifest) makes it
installable (full-window, with Terminal/CV/Games shortcuts on the icon), and a service worker
built from [`pwa/sw.js`](pwa/sw.js) caches the app shell so it boots offline. The build stamps the
worker with this release's files, so installed copies show an "update" notification after a
release; clicking it restarts into the new version. Live data (`/api/*`, other sites) is never
cached. The worker only registers in production builds; `.claude/launch.json` has a `prod`
configuration that builds and serves one on port 4180.

## Releases and hosting

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) typechecks and builds every push to
`main` and every pull request.

Publishing a GitHub release with a semver tag (`v1.2.3`) runs
[`.github/workflows/release.yml`](.github/workflows/release.yml): it refreshes the activity
snapshot, builds the site, and pushes a multi-arch (amd64 + arm64) image to
`ghcr.io/vleeuwenmenno/mennovanleeuwen.nl` tagged `1.2.3`, `1.2`, `1` and `latest`. Prereleases
skip `latest`.

Run it with [`compose.yml`](compose.yml), on a server or locally: `docker compose up -d` pulls
the released image, `docker compose up -d --build` builds this checkout instead. For working on the site,
use `pnpm dev`: it reloads instantly and serves the live `/api` endpoints too. Put
`GITHUB_TOKEN=...` in a `.env` next to it (git-ignored) to give `git log` GitHub's signed-in rate
limit; a fine-grained token with read-only access to public repositories is enough. `PORT=...` in the
same file changes the host port (default 8080).

The container runs [`server/index.ts`](server/index.ts), a dependency-free Node server, as a
non-root user on port 8080 (`PORT` changes it). Its API routes live in
[`server/api.ts`](server/api.ts), shared with `pnpm dev`. It serves the built site, answers `/healthz`, serves
`/api/activity` (git.mvl.sh's activity feeds, which browsers can't read cross-origin), 
`/api/git/<owner>/<repo>/commits` (for `git log`, cached; set `GITHUB_TOKEN` to lift GitHub's
anonymous limit of 60 requests an hour), and `/api/minecraft`: a live Server List Ping of the Minecraft server, cached for 10 seconds,
so the status and join/leave notifications don't wait on public status APIs that cache for
minutes. On a static host without that endpoint the site falls back to those APIs. `pnpm dev`
and `pnpm preview` serve the endpoint too. Build the image locally with `docker build -t mvlos .`.

While it runs, the server also pings the Minecraft server every 30 seconds
([`server/minecraft.ts`](server/minecraft.ts)) and keeps 30 days of it in SQLite under `DATA_DIR`: online or
not, the player count, the ping time, and each player's visits (from the names the ping lists).
`/api/minecraft/overview?range=24h|7d|30d` turns that into the **Minecraft server** window: uptime,
players over time with the server's availability underneath, who is on and since when, recent
visits and who played most. Open it from Spotlight (Enter on the Minecraft entry), the
*Overview* button in the top bar's Minecraft popup, or `open mcserver`. `MC_WATCH=off` stops the
pinger; the window then shows the live status only.
