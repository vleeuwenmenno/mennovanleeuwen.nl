import { synced } from '../os/synced'
import { spotlightPrefs } from './spotlightPrefs'

// Websites opened from MvL OS (Spotlight, launchers, the terminal's open and go, links in apps),
// newest first, for Spotlight's "Recently visited". A web page can't read the browser's own
// history, so this only knows what was opened from here. Go links are kept by alias
// (`go:<alias>`), never by their URL, so the golinks token stays out of it. Kept in this browser;
// synced when signed in; off in Settings → Spotlight.

export type Visit = { url: string; title?: string; at: number; count: number }

const MAX = 60
const store = synced<Visit[]>('site-history', [], {
  normalize: (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x.url === 'string' && typeof x.at === 'number') : []),
  // Two devices both opened things: keep both, the latest visit of each page.
  merge: (local, remote) => {
    const byUrl = new Map<string, Visit>()
    for (const v of [...remote, ...local]) {
      const had = byUrl.get(v.url)
      byUrl.set(v.url, had && had.at > v.at ? had : { ...v, count: Math.max(v.count, had?.count ?? 0) })
    }
    return [...byUrl.values()].sort((a, b) => b.at - a.at).slice(0, MAX)
  },
})

export const useVisits = store.use
export const visits = store.get

/** One entry per page: no fragment, no trailing slash. */
const clean = (url: string) => url.replace(/#.*$/, '').replace(/\/$/, '')

export function rememberVisit(url: string, title?: string) {
  if (!spotlightPrefs().history) return
  if (!/^https?:\/\//i.test(url) && !url.startsWith('go:')) return
  const key = clean(url)
  const name = title?.trim().slice(0, 120) || undefined
  store.set((all) => {
    const old = all.find((v) => v.url === key)
    return [{ url: key, title: name ?? old?.title, at: Date.now(), count: (old?.count ?? 0) + 1 }, ...all.filter((v) => v.url !== key)].slice(0, MAX)
  })
}

export const forgetVisit = (url: string) => store.set((all) => all.filter((v) => v.url !== url))
export const clearVisits = () => store.set([])
