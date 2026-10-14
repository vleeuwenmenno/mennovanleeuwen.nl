# Notes for coding agents

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

Don't re-run a suite that already passed unless the code it covers changed since. If a heavy check
fails for a reason unrelated to the change, say so rather than rerunning it repeatedly.

## Performance

Read "Performance guardrails" in README.md before changing rendering. Use `check:perf --update`
only for intended changes, and only for the scenes you changed.

## Privacy

This repo is public. Never commit logs, traces, screenshots of real data, hostnames, hardware or
system info. Research output stays outside the repo.
