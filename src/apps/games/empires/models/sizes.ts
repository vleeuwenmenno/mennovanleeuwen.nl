import type { Hardpoint, Tier, UnitType } from '../data.ts'

// Ship sizes. Every ship bigger than strike craft is built bigger than its numbers in data.ts were
// first written for, by its size class: heavier to turn and slower to get going, its guns spread
// out over the bigger hull (BIG_LAYOUT) and reaching as far past it as they did. The yards grow with
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

/**
 * Where warships carry their hardpoints, on the 0-10 grid (x from the left, y from the
 * nose), with each one's size `s` as a share of the ship's length, in the order of the unit's
 * hardpoints in data.ts. One turret per gun, spread over the bigger hull: the guns stay about the
 * size they were written at (a little bigger on the flagships), so there is room between them. The
 * Swarm's concept designs use the droid units' layouts.
 * Ships with no hardpoints (strike craft, gunships) carry their guns on the hull.
 */
export const BIG_LAYOUT: Record<string, { x: number; y: number; s?: number }[]> = {
  // Warden frigate: the flak in two pairs, forward on the deck and aft on the flanks; the
  // turbolaser on its barbette on the centre line ahead of the superstructure; the shield dome
  // crowning the superstructure.
  'r-frigate': [
    { x: 4.11, y: 2.8, s: 0.055 },
    { x: 5.89, y: 2.8, s: 0.055 },
    { x: 1.87, y: 6.2, s: 0.055 },
    { x: 8.13, y: 6.2, s: 0.055 },
    { x: 5, y: 4.4, s: 0.08 },
    { x: 5, y: 7.4, s: 0.075 },
  ],
  // Sovereign dreadnought: four turbolasers on barbettes down the upper deck in two pairs, the
  // flak forward on the deck and aft on the flanks, the shield domes on the twin towers, the
  // hangar in the flight deck, the engine block where it was.
  'r-capital': [
    { x: 3.81, y: 3.8, s: 0.06 },
    { x: 6.19, y: 3.8, s: 0.06 },
    { x: 3.25, y: 5.6, s: 0.06 },
    { x: 6.75, y: 5.6, s: 0.06 },
    { x: 4.13, y: 2.6, s: 0.04 },
    { x: 5.87, y: 2.6, s: 0.04 },
    { x: 1.82, y: 6.4, s: 0.04 },
    { x: 8.18, y: 6.4, s: 0.04 },
    { x: 2.75, y: 8.15, s: 0.096 },
    { x: 7.25, y: 8.15, s: 0.096 },
    { x: 5, y: 9.2 },
    { x: 5, y: 4.9, s: 0.08 },
  ],
  // Paladin cruiser: two turbolasers down the spine, two on the shoulders, the flak on pads either
  // side aft, the shield bulbs on the sponsons, the engines where they were.
  'r-cruiser': [
    { x: 5, y: 1.9, s: 0.05 },
    { x: 5, y: 3.1, s: 0.05 },
    { x: 3.62, y: 4.6, s: 0.05 },
    { x: 6.38, y: 4.6, s: 0.05 },
    { x: 2.77, y: 7.1, s: 0.04 },
    { x: 7.23, y: 7.1, s: 0.04 },
    { x: 1.7, y: 5.6, s: 0.075 },
    { x: 8.3, y: 5.6, s: 0.075 },
    { x: 2.46, y: 9.4 },
    { x: 7.54, y: 9.4 },
  ],
  // Disruptor frigate: the ion cannon forward, the shield generator amidships, the flak aft, spaced
  // out down the spine.
  'd-ion': [
    { x: 5, y: 2.3, s: 0.13 },
    { x: 5, y: 4.6, s: 0.075 },
    { x: 5, y: 6.8, s: 0.06 },
  ],
  // Bulwark frigate: the twin cannons either side of the bulb, the shield generator on the spine
  // behind it, the flak on the sponsons.
  'd-frigate': [
    { x: 3.1, y: 1.4, s: 0.06 },
    { x: 6.9, y: 1.4, s: 0.06 },
    { x: 5, y: 3.8, s: 0.065 },
    { x: 2.49, y: 6.73, s: 0.05 },
    { x: 7.51, y: 6.73, s: 0.05 },
  ],
  // Anvil cruiser: down each gallery from the root out, the light gun, the shield generator, then
  // the heavy cannon near the tip.
  'd-cruiser': [
    { x: 0.9, y: 6.06, s: 0.055 },
    { x: 9.1, y: 6.06, s: 0.055 },
    { x: 3.4, y: 4.25, s: 0.045 },
    { x: 6.6, y: 4.25, s: 0.045 },
    { x: 2.15, y: 5.0, s: 0.05 },
    { x: 7.85, y: 5.0, s: 0.05 },
    { x: 4.47, y: 9.3 },
    { x: 5.52, y: 9.3 },
  ],
  // Gyre battleship: two heavy guns on the core sphere and two out on the ring's flanks, the shield
  // generators on the core's crown, the flak and the hangars round the ring.
  'd-capital': [
    { x: 4.08, y: 5.85, s: 0.05 },
    { x: 5.92, y: 5.85, s: 0.05 },
    { x: 1.27, y: 5.6, s: 0.05 },
    { x: 8.73, y: 5.6, s: 0.05 },
    { x: 2.72, y: 1.31, s: 0.04 },
    { x: 7.28, y: 1.31, s: 0.04 },
    { x: 1.25, y: 3.33, s: 0.04 },
    { x: 8.75, y: 3.33, s: 0.04 },
    { x: 4.19, y: 4.7, s: 0.06 },
    { x: 5.81, y: 4.7, s: 0.06 },
    { x: 5, y: 9.1 },
    { x: 2.64, y: 2.55, s: 0.075 },
    { x: 7.36, y: 2.55, s: 0.075 },
  ],
}

/** Rough body radius, as the sim works it out (sim.ts `radius`), from the unit's box (data.ts dims). */
const radiusOf = (t: UnitType) => {
  const [w, h] = t.aspect >= 1 ? [t.size, t.size / t.aspect] : [t.size * t.aspect, t.size]
  return (w + h) * 0.25
}

/**
 * A unit type at its size: `size` times its class (sizeClass), its handling from HANDLING, the
 * warships' hardpoints from BIG_LAYOUT. Its guns reach as far past its hull as they did: each
 * weapon's range grows by as much as the hull's radius grew, so a flagship 2.5 times as long
 * doesn't spend half its gun range on its own hull. Classes that keep their size come back as they
 * are (the same object). data.ts calls it once per unit.
 */
export function sized(t: UnitType): UnitType {
  const f = sizeClass(t)
  if (f === 1) return t
  const h = HANDLING[t.tier]
  const grow = radiusOf(t) * (f - 1)
  const longer = <W extends { range: number }>(w: W): W => ({ ...w, range: Math.round(w.range + grow) })
  const layout = BIG_LAYOUT[t.id]
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
  }
}
