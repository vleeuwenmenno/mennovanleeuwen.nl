import { synced } from '../os/synced'

// Spotlight's favourites: results starred from its right-click menu, shown first in the empty
// box. Apps, actions, notes, files and the like are kept by their result id; websites (visited
// pages, repositories, launchers' pages) and go links by their address, so they stay after they
// drop out of the history. Kept in this browser; synced when signed in, like notes.

export type Favourite = { kind: 'result'; id: string; title: string } | { kind: 'site'; url: string; title: string }

const MAX = 12

const valid = (f: Favourite) => f && typeof f.title === 'string' && ((f.kind === 'result' && typeof f.id === 'string') || (f.kind === 'site' && typeof f.url === 'string'))
const store = synced<Favourite[]>('spotlight-favourites', [], { normalize: (v) => (Array.isArray(v) ? v.filter(valid) : []) })

export const useFavourites = store.use

/** One key per favourite, whatever its title. */
export const favouriteKey = (f: Favourite) => (f.kind === 'site' ? `site:${f.url}` : `result:${f.id}`)

export const addFavourite = (f: Favourite) => store.set((all) => (all.some((x) => favouriteKey(x) === favouriteKey(f)) ? all : [...all, f].slice(-MAX)))
export const removeFavourite = (key: string) => store.set((all) => all.filter((f) => favouriteKey(f) !== key))

export function moveFavourite(key: string, by: number) {
  store.set((all) => {
    const i = all.findIndex((f) => favouriteKey(f) === key)
    const j = i + by
    if (i < 0 || j < 0 || j >= all.length) return all
    const next = all.slice()
    next.splice(j, 0, next.splice(i, 1)[0])
    return next
  })
}
