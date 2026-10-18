// Combat in ground battles: who a ground unit goes after, its guns firing the seven ground weapons,
// shots in flight, splash and burns. Called from ground/world.ts (engage from the movement, and
// groundCombat once a tick after it); damage lands through the space sim's own `damage`, so kills,
// veterancy and the events that go with them are the space game's.
//
// - Targets: only enemies our team sees (allies' eyes count, which is how artillery reaches past its
//   own sight). An attack order goes after its target until it is gone; attack-move, patrols and idle
//   units take on what they meet by their stance (hold: only what is in reach; maneuver: give chase,
//   but only so far from where the fight started; roam: anything in sight). A plain move fires on the
//   way without stopping.
// - Guns: a turret (a hardpoint with a weapon) turns on its own and fires all round; a weapon fixed
//   along the nose (`arc`) fires only within its arc, so the unit turns to bring it to bear.
// - Weapons (data/kit.ts GROUND_VS, GROUND_ACC): pulse bolts and heavy shells fly straight at where
//   the target will be; rockets home in; artillery is lobbed onto a spot (a minimum range, a scatter
//   that grows with the distance, splash); swarm rockets go as a salvo onto a spot, with a little
//   splash; a beam holds on its target and burns harder the longer it does; a spray hurts everything
//   in a short cone and leaves a burn.
//
// Lockstep as the rest of the sim: the world's random stream, detmath, units in `w.units` order.

import * as M from '../detmath.ts'
import { GROUND_ACC, GROUND_VS, type Armour, type GroundWeaponKind, type UnitType } from '../data/kit.ts'
import { RANK_BONUS, damage, foes, hpPos, near, rand, sees, type Gun, type Owner, type Unit, type World } from '../sim.ts'
import { TILE } from './types.ts'
import { footDist } from './world.ts'

/** A shot in flight (World `gshots`): its weapon, where it is and how it moves, seconds left to fly
 * and flown (an artillery shell's arc goes by them), where it set off from, the unit it was fired at
 * (0: a spot) and the spot it lands on, its damage before armour, whether it connects, whose it is
 * (seat and unit), and the radius it hurts where it lands (0: only its target). */
export type GroundShot = {
  g: GroundWeaponKind
  x: number
  y: number
  vx: number
  vy: number
  left: number
  age: number
  flight: number
  sx: number
  sy: number
  target: number
  tx: number
  ty: number
  dmg: number
  hit: boolean
  owner: Owner
  from: number
  splash: number
}

/** Flight speeds, world units a second. */
const SPEED: Record<GroundWeaponKind, number> = { pulse: 900, beam: 0, rocket: 300, shell: 620, artillery: 380, swarm: 360, spray: 0 }
/** How far from where the fight started a Maneuver unit gives chase. */
const LEASH = TILE * 9
/** How much further than its guns reach a Maneuver unit takes on what it sees. */
const ACQUIRE = TILE * 4
/** Half the spray's cone, radians. */
export const CONE = 0.45
/** How long a spray's burn lasts after the spray moves on, seconds, and its share of the spray's damage. */
const BURN = { left: 2, share: 0.35 }
/** Seconds between a beam's or a spray's fire sounds while it holds. */
const HUM = 0.4

const TAU = Math.PI * 2
const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU)
const d2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by)

/** What a ground unit or building is armoured as. */
export const armourOf = (t: UnitType): Armour => t.ground?.armour ?? (t.tier === 'building' ? 'structure' : 'light')

/** How far (x, y) is from what can be hit of `e`: a building's footprint, or a unit's body. */
function edge(e: Unit, x: number, y: number) {
  if (e.foot) return footDist(e, x, y)
  return Math.max(0, Math.sqrt(d2(e.x, e.y, x, y)) - (e.t.ground?.radius ?? 10))
}

/** An enemy of `owner`'s that its team sees and can be shot at. */
function foe(w: World, owner: Owner, e: Unit | undefined): e is Unit {
  return !!e && !e.dead && foes(w, e.owner, owner) && sees(w, owner, e) && !(e.site && !e.site.started)
}

