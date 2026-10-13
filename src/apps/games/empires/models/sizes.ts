import { UNIT, dims, type Hardpoint, type Tier, type UnitType } from '../data.ts'

// Ship sizes: Big (the default) or Classic (the battle as it was before), picked per match and
// carried in the match's config, so every player's copy of a battle and the server referee agree.
// Battles, matches and campaigns from before there was a choice are Classic.
// Under Big, warships are bigger by their size class, handle heavier, and the Republic's Warden
// and Sovereign are their bigger redesigns (proto.ts) with their guns spread out over the hull.
// Everything Big changes is in the tables here; the sim, the renderer and the Codex all take their
// unit types from bigType(). No DOM here: the sim and the server load it too.

export type ShipSizes = 'classic' | 'big'
export const SHIP_SIZES: ShipSizes[] = ['big', 'classic']
export const SHIP_SIZE_NAMES: Record<ShipSizes, string> = { classic: 'Classic', big: 'Big' }
export const SHIP_SIZE_BLURB: Record<ShipSizes, string> = {
  classic: 'Warships at their original, smaller sizes.',
  big: 'Warships much bigger by class (flagships 2.5×), heavier to turn and slower to get going.',
}

/** How much longer each class is under Big than in Classic. */
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
  yard: 1,
}

/**
 * How a class handles under Big, as multipliers on its Classic numbers: a bigger ship is heavier,
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

/** How much further apart a Big fleet sits: formations and the repair tenders' reach grow by this. */
export const BIG_SPREAD = 1.3

/**
 * Where warships carry their hardpoints under Big, on the 0-10 grid (x from the left, y from the
 * nose), with each one's size `s` as a share of the ship's length, in the order of the unit's
 * hardpoints in data.ts. One turret per gun, spread over the bigger hull: the guns stay about the
 * size they were in Classic (a little bigger on the flagships), so there is room between them. The
 * Swarm's concept designs use the droid units' layouts, as they use their hardpoints in Classic.
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

/** Rough body radius, as the sim works it out (sim.ts `radius`). */
const radiusOf = (t: UnitType) => {
  const [w, h] = dims(t)
  return (w + h) * 0.25
}

const big = new WeakMap<UnitType, UnitType>()
/**
 * A unit type as it is under Big: `size` times its class, its handling from HANDLING, the
 * redesigned ships' hardpoints from BIG_LAYOUT. Its guns reach as far past its hull as they did:
 * each weapon's range grows by as much as the hull's radius grew, so a flagship 2.5 times as long
 * doesn't spend half its gun range on its own hull. Classes that stay the size they are come back
 * as they are (the same object).
 */
export function bigType(t: UnitType): UnitType {
  const f = SIZE_CLASSES[t.tier]
  if (f === 1 || t.big) return t
  let s = big.get(t)
  if (s) return s
  const h = HANDLING[t.tier]
  const grow = radiusOf(t) * (f - 1)
  const longer = <W extends { range: number }>(w: W): W => ({ ...w, range: Math.round(w.range + grow) })
  const layout = BIG_LAYOUT[t.id]
  const hardpoints: Hardpoint[] = t.hardpoints.map((hp, i) => ({ ...hp, ...(layout?.[i] ?? {}), ...(hp.weapon ? { weapon: longer(hp.weapon) } : {}) }))
  s = {
    ...t,
    size: t.size * f,
    turn: t.turn * h.turn,
    speed: t.speed * h.speed,
    accel: h.accel,
    weapons: t.weapons.map(longer),
    hardpoints,
    ...(t.support ? { support: { ...t.support, range: Math.round(t.support.range * BIG_SPREAD) } } : {}),
    big: true,
  }
  big.set(t, s)
  return s
}

/** The type a unit id stands for in a battle with these ship sizes. */
export const sizedType = (id: string, sizes: ShipSizes | undefined): UnitType => (sizes === 'big' ? bigType(UNIT[id]) : UNIT[id])

/** A unit type at its proposed size, for the Codex: the same as it is under Big. */
export const protoType = bigType
