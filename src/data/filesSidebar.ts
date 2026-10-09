import { synced } from '../os/synced'
import { HOME } from '../terminal/vfs'

// Files' sidebar, as you arranged it: the order of the sections, the order of the items in each,
// what is hidden, and the bookmarks. Synced, so every Files window and device shows the same.
// Sections and items not mentioned (new libraries, a section added in a later release) keep their
// default place after the ones you moved.

export type SidebarState = {
  /** Section ids, in your order */
  order: string[]
  /** Item ids per section, in your order */
  items: Record<string, string[]>
  /** Hidden sections ("places") and items ("places:music") */
  hidden: string[]
  bookmarks: string[]
}

const DEFAULT_BOOKMARKS = [`${HOME}/projects`, `${HOME}/games`, `${HOME}/contributions`]

/** Bookmarks used to live with the view settings in this browser only; they move along once. */
function legacyBookmarks(): string[] {
  try {
    const old = JSON.parse(localStorage.getItem('mvlos.files.v1') ?? '{}') as { bookmarks?: unknown }
    if (Array.isArray(old.bookmarks)) return old.bookmarks.filter((b): b is string => typeof b === 'string')
  } catch {
    /* none */
  }
  return DEFAULT_BOOKMARKS
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const store = synced<SidebarState>(
  'files-sidebar',
  { order: [], items: {}, hidden: [], bookmarks: legacyBookmarks() },
  {
    normalize: (v) => {
      const o = (v ?? {}) as Partial<SidebarState>
      const items: Record<string, string[]> = {}
      if (o.items && typeof o.items === 'object') for (const [k, list] of Object.entries(o.items)) items[k] = strings(list)
      return { order: strings(o.order), items, hidden: strings(o.hidden), bookmarks: Array.isArray(o.bookmarks) ? strings(o.bookmarks) : legacyBookmarks() }
    },
  },
)

export const useSidebar = store.use
export const getSidebar = store.get
const update = (fn: (s: SidebarState) => SidebarState) => store.set(fn)

/** Ids in your order: the ones you placed first, then the rest in their default order. */
export function arrange(defaults: string[], stored: string[] | undefined): string[] {
  const known = new Set(defaults)
  const placed = (stored ?? []).filter((id) => known.has(id))
  const seen = new Set(placed)
  return [...placed, ...defaults.filter((id) => !seen.has(id))]
}

/** Moves `id` to just before `before` (or to the end), within a list that holds both. */
function moveIn(list: string[], id: string, before: string | null): string[] {
  const rest = list.filter((x) => x !== id)
  const i = before === null ? rest.length : rest.indexOf(before)
  rest.splice(i < 0 ? rest.length : i, 0, id)
  return rest
}

export const moveSection = (current: string[], id: string, before: string | null) => update((s) => ({ ...s, order: moveIn(current, id, before) }))

export function moveItem(section: string, current: string[], id: string, before: string | null) {
  const next = moveIn(current, id, before)
  // Bookmarks are their own order.
  if (section === 'bookmarks') return update((s) => ({ ...s, bookmarks: next }))
  update((s) => ({ ...s, items: { ...s.items, [section]: next } }))
}

export const setHidden = (key: string, hidden: boolean) => update((s) => ({ ...s, hidden: hidden ? [...new Set([...s.hidden, key])] : s.hidden.filter((h) => h !== key) }))

export const addBookmark = (path: string) => update((s) => (s.bookmarks.includes(path) ? s : { ...s, bookmarks: [...s.bookmarks, path] }))
export const removeBookmark = (path: string) => update((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b !== path) }))

/** Everything back where it was: order and hidden things (bookmarks stay). */
export const resetSidebar = () => update((s) => ({ ...s, order: [], items: {}, hidden: [] }))
