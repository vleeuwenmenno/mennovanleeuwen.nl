import type { Tier, UnitType } from '../data.ts'

// The size classes being tried for bigger warships: how much longer each class would be than it is
// in the battle today. Only the Codex's prototype view uses them so far; the battle, its sizes and
// its hardpoints are untouched. One table, so the classes can be tuned in one place.

export const SIZE_CLASSES: Record<Tier, number> = {
  /** Strike craft stay as they are. */
  fighter: 1,
  /** Gunships and corvettes. */
  gunship: 1.15,
  frigate: 1.4,
  cruiser: 1.7,
  /** The flagships, the biggest and dearest ships. */
  capital: 2.5,
  /** Stations and platforms stay as they are for now. */
  station: 1,
  mine: 1,
  defense: 1,
}

const scaled = new WeakMap<UnitType, UnitType>()
/** A unit type at its proposed size: the same unit, `size` times its class. */
export function protoType(t: UnitType): UnitType {
  let s = scaled.get(t)
  if (!s) scaled.set(t, (s = { ...t, size: t.size * SIZE_CLASSES[t.tier] }))
  return s
}