/** Where gun `g` of `u` fires from. */
export function muzzle(u: Unit, g: Gun) {
  if (g.hp >= 0) return hpPos(u, g.hp)
  const r = (u.t.ground?.radius ?? 10) * 0.7
  return { x: u.x + M.cos(u.a) * r, y: u.y + M.sin(u.a) * r }
}

/** Whether gun `g` of `u` (firing from `from`) can bring itself to bear on `e`: in reach, past its
 * minimum range, and inside its arc when it is fixed. */
function bears(u: Unit, g: Gun, e: Unit, from: { x: number; y: number }, slack = 0) {
  const d = edge(e, from.x, from.y)
  if (d > g.w.range + slack) return false
  if (g.w.min && Math.sqrt(d2(e.x, e.y, from.x, from.y)) < g.w.min) return false
  if (g.w.arc && g.hp < 0 && Math.abs(wrap(M.atan2(e.y - from.y, e.x - from.x) - u.a)) > g.w.arc) return false
  return true
}

/** How much a gun is worth turning on `e`: its damage against e's armour, times how likely it
 * connects. */
const worth = (g: Gun, e: Unit) => GROUND_VS[g.w.ground!][armourOf(e.t)] * GROUND_ACC[g.w.ground!][armourOf(e.t)]

/** The guns that work (not on a shot-off hardpoint). */
const working = (u: Unit) => u.guns.filter((g) => !!g.w.ground && (g.hp < 0 || u.hps[g.hp].hp > 0))

/** The furthest any of `u`'s working guns reach. */
const reachOf = (u: Unit) => Math.max(0, ...working(u).map((g) => g.w.range))

/** The enemy `u` should go after within `r` of it: what its guns hurt most, nearer first, the ones
 * shooting at it before others. */
function pick(w: World, u: Unit, r: number): Unit | undefined {
  const guns = working(u)
  let best: Unit | undefined
  let score = 0
  near(w, u.x, u.y, r + 120, (e) => {
    if (!foe(w, u.owner, e) || edge(e, u.x, u.y) > r) return
    const hurt = Math.max(0, ...guns.map((g) => worth(g, e)))
    const threat = e.target === u.id || u.hitBy === e.id ? 1.5 : 1
    const s = ((hurt + 0.05) * threat) / (Math.sqrt(d2(e.x, e.y, u.x, u.y)) + 100)
    if (s > score) {
      score = s
      best = e
    }
  })
  return best
}

/** The enemy unit (not a building) `u` should go after within `r`, if any. */
function pickUnit(w: World, u: Unit, r: number): Unit | undefined {
  let best: Unit | undefined
  let bd = Infinity
  near(w, u.x, u.y, r + 120, (e) => {
    if (e.foot || !foe(w, u.owner, e) || edge(e, u.x, u.y) > r) return
    const d = d2(e.x, e.y, u.x, u.y)
    if (d < bd) {
      bd = d
      best = e
    }
  })
  return best
}

/** What the fight wants of a unit's movement this tick: nothing (null: its orders as usual), its
 * attack order finished ('done': the target is gone or out of sight), stand and fire (`hold`, turned
 * to `face` when its guns are fixed), or drive to (x, y) (after a target, or back where it was). */
export type Engage = null | 'done' | { hold: true; face?: number } | { hold: false; x: number; y: number }

