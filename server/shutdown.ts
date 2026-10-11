// What the server does on the way down. A deploy restarts the site: Docker sends SIGTERM and waits
// about 10 seconds before it kills the process. Each part that keeps something in memory (Empires
// battles, Agents turns) adds a hook here, and one handler runs them all, in the order they were
// added, before the process exits. Hooks are synchronous: there is no time to wait for anything.

const hooks: { name: string; run: () => void }[] = []
let installed = false
let done = false

/** Runs `run` once on SIGTERM or SIGINT, before the process exits. */
export function onShutdown(name: string, run: () => void) {
  hooks.push({ name, run })
  if (installed) return
  installed = true
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.once(sig, () => {
      shuttingDown()
      // Vite's dev server has its own handler, which closes and exits; on our own, exit once the
      // last words (close frames, the end of streams) have had a moment to go out.
      if (!process.listenerCount(sig)) setTimeout(() => process.exit(0), 300)
    })
}

/** Runs every hook now (once): what the signal handler does. */
export function shuttingDown() {
  if (done) return
  done = true
  for (const h of hooks) {
    try {
      h.run()
    } catch (e) {
      console.error(`[${h.name}] shutting down:`, (e as Error).message)
    }
  }
}

/** Whether the server is on its way down: nothing new should start. */
export const isShuttingDown = () => done
