import { dims, isShip, type UnitType, type WeaponKind } from './data.ts'

// What the weapon range rings show, worked out the way the battle measures it (sim.ts), so a ring
// is where a gun really reaches. No DOM here: the battle's renderer and the Codex both draw from it.
//
// A gun on a hardpoint fires from the hardpoint itself (sim.ts `shoot`: `from = hpPos(u, g.hp)`),
// out to its range times the ship's range bonus; a target counts as in reach once its centre is
// within that plus half its own radius, an allowance for the target's size that the rings leave out.
// So a module's ring is centred on the module, at its plain range. Weapons built into the hull
// (strike craft, gunships) fire from the centre.
//
// For the whole unit there is one ring per kind of gun, centred on the unit, at the average reach
// of that kind's guns measured from the centre. A ship turns its nose to what it fights, so a gun's
// reach from its centre is measured as the battle's stopping distances measure it (sim.ts
// `gunReach`): its range less how far its hardpoint sits out to the side or behind the centre (one
// further forward is never further away once the ship has turned). A structure never turns, so
// for it a gun's reach from the centre is averaged over every direction round it.

/** A module's own ring: its gun's kind and range (null for a module without a gun). */
export function moduleRing(t: UnitType, i: number, rangeMul = 1): { kind: WeaponKind; range: number } | null {
  const wp = t.hardpoints[i]?.weapon
  return wp ? { kind: wp.kind, range: wp.range * rangeMul } : null
}

/** How far a gun of `range` at (side, fwd) from a structure's centre reaches from the centre,
 * averaged over every direction: the distance from the centre out to the edge of the gun's circle,
 * round the compass. */
function meanReach(range: number, side: number, fwd: number) {
  const d = Math.hypot(side, fwd)
  if (d < 1e-6) return range
  let sum = 0
  const N = 64
  for (let k = 0; k < N; k++) {
    const c = Math.cos(((k + 0.5) / N) * Math.PI * 2)
    const s2 = 1 - c * c
    const inner = range * range - d * d * s2
    sum += inner > 0 ? Math.max(0, d * c + Math.sqrt(inner)) : 0
  }
  return sum / N
}

/**
 * The unit's rings: one per kind of gun, at the average reach from its centre of that kind's guns
 * still standing (`live` says which hardpoints are), longest first. `n` is how many guns made it.
 */
export function averageRings(t: UnitType, live: (i: number) => boolean = () => true, rangeMul = 1): { kind: WeaponKind; reach: number; n: number }[] {
  const [w, h] = dims(t)
  const ship = isShip(t)
  const by = new Map<WeaponKind, { sum: number; n: number }>()
  const add = (kind: WeaponKind, reach: number) => {
    const g = by.get(kind) ?? { sum: 0, n: 0 }
    g.sum += reach
    g.n++
    by.set(kind, g)
  }
  for (const wp of t.weapons) add(wp.kind, wp.range * rangeMul)
  t.hardpoints.forEach((hp, i) => {
    if (!hp.weapon || !live(i)) return
    const r = hp.weapon.range * rangeMul
    const side = (hp.x / 10 - 0.5) * w
    const fwd = (0.5 - hp.y / 10) * h
    add(hp.weapon.kind, ship ? r - Math.hypot(side, Math.max(0, -fwd)) : meanReach(r, side, fwd))
  })
  return [...by].map(([kind, g]) => ({ kind, reach: g.sum / g.n, n: g.n })).sort((a, b) => b.reach - a.reach)
}
