import { synced } from '../os/synced'

// How Spotlight behaves: what the empty box shows, which kinds of results it searches, what Enter
// does when nothing of yours matches, the preview pane, and whether it remembers the websites you
// open. Kept in this browser; synced when signed in, like notes.

/** What the empty box shows, in this order. */
export type StartSection = 'favourites' | 'answers' | 'sites' | 'status' | 'apps' | 'code'
export const START_SECTIONS: [StartSection, string, string][] = [
  ['favourites', 'Favourites', 'What you starred: right-click a result → Add to favourites'],
  ['answers', 'Recent answers', 'Questions you asked Agents from here'],
  ['sites', 'Recently visited websites', 'The last pages you opened from here'],
  ['status', 'Status', 'The Minecraft server, latest activity and contributions'],
  ['apps', 'Apps and actions', 'Terminal, Projects, CV and Games'],
  ['code', 'Repositories and issues', 'The ones you open most, once signed in'],
]

/** How many recently visited websites, and repositories and issues, the empty box shows. */
export const RECENT_COUNTS = [3, 5, 8, 12] as const

/** Kinds of results that can be left out of what you type. */
export type Category = 'answers' | 'sites' | 'status' | 'projects' | 'games' | 'files'
export const CATEGORIES: [Category, string][] = [
  ['answers', 'Recent answers'],
  ['sites', 'Recently visited websites'],
  ['status', 'Status'],
  ['projects', 'Projects'],
  ['games', 'Games'],
  ['files', 'Files'],
]

/** How long a quick answer from Agents stays in Spotlight when it is not continued in the app. */
export type AnswersKeep = '1h' | '1d' | '1w' | '30d' | 'never'
export const ANSWERS_KEEP: [AnswersKeep, string][] = [
  ['1h', '1 hour'],
  ['1d', '1 day'],
  ['1w', '1 week'],
  ['30d', '30 days'],
  ['never', 'Until removed'],
]

/** Enter when nothing of yours matches. */
export type Fallback = 'web' | 'terminal'

export type SpotlightPrefs = {
  start: Record<StartSection, boolean>
  include: Record<Category, boolean>
  fallback: Fallback
  preview: boolean
  /** Recent items of each kind in the empty box, one of RECENT_COUNTS */
  recentCount: number
  /** Remember websites opened from MvL OS */
  history: boolean
  /** Quick answers are deleted this long after their last message (read by the server) */
  answersKeep: AnswersKeep
}

const DEFAULTS: SpotlightPrefs = {
  start: { favourites: true, answers: true, sites: true, status: true, apps: true, code: true },
  include: { answers: true, sites: true, status: true, projects: true, games: true, files: true },
  fallback: 'web',
  preview: true,
  recentCount: 5,
  history: true,
  answersKeep: '1d',
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
      recentCount: (RECENT_COUNTS as readonly number[]).includes(s.recentCount) ? s.recentCount : DEFAULTS.recentCount,
      history: s.history !== false,
      answersKeep: ANSWERS_KEEP.some(([k]) => k === s.answersKeep) ? s.answersKeep : DEFAULTS.answersKeep,
    }
  },
})

export const useSpotlightPrefs = store.use
export const spotlightPrefs = store.get
export const setSpotlightPrefs = (patch: Partial<SpotlightPrefs>) => store.set((s) => ({ ...s, ...patch }))
export const setStart = (section: StartSection, on: boolean) => store.set((s) => ({ ...s, start: { ...s.start, [section]: on } }))
export const setInclude = (category: Category, on: boolean) => store.set((s) => ({ ...s, include: { ...s.include, [category]: on } }))
