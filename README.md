# mennovanleeuwen.nl

My CV as a tiny operating system: a sticky note, a terminal that actually works, and a dock
with apps for projects, contributions, recent activity, the CV itself and contact details.

Built with Vite, React and TypeScript. No backend; everything runs in the browser.

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

`pepper` ([`src/terminal/pepper.ts`](src/terminal/pepper.ts)) simulates the Pepper CLI against a
pretend lab cluster (3 masters, 4 minions). Its grammar, outcome names and output layout follow
the real CLI; the cluster, states and timings are invented, and applies only last for the session.

Pressing P during the boot log lets the boot finish but stops short of the desktop, logging in
on a text console on "tty1" instead (the same shell, without a window manager); `exit` starts the
desktop. `reboot` and `shutdown` play the systemd
shutdown log ([`src/os/Power.tsx`](src/os/Power.tsx)); a reboot starts from the opening layout again.

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
the released image, `docker compose up -d --build` builds this checkout instead. For working on it in
Docker, `docker compose --profile dev up dev` runs the Vite dev server on the mounted checkout
(every save shows up instantly, on `DEV_PORT`, default 5173), and `docker compose watch` keeps a
production build that rebuilds whenever a source file changes. Put
`GITHUB_TOKEN=...` in a `.env` next to it (git-ignored) to give `git log` GitHub's signed-in rate
limit; a fine-grained token with read-only access to public repositories is enough. `PORT=...` in the
same file changes the host port (default 8080).

The container runs [`server/index.ts`](server/index.ts), a dependency-free Node server, as a
non-root user on port 8080 (`PORT` changes it). It serves the built site, answers `/healthz`, serves
`/api/activity` (git.mvl.sh's activity feeds, which browsers can't read cross-origin), 
`/api/git/<owner>/<repo>/commits` (for `git log`, cached; set `GITHUB_TOKEN` to lift GitHub's
anonymous limit of 60 requests an hour), and `/api/minecraft`: a live Server List Ping of the Minecraft server, cached for 10 seconds,
so the status and join/leave notifications don't wait on public status APIs that cache for
minutes. On a static host without that endpoint the site falls back to those APIs. `pnpm dev`
and `pnpm preview` serve the endpoint too. Build the image locally with `docker build -t mvlos .`.
