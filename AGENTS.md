# Notes for coding agents

## MvL OS in short

MvL OS is a browser desktop (React + TypeScript, Vite) with a small Node server. README.md is the
documentation of record: when you change how something behaves, update its README section in the
same change.

**Where things live**
- `src/os/`: the shell (desktop, windows, dock, top bar, Spotlight, dialogs, notifications) and shared stores.
- `src/apps/`: the apps. They are registered in `APP_META` in `src/os/apps.tsx`.
- `src/terminal/`: the terminal and its shell (msh) and commands.
- `src/widgets/`: desktop widgets.
- `src/data/`: shared logic, some of it also imported by the server (see the Dockerfile rule below).
- `server/`: the Node server, run directly as TypeScript (`node server/index.ts`, no build step).
  - Only erasable syntax is allowed there (`erasableSyntaxOnly`): no enums, namespaces or parameter properties.
  - Imports need explicit `.ts` extensions.

**Conventions**
- **Settings that follow the account** across devices use `synced()` (`src/os/synced.ts`). Per-browser preferences use `localPref`/`flagPref` (`src/os/localPref.ts`).
- **Browser storage** can be blocked or empty, so code must keep working without it.
- **OS settings** live in `src/apps/Settings.tsx`. App settings go in its Apps group, with search keywords, and can also have their own panel in the app.
- **Colours** come from the Omarchy theme palettes via CSS variables. Never hard-code colours, so light and dark themes and accents keep working.
- **Touch and phones:** every feature must work with touch and on a phone-sized screen (see "Touch screens" in README.md). Use the existing helpers (`useIsMobile`, the coarse-pointer checks) rather than new detection.
- **Keyboard:** Alt+1…9 switches workspaces. Don't bind it in apps or games.
- **Games** also run on their own at `/play/<id>` (see `src/os/playMode.ts`), where the OS shell and its settings are absent. Anything a game needs must be reachable from the game itself.
- **Account-gated features:** some features belong to the signed-in owner or admins only (`user.admin` on the server). Keep checks server-side; the UI only hides things.

## Testing: proportional, not exhaustive

The repo has many checks (`pnpm check:*`) and a slow performance suite. Run what the change can break,
and run the heavy suites once, at the end, not after every edit.

**While iterating**
- `pnpm typecheck`, plus the one or two `check:*` scripts that cover the code you're touching
  (e.g. `check:empires-launch` for yard launches, `check:agents-roles` for agent roles).
- A narrow perf scene if you're changing rendering: `pnpm check:perf --only <scene>`.

**Once, before handing over or opening a PR**
- `pnpm typecheck` and `pnpm build`.
- The `check:*` scripts for the areas you changed. For Empires sim changes that includes
  `check:empires` (lockstep hash and sync).
- `pnpm check:perf` once, if the change touches rendering, the HUD, the galaxy map or the desktop.
  CI runs it again on every PR anyway.

**Only when the change calls for it**
- `check:empires-ws` / `check:empires-match` (need a running dev server): only for changes to the
  protocol, commands, the server referee or match config.
- `pnpm empires:tournament`: only for AI or balance changes. Use a few seeds; a large sweep only
  when win rates are the point of the change.
- Full measurement matrices (many viewports, both browsers, uncapped fps): only for dedicated
  performance work, not for features.
- `check:empires-panels` (needs a dev server): only when changing the build panel or unit card layout.
- `check:empires-gui-fit` (needs a dev server): only when changing where floating GUI goes (tooltips, popovers, panels, `fit.ts`).

Don't re-run a suite that already passed unless the code it covers changed since. If a heavy check
fails for a reason unrelated to the change, say so rather than rerunning it repeatedly.

## Dev servers and the dev proxy

- Run your own Vite dev server for browser checks: `DATA_DIR=<scratch dir> ./node_modules/.bin/vite --port <port> --strictPort`.
  - Use a port in **5170–5299** and a scratch `DATA_DIR`, never the real data.
  - One server per task. Stop it when you're done, and stop any helper servers you started.
- `pnpm dev:proxy` (`scripts/dev-proxy.ts`) listens on 127.0.0.1:5200. It lists every dev server on 5170–5299 at `http://localhost:5200/` and proxies to them, WebSockets included. Someone working remotely only has to tunnel that one port.
  - When you hand over a server, give the proxy link `http://<port>.localhost:5200/` (for example `http://5251.localhost:5200/play/empires`), not a bare port.
  - Start the proxy if nothing is listening on 5200.
  - Start servers from your git worktree, not a copied folder, so the dashboard shows the branch.
- Mute sound in every browser tab you test in, unless the test is about sound.

## Worktrees and other sessions

- Work in a git worktree. Symlink the main checkout's `node_modules` into it **before** running any pnpm command, so pnpm doesn't install a second copy.
- Several sessions may work in this repo at once. Never touch another session's worktree, branch, server or uncommitted changes.
  - Clean up only what you created, by name.
  - Keep the main checkout clean.
- **Extra work goes to a new session, not a subagent.** Work that edits code (a feature, a fix, a follow-up) is started as its own session, so the user can find it in the UI, see what it is doing, and talk to it.
  - Brief it fully: the task, the files or area, and what done looks like. Follow up with the session that has the context rather than starting another.
  - Its report comes back as a short note. Check the diff and results yourself before calling it done.
  - Quick reads and searches stay inline in the current session. Don't spawn a subagent or a session for them.

## Code rules worth knowing

- **Empires At War lockstep:**
  - The sim (`sim.ts`, `ai.ts`, `galaxy.ts` and what they call) must stay deterministic: no `Math.random`, no `Date`, no order-dependent iteration surprises. Use the sim's seeded RNG.
  - Player actions are orders through `commands.ts` and the protocol, validated by the server referee (`server/empires.ts`).
  - `check:empires` must report "in sync".
  - Saved battles and campaigns from earlier versions must keep loading: give new state safe defaults, and bump the save version where its pattern says to.
- **Server imports:** the Dockerfile copies only specific `src/` files into the server image. If server code starts importing another file from `src/`, add it to the Dockerfile `COPY` list. The CI `image` job boots the image and catches a missing one.
- **Dialogs:** never use `window.alert`, `confirm` or `prompt`. Use the OS's own dialogs.
- **Dev-only tools** (such as the Empires F9 cheat panel) go behind `import.meta.env.DEV`. Before merging, grep `dist/` to prove they aren't in the production build.

## Merging and releasing

- Before merging a PR, wait until all three CI checks have run and passed: `build`, `image` and `perf`. "No checks reported" means they haven't started yet; it's not a pass.
- Releases are GitHub releases named `MvL OS X.Y.Z`. Other sessions release too, so work out the next version from the latest release at the moment you create yours.
- Release notes are written for players and users, not developers.
- A release goes live within minutes.

## Performance

Read "Performance guardrails" in README.md before changing rendering. Use `check:perf --update`
only for intended changes, and only for the scenes you changed.

## Privacy

This repo is public. Never commit logs, traces, screenshots of real data, hostnames, hardware or
system info. Research output stays outside the repo.
