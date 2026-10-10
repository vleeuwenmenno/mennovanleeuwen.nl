import type { Brain } from './ai'
import type { UnitType } from './data'
import type { Camera } from './render'
import type { World } from './sim'

// A battle frozen mid-fight, so a reload (or a closed tab) carries on from the same moment: the
// whole world (every ship with its damage, orders and reload timers, the shots in flight, the
// wrecks), the AI admirals' plans, and where the player was looking with what selected. The world
// is plain data apart from its lookup tables, which are rebuilt; ship types are stored once each,
// since grown stations and upgraded platforms carry types of their own.

export type BattleSnap = {
  world: string
  brains: (Omit<Brain, 'scouts'> & { scouts: number[] })[]
  cam: Camera
  sel: number[]
  groups: [string, number[]][]
  speed: number
}

// JSON has no Infinity (a derelict hulk never decays): written as markers and read back.
const INF = '__inf'
const NINF = '__-inf'
const write = (_: string, v: unknown) => (v === Infinity ? INF : v === -Infinity ? NINF : typeof v === 'number' && Number.isNaN(v) ? 0 : v)
const read = (_: string, v: unknown) => (v === INF ? Infinity : v === NINF ? -Infinity : v)

export function snapshotWorld(w: World): string {
  const types: UnitType[] = []
  const index = new Map<UnitType, number>()
  const units = w.units.map((u) => {
    let i = index.get(u.t)
    if (i === undefined) {
      i = types.length
      types.push(u.t)
      index.set(u.t, i)
    }
    return { ...u, t: i }
  })
  const rest: Partial<World> = { ...w }
  delete rest.byId
  delete rest.grid
  delete rest.nav
  delete rest.units
  return JSON.stringify({ v: 1, ...rest, units, types }, write)
}

export function restoreWorld(s: string): World | null {
  try {
    const o = JSON.parse(s, read) as Record<string, unknown> & { v: number; types: UnitType[]; units: (Omit<World['units'][number], 't'> & { t: number })[] }
    if (o?.v !== 1 || !Array.isArray(o.units) || !Array.isArray(o.types)) return null
    const units = o.units.map((u) => ({ ...u, t: o.types[u.t] }))
    const w = { ...o, units, byId: new Map(units.map((u) => [u.id, u])), grid: new Map(), nav: new Map() } as unknown as World & { v?: number; types?: unknown }
    delete w.v
    delete w.types
    return w
  } catch {
    return null
  }
}

export const snapBrain = (b: Brain) => ({ ...b, scouts: [...b.scouts] })
export const restoreBrain = (b: BattleSnap['brains'][number]): Brain => ({ ...b, scouts: new Set(b.scouts) })

// --- Where they're kept ------------------------------------------------------------------------------

/** A skirmish in progress: its lobby setup (to rebuild the screen) and the snapshot. */
const SKIRMISH = 'mvlos.empires.battle.skirmish'
/** A campaign's battle in progress, by save slot: which planet it's over, and the snapshot. */
const CAMPAIGN = (save: string) => `mvlos.empires.battle.${save}`

function put(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(v))
  } catch {
    // Storage full or blocked: this battle can't be picked up after a reload.
  }
}
function get<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

export const saveSkirmish = <S>(v: { setup: S; snap: BattleSnap } | null) => put(SKIRMISH, v)
export const loadSkirmish = <S>() => get<{ setup: S; snap: BattleSnap }>(SKIRMISH)
export const saveCampaignBattle = (save: string, v: { planet: number; snap: BattleSnap } | null) => put(CAMPAIGN(save), v)
export const loadCampaignBattle = (save: string) => get<{ planet: number; snap: BattleSnap }>(CAMPAIGN(save))
