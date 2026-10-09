import { synced } from '../os/synced'

// How Spotlight behaves: what the empty box shows, which kinds of results it searches, what Enter
// does when nothing of yours matches, the preview pane, and whether it remembers the websites you
// open. Kept in this browser; synced when signed in, like notes.

/** What the empty box shows, in this order. */
export type StartSection = 'sites' | 'status' | 'apps' | 'code'
export const START_SECTIONS: [StartSection, string, string][] = [
  ['sites', 'Recently visited websites', 'The last pages you opened from here'],
  ['status', 'Status', 'The Minecraft server, latest activity and contributions'],
  ['apps', 'Apps and actions', 'Terminal, Projects, CV and Games'],
  ['code', 'Repositories and issues', 'The ones you open most, once signed in'],
]

/** Kinds of results that can be left out of what you type. */
export type Category = 'sites' | 'status' | 'projects' | 'games' | 'files'
export const CATEGORIES: [Category, string][] = [
  ['sites', 'Recently visited websites'],
  ['status', 'Status'],
  ['projects', 'Projects'],
  ['games', 'Games'],
  ['files', 'Files'],
]

/** Enter when nothing of yours matches. */
export type Fallback = 'web' | 'terminal'

export type SpotlightPrefs = {
  start: Record<StartSection, boolean>
  include: Record<Category, boolean>
  fallback: Fallback
  preview: boolean
  /** Remember websites opened from MvL OS */
  history: boolean
}

const DEFAULTS: SpotlightPrefs = {
  start: { sites: true, status: true, apps: true, code: true },
  include: { sites: true, status: true, projects: true, games: true, files: true },
  fallback: 'web',
  preview: true,
  history: true,
}

const flags = <K extends string>(defaults: Record<K, boolean>, v: unknown): Record<K, boolean> => {
  const given = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, typeof given[k] === 'boolean' ? given[k] : d])) as Record<K, boolean>
}

const store = synced<SpotlightPrefs>('spotlight', DEFAULTS, {
  normalize: (v) => {
    const s = { ...DEFAULTS, ...(v as Partial<SpotlightPrefs>) }
    return {
      start: flags(DEFAULTS.start, s.start),
      include: flags(DEFAULTS.include, s.include),
      fallback: s.fallback === 'terminal' ? 'terminal' : 'web',
      preview: s.preview !== false,
      history: s.history !== false,
    }
  },
})

export const useSpotlightPrefs = store.use
export const spotlightPrefs = store.get
export const setSpotlightPrefs = (patch: Partial<SpotlightPrefs>) => store.set((s) => ({ ...s, ...patch }))
export const setStart = (section: StartSection, on: boolean) => store.set((s) => ({ ...s, start: { ...s.start, [section]: on } }))
export const setInclude = (category: Category, on: boolean) => store.set((s) => ({ ...s, include: { ...s.include, [category]: on } }))
