import * as M from '../detmath.ts'
import { SPREAD } from '../data.ts'
import { nextOrder, rand, type Unit, type World } from '../sim.ts'
import { standsAt } from './nav.ts'
import { TILE } from './types.ts'

// Squads in ground battles (GroundSpec `squad`): one unit (it is selected, ordered, pathed and
// counted as one) whose members walk on their own round it. Each member heads for its place in a
// loose formation round the unit's middle, nudged by a drift of its own that changes now and then,
// so they spread, bunch and shuffle rather than stand in a grid; where its place is blocked or the
// way there isn't clear (a narrow gap, a bridge, a ramp) it follows the unit's trail instead, so the
// squad files through in a column and fans out again after. The hull is the squad's; members fall
// one by one as it drops (the last one with the unit), and each member still standing fires the
// unit's weapons from where it stands, on its own reload and at a target of its own (ground/combat.ts),
// so fewer members means less firepower. Spread out (the squad's ability, data/kit.ts SPREAD), its
// formation is wider, its members walk out to it, and it is harder to hit, slower and slower to fire. Part of the lockstep sim: detmath and the world's random
// stream only, and the members (`crew`) are in the hash and the snapshots.

/** One member of a squad: its number in the squad (`k`, kept as others fall), where it stands and
 * faces, its drift from its place in the formation ([forward, right] in world units) and seconds
 * until that changes, seconds it has been unable to walk straight to its place, and per gun of the
 * unit its reload left and the unit it shoots at (0: none). */
export type Member = { k: number; x: number; y: number; a: number; ox: number; oy: number; wait: number; lost: number; cd: number[]; t: number[] }

/** How far a member drifts from its place, as a share of the spacing. */
const DRIFT = 0.45
/** Seconds between a member's drifts: at least, and up to this much more. */
const WAIT = 2
const WAIT_MORE = 4
/** How much faster than the unit a member may walk, to catch up. */
const CATCH = 1.35
/** Radians a second a member turns. */
const TURN = 7
/** Seconds a member may fail to walk straight to its place before it follows the trail. */
const LOST = 0.4
/** Further from the middle than this (world units), a member is put back beside it. */
const STRAY = TILE * 6

const TAU = Math.PI * 2
const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU)

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
export const membersLeft = (u: Unit) => u.crew?.length ?? u.members ?? u.t.ground?.squad?.n ?? 1

/** Where formation place `k` of squad `u` is now, with drift (`ox`, `oy`), in world units. */
function placeOf(u: Unit, k: number, ox = 0, oy = 0) {
  const sq = u.t.ground!.squad!
  // Spread out, the formation is wider (data/kit.ts SPREAD).
  const [f, r] = formation(sq.n, u.spread ? sq.spacing * SPREAD.spacing : sq.spacing)[k]
  const c = M.cos(u.a)
  const sn = M.sin(u.a)
  return { x: u.x + c * (f + ox) - sn * (r + oy), y: u.y + sn * (f + ox) + c * (r + oy) }
}

/** A new drift for member `m`, and when it changes next. */
function drift(w: World, m: Member, s: number) {
  const a = rand(w) * TAU
  const r = rand(w) * s * DRIFT
  m.ox = M.cos(a) * r
  m.oy = M.sin(a) * r
  m.wait = WAIT + rand(w) * WAIT_MORE
}

/** Squad `u`'s members, made in their places the first time (a new squad, or one saved before
 * members walked on their own). */
export function crewOf(w: World, u: Unit): Member[] {
  if (u.crew) return u.crew
  const sq = u.t.ground!.squad!
  const n = Math.min(sq.n, u.members ?? sq.n)
  u.crew = []
  for (let k = 0; k < n; k++) {
    const p = placeOf(u, k)
    const m: Member = { k, x: p.x, y: p.y, a: u.a, ox: 0, oy: 0, wait: 0, lost: 0, cd: u.guns.map((g) => rand(w) * g.w.cooldown), t: u.guns.map(() => 0) }
    drift(w, m, sq.spacing)
    u.crew.push(m)
  }
  u.members = n
  return u.crew
}

/** Where member `m` of squad `u` stands now (world units); `k` spreads the squad out from its
 * middle (the screen does when zoomed far out). */
export const memberPos = (u: Unit, m: Member, k = 1) => ({ x: u.x + (m.x - u.x) * k, y: u.y + (m.y - u.y) * k })

/** How far squad `u`'s members stand from its middle at most (world units), for its ring. */
export function squadReach(u: Unit) {
  let r = 0
  for (const m of u.crew ?? []) r = Math.max(r, Math.sqrt((m.x - u.x) * (m.x - u.x) + (m.y - u.y) * (m.y - u.y)))
  return r
}

/** The point `d` world units back along squad `u`'s trail from its middle. */
function trailAt(u: Unit, d: number) {
  const tr = u.trail ?? []
  let px = u.x
  let py = u.y
  for (let i = 0; i + 1 < tr.length; i += 2) {
    const qx = tr[i]
    const qy = tr[i + 1]
    const seg = Math.sqrt((qx - px) * (qx - px) + (qy - py) * (qy - py))
    if (seg >= d && seg > 0) return { x: px + ((qx - px) * d) / seg, y: py + ((qy - py) * d) / seg }
    d -= seg
    px = qx
    py = qy
  }
  return { x: px, y: py }
}

