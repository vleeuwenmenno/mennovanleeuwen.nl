import type { Brain } from './ai.ts'
import type { UnitType } from './data.ts'
import { buildGrid, type World } from './sim.ts'

// A battle frozen mid-fight, so a reload carries on from the same moment (keep.ts stores it): the
// whole world (every ship with its damage, orders and reload timers, the shots in flight, the
// wrecks), the AI admirals' plans, and where the player was looking with what selected. The world
// is plain data apart from its lookup tables, which are rebuilt; ship types are stored once each,
// since grown stations and upgraded platforms carry types of their own.
//
// Version 2 is the one ship size there is now (models/sizes.ts). A version-1 battle fought at Big
// ship sizes is the same game and carries on; one fought at Classic sizes can't (its ships would sit
// on top of each other at their real size), so it is refused (see outdatedSnapshot).

export type BattleSnap = {
  world: string
  brains: (Omit<Brain, 'scouts'> & { scouts: number[] })[]
  /** Where the player was looking (render.ts's Camera; spelled out so the server, which loads
   * this file, needn't load the renderer). */
  cam: { x: number; y: number; zoom: number }
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
  // The lookup grid is rebuilt at the start of every tick, but the AI thinks before the tick, on the
  // grid the last tick built (from where the units were then). A restored world must think on that
  // same grid, or its admirals see a different battle for one think and the copies drift apart.
  const cells = [...w.grid].map(([k, us]) => [k, us.map((u) => u.id)])
  return JSON.stringify({ v: 2, ...rest, units, types, cells }, write)
}

export function restoreWorld(s: string): World | null {
  try {
    const o = JSON.parse(s, read) as Record<string, unknown> & { v: number; types: UnitType[]; units: (Omit<World['units'][number], 't'> & { t: number })[] }
    if (!(o?.v === 2 || (o?.v === 1 && o.sizes === 'big')) || !Array.isArray(o.units) || !Array.isArray(o.types)) return null
    delete o.sizes
    const units = o.units.map((u) => ({ ...u, t: o.types[u.t] }))
    const byId = new Map(units.map((u) => [u.id, u]))
    const cells = Array.isArray(o.cells) ? (o.cells as [number, number[]][]) : null
    const w = { ...o, units, byId, grid: new Map(), nav: new Map() } as unknown as World & { v?: number; types?: unknown; cells?: unknown }
    delete w.v
    delete w.types
    delete w.cells
    // Saved before snapshots kept the grid: built from where the units are, as a tick would.
    if (cells) for (const [k, ids] of cells) w.grid.set(k, ids.map((id) => byId.get(id)).filter((u) => !!u))
    else buildGrid(w)
    // Saved before the world kept its own counters and random numbers.
    w.squadSeq ??= Math.max(0, ...units.map((u) => u.squad)) + 1
    w.wreckSeq ??= Math.max(999, ...w.wrecks.map((h) => h.id)) + 1
    w.rs ??= (Math.random() * 2 ** 32) >>> 0
    return w
  } catch {
    return null
  }
}

/** Whether a saved battle is from before there was only one ship size, fought at Classic sizes:
 * restoreWorld refuses it, and the battle says so instead of quietly starting afresh. */
export function outdatedSnapshot(s: string) {
  try {
    const o = JSON.parse(s) as { v?: number; sizes?: string }
    return o?.v === 1 && o.sizes !== 'big'
  } catch {
    return false
  }
}

export const snapBrain = (b: Brain) => ({ ...b, scouts: [...b.scouts] })
export const restoreBrain = (b: BattleSnap['brains'][number]): Brain => ({ ...b, scouts: new Set(b.scouts) })
