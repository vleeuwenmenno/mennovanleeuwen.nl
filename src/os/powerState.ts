import { useSyncExternalStore } from 'react'

// The machine's power state. 'boot' prints the boot log (and may pause into a tty), 'up' is the
// desktop, 'down' prints the shutdown log, and 'off' is a black screen waiting for a key.

export type PowerPhase = 'boot' | 'up' | 'down' | 'off'
type State = { phase: PowerPhase; /** What 'down' leads to. */ then: 'boot' | 'off'; /** Bumped per boot, to restart it. */ run: number }

/** Loaded as the browser's home or new tab page (/?newtab): straight to a fresh terminal, no boot. */
export const newTab = typeof location !== 'undefined' && new URLSearchParams(location.search).has('newtab')

let state: State = {
  phase: newTab || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'up' : 'boot',
  then: 'boot',
  run: 0,
}
const listeners = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function usePower() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export const reboot = () => set({ phase: 'down', then: 'boot' })
export const shutdown = () => set({ phase: 'down', then: 'off' })
/** The shutdown log finished: power off, or start booting again. */
export const finishShutdown = () => set(state.then === 'off' ? { phase: 'off' } : { phase: 'boot', run: state.run + 1 })
export const powerOn = () => set({ phase: 'boot', run: state.run + 1 })
export const bootDone = () => set({ phase: 'up' })