export function engage(w: World, u: Unit): Engage {
  const guns = working(u)
  if (!guns.length) return null
  const o = u.order
  const reach = reachOf(u)
  const fixed = guns.some((g) => g.hp < 0 && !!g.w.arc)
  const fight = (e: Unit): Engage => {
    u.target = e.id
    if (edge(e, u.x, u.y) <= reach * 0.85 && guns.some((g) => !g.w.min || Math.sqrt(d2(e.x, e.y, u.x, u.y)) >= g.w.min)) return { hold: true, face: fixed ? M.atan2(e.y - u.y, e.x - u.x) : undefined }
    return { hold: false, x: e.x, y: e.y }
  }
  if (o.k === 'attack') {
    const e = w.byId.get(o.id)
    if (!foe(w, u.owner, e)) {
      u.target = 0
      return 'done'
    }
    return fight(e)
  }
  // A plain move, building and gathering: no stopping for a fight (guns still fire on the way).
  if ((o.k === 'move' && !o.attack) || o.k === 'construct' || o.k === 'gather' || o.k === 'mend') {
    u.target = 0
    return null
  }
  const idle = o.k === 'idle' || o.k === 'guard'
  const range = u.stance === 'hold' ? reach : u.stance === 'roam' ? Math.max(reach, (u.t.ground?.sight ?? 8) * TILE) : reach + ACQUIRE
  let e = u.target ? w.byId.get(u.target) : undefined
  if (!foe(w, u.owner, e) || edge(e, u.x, u.y) > range * 1.3) e = undefined
  if (!e) {
    e = pick(w, u, range)
    // Where the fight starts: a Maneuver unit doesn't chase far from here.
    if (e && !u.target) {
      u.gx = u.x
      u.gy = u.y
    }
  }
  // On a building while enemy units come in reach (its repair crew, its defenders): them first.
  if (e?.foot) {
    const unit = pickUnit(w, u, reach)
    if (unit) e = unit
  }
  if (e && u.stance === 'maneuver' && d2(u.x, u.y, u.gx, u.gy) > LEASH * LEASH) e = undefined
  if (!e) {
    u.target = 0
    // Idle and drawn off its spot by a chase: back to it.
    if (idle && u.stance !== 'hold' && d2(u.x, u.y, u.ax, u.ay) > (TILE * 2) ** 2) return { hold: false, x: u.ax, y: u.ay }
    return null
  }
  const f = fight(e)
  // Holding its ground: fire at what comes in reach, never chase it.
  if (u.stance === 'hold' && f && f !== 'done' && !f.hold) {
    u.target = 0
    return null
  }
  return f
}

/** A chase that got nowhere (its target walled off): it lets the target go. */
export function giveUp(u: Unit) {
  u.target = 0
  if (u.order.k === 'attack') u.order = { k: 'idle' }
}

// --- Firing ------------------------------------------------------------------------------------------

/** Damage `amount` of weapon kind `g` dealt to `e` by unit `from` of `owner`, through its armour. */
function hurt(w: World, e: Unit, g: GroundWeaponKind, amount: number, owner: Owner, from: number, sx: number, sy: number, look: Gun['w']['kind']) {
  if (e.dead) return
  damage(w, e, amount * GROUND_VS[g][armourOf(e.t)], look, -1, sx, sy, owner, from)
}

/** Every enemy of `owner` within `r` of (x, y) takes `dmg` of weapon `g`, less towards the edge. */
function splash(w: World, x: number, y: number, r: number, g: GroundWeaponKind, dmg: number, owner: Owner, from: number, look: Gun['w']['kind']) {
  const hit: Unit[] = []
  near(w, x, y, r + TILE * 3, (e) => {
    if (!e.dead && foes(w, e.owner, owner) && e.t.ground && !(e.site && !e.site.started) && edge(e, x, y) <= r) hit.push(e)
  })
  for (const e of hit) hurt(w, e, g, dmg * (1 - (0.6 * edge(e, x, y)) / r), owner, from, x, y, look)
  w.events.push({ k: 'splash', x, y, r, owner })
}

