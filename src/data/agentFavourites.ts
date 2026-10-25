import { useSyncExternalStore } from 'react'
import { synced } from '../os/synced'
import { agentSettings, onAgentSettingsRemote } from './agents'

// The models starred in the Agents model picker (src/apps/AgentsModelPicker.tsx), in the order
// they were starred: Ctrl+1…9 picks the first nine. They follow the account under a key of their
// own, merged model by model, so starring on one device or tab while another stars, unstars or
// changes any other agents setting keeps both changes.
//
// Every model ever starred has an entry: on (starred) or off (unstarred), with a change counter
// (`at`). Per model, the higher counter wins; an unstar is an entry like any other, so it sticks
// however late an older copy that still has the star turns up. A change made here counts on from
// the entry it changes (nextAt), so a device whose clock runs behind still wins with a later
// change. The starred ones are shown by their counter: the order they were starred in.
//
// They used to be the agents settings' `favoriteModels` (that store has no merge, and a tab still on
// an older release saved its settings without them, which wiped every star). That list is moved
// over once per model: a model the set already has, on or off, is left as it is, so an old copy
// never brings back a star taken off since.

export type FavouriteEntry = { on: boolean; at: number }
export type FavouriteSet = { models: Record<string, FavouriteEntry> }

/** Entries kept at most: the unstarred ones go first, the longest unchanged first. */
const MAX_ENTRIES = 200
const EMPTY: FavouriteSet = { models: {} }
const validName = (n: unknown): n is string => typeof n === 'string' && n.length > 0 && n.length <= 80

/** Whether `a` wins over `b`: the higher counter; a tie goes to the unstar, the same on every device. */
const wins = (a: FavouriteEntry, b: FavouriteEntry) => (a.at !== b.at ? a.at > b.at : !a.on && b.on)

function capped(models: Record<string, FavouriteEntry>): Record<string, FavouriteEntry> {
  const names = Object.keys(models)
  if (names.length <= MAX_ENTRIES) return models
  const keep = names.sort((a, b) => Number(models[b].on) - Number(models[a].on) || models[b].at - models[a].at || (a < b ? -1 : 1)).slice(0, MAX_ENTRIES)
  return Object.fromEntries(keep.map((n) => [n, models[n]]))
}

/** Reads the set; anything that isn't one counts as empty. */
export function normalizeFavourites(v: unknown): FavouriteSet {
  const raw = v && typeof v === 'object' && !Array.isArray(v) ? (v as { models?: unknown }).models : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY
  const models: Record<string, FavouriteEntry> = {}
  for (const [name, e] of Object.entries(raw as Record<string, Partial<FavouriteEntry>>))
    if (validName(name) && e && typeof e === 'object' && typeof e.at === 'number' && Number.isFinite(e.at)) models[name] = { on: e.on === true, at: e.at }
  return { models: capped(models) }
}

/** Per model, the side that changed it last wins; a model only one side has is kept. */
export function mergeFavourites(local: FavouriteSet, remote: FavouriteSet): FavouriteSet {
  const models = { ...remote.models }
  for (const [name, l] of Object.entries(local.models)) if (!models[name] || wins(l, models[name])) models[name] = l
  return { models: capped(models) }
}

/** The starred models, in the order they were starred. */
export function starred(set: FavouriteSet): string[] {
  return Object.entries(set.models)
    .filter(([, e]) => e.on)
    .sort(([a, x], [b, y]) => x.at - y.at || (a < b ? -1 : 1))
    .map(([n]) => n)
}

/** `set` with `name` starred or unstarred, counting on from its entry (whatever the clock says). */
export function toggled(set: FavouriteSet, name: string, now = Date.now()): FavouriteSet {
  const e = set.models[name]
  return { models: capped({ ...set.models, [name]: { on: !e?.on, at: Math.max(now, (e?.at ?? 0) + 1) } }) }
}

/** `set` with the models of an older list that it doesn't know yet, starred before anything starred since. */
export function withLegacy(set: FavouriteSet, legacy: unknown): FavouriteSet {
  if (!Array.isArray(legacy)) return set
  const add = [...new Set(legacy.filter(validName))].filter((n) => !set.models[n])
  if (!add.length) return set
  // Counters 1, 2, 3…: in the old order, and below any change made anywhere since.
  const models = { ...set.models }
  add.forEach((n) => (models[n] = { on: true, at: legacy.indexOf(n) + 1 }))
  return { models: capped(models) }
}

const store = synced<FavouriteSet>('agents:favourites', EMPTY, { normalize: normalizeFavourites, merge: mergeFavourites, mergeTabs: true })

let names = starred(store.get())
let namesOf = store.get()
/** The starred models, in the order they were starred (the same array until they change). */
export const favouriteNames = (): string[] => {
  const set = store.get()
  if (set !== namesOf) (namesOf = set), (names = starred(set))
  return names
}
/** The starred models, kept up to date. */
export const useFavouriteNames = () => useSyncExternalStore(store.subscribe, favouriteNames)
/**
 * The entries changed in this tab. Another tab's save is taken as it is (synced's storage event),
 * and one made at the same moment as a change here may not have had it yet: these are merged back
 * in whenever a copy from elsewhere arrives without them, so neither tab's star is lost.
 */
const mine: Record<string, FavouriteEntry> = {}
store.onRemote((set) => {
  if (Object.entries(mine).some(([n, e]) => !set.models[n] || wins(e, set.models[n]))) store.set((s) => mergeFavourites({ models: mine }, s))
})

/** Stars a model, or takes its star off. */
export const toggleFavourite = (name: string) => {
  if (!validName(name)) return
  store.set((s) => {
    const next = toggled(s, name)
    mine[name] = next.models[name]
    return next
  })
}

/** Moves the agents settings' old list over (no change when every model in it is known). */
const importLegacy = (legacy: unknown) => store.set((s) => withLegacy(s, legacy))
importLegacy(agentSettings().favoriteModels)
// An older copy of the settings arriving from the server or another tab may still hold stars made
// on another device before it had this set (or by a tab still on an older release).
onAgentSettingsRemote((s) => importLegacy(s.favoriteModels))
