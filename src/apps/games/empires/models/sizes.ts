import { UNIT, dims, type Hardpoint, type Tier, type UnitType } from '../data.ts'

// Ship sizes: Classic (the battle as it has always been) or Big (preview), picked per match and
// carried in the match's config, so every player's copy of a battle and the server referee agree.
// Under Big, warships are bigger by their size class, handle heavier, and the Republic's Warden
// and Sovereign are their bigger redesigns (proto.ts) with their guns spread out over the hull.
// Everything Big changes is in the tables here; the sim, the renderer and the Codex all take their
// unit types from bigType(). No DOM here: the sim and the server load it too.

export type ShipSizes = 'classic' | 'big'
export const SHIP_SIZES: ShipSizes[] = ['classic', 'big']
export const SHIP_SIZE_NAMES: Record<ShipSizes, string> = { classic: 'Classic', big: 'Big (preview)' }
export const SHIP_SIZE_BLURB: Record<ShipSizes, string> = {
  classic: 'Every ship at its usual size.',
  big: 'Warships much bigger by class (flagships 2.5×), heavier to turn and slower to get going. A preview.',
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
}

/** How much further apart a Big fleet sits: formations and the repair tenders' reach grow by this. */
export const BIG_SPREAD = 1.3

/**
 * Where the redesigned ships carry their hardpoints under Big, on the 0-10 grid (x from the left,
 * y from the nose), with each one's size `s` as a share of the ship's length, in the order of the
 * unit's hardpoints in data.ts. One turret per gun, spread over the bigger hull: the guns stay
 * about the size they were in Classic, so there is room between them. Every other ship keeps its
 * hardpoints where they are on its grid, growing with the hull.
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
