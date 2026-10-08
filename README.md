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
