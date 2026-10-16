import type { FactionId } from '../data.ts'
import { GROUND as droid } from './droid/ground.ts'
import { scorchSpots } from './index.ts'
import { seedOf } from './kit.ts'
import { GROUND as republic } from './republic/ground.ts'
import type { ModelSpec } from './spec.ts'
import { GROUND as swarm } from './swarm/ground.ts'
import type { Model } from './types.ts'

// Models for the ground battle's units and buildings, in the same parts-and-vectors format as the
// ships (models/types.ts): parts in the faction's palette, facets for the cel shading, lift shadows,
// painted by models/paint.ts with the light from the top left. Each faction's designs are in
// models/<faction>/ground.ts, by ground unit type id (ground/units.ts). No DOM here.
//
// Model space as for ships: origin in the middle of the box, nose up (-y). A building faces south
// (its door at +y) and is drawn unturned; a vehicle with sim heading h is drawn turned by h + π/2.
// Ground units have no hardpoints yet (no weapons in the slice), so no mounts.

/** One ground design: its box in model units (100 on the long side) and its parts. */
export type GroundModel = { w: number; h: number; spec: (c: { w: number; h: number }) => ModelSpec }
/** A faction's ground designs, by ground unit type id. */
export type GroundModels = Record<string, GroundModel>

const BY_FACTION: Record<FactionId, GroundModels> = { republic, droid, swarm }
const DEFS: Record<string, { faction: FactionId; def: GroundModel }> = {}
for (const f of Object.keys(BY_FACTION) as FactionId[]) for (const [id, def] of Object.entries(BY_FACTION[f])) DEFS[id] = { faction: f, def }

/** Every ground type id with a model. */
export const groundModelIds = () => Object.keys(DEFS)

/** Builds the model for ground unit type `id` (throws when it has none). */
export function buildGroundModel(id: string): Model {
  const d = DEFS[id]
  if (!d) throw new Error(`No ground model for ${id}`)
  const { w, h } = d.def
  const spec = d.def.spec({ w, h })
  const parts = [...spec.parts].sort((a, b) => a.z - b.z)
  const seed = seedOf(`ground:${id}`)
  return {
    key: `ground:${id}`,
    faction: d.faction,
    w,
    h,
    long: Math.max(w, h),
    parts,
    mounts: [],
    engines: spec.engines ?? [],
    detachable: parts.flatMap((p, i) => (p.detach ? [i] : [])),
    breakStyle: spec.breakStyle ?? 'bands',
    cuts: spec.cuts,
    core: spec.core,
    scorch: scorchSpots(parts, w, h, seed),
    seed,
  }
}

const built = new Map<string, Model | null>()
/** The model for ground unit type `id`, built on first use; null when it has none. */
export function groundModelFor(id: string): Model | null {
  let m = built.get(id)
  if (m === undefined) built.set(id, (m = id in DEFS ? buildGroundModel(id) : null))
  return m
}
