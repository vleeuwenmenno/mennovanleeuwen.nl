import type { Hardpoint, Tier, UnitType } from '../data.ts'
import type { Layout } from '../data/kit.ts'

// Ship sizes. Every ship bigger than strike craft is built bigger than its numbers in data.ts were
// first written for, by its size class: heavier to turn and slower to get going, its guns spread
// out over the bigger hull (each faction's `layout`, data.ts BIG_LAYOUT) and reaching as far past it as they did. The yards grow with
// the ships they build. data.ts applies this once to every unit (sized()), so a unit type is always
// its full size; there is no other. (Battles once offered a choice of "Classic" sizes, the numbers
// as written; saves from then are refused or carried over, see snapshot.ts and galaxy.ts.)
// No DOM here: the sim and the server load it too.

/** How much longer each class is than its numbers in data.ts were written for. */
export const SIZE_CLASSES: Record<Tier, number> = {
  /** Strike craft stay as they are. */
  fighter: 1,
  /** Gunships and corvettes. */
  gunship: 1.15,
  frigate: 1.4,
  cruiser: 1.7,
  /** The flagships, the biggest and dearest ships. */
  capital: 2.5,
  /** Stations and platforms stay as they are. */
  station: 1,
  mine: 1,
  defense: 1,
  /** Yards go by what they build (see sizeClass): the Frigate Yard as a frigate, the Capital Yard
   * as a flagship, so the biggest ship of each fits its berth. */
  yard: 1,
}

/** How much bigger a unit is than written: its class's, a yard's by what it builds. */
export const sizeClass = (t: Pick<UnitType, 'tier' | 'id'>) => (t.tier === 'yard' ? SIZE_CLASSES[t.id.endsWith('cyard') ? 'capital' : 'frigate'] : SIZE_CLASSES[t.tier])

/**
 * How a class handles at its size, as multipliers on its numbers as written: a bigger ship is heavier,
 * so it turns slower, gets up to speed (and brakes) slower, and the biggest fly a little slower.
 */
export const HANDLING: Record<Tier, { turn: number; accel: number; speed: number }> = {
  fighter: { turn: 1, accel: 1, speed: 1 },
  gunship: { turn: 0.9, accel: 0.9, speed: 1 },
  frigate: { turn: 0.8, accel: 0.8, speed: 0.95 },
  cruiser: { turn: 0.72, accel: 0.7, speed: 0.92 },
  capital: { turn: 0.65, accel: 0.6, speed: 0.88 },
  station: { turn: 1, accel: 1, speed: 1 },
  mine: { turn: 1, accel: 1, speed: 1 },
  defense: { turn: 1, accel: 1, speed: 1 },
  yard: { turn: 1, accel: 1, speed: 1 },
}

/** How much further apart a fleet sits than its ships' sizes alone would put it: formations and the
 * repair tenders' reach grow by this. */
export const BIG_SPREAD = 1.3

/** Rough body radius, as the sim works it out (sim.ts `radius`), from the unit's box (data.ts dims). */
const radiusOf = (t: UnitType) => {
  const [w, h] = t.aspect >= 1 ? [t.size, t.size / t.aspect] : [t.size * t.aspect, t.size]
  return (w + h) * 0.25
}

/**
 * A unit type at its size: `size` times its class (sizeClass), its handling from HANDLING, the
 * warships' hardpoints from `layout` (its faction's, see data.ts BIG_LAYOUT). Its guns reach as far
 * past its hull as they did: each weapon's range grows by as much as the hull's radius grew, so a
 * flagship 2.5 times as long doesn't spend half its gun range on its own hull. Repair tenders and
 * auras reach as much further as the fleet spreads out (BIG_SPREAD). Classes that keep their size
 * come back as they are (the same object). data.ts calls it once per unit.
 */
export function sized(t: UnitType, layout?: Layout): UnitType {
  const f = sizeClass(t)
  if (f === 1) return t
  const h = HANDLING[t.tier]
  const grow = radiusOf(t) * (f - 1)
  const longer = <W extends { range: number }>(w: W): W => ({ ...w, range: Math.round(w.range + grow) })
  const hardpoints: Hardpoint[] = t.hardpoints.map((hp, i) => ({ ...hp, ...(layout?.[i] ?? {}), ...(hp.weapon ? { weapon: longer(hp.weapon) } : {}) }))
  return {
    ...t,
    size: t.size * f,
    turn: t.turn * h.turn,
    speed: t.speed * h.speed,
    accel: h.accel,
    weapons: t.weapons.map(longer),
    hardpoints,
    ...(t.support ? { support: { ...t.support, range: Math.round(t.support.range * BIG_SPREAD) } } : {}),
    ...(t.drain ? { drain: { ...t.drain, radius: Math.round(t.drain.radius * BIG_SPREAD) } } : {}),
    ...(t.fireControl ? { fireControl: { ...t.fireControl, radius: Math.round(t.fireControl.radius * BIG_SPREAD) } } : {}),
  }
}