/** One shot (or a salvo) from gun `g` of `u` at `e`. */
function fire(w: World, u: Unit, g: Gun, e: Unit) {
  const k = g.w.ground!
  const from = muzzle(u, g)
  const dmg = g.w.damage * (1 + RANK_BONUS * u.rank)
  const acc = GROUND_ACC[k][armourOf(e.t)]
  const dist = Math.sqrt(d2(e.x, e.y, from.x, from.y))
  const speed = SPEED[k]
  // Where the target will be when the shot gets there (it keeps going as it is).
  const lead = dist / speed
  const px = e.x + M.cos(e.a) * e.v * lead
  const py = e.y + M.sin(e.a) * e.v * lead
  const shot = (tx: number, ty: number, hit: boolean, target: number, flight: number, splashR: number, dmgEach: number): void => {
    const vx = (tx - from.x) / flight
    const vy = (ty - from.y) / flight
    ;(w.gshots ??= []).push({ g: k, x: from.x, y: from.y, vx, vy, left: flight, age: 0, flight, sx: from.x, sy: from.y, target, tx, ty, dmg: dmgEach, hit, owner: u.owner, from: u.id, splash: splashR })
  }
  if (k === 'artillery') {
    // Lobbed onto the spot, scattered more the further it goes.
    const spread = 14 + dist * 0.05
    const a = rand(w) * TAU
    const s = rand(w) * spread
    shot(px + M.cos(a) * s, py + M.sin(a) * s, true, 0, 0.6 + dist / speed, g.w.splash ?? 64, dmg)
  } else if (k === 'swarm') {
    // A salvo of small rockets spread over the spot.
    const n = Math.max(1, g.w.burst ?? 6)
    for (let i = 0; i < n; i++) {
      const a = rand(w) * TAU
      const s = rand(w) * (18 + dist * 0.04) * (rand(w) < acc ? 0.5 : 1.6)
      shot(px + M.cos(a) * s, py + M.sin(a) * s, true, 0, dist / speed + i * 0.05, g.w.splash ?? 36, dmg)
    }
  } else {
    const hit = rand(w) < acc
    let tx = px
    let ty = py
    if (!hit) {
      // A miss goes wide, past the target's side.
      const off = (e.t.ground?.radius ?? 12) * (1.2 + rand(w)) + 12
      const side = rand(w) < 0.5 ? -1 : 1
      const ang = M.atan2(ty - from.y, tx - from.x) + (side * Math.PI) / 2
      tx += M.cos(ang) * off
      ty += M.sin(ang) * off
    }
    const flight = Math.max(0.05, Math.sqrt(d2(tx, ty, from.x, from.y)) / speed)
    shot(tx, ty, hit, e.id, hit ? flight : flight * 1.4, 0, dmg)
  }
  w.events.push({ k: 'fire', kind: g.w.kind, x: from.x, y: from.y, owner: u.owner, light: k === 'pulse' || k === 'swarm' })
}

/** A beam or a spray holding on `e` this tick. */
function pour(w: World, u: Unit, g: Gun, e: Unit, dt: number) {
  const k = g.w.ground!
  const from = muzzle(u, g)
  g.hold = (g.hold ?? 0) + dt
  const dmg = g.w.damage * (1 + RANK_BONUS * u.rank) * dt
  if (k === 'beam') {
    // Burns harder the longer it holds the same target: up to twice as hard after two seconds.
    hurt(w, e, k, dmg * Math.min(2, 1 + g.hold / 2), u.owner, u.id, from.x, from.y, g.w.kind)
  } else {
    // A spray: everything in its cone, each left burning a while.
    const hit: Unit[] = []
    near(w, from.x, from.y, g.w.range + TILE * 3, (o) => {
      if (!foe(w, u.owner, o) || edge(o, from.x, from.y) > g.w.range) return
      if (Math.abs(wrap(M.atan2(o.y - from.y, o.x - from.x) - g.aim)) > CONE) return
      hit.push(o)
    })
    for (const o of hit) {
      hurt(w, o, k, dmg, u.owner, u.id, from.x, from.y, g.w.kind)
      o.burn = { dps: g.w.damage * BURN.share, left: BURN.left, by: u.owner, from: u.id }
    }
  }
  g.cd -= dt
  if (g.cd <= 0) {
    g.cd = HUM
    w.events.push({ k: 'fire', kind: g.w.kind, x: from.x, y: from.y, owner: u.owner, light: true })
  }
}

/** One tick of `u`'s guns: each takes the unit's target when it bears on it (or a building's
 * focus), else the best enemy it bears on, and fires when it has reloaded. */
