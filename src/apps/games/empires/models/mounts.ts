import type { FactionId } from '../data.ts'
import * as droid from './droid/mounts.ts'
import * as republic from './republic/mounts.ts'
import * as swarm from './swarm/mounts.ts'
import type { AnyDesign, MountDesign, MountExtra, Part } from './types.ts'

// What sits on a hardpoint, drawn on a mount of radius 1 with its guns pointing up (negative y),
// then scaled to the hardpoint's size. Turrets turn on their own, so they are painted apart from
// the hull and lit for the way they point. Each faction draws its own (models/<faction>/mounts.ts);
// this builds and keeps them.
//
// A faction's mounts file exports `build(design, broken)` for the common designs (MountLook), and
// may export `extras`: its own designs beyond those, by name (MountExtra in data/kit.ts), each a
// function of `broken` returning the parts, e.g.
//
//   export const extras: MountExtras = {
//     torpedo: (broken) => [...parts],
//     pd: (broken) => [...parts],
//   }
//
// (Its `build` may also take an extra's name itself and return its parts, or undefined to pass.)
// A hardpoint picks an extra with `look` in the faction's data (Hardpoint `look`), or a model with
// its ModelSpec `mount` override ({ design: 'torpedo' }). Where a faction has no such design, the
// closest common one (FALLBACK) is drawn instead, so one faction's data or a shared hardpoint can name
// a design another faction hasn't drawn yet. Run `pnpm check:empires-models` after adding one.

/** The common designs and a blown-off mount's burnt socket: what every faction's `build` draws. */
export type MountLook = MountDesign | 'crater'
/** Any design a mount can be drawn in: the common ones, a faction's extras, the burnt socket. */
export type AnyLook = AnyDesign | 'crater'
/** A faction's extra mount designs (see above). */
export type MountExtras = Partial<Record<MountExtra, (broken: boolean) => Part[]>>

/** What a faction's mounts file gives: its common designs, and any extras. */
type FactionMounts = { build: (design: MountLook, broken: boolean) => Part[]; extras?: MountExtras }
/** Each faction's mounts. */
const MOUNTS = { republic, droid, swarm } as Record<FactionId, FactionMounts>

/** The common design drawn for an extra a faction hasn't drawn: the nearest in what it is. */
export const FALLBACK: Record<MountExtra, MountDesign> = {
  torpedo: 'turbo', pd: 'flak', triple: 'turbo', missileBox: 'turbo', strike: 'turbo', railgun: 'turbo', beam: 'turbo', quad: 'flak',
  spore: 'flak', acid: 'turbo', lance: 'ion', bioturret: 'turbo', parasite: 'flak', regen: 'shield', engineSac: 'engine', broodSac: 'hangar', spine: 'turbo', projector: 'shield',
}
const isExtra = (d: AnyLook): d is MountExtra => d in FALLBACK

/** The design a faction actually draws for `design`: its own, or the fallback for an extra it
 * doesn't draw. (An extra that falls back to 'engine' draws nothing, as an engine has no mount.) */
export function drawnDesign(design: AnyDesign, faction: FactionId): AnyDesign {
  if (!isExtra(design)) return design
  return extraParts(design, faction, false) ? design : FALLBACK[design]
}

/** A faction's own parts for an extra design, or undefined when it has none. */
function extraParts(design: MountExtra, faction: FactionId, broken: boolean): Part[] | undefined {
  const own = MOUNTS[faction]
  return own.extras?.[design]?.(broken) ?? (own.build as (d: AnyLook, b: boolean) => Part[] | undefined)(design, broken) ?? undefined
}

const cache = new Map<string, Part[]>()

/** A mount's parts, built once per design, faction and state. */
export function mountParts(design: AnyLook, faction: FactionId, broken: boolean): Part[] {
  const key = `${design}:${faction}:${broken ? 1 : 0}`
  let parts = cache.get(key)
  if (!parts) {
    const made = isExtra(design) ? (extraParts(design, faction, broken) ?? MOUNTS[faction].build(FALLBACK[design], broken)) : MOUNTS[faction].build(design, broken)
    cache.set(key, (parts = [...(made ?? [])].sort((a, b) => a.z - b.z)))
  }
  return parts
}
