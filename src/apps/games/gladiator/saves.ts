import { synced } from '../../../os/synced'
import type { HallEntry, Save } from './career'
import { estateFor } from './estate'

// Gladiator's save slots and Hall of Fame, kept like the desktop's notes: in this browser, and
// signed in, on the server too (see os/synced.ts), so a run can continue on another device.
// This module is tiny and loads with the arcade, not with the (lazy) game, so the store exists
// when the browser pulls synced state after signing in.

export const SLOTS = 3
/** `tiers` marks saves that use the thirteen-tier gear numbering (before, there were seven). */
export type GladiatorStore = { slots: (Save | null)[]; hall: HallEntry[]; tiers?: number }

const TIERS = 13
const empty = (): GladiatorStore => ({ slots: Array.from({ length: SLOTS }, () => null), hall: [], tiers: TIERS })

/** Seven tiers became thirteen with a half step between each: old tier n is new tier 2n. */
function retier(gear: Record<string, string | undefined> | undefined) {
  const out: Record<string, string> = {}
  for (const [slot, id] of Object.entries(gear ?? {})) if (id) out[slot] = id.replace(/-(\d+)$/, (_, n) => `-${Number(n) * 2}`)
  return out
}

function normalize(v: unknown): GladiatorStore {
  const s = v as Partial<GladiatorStore> | null
  if (!s || !Array.isArray(s.slots)) return empty()
  const old = s.tiers !== TIERS
  // A save that came back damaged (or from an older version) shows as an empty slot rather than
  // breaking the title screen.
  const ok = (x: unknown): x is Save => !!x && typeof x === 'object' && !!(x as Save).g?.look && !!(x as Save).record && Array.isArray((x as Save).rivals)
  const slots = [...s.slots, null, null, null].slice(0, SLOTS).map((x) => {
    if (!ok(x)) return null
    let save = x
    if (old) save = { ...save, g: { ...save.g, gear: retier(save.g.gear) } }
    // Saves from before the estate get one, stocked for how far they've come.
    if (!save.estate) save = { ...save, estate: estateFor(save.g.level, save.g.gear) }
    return save
  })
  const hall = (Array.isArray(s.hall) ? s.hall.filter((h) => h && typeof h.name === 'string' && h.look) : []).map((h) => (old ? { ...h, gear: retier(h.gear) } : h))
  return { slots, hall, tiers: TIERS }
}

/**
 * Two devices saved since they last agreed: per slot, the most recently played run wins (and a
 * run beats an emptied slot, so a delete on one device can't wipe progress made on another);
 * the Hall of Fame keeps everyone from both.
 */
export function merge(localRaw: GladiatorStore, remoteRaw: GladiatorStore): GladiatorStore {
  // Either side may still be in an older format: bring both up to date before comparing.
  const local = normalize(localRaw)
  const remote = normalize(remoteRaw)
  const slots = local.slots.map((l, i) => {
    const r = remote.slots[i]
    if (!l) return r ?? null
    if (!r) return l
    return (r.updated ?? 0) > (l.updated ?? 0) ? r : l
  })
  const seen = new Set<string>()
  const hall = [...local.hall, ...remote.hall]
    .filter((h) => {
      const id = `${h.name}|${h.date}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => b.date - a.date)
    .slice(0, 30)
  return { slots, hall, tiers: TIERS }
}

export const gladiatorStore = synced<GladiatorStore>('games:gladiator', empty(), { legacyKey: 'mvlos.gladiator.v1', normalize, merge })

/** The highest level reached by any gladiator, saved or remembered, for the arcade's card. */
export function bestGladiatorLevel() {
  const s = gladiatorStore.get()
  return Math.max(0, ...s.slots.map((x) => x?.g.level ?? 0), ...s.hall.map((h) => h.level))
}

// --- Export and import ---------------------------------------------------------------------------

const FORMAT = 'mvlos-gladiator'

/** Every slot and the Hall of Fame as a downloadable JSON file. */
export function exportSaves() {
  const data = { format: FORMAT, version: 1, exported: new Date().toISOString(), ...gladiatorStore.get() }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `gladiator-saves-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Reads an exported file; throws with a readable message if it isn't one. */
export function parseImport(text: string): GladiatorStore {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file isn\u2019t JSON.')
  }
  const r = raw as { format?: string } | null
  if (!r || r.format !== FORMAT) throw new Error('That isn\u2019t a Gladiator save file.')
  const store = normalize(raw)
  if (!store.slots.some(Boolean) && !store.hall.length) throw new Error('That file has no gladiators in it.')
  return store
}

/** Merge keeps the newest run per slot and everyone in the Hall of Fame; replace takes the file as it is. */
export function applyImport(store: GladiatorStore, how: 'merge' | 'replace') {
  gladiatorStore.set((cur) => (how === 'replace' ? store : merge(store, cur)))
}
