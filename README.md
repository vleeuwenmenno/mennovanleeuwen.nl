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

## Recent activity

The Activity app and the `recent` command merge two sources:

- **Live**: the GitHub events and releases APIs, fetched from the browser (CORS allowed,
  60 requests/hour per visitor, cached in `sessionStorage` for 10 minutes).
- **Snapshot**: `public/recents.json`, written by `pnpm recents`. This is the only way
  Pepper's activity on git.mvl.sh gets in, because Forgejo does not send CORS headers.

Refresh the snapshot before each deploy (`pnpm build:full` does both), or on a schedule in CI.
Set `GITHUB_TOKEN` there to avoid the anonymous rate limit.

## Terminal

Commands live in [`src/terminal/commands.ts`](src/terminal/commands.ts). The filesystem is
read-only and in memory; only `/tmp` accepts writes (`echo hi > /tmp/x`), and those vanish on
reload. Pipes, `;`, `&&`, `$VARS`, tab completion and history all work. `ps` and `kill` operate
on the open windows.
