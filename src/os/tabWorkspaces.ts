import { useSyncExternalStore } from 'react'
import { jsonPref } from './localPref'

// One workspace per tab: every open tab of MvL OS in this browser has a workspace of its own,
// as every monitor has in Hyprland. The windows are still one synced layout (os/wm.tsx), so a
// window moved to another tab's workspace shows up in that tab.
//
// A tab owns its workspace by holding a Web Lock named after it (mvlos.ws.<n>) for as long as it
// is open. The browser lets go of it when the tab closes or crashes, so `navigator.locks.query()`
// is always right about which workspaces other tabs have; nothing has to be cleaned up after a
// tab that went away without saying so. A workspace with windows on it but no tab is left behind
// by a tab that closed, and the next tab to open can adopt it.
//
// Which workspace a tab has is kept in sessionStorage, which is the tab's own and survives a
// reload, so a reload comes back to the same workspace. Other devices are not involved: locks
// are per browser, like the workspace on screen always was.

export type TabWorkspacePrefs = {
  /** Every tab its own workspace. Off: every tab shows the same one, as before. */
  perTab: boolean
  /** A new tab takes over a workspace a closed tab left windows on. */
  adopt: boolean
  /** …also when it is the browser's new tab page (/?newtab), where every Ctrl+T would take one. */
  adoptNewTab: boolean
}

/** Settings → Windows. This browser's tabs, so kept in this browser and not synced. */
export const tabWorkspacePrefs = jsonPref<TabWorkspacePrefs>('mvlos.tabWorkspaces', { perTab: true, adopt: true, adoptNewTab: false })

/** Without Web Locks a tab cannot tell whether another one is still open: every tab shares, as before. */
export const tabWorkspacesSupported = typeof navigator !== 'undefined' && !!navigator.locks

/**
 * `off`: not in use (turned off, a phone, no Web Locks). `claiming`: looking for a workspace.
 * `own`: this tab has `mine`. `shared`: every workspace has a tab already, so this one shares
 * them the way every tab did before.
 */
export type TabWorkspaces = { status: 'off' | 'claiming' | 'own' | 'shared'; mine: number | null; /** Workspaces other tabs have, while this one has its own. */ others: number[] }

const LOCK = 'mvlos.ws.'
const SESSION_KEY = 'mvlos.tabWorkspace'

let snap: TabWorkspaces = { status: 'off', mine: null, others: [] }
const listeners = new Set<() => void>()
const set = (patch: Partial<TabWorkspaces>) => {
  snap = { ...snap, ...patch }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
export const tabWorkspaces = () => snap
export const useTabWorkspaces = () => useSyncExternalStore(subscribe, tabWorkspaces)

/** The lock this tab holds, and how to let go of it. */
let held: { n: number; release: () => void } | null = null
/** Bumped by every start and stop, so a claim still under way when the feature goes off drops what it gets. */
let run = 0
let cancel = new AbortController()

// Tabs tell each other when they take or leave a workspace, so the others' bars mark it at once.
// A tab that closes cannot say so; the lock watchers below notice that instead.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mvlos.tabs') : null
if (channel) channel.onmessage = () => void refresh()
const announce = () => channel?.postMessage('changed')
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refresh())

/** The workspace this tab had before a reload (or that a duplicated tab copied), if any. */
export function rememberedWorkspace(): number | null {
  try {
    const n = Number(sessionStorage.getItem(SESSION_KEY))
    return Number.isInteger(n) && n >= 1 ? n : null
  } catch {
    return null
  }
}
function remember(n: number | null) {
  try {
    if (n === null) sessionStorage.removeItem(SESSION_KEY)
    else sessionStorage.setItem(SESSION_KEY, String(n))
  } catch {
    /* not kept: a reload looks for a workspace again */
  }
}

/**
 * Takes workspace n's lock and keeps it until the returned function is called; null when another
 * tab has it. `wait` (ms) waits for it to come free, for a reload: the page before it lets go of
 * its lock only as it unloads, which can be after this one asks.
 */
function hold(n: number, wait = 0): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    let release = () => {}
    const kept = new Promise<void>((r) => (release = r))
    const opts: LockOptions = wait ? { signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(wait)]) } : { ifAvailable: true }
    navigator.locks
      .request(LOCK + n, opts, (lock) => {
        if (!lock) return resolve(null)
        resolve(release)
        return kept
      })
      .catch(() => resolve(null))
  })
}

