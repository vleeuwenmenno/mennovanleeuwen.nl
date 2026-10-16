import type { FactionId } from '../data.ts'
import type { Model } from '../models/types.ts'
import type { GroundUnit, GroundWorld, Owner } from './sim.ts'

// Building and training in ground battles: placing a building on the tile grid, engineers putting
// it up, structures training units, and what the screen asks about them. This file is the contract
// between the sim side (which fills in every body below) and the battle screen (which only calls
// these). The bodies are stubs until then: they refuse everything and report nothing.

/** One tile of a placement ghost: whether a building may cover it. */
export type TileCheck = { tc: number; tr: number; ok: boolean }

/** Where a building would go: its footprint's top-left tile, what it costs, every tile checked, and
 * the first rule that fails (null when it may go there). The ghost under the cursor shows this. */
export type Placement = { why: string | null; tc: number; tr: number; cost: number; tiles: TileCheck[] }

/** The slice's two unit types per faction, by faction. */
export type SliceIds = { engineer: string; center: string }
export const SLICE_IDS: Record<FactionId, SliceIds> = {
  republic: { engineer: 'r-g-engineer', center: 'r-g-center' },
  droid: { engineer: 'd-g-engineer', center: 'd-g-center' },
  swarm: { engineer: 's-g-engineer', center: 's-g-center' },
}

/** Where building `type` would go with its footprint centred as near (x, y) as the grid allows. */
export function placement(_w: GroundWorld, _owner: Owner, _type: string, _x: number, _y: number): Placement {
  return { why: 'Building is not in the game yet', tc: 0, tr: 0, cost: 0, tiles: [] }
}

/** What engineers `ids` (of `owner`) may build: building type ids, in card order. */
export function buildable(_w: GroundWorld, _owner: Owner): string[] {
  return []
}

/** What structure `id` may train, in card order. */
export function trainable(_w: GroundWorld, _id: number): string[] {
  return []
}

/** Why `owner` can't train `type` at structure `id` now, or null. */
export function cantTrain(_w: GroundWorld, _owner: Owner, _id: number, _type: string): string | null {
  return 'Training is not in the game yet'
}

/** A building site's progress, 0 to 1, or null when `u` is not a site under construction. */
export function siteProgress(_u: GroundUnit): number | null {
  return null
}

/** A structure's training queue: type ids and the progress of the first, 0 to 1. */
export function queueOf(_u: GroundUnit): { items: string[]; progress: number } {
  return { items: [], progress: 0 }
}

/** The model a ground unit type is drawn with (procedural parts, as space ships are), or null
 * while it has none: the screen then draws a plain marker. */
export function groundModel(_type: string): Model | null {
  return null
}

// --- Orders (in commands.ts's table) ------------------------------------------------------------

/** Engineers `ids` place building `type` centred near (x, y) and go to build it; `queued`: after
 * their current orders. Returns why not, or null. */
export function cmdPlace(_w: GroundWorld, _owner: Owner, _ids: number[], _type: string, _x: number, _y: number, _queued: boolean): string | null {
  return 'Building is not in the game yet'
}

/** Engineers `ids` go and build (or repair) structure `id` of ours. */
export function cmdConstruct(_w: GroundWorld, _owner: Owner, _ids: number[], _id: number, _queued: boolean): string | null {
  return 'Building is not in the game yet'
}

/** Structure `id` trains one `type` (`count` of them with shift: 5). */
export function cmdTrain(_w: GroundWorld, _owner: Owner, _id: number, _type: string, _count: number): string | null {
  return 'Training is not in the game yet'
}

/** Cancel item `index` of structure `id`'s queue, or a site under construction when `index` is -1
 * (refunds follow the plan's rules). */
export function cmdCancel(_w: GroundWorld, _owner: Owner, _id: number, _index: number): string | null {
  return null
}

/** Structure `id`'s rally point. */
export function cmdRally(_w: GroundWorld, _owner: Owner, _id: number, _x: number, _y: number): string | null {
  return null
}
