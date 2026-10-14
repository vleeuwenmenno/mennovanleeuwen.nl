import type { FactionId } from '../data.ts'
import { build as droid } from './droid/mounts.ts'
import { build as republic } from './republic/mounts.ts'
import { build as swarm } from './swarm/mounts.ts'
import type { MountDesign, Part } from './types.ts'

// What sits on a hardpoint, drawn on a mount of radius 1 with its guns pointing up (negative y),
// then scaled to the hardpoint's size. Turrets turn on their own, so they are painted apart from
// the hull and lit for the way they point. Each faction draws its own (models/<faction>/mounts.ts);
// this builds and keeps them.

export type MountLook = MountDesign | 'crater'

/** Each faction's mounts. */
const BUILD: Record<FactionId, (design: MountLook, broken: boolean) => Part[]> = { republic, droid, swarm }

const cache = new Map<string, Part[]>()

/** A mount's parts, built once per design, faction and state. */
export function mountParts(design: MountLook, faction: FactionId, broken: boolean): Part[] {
  const key = `${design}:${faction}:${broken ? 1 : 0}`
  let parts = cache.get(key)
  if (!parts) cache.set(key, (parts = BUILD[faction](design, broken).sort((a, b) => a.z - b.z)))
  return parts
}