/** The workspaces some tab of this browser has (this one's included). */
async function taken(): Promise<Set<number>> {
  const q = await navigator.locks.query()
  // Only the owners' exclusive locks: a watcher's shared one is there for a moment only.
  return new Set((q.held ?? []).filter((l) => l.mode === 'exclusive' && l.name?.startsWith(LOCK)).map((l) => Number(l.name!.slice(LOCK.length))))
}

// Watchers: for each workspace another tab has, a shared request for its lock waits behind that
// tab's. It is granted (and let go of straight away) the moment the tab closes, crashed or not.
const watching = new Map<number, AbortController>()
function watch(n: number) {
  if (watching.has(n)) return
  const ctl = new AbortController()
  watching.set(n, ctl)
  navigator.locks.request(LOCK + n, { mode: 'shared', signal: ctl.signal }, () => {}).then(
    () => {
      watching.delete(n)
      void refresh()
    },
    () => watching.delete(n),
  )
}

/** Looks again at which workspaces the other tabs have. */
async function refresh() {
  if (snap.status !== 'own') return
  const r = run
  let all: Set<number>
  try {
    all = await taken()
  } catch {
    return
  }
  if (r !== run) return
  const others = [...all].filter((n) => Number.isInteger(n) && n !== held?.n).sort((a, b) => a - b)
  others.forEach(watch)
  if (others.join() !== snap.others.join()) set({ others })
}

export type ClaimOptions = {
  /** The workspace to have if it is free: the one from before a reload, or the one on screen. */
  prefer: number | null
  /** How long to wait for `prefer` (ms); see hold(). */
  wait: number
  /** Whether to take a left-behind workspace before an empty one. */
  adopt: boolean
  /** The workspaces with windows on them. */
  occupied: () => Set<number>
  count: number
  /** Told the outcome (null: shared) before anything following this store hears of it, so the
   * screen is on the new workspace by the time `mine` says it is this tab's. */
  onClaim: (n: number | null) => void
}

/**
 * Finds this tab a workspace: the preferred one if it is free, then (adopting) the lowest one with
 * windows but no tab, then the lowest empty one with no tab, then any without a tab. Null when
 * every workspace has a tab: the tab shares them. Does nothing when already started.
 */
export async function startTabWorkspaces(o: ClaimOptions) {
  if (snap.status !== 'off' || !tabWorkspacesSupported) return
  const r = ++run
  cancel = new AbortController()
  set({ status: 'claiming', mine: null, others: [] })
  const got = await claim(o, r)
  if (r !== run) return got?.release()
  o.onClaim(got?.n ?? null)
  if (!got) return set({ status: 'shared' })
  held = got
  remember(got.n)
  set({ status: 'own', mine: got.n })
  announce()
  void refresh()
}

async function claim(o: ClaimOptions, r: number): Promise<{ n: number; release: () => void } | null> {
  if (o.prefer !== null && o.prefer <= o.count) {
    const release = await hold(o.prefer, o.wait)
    if (release) return { n: o.prefer, release }
  }
  let all: Set<number>
  try {
    all = await taken()
  } catch {
    return null
  }
  const occupied = o.occupied()
  const free = Array.from({ length: o.count }, (_, i) => i + 1).filter((n) => !all.has(n))
  const left = free.filter((n) => occupied.has(n))
  const empty = free.filter((n) => !occupied.has(n))
  for (const n of o.adopt ? [...left, ...empty] : [...empty, ...left]) {
    if (r !== run) return null
    const release = await hold(n)
    if (release) return { n, release }
  }
  return null
}

/**
 * Moves this tab to workspace n: takes its lock, then lets go of the old one (so the old one is
 * free from then on, windows and all). False when another tab has n.
 */
export async function moveTabWorkspace(n: number): Promise<boolean> {
  if (snap.status !== 'own' || !held || held.n === n) return true
  const r = run
  const release = await hold(n)
  if (r !== run || !held) {
    release?.()
    return true
  }
  if (!release) {
    void refresh()
    return false
  }
  held.release()
  held = { n, release }
  remember(n)
  set({ mine: n })
  announce()
  void refresh()
  return true
}

/** Lets go of this tab's workspace and stops following the others: every tab shares again. */
export function stopTabWorkspaces() {
  if (snap.status === 'off') return
  run++
  cancel.abort()
  held?.release()
  held = null
  for (const c of watching.values()) c.abort()
  watching.clear()
  remember(null)
  set({ status: 'off', mine: null, others: [] })
  announce()
}
