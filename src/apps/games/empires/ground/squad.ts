import * as M from '../detmath.ts'
import type { Unit, World } from '../sim.ts'

// Squads in ground battles (GroundSpec `squad`): one unit whose members stand in a loose formation
// round its middle and turn and walk with it. The hull is the squad's; members fall one by one as it
// drops (the last one with the unit), and each member still standing fires the unit's weapons from
// where it stands (ground/combat.ts), so fewer members means less firepower. Part of the lockstep
// sim: detmath only, and `members` is in the hash and the snapshots.

/** Each member's place in a formation of `n` members `s` apart, as [forward, right] of the middle in
 * world units: a loose cluster (a sunflower spiral), worked out once. */
const forms = new Map<string, [number, number][]>()
export function formation(n: number, s: number): [number, number][] {
  const key = `${n}:${s}`
  let f = forms.get(key)
  if (!f) {
    f = []
    for (let i = 0; i < n; i++) {
      const r = s * 0.75 * Math.sqrt(i + 0.3)
      const a = i * 2.3999632
      f.push([M.cos(a) * r, M.sin(a) * r])
    }
    forms.set(key, f)
  }
  return f
}

/** How many of a squad's members are standing (all of them before its first tick). */
export const membersLeft = (u: Unit) => u.members ?? u.t.ground?.squad?.n ?? 1

/** Where member `i` of squad `u` stands, in world units; `k` spreads the formation (the screen
 * spreads it when zoomed far out). */
export function memberAt(u: Unit, i: number, k = 1) {
  const sq = u.t.ground!.squad!
  const [f, r] = formation(sq.n, sq.spacing)[i]
  const c = M.cos(u.a)
  const sn = M.sin(u.a)
  return { x: u.x + (c * f - sn * r) * k, y: u.y + (sn * f + c * r) * k }
}

/** Once a tick: each squad's members fall as its hull drops, one per 1/n of it lost. */
export function squadsTick(w: World) {
  for (const u of w.units) {
    const sq = u.t.ground?.squad
    if (!sq || u.dead) continue
    const left = Math.max(1, Math.ceil((u.hull / u.hullMax) * sq.n - 1e-6))
    u.members = Math.min(u.members ?? sq.n, left)
  }
}