/** Whether a member can walk straight from (ax, ay) to (bx, by): ground it can stand on all the way. */
function clear(w: World, ax: number, ay: number, bx: number, by: number) {
  const nav = w.ground!.nav
  for (let i = 1; i <= 4; i++) if (!standsAt(nav, 1, ax + ((bx - ax) * i) / 4, ay + ((by - ay) * i) / 4)) return false
  return true
}

/**
 * Once a tick, after the units moved: each squad's members walk. A member heads for its place in
 * the formation plus its drift, or, when that place is blocked or out of a straight walk, for its
 * spot on the unit's trail (a column through the gap); it keeps a little apart from the others,
 * walks a little faster than the unit to keep up, never onto ground it can't stand on, and turns to
 * where it shoots, else where it walks.
 */
export function crewTick(w: World, dt: number) {
  const nav = w.ground!.nav
  for (const u of w.units) {
    const sq = u.t.ground?.squad
    if (!sq || u.dead) continue
    const crew = crewOf(w, u)
    // A Shift-queued Spread out (or close up) when its turn comes, then on to the next order.
    while (u.order.k === 'spread') {
      u.spread = u.order.on
      nextOrder(u, u.x, u.y)
    }
    const s = sq.spacing
    // How far apart its members keep, wider spread out.
    const apart = u.spread ? s * SPREAD.spacing : s
    // The trail: where the middle has been, newest first, a point every half spacing.
    const tr = (u.trail ??= [])
    if (!tr.length || (tr[0] - u.x) * (tr[0] - u.x) + (tr[1] - u.y) * (tr[1] - u.y) > s * s * 0.25) {
      tr.unshift(u.x, u.y)
      if (tr.length > (sq.n + 4) * 6) tr.length = (sq.n + 4) * 6
    }
    const vmax = Math.max(u.t.speed, 40) * CATCH
    for (let i = 0; i < crew.length; i++) {
      const m = crew[i]
      m.wait -= dt
      if (m.wait <= 0) drift(w, m, apart)
      if ((m.x - u.x) * (m.x - u.x) + (m.y - u.y) * (m.y - u.y) > STRAY * STRAY) {
        m.x = u.x
        m.y = u.y
      }
      let goal = placeOf(u, m.k, m.ox, m.oy)
      if (m.lost > LOST || !standsAt(nav, 1, goal.x, goal.y) || !clear(w, m.x, m.y, goal.x, goal.y)) {
        // Through a gap: in file along the trail, in the order they stand in the squad.
        goal = trailAt(u, s * (0.6 + i * 0.8))
        if (m.lost > LOST && clear(w, m.x, m.y, placeOf(u, m.k, m.ox, m.oy).x, placeOf(u, m.k, m.ox, m.oy).y)) m.lost = 0
      }
      // A little apart from the others.
      for (const o of crew) {
        if (o === m) continue
        const dx = m.x - o.x
        const dy = m.y - o.y
        const d2 = dx * dx + dy * dy
        const min = apart * 0.6
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2)
          goal = { x: goal.x + (dx / d) * (min - d) * 0.5, y: goal.y + (dy / d) * (min - d) * 0.5 }
        }
      }
      const dx = goal.x - m.x
      const dy = goal.y - m.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      let walked = false
      if (dist > 0.5) {
        // Each walks at its own pace, slowing as it arrives.
        const pace = vmax * (0.9 + ((m.k * 37) % 10) * 0.02) * Math.min(1, dist / s)
        const step = Math.min(dist, pace * dt)
        const nx = m.x + (dx / dist) * step
        const ny = m.y + (dy / dist) * step
        if (standsAt(nav, 1, nx, ny)) {
          m.x = nx
          m.y = ny
          walked = true
        } else if (standsAt(nav, 1, nx, m.y)) {
          m.x = nx
          walked = true
        } else if (standsAt(nav, 1, m.x, ny)) {
          m.y = ny
          walked = true
        }
        m.lost = walked ? Math.max(0, m.lost - dt) : m.lost + dt
      }
      // Turned to its target, else to where it walks.
      const aim = m.t.find((id) => id)
      const e = aim ? w.byId.get(aim) : undefined
      const want = e && !e.dead ? M.atan2(e.y - m.y, e.x - m.x) : walked && dist > 2 ? M.atan2(dy, dx) : m.a
      const da = wrap(want - m.a)
      m.a = wrap(m.a + Math.max(-TURN * dt, Math.min(TURN * dt, da)))
    }
  }
}

/** Once a tick, after the fighting: each squad's members fall as its hull drops, one per 1/n of it
 * lost, the one that falls picked from the world's random stream. */
export function squadsTick(w: World) {
  for (const u of w.units) {
    const sq = u.t.ground?.squad
    if (!sq || u.dead) continue
    const crew = crewOf(w, u)
    const left = Math.max(1, Math.ceil((u.hull / u.hullMax) * sq.n - 1e-6))
    while (crew.length > left) crew.splice(Math.floor(rand(w) * crew.length), 1)
    u.members = crew.length
  }
}

/** The squads' own state in a world's hash (ground/combat.ts combatHash). */
export function squadHash(w: World, int: (v: number) => void, num: (v: number) => void) {
  for (const u of w.units) {
    if (!u.crew || u.dead) continue
    int(u.crew.length)
    int(u.spread ? 1 : 0)
    for (const m of u.crew) {
      int(m.k)
      num(m.x)
      num(m.y)
      num(m.a)
      num(m.ox)
      num(m.oy)
      num(m.wait)
      num(m.lost)
      for (const c of m.cd) num(c)
      for (const t of m.t) int(t)
    }
    int((u.trail ?? []).length)
    for (const v of u.trail ?? []) num(v)
  }
}
