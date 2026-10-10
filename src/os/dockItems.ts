import { addLauncher, getLaunchers, useLaunchers } from '../data/launchers'
import { signedIn, useAccount } from './account'
import { synced } from './synced'
import type { AppId } from './wm'

// What the dock shows between "All apps" and Trash: apps and your own launchers
// ("launcher:<id>"), in your order. Everyone can reorder; signed in, you can also take things
// off the dock and pin others (apps, launchers, repositories from Spotlight) on.
//
// Stored as an order plus the default apps you removed, so apps added to the default dock in a
// later release still show up. null is the default dock.

export type DockId = AppId | `launcher:${string}`

export const DEFAULT_DOCK: AppId[] = ['terminal', 'files', 'zed', 'projects', 'recents', 'cv', 'games', 'notes', 'notebook', 'contact']

/** Apps that can sit on the dock: not Trash (always last), not windows that need a file or note. */
const DOCKABLE = new Set<AppId>([...DEFAULT_DOCK, 'keys', 'settings', 'calendar', 'agents', 'preview', 'player', 'amp', 'newdoc', 'newsheet', 'newslides'])

type DockState = { order: DockId[]; removed: AppId[] } | null

function normalize(v: unknown): DockState {
  // Before launchers could be pinned this was just an order of apps; [] meant the default.
  if (Array.isArray(v)) return v.length ? { order: v as DockId[], removed: [] } : null
  if (v && typeof v === 'object' && Array.isArray((v as { order?: unknown }).order)) {
    const s = v as { order: DockId[]; removed?: AppId[] }
    return { order: s.order, removed: Array.isArray(s.removed) ? s.removed : [] }
  }
  return null
}

const store = synced<DockState>('dock', null, { legacyKey: 'mvlos.dock.v1', normalize })

export const isLauncherId = (id: string): id is `launcher:${string}` => id.startsWith('launcher:')
export const launcherDockId = (launcherId: string): DockId => `launcher:${launcherId}`

/** The dock's items right now: your order (minus anything gone), then default apps you kept. */
export function resolveDock(state: DockState = store.get(), launchers = getLaunchers()): DockId[] {
  const valid = (id: DockId) => (isLauncherId(id) ? launchers.some((l) => `launcher:${l.id}` === id) : DOCKABLE.has(id))
  const order = [...new Set(state?.order ?? [])].filter(valid)
  const removed = new Set(state?.removed ?? [])
  return [...order, ...DEFAULT_DOCK.filter((a) => !order.includes(a) && !removed.has(a))]
}

export function useDock(): DockId[] {
  const state = store.use()
  const launchers = useLaunchers()
  return resolveDock(state, launchers)
}

/** Whether pinning and removing is allowed (signed in); reordering always is. */
export const useCanCustomizeDock = () => useAccount().status === 'user'

export const onDockRemote = store.onRemote

export function setDockOrder(order: DockId[]) {
  const current = store.get()
  const next = { order, removed: current?.removed ?? [] }
  store.set(next.order.join() === resolveDock(null).join() && !next.removed.length ? null : next)
}

export const isPinned = (id: DockId) => resolveDock().includes(id)

export function pinToDock(id: DockId) {
  if (!signedIn()) return
  const current = resolveDock()
  const state = store.get()
  const removed = (state?.removed ?? []).filter((a) => a !== id)
  store.set({ order: current.includes(id) ? current : [...current, id], removed })
}

export function unpinFromDock(id: DockId) {
  if (!signedIn()) return
  const state = store.get()
  const removed = !isLauncherId(id) && DEFAULT_DOCK.includes(id) ? [...new Set([...(state?.removed ?? []), id])] : (state?.removed ?? [])
  store.set({ order: resolveDock().filter((x) => x !== id), removed })
}

/** Back to the default dock: default apps in the default order, no launchers. */
export const resetDock = () => store.set(null)
export const isDefaultDock = () => store.get() === null

/** Apps that could be pinned but aren't, for Settings' "add back" list. */
export const unpinnedApps = (dock: DockId[]) => [...DOCKABLE].filter((a) => !dock.includes(a))

/** Pins a web address (e.g. a repository from Spotlight) as a launcher on the dock, reusing an
 * existing launcher for the same address. */
export function pinLink(label: string, url: string) {
  if (!signedIn()) return
  const existing = getLaunchers().find((l) => l.url === url)
  const id = existing?.id ?? addLauncher({ label: label.slice(0, 40), url, desktop: false }).id
  pinToDock(launcherDockId(id))
}

/** The dock entry for a launcher with this address, if there is one. */
export const linkDockId = (url: string): DockId | null => {
  const l = getLaunchers().find((x) => x.url === url)
  return l ? launcherDockId(l.id) : null
}

export const isDockableApp = (app: AppId) => DOCKABLE.has(app)