function shoot(w: World, u: Unit, dt: number) {
  if (u.focus && !foe(w, u.owner, w.byId.get(u.focus))) u.focus = 0
  const primary = u.focus ? w.byId.get(u.focus) : u.target ? w.byId.get(u.target) : undefined
  for (const g of u.guns) {
    if (!g.w.ground || (g.hp >= 0 && u.hps[g.hp].hp <= 0)) continue
    const k = g.w.ground
    const steady = k === 'beam' || k === 'spray'
    if (!steady) g.cd -= dt
    const from = muzzle(u, g)
    let e: Unit | undefined = foe(w, u.owner, primary) && bears(u, g, primary, from) ? primary : undefined
    if (!e) {
      const kept = g.target ? w.byId.get(g.target) : undefined
      if (foe(w, u.owner, kept) && bears(u, g, kept, from)) e = kept
    }
    if (!e) {
      let score = 0
      near(w, from.x, from.y, g.w.range + TILE * 3, (o) => {
        if (!foe(w, u.owner, o) || !bears(u, g, o, from)) return
        const s = (worth(g, o) + 0.05) / (Math.sqrt(d2(o.x, o.y, from.x, from.y)) + 100)
        if (s > score) {
          score = s
          e = o
        }
      })
    }
    if (!e) {
      g.target = 0
      g.hold = 0
      continue
    }
    if (g.target !== e.id) g.hold = 0
    g.target = e.id
    g.aim = M.atan2(e.y - from.y, e.x - from.x)
    if (steady) {
      pour(w, u, g, e, dt)
      continue
    }
    if (g.cd > 0) continue
    fire(w, u, g, e)
    g.cd = g.w.cooldown * (0.9 + rand(w) * 0.2)
  }
}

/** Shots in flight: rockets home in on their target; a shot that has flown its time lands, on its
 * target (pulse, rocket, shell) or on its spot with splash (artillery, swarm rockets). */
function fly(w: World, dt: number) {
  const shots = w.gshots
  if (!shots?.length) return
  const keep: GroundShot[] = []
  for (const s of shots) {
    s.age += dt
    if (s.g === 'rocket' && s.hit) {
      const e = w.byId.get(s.target)
      if (e && !e.dead) {
        const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy)
        const ang = M.atan2(e.y - s.y, e.x - s.x)
        const cur = M.atan2(s.vy, s.vx)
        const turn = 4 * dt
        const na = cur + Math.max(-turn, Math.min(turn, wrap(ang - cur)))
        s.vx = M.cos(na) * sp
        s.vy = M.sin(na) * sp
        s.left = Math.max(s.left, Math.sqrt(d2(e.x, e.y, s.x, s.y)) / sp)
      }
    }
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.left -= dt
    if (s.left > 0 && s.age < 6) {
      keep.push(s)
      continue
    }
    const look = s.g === 'pulse' ? 'laser' : s.g === 'rocket' || s.g === 'swarm' ? 'missile' : 'turbo'
    if (s.splash > 0) {
      splash(w, s.x, s.y, s.splash, s.g, s.dmg, s.owner, s.from, look)
      w.events.push({ k: 'hit', kind: look, x: s.x, y: s.y, shield: false, owner: s.owner })
      continue
    }
    if (!s.hit) continue
    const e = w.byId.get(s.target)
    if (!e || e.dead) continue
    hurt(w, e, s.g, s.dmg, s.owner, s.from, s.sx, s.sy, look)
    w.events.push({ k: 'hit', kind: look, x: s.x, y: s.y, shield: false, owner: e.owner })
  }
  w.gshots = keep
}

/** Burns from sprays eat at what they caught. */
function burns(w: World, dt: number) {
  for (const u of w.units) {
    const b = u.burn
    if (!b || u.dead) continue
    damage(w, u, b.dps * GROUND_VS.spray[armourOf(u.t)] * dt, 'flak', -1, u.x, u.y, b.by, b.from)
    b.left -= dt
    if (b.left <= 0) delete u.burn
  }
}

/** The ground battle's combat for one tick, after the units moved: every armed ground unit and
 * finished building fires, shots fly and land, burns burn. */
export function groundCombat(w: World, dt: number) {
  const n = w.units.length
  for (let i = 0; i < n; i++) {
    const u = w.units[i]
    if (u.dead || !u.t.ground || !u.guns.length || u.site) continue
    shoot(w, u, dt)
  }
  fly(w, dt)
  burns(w, dt)
}

/** The fight's own state in a world's hash (ground/world.ts groundHash). */
export function combatHash(w: World, int: (v: number) => void, num: (v: number) => void) {
  const shots = w.gshots ?? []
  int(shots.length)
  for (const s of shots) {
    num(s.x)
    num(s.y)
    num(s.left)
  }
  for (const u of w.units) {
    if (u.dead || !u.t.ground) continue
    if (u.guns.length) {
      int(u.target)
      for (const g of u.guns) {
        num(g.cd)
        int(g.target)
        num(g.hold ?? 0)
      }
    }
    if (u.burn) num(u.burn.left)
  }
}
