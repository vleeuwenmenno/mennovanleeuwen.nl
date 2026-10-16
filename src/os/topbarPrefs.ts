import { cvMode } from './cvMode'
import { synced } from './synced'

// What the top bar shows and in which order. Follows the account when signed in (synced), else
// this browser only (localStorage through the same store). Locked by default: unlock from the
// bar's right-click menu to reorder (drag) and show or hide widgets.

export const TOPBAR_IDS = ['menu', 'workspaces', 'clock', 'search', 'activity', 'minecraft', 'theme', 'notifications'] as const
export type TopbarId = (typeof TOPBAR_IDS)[number]
/** A flexible gap between clusters (keeps the clock centred in the default layout). */
export type TopbarSlot = TopbarId | 'spacer'

export type TopbarPrefs = {
  /** Left-to-right slots, including spacers. Hidden widgets stay in the list but are not drawn. */
  order: TopbarSlot[]
  /** Widgets turned off. Empty together with the default order means "use page defaults". */
  hidden: TopbarId[]
  /** When false, dragging reorders and the menu offers show/hide. */
  locked: boolean
}

export const TOPBAR_LABELS: Record<TopbarId, string> = {
  menu: 'MvL OS menu',
  workspaces: 'Workspaces',
  clock: 'Time and date',
  search: 'Search',
  activity: 'Activity',
  minecraft: 'Minecraft',
  theme: 'Theme',
  notifications: 'Notifications',
}

/** Default layout: menu + workspaces | clock | search, activity, minecraft, theme, notifications. */
export const DEFAULT_ORDER: TopbarSlot[] = [
  'menu',
  'workspaces',
  'spacer',
  'clock',
  'spacer',
  'search',
  'activity',
  'minecraft',
  'theme',
  'notifications',
]

const ALL = new Set<string>(TOPBAR_IDS)

function isId(s: string): s is TopbarId {
  return ALL.has(s)
}

function normalizeOrder(v: unknown): TopbarSlot[] {
  if (!Array.isArray(v)) return [...DEFAULT_ORDER]
  const out: TopbarSlot[] = []
  for (const x of v) {
    if (x === 'spacer') out.push('spacer')
    else if (typeof x === 'string' && isId(x) && !out.includes(x)) out.push(x)
  }
  for (const id of TOPBAR_IDS) if (!out.includes(id)) out.push(id)
  if (!out.includes('spacer')) {
    const clock = out.indexOf('clock')
    if (clock >= 0) {
      out.splice(clock, 0, 'spacer')
      out.splice(clock + 2, 0, 'spacer')
    } else out.splice(Math.min(2, out.length), 0, 'spacer')
  }
  return out
}

function normalize(v: unknown): TopbarPrefs {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { order: [...DEFAULT_ORDER], hidden: [], locked: true }
  }
  const o = v as Partial<TopbarPrefs>
  const hidden = Array.isArray(o.hidden) ? o.hidden.filter((x): x is TopbarId => typeof x === 'string' && isId(x)) : []
  return {
    order: normalizeOrder(o.order),
    hidden: [...new Set(hidden)],
    locked: o.locked !== false,
  }
}

const store = synced<TopbarPrefs>('topbar', { order: [...DEFAULT_ORDER], hidden: [], locked: true }, { normalize })

export const useTopbarPrefs = store.use
export const topbarPrefs = store.get
export const setTopbarPrefs = (patch: Partial<TopbarPrefs> | ((p: TopbarPrefs) => TopbarPrefs)) =>
  store.set((p) => (typeof patch === 'function' ? patch(p) : { ...p, ...patch }))

/** Minecraft is off on /cv by default and on elsewhere (swapped from the old CV-only rule). */
export const defaultHidden = (id: TopbarId): boolean => id === 'minecraft' && cvMode()

/** Still on the stock layout with no show/hide edits: page defaults apply for minecraft. */
export const isPristineTopbar = (p: TopbarPrefs = store.get()) =>
  p.locked && p.hidden.length === 0 && p.order.join() === DEFAULT_ORDER.join()

/** Effective hidden set: page defaults while pristine, otherwise the saved list. */
export function hiddenSet(prefs: TopbarPrefs = store.get()): Set<TopbarId> {
  if (isPristineTopbar(prefs)) return new Set(TOPBAR_IDS.filter(defaultHidden))
  return new Set(prefs.hidden)
}

export const isTopbarHidden = (id: TopbarId, prefs: TopbarPrefs = store.get()) => hiddenSet(prefs).has(id)

/** Visible slots left to right (spacers kept; hidden widgets dropped). */
export function resolveTopbar(prefs: TopbarPrefs = store.get()): TopbarSlot[] {
  const hide = hiddenSet(prefs)
  return prefs.order.filter((s) => s === 'spacer' || !hide.has(s))
}

/** Freeze page defaults into `hidden` so /cv and / keep the same choice after the first edit. */
function withDefaultsBaked(p: TopbarPrefs): TopbarPrefs {
  if (p.hidden.length > 0 || p.order.join() !== DEFAULT_ORDER.join()) return p
  return { ...p, hidden: TOPBAR_IDS.filter(defaultHidden) }
}

export function setTopbarLocked(locked: boolean) {
  setTopbarPrefs((p) => ({ ...withDefaultsBaked(p), locked }))
}

export function setTopbarOrder(order: TopbarSlot[]) {
  setTopbarPrefs((p) => ({ ...withDefaultsBaked(p), order: normalizeOrder(order) }))
}

export function toggleTopbarWidget(id: TopbarId) {
  setTopbarPrefs((p) => {
    const next = withDefaultsBaked(p)
    const hide = new Set(next.hidden)
    if (hide.has(id)) hide.delete(id)
    else hide.add(id)
    return { ...next, hidden: [...hide] }
  })
}

export const resetTopbar = () => store.set({ order: [...DEFAULT_ORDER], hidden: [], locked: true })
export const isDefaultTopbar = () => isPristineTopbar()
