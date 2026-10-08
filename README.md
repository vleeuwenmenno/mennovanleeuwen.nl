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

`pepper` ([`src/terminal/pepper.ts`](src/terminal/pepper.ts)) simulates the Pepper CLI against a
pretend lab cluster (3 masters, 4 minions). Its grammar, outcome names and output layout follow
the real CLI; the cluster, states and timings are invented, and applies only last for the session.

Pressing P during the boot log lets the boot finish but stops short of the desktop, logging in
on a text console on "tty1" instead (the same shell, without a window manager); `exit` starts the
desktop. `reboot` and `shutdown` play the systemd
shutdown log ([`src/os/Power.tsx`](src/os/Power.tsx)); a reboot starts from the opening layout again.

## Releases and hosting

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) typechecks and builds every push to
`main` and every pull request.

Publishing a GitHub release with a semver tag (`v1.2.3`) runs
[`.github/workflows/release.yml`](.github/workflows/release.yml): it refreshes the activity
snapshot, builds the site, and pushes a multi-arch (amd64 + arm64) nginx image to
`ghcr.io/vleeuwenmenno/mennovanleeuwen.nl` tagged `1.2.3`, `1.2`, `1` and `latest`. Prereleases
skip `latest`.

Run it on a server:

```yaml
# compose.yml
services:
  site:
    image: ghcr.io/vleeuwenmenno/mennovanleeuwen.nl:latest
    restart: unless-stopped
    ports:
      - "8080:80"
```

The container serves on port 80 and answers `/healthz`. Build it locally with
`docker build -t mvlos .`.
