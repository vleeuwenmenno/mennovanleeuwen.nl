import { flagPref, jsonPref, levelPref } from '../../os/localPref'
import { GAME_CATALOG } from './catalog'

// The games' own preferences, kept in this browser under the keys each game has always used:
// Pool's helpers, sensitivity and computer, and the sound of Pool, Gladiator and Empires At War.
// They live here, apart from the (sometimes lazily loaded) games, so Settings → Apps → Games can
// show and change them without loading a game, and a game that is open hears the change at once.
// Empires At War's game settings and key bindings have their own small store (empires/settings.ts).
// The library's two lists (what you played last, what you favourited) are at the end of this file.

// --- Pool -----------------------------------------------------------------------------------------

/** Metres of drag back for a full-power stroke. */
export const POOL_DRAG = { low: 0.6, medium: 0.4, high: 0.25 }
export type PoolSensitivity = keyof typeof POOL_DRAG
export type PoolLevel = 'easy' | 'medium' | 'hard'
export const POOL_LEVELS: PoolLevel[] = ['easy', 'medium', 'hard']
export type PoolSettings = { helpers: boolean; sensitivity: PoolSensitivity; level: PoolLevel }

export const poolSettings = jsonPref<PoolSettings>('mvlos.pool.settings', { helpers: true, sensitivity: 'medium', level: 'medium' }, (v) => ({
  helpers: v.helpers !== false,
  sensitivity: v.sensitivity in POOL_DRAG ? v.sensitivity : 'medium',
  level: POOL_LEVELS.includes(v.level) ? v.level : 'medium',
}))
export const poolMuted = flagPref('mvlos.pool.muted', false)
export const poolVolume = levelPref('mvlos.pool.volume', 0.8)

// --- Gladiator ------------------------------------------------------------------------------------

export const gladiatorMuted = flagPref('mvlos.gladiator.muted', false)
export const gladiatorMusic = flagPref('mvlos.gladiator.music', true)
export const gladiatorVolume = levelPref('mvlos.gladiator.volume', 0.8)

// --- Empires At War -------------------------------------------------------------------------------

/** Battle sounds, crews answering (and abilities), interface and alerts, ambience and music. */
export type EmpiresBus = 'sfx' | 'voice' | 'ui' | 'amb' | 'music'
export type EmpiresMix = Record<EmpiresBus, number>

/** How the lobbies' map picker sorts its list, remembered in this browser. */
export type EmpiresMapSort = { by: 'name' | 'size' | 'players'; desc: boolean }
export const empiresMapSort = jsonPref<EmpiresMapSort>('mvlos.empires.mapsort', { by: 'name', desc: false }, (v) => ({
  by: v.by === 'size' || v.by === 'players' ? v.by : 'name',
  desc: v.desc === true,
}))

export const empiresMuted = flagPref('mvlos.empires.muted', false)
export const empiresMusic = flagPref('mvlos.empires.music', true)
export const empiresVolume = levelPref('mvlos.empires.volume', 0.7)
export const empiresMix = jsonPref<EmpiresMix>('mvlos.empires.mix', { sfx: 1, voice: 0.9, ui: 0.9, amb: 0.7, music: 0.7 })

// --- The library ----------------------------------------------------------------------------------

// What the library needs to know about you: the games you played, most recent first (its hero and
// its order), and the ones you starred. Both are just ids, so a game that goes away leaves nothing
// broken behind: unknown ids are dropped when the list is read.

/** Enough to fill the "recently played" order; older ones fall off the end. */
const RECENT_MAX = 12

export type Played = { id: string; at: number }
const known = new Set(GAME_CATALOG.map((g) => g.id))

export const gamesRecent = jsonPref<{ list: Played[] }>('mvlos.games.recent', { list: [] }, (v) => ({
  list: Array.isArray(v.list)
    ? v.list
        .filter((p): p is Played => !!p && typeof p.id === 'string' && known.has(p.id) && Number.isFinite(p.at))
        .slice()
        .sort((a, b) => b.at - a.at)
        .slice(0, RECENT_MAX)
    : [],
}))

/** Notes that a game was opened, which is what puts it first in the library. */
export function notePlayed(id: string) {
  if (!known.has(id)) return
  gamesRecent.set((v) => ({ list: [{ id, at: Date.now() }, ...v.list.filter((p) => p.id !== id)].slice(0, RECENT_MAX) }))
}

export const gamesFavourites = jsonPref<{ ids: string[] }>('mvlos.games.favourites', { ids: [] }, (v) => ({
  ids: Array.isArray(v.ids) ? [...new Set(v.ids.filter((id): id is string => typeof id === 'string' && known.has(id)))] : [],
}))

/** Stars or unstars a game. */
export function toggleFavourite(id: string) {
  if (!known.has(id)) return
  gamesFavourites.set((v) => ({ ids: v.ids.includes(id) ? v.ids.filter((x) => x !== id) : [...v.ids, id] }))
}
