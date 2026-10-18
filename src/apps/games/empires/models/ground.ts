import type { FactionId, UnitType } from '../data.ts'
import { drawnDesign } from './mounts.ts'
import { GROUND as droid } from './droid/ground.ts'
import { scorchSpots, setGroundModels } from './index.ts'
import { circle, seedOf } from './kit.ts'
import { GROUND as republic } from './republic/ground.ts'
import type { ModelSpec } from './spec.ts'
import { GROUND as swarm } from './swarm/ground.ts'
import { KYBER } from './kyber.ts'
import type { AnyDesign, Model, Part } from './types.ts'

// Models for the ground battle's units and buildings, in the same parts-and-vectors format as the
// ships (models/types.ts): parts in the faction's palette, facets for the cel shading, lift shadows,
// painted by models/paint.ts with the light from the top left. Each faction's designs are in
// models/<faction>/ground.ts, by ground unit type id (data/<faction>.ts). No DOM here.
//
// Model space as for ships: origin in the middle of the box, nose up (-y). A building faces south
// (its door at +y) and is drawn unturned; a vehicle with sim heading h is drawn turned by h + π/2.
// A ground unit's turrets (hardpoints with a weapon, its data's) are mounts placed on its model as on
// a ship's, each in a socket, turning on their own; a weapon fixed along the nose has no mount.
// Designs that walk (a squad's members, walkers) give their poses in walking order (ModelSpec
// `walk`) and their legs as parts with a `pose`; the paint cache keeps a look per pose.

/** One ground design: its box in model units (100 on the long side) and its parts; `tier`: the tier
 * a factory stands at (GroundSpec `tier`), whose design grows with it. */
export type GroundModel = { w: number; h: number; spec: (c: { w: number; h: number; tier: number }) => ModelSpec }
/** A faction's ground designs, by ground unit type id. */
export type GroundModels = Record<string, GroundModel>

const BY_FACTION: Record<FactionId, GroundModels> = { republic, droid, swarm }
const DEFS: Record<string, { faction: FactionId; def: GroundModel }> = {}
for (const f of Object.keys(BY_FACTION) as FactionId[]) for (const [id, def] of Object.entries(BY_FACTION[f])) DEFS[id] = { faction: f, def }

/** Every ground type id with a model (and the squads' members, by their model id). */
export const groundModelIds = () => Object.keys(DEFS)

const members = new Map<string, Model>()
/** The model of a squad's member (GroundSpec `squad`: a design here by its id, in its faction's
 * palette), built on first use; null when there is none. */
export function memberModel(id: string): Model | null {
  let m = members.get(id)
  if (!m) {
    const d = DEFS[id]
    if (!d) return null
    members.set(id, (m = assemble(`member:${id}`, d.faction, d.def)))
  }
  return m
}

/** Builds the model for ground unit type `id` (throws when it has none); with its type `t`, its
 * turrets on it, and drawn with the design it borrows when it has none of its own (GroundSpec `look`). */
export function buildGroundModel(id: string, t?: UnitType): Model {
  const d = DEFS[t?.ground?.look ?? id]
  if (!d) throw new Error(`No ground model for ${id}`)
  const tier = t?.ground?.factory ? (t.ground.tier ?? 1) : 1
  return assemble(`ground:${id}${tier > 1 ? `:${tier}` : ''}`, d.faction, d.def, t)
}

const crystals = new Map<number, Model>()
/** The model of kyber crystal cluster shape `shape` (models/kyber.ts), built on first use. Painted
 * in the Confederacy's palette for its oranges; the clusters belong to nobody. */
export function crystalModel(shape: number): Model {
  const k = ((shape % KYBER.length) + KYBER.length) % KYBER.length
  let m = crystals.get(k)
  if (!m) crystals.set(k, (m = assemble(`kyber:${k}`, 'droid', KYBER[k])))
  return m
}
/** How many crystal cluster shapes there are. */
export const crystalShapes = () => KYBER.length

function assemble(key: string, faction: FactionId, def: GroundModel, t?: UnitType): Model {
  const { w, h } = def
  const spec = def.spec({ w, h, tier: t?.ground?.factory ? (t.ground.tier ?? 1) : 1 })
  const long = Math.max(w, h)
  // Its turrets, on its hardpoints (as a ship's: 0-10 grids over its box), in the faction's designs.
  const mounts = (t?.hardpoints ?? []).flatMap((hp, i) => {
    if (!hp.weapon) return []
    const named: AnyDesign = hp.look ?? hp.art ?? 'flak'
    const design = drawnDesign(named, t!.faction)
    return [{ hp: i, x: (hp.x / 10 - 0.5) * w, y: (hp.y / 10 - 0.5) * h, r: ((hp.s ?? 0.05) * long) / 2, design, turns: !hp.weapon.spinal, detach: true }]
  })
  const sockets: Part[] = mounts.map((m) => ({ id: `socket${m.hp}`, pts: circle(m.x, m.y, m.r * 1.1, 18), tone: 'dark' as const, z: 6.5, details: [{ k: 'line' as const, pts: circle(m.x, m.y, m.r * 0.92, 16) }] }))
  const parts = [...spec.parts, ...sockets].sort((a, b) => a.z - b.z)
  const seed = seedOf(key)
  return {
    key,
    faction,
    w,
    h,
    long,
    parts,
    mounts,
    engines: spec.engines ?? [],
    detachable: parts.flatMap((p, i) => (p.detach ? [i] : [])),
    breakStyle: spec.breakStyle ?? 'bands',
    cuts: spec.cuts,
    core: spec.core,
    scorch: scorchSpots(parts, w, h, seed),
    seed,
    ...(spec.walk ? { walk: spec.walk } : {}),
  }
}

const built = new Map<string, Model | null>()
/** The model for ground unit type `id` (with its type `t`: its turrets on it), built on first use;
 * null when it has none. */
export function groundModelFor(id: string, t?: UnitType): Model | null {
  // A factory's model grows with its tier: one a tier.
  const key = t?.ground?.factory && (t.ground.tier ?? 1) > 1 ? `${id}:${t.ground.tier}` : id
  let m = built.get(key)
  if (m === undefined) built.set(key, (m = (t?.ground?.look ?? id) in DEFS ? buildGroundModel(id, t) : null))
  return m
}

// The game's model lookup (index.ts modelFor) has ground units' models from here on.
setGroundModels({
  ids: groundModelIds,
  has: (t) => (t.ground?.look ?? t.id) in DEFS,
  build: (t) => buildGroundModel(t.id, t),
  model: (t) => groundModelFor(t.id, t),
})
