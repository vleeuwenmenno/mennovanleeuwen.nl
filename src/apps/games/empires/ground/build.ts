import type { FactionId } from '../data.ts'
import type { Model } from '../models/types.ts'
import { groundModelFor } from '../models/ground.ts'
import { TF, TILE, canStep } from './types.ts'
import { onMap } from './nav.ts'
import { explored, seesAt } from './fog.ts'
import { DEFAULT_RANGE } from './units.ts'
import {
  GROUND_UNIT, GROUND_UNITS, MAX_ORDERS, addSite, footDist, needsWork, own, removeUnit, seesFoot, spotsTaken, teamOf, typeOf, workSpot,
  type GroundUnit, type GroundWorld, type KnownBuilding, type Owner,
} from './sim.ts'

// Building and training in ground battles: placing a building on the tile grid, engineers putting
// it up, structures training units, and what the screen asks about them. This file is the contract
// between the sim side and the battle screen (which only calls these). The work itself (sites that
// start and grow, repairs, training queues, income) runs in the sim's tick (sim.ts, "Works").
//
// What a player knows decides what they may do: placement goes by the team's fog (explored ground,
// enemy units it sees, enemy buildings it sees or remembers), never by what it can't see. A site on
// ground where a hidden enemy building already stands is accepted, and given up with a full refund
// when its engineer gets there (sim.ts startSite).

/** One tile of a placement ghost: whether a building may cover it. */
export type TileCheck = { tc: number; tr: number; ok: boolean }

/** Where a building would go: its footprint's top-left tile, what it costs, every tile checked, and
 * the first rule that fails (null when it may go there). The ghost under the cursor shows this.
 * `door`: the row of tiles in front of its door (south side), which must stay free. */
export type Placement = { why: string | null; tc: number; tr: number; cost: number; tiles: TileCheck[]; door?: TileCheck[] }

/** The slice's two unit types per faction, by faction. */
export type SliceIds = { engineer: string; center: string }
export const SLICE_IDS: Record<FactionId, SliceIds> = {
  republic: { engineer: 'r-g-engineer', center: 'r-g-center' },
  droid: { engineer: 'd-g-engineer', center: 'd-g-center' },
  swarm: { engineer: 's-g-engineer', center: 's-g-center' },
}

/** How far (in tiles, middle to middle) a standalone building (a Command Center) must stay from
 * every enemy building we know of. */
export const STANDALONE_GAP = 20
/** Most units a structure's queue holds. */
export const QUEUE_MAX = 10
/** How many units one shift-click queues. */
export const TRAIN_BATCH = 5

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** A footprint a team knows of: its tiles, and whether the building is an enemy's. */
type Foot = { tc: number; tr: number; fw: number; fh: number; enemy: boolean; type: string }

/**
 * The buildings `owner`'s team knows stand on the map: all of its own team's (sites nobody has
 * started included), the other teams' it sees now, and the ones it remembers seeing.
 */
function knownFeet(w: GroundWorld, owner: Owner): Foot[] {
  const team = teamOf(w, owner)
  const out: Foot[] = []
  const seen = new Set<number>()
  for (const u of w.units) {
    const t = typeOf(u)
    if (u.dead || !t.foot) continue
    const mine = teamOf(w, u.owner) === team
    // Another seat's unstarted site is a secret even from its teammates.
    if (u.site && !u.site.started && u.owner !== owner) continue
    if (!mine && !(u.stamped && seesFoot(w, team, u.tc, u.tr, t.foot[0], t.foot[1]))) continue
    seen.add(u.id)
    out.push({ tc: u.tc, tr: u.tr, fw: t.foot[0], fh: t.foot[1], enemy: !mine, type: u.type })
  }
  for (const k of w.memory[team]?.values() ?? []) {
    if (seen.has(k.id)) continue
    const [fw, fh] = GROUND_UNIT[k.type].foot!
    out.push({ tc: k.tc, tr: k.tr, fw, fh, enemy: true, type: k.type })
  }
  return out
}

const covers = (f: Foot, c: number, r: number) => c >= f.tc && c < f.tc + f.fw && r >= f.tr && r < f.tr + f.fh
/** Whether tile (c, r) is in front of footprint f's door (the row under its south side). */
const doorOf = (f: Foot, c: number, r: number) => r === f.tr + f.fh && c >= f.tc && c < f.tc + f.fw

/** Why one tile can't be under a building, by the placement's first rule; '' when it can. In the
 * order the reasons are reported. */
const TILE_RULES = ['Unexplored ground', 'Not on buildable ground', 'A deposit is in the way', 'The ground must be level', 'Something is built there', "It would block a building's door"] as const

/** Where building `type` would go with its footprint centred as near (x, y) as the grid allows.
 * The rules, in order: every tile explored, buildable, on one level and free of deposits and
 * buildings (and of other buildings' doors); inside the command range of one of our buildings, or
 * for a standalone one (a Command Center) anywhere at least STANDALONE_GAP tiles from a known enemy
 * building; no enemy unit we see on it; its door row free; enough credits. */
export function placement(w: GroundWorld, owner: Owner, type: string, x: number, y: number): Placement {
  const t = GROUND_UNIT[type]
  const p = w.players[owner]
  if (!t || t.kind !== 'structure' || !t.foot || !p) return { why: 'Not a building', tc: 0, tr: 0, cost: 0, tiles: [] }
  const g = w.map.grid
  const { cols, rows } = g
  const [fw, fh] = t.foot
  const tc = clamp(Math.round(x / TILE - fw / 2), 0, cols - fw)
  const tr = clamp(Math.round(y / TILE - fh / 2), 0, rows - fh)
  const cost = t.cost ?? 0
  const team = p.team
  const feet = knownFeet(w, owner).filter((f) => f.tc < tc + fw + 1 && tc < f.tc + f.fw + 1 && f.tr < tr + fh + 1 && tr < f.tr + f.fh + 1)
  const level = g.height[(tr + (fh >> 1)) * cols + tc + (fw >> 1)]
  // 1. The ground under it.
  let worst: number = TILE_RULES.length
  const tiles: TileCheck[] = []
  for (let r = tr; r < tr + fh; r++)
    for (let c = tc; c < tc + fw; c++) {
      const i = r * cols + c
      const f = g.flags[i]
      const rule = !explored(w.fog, team, i)
        ? 0
        : f & (TF.blocked | TF.water | TF.noBuild | TF.ramp)
          ? 1
          : f & TF.deposit
            ? 2
            : g.height[i] !== level
              ? 3
              : feet.some((k) => covers(k, c, r))
                ? 4
                : feet.some((k) => doorOf(k, c, r))
                  ? 5
                  : -1
      tiles.push({ tc: c, tr: r, ok: rule < 0 })
      if (rule >= 0) worst = Math.min(worst, rule)
    }
  // The row in front of the door: open ground, joined to the footprint's edge, nothing built on it.
  const door: TileCheck[] = []
  const dr = tr + fh
  for (let c = tc; c < tc + fw; c++) {
    const i = dr * cols + c
    const ok = dr < rows && explored(w.fog, team, i) && (g.flags[i] & TF.blocked) === 0 && canStep(g, i - cols, i) && !feet.some((k) => covers(k, c, dr))
    door.push({ tc: c, tr: dr, ok })
  }
  const out = (why: string | null): Placement => ({ why, tc, tr, cost, tiles, door })
  if (worst < TILE_RULES.length && worst !== 5) return out(TILE_RULES[worst])
  // 2. Command range: near one of our buildings, or (standalone) away from the enemy's.
  const cx = (tc + fw / 2) * TILE
  const cy = (tr + fh / 2) * TILE
  if (t.standalone) {
    const gap = STANDALONE_GAP * TILE
    const near = knownFeet(w, owner).some((f) => {
      const dx = cx - (f.tc + f.fw / 2) * TILE
      const dy = cy - (f.tr + f.fh / 2) * TILE
      return f.enemy && dx * dx + dy * dy < gap * gap
    })
    if (near) return out(`Too close to an enemy building (keep ${STANDALONE_GAP} tiles away)`)
  } else if (!inCommand(w, owner, cx, cy)) return out('Outside the command range of your buildings')
  // 3. Enemy units we can see on it.
  const box = { x0: tc * TILE, y0: tr * TILE, x1: (tc + fw) * TILE, y1: (tr + fh) * TILE }
  for (const u of w.units) {
    if (u.dead || typeOf(u).kind !== 'vehicle' || teamOf(w, u.owner) === team || !seesAt(w.fog, team, u.x, u.y)) continue
    const dx = Math.max(box.x0 - u.x, 0, u.x - box.x1)
    const dy = Math.max(box.y0 - u.y, 0, u.y - box.y1)
    if (dx * dx + dy * dy < typeOf(u).radius * typeOf(u).radius) return out('Enemy units are in the way')
  }
  // 4. Doors: its own, and the ones it would stand in front of.
  if (!door.every((d) => d.ok)) return out('No room in front of its door')
  if (worst === 5) return out(TILE_RULES[5])
  // 5. Credits.
  if (p.credits < cost) return out('Not enough credits')
  return out(null)
}

/** Whether (x, y) lies inside the command range of one of `owner`'s standing buildings (sites
 * nobody has started don't count). */
export function inCommand(w: GroundWorld, owner: Owner, x: number, y: number) {
  return commandAreas(w, owner).some((a) => (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y) <= a.r * a.r)
}

/** The command range circles of `owner`'s standing buildings, in world units: where the ghost can
 * show the area a building may go in. */
export function commandAreas(w: GroundWorld, owner: Owner): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = []
  for (const u of w.units) {
    if (u.dead || u.owner !== owner || !u.stamped) continue
    out.push({ x: u.x, y: u.y, r: (typeOf(u).range ?? DEFAULT_RANGE) * TILE })
  }
  return out
}

/** What engineers `ids` (of `owner`) may build: building type ids, in card order. */
export function buildable(w: GroundWorld, owner: Owner): string[] {
  const f = w.players[owner]?.faction
  const out: string[] = []
  for (const t of GROUND_UNITS) if (t.faction === f) for (const b of t.builds ?? []) if (!out.includes(b)) out.push(b)
  return out
}

/** What structure `id` may train, in card order. */
export function trainable(w: GroundWorld, id: number): string[] {
  const u = w.byId.get(id)
  if (!u || u.dead || u.site) return []
  return typeOf(u).trains ?? []
}

/** Why `owner` can't train `type` at structure `id` now, or null. */
export function cantTrain(w: GroundWorld, owner: Owner, id: number, type: string): string | null {
  const u = w.byId.get(id)
  if (!u || u.dead || u.owner !== owner || typeOf(u).kind !== 'structure') return 'Not your building'
  if (u.site) return 'Still under construction'
  if (!(typeOf(u).trains ?? []).includes(type)) return "It can't train that"
  if (u.queue.length >= QUEUE_MAX) return 'The queue is full'
  if ((w.players[owner]?.credits ?? 0) < (GROUND_UNIT[type].cost ?? 0)) return 'Not enough credits'
  return null
}

/** A building site's progress, 0 to 1, or null when `u` is not a site under construction. */
export function siteProgress(u: GroundUnit): number | null {
  return u.site ? u.site.work : null
}

/** A structure's training queue: type ids and the progress of the first, 0 to 1. */
export function queueOf(u: GroundUnit): { items: string[]; progress: number } {
  const first = u.queue[0]
  return { items: u.queue, progress: first ? Math.min(1, u.qt / Math.max(1e-6, GROUND_UNIT[first]?.build ?? 1)) : 0 }
}

/** The model a ground unit type is drawn with (procedural parts, as space ships are), or null
 * while it has none: the screen then draws a plain marker. Model space as in space: nose up (-y),
 * so a vehicle with sim heading h (0 is +x) is drawn turned by h + π/2, and a building (facing south,
 * its door at +y) unturned. Draw it groundDrawSize(type) world units on its long side. */
export function groundModel(type: string): Model | null {
  return groundModelFor(type)
}

/** How big to draw a ground unit type, world units on its model's long side: a building its
 * footprint, a vehicle a little wider than its body. */
export function groundDrawSize(type: string): number {
  const t = GROUND_UNIT[type]
  if (!t) return TILE
  return t.foot ? Math.max(t.foot[0], t.foot[1]) * TILE : t.radius * 2.6
}

/** Whether a player sees unit `u` now: their own team's always (except a teammate's site nobody has
 * started yet), anyone else's while their team sees it. Buildings no longer seen are in
 * knownBuildings, to draw as ghosts. */
export function shownTo(w: GroundWorld, viewer: Owner, u: GroundUnit): boolean {
  if (u.dead) return false
  if (u.site && !u.site.started) return u.owner === viewer
  const team = teamOf(w, viewer)
  if (teamOf(w, u.owner) === team) return true
  const t = typeOf(u)
  return t.foot ? seesFoot(w, team, u.tc, u.tr, t.foot[0], t.foot[1]) : seesAt(w.fog, team, u.x, u.y)
}

/** The enemy buildings `viewer`'s team remembers (the enemy's starting Command Centers from the
 * first second), as last seen: the screen draws the ones it doesn't see now as ghosts in the fog. */
export function knownBuildings(w: GroundWorld, viewer: Owner): KnownBuilding[] {
  return [...(w.memory[teamOf(w, viewer)]?.values() ?? [])]
}

/** Credits a second `owner` earns now, for the top bar. */
export const incomeOf = (w: GroundWorld, owner: Owner) => w.players[owner]?.income ?? 0

// --- Orders (in commands.ts's table) ------------------------------------------------------------

/** Sends engineers to build or repair structure `s`, each to its own spot round it, nearest first. */
function sendCrew(w: GroundWorld, engs: GroundUnit[], s: GroundUnit, queued: boolean) {
  const taken = spotsTaken(w, s)
  const order = engs.map((u, i) => ({ u, i, d: footDist(s, u.x, u.y) })).sort((a, b) => a.d - b.d || a.i - b.i)
  for (const { u } of order) {
    const at = workSpot(w, u, s, taken)
    const o = { k: 'build' as const, id: s.id, x: at.x, y: at.y }
    if (queued && u.orders.length) {
      if (u.orders.length < MAX_ORDERS) u.orders.push(o)
    } else {
      u.orders = [o]
      u.path = []
      u.pv = -1
    }
  }
}

/** Engineers `ids` place building `type` centred near (x, y) and go to build it; `queued`: after
 * their current orders. Pays for it now. Returns why not, or null. */
export function cmdPlace(w: GroundWorld, owner: Owner, ids: number[], type: string, x: number, y: number, queued: boolean): string | null {
  const engs = own(w, owner, ids).filter((u) => typeOf(u).builds?.includes(type))
  if (!engs.length) return 'Select an engineer that can build that'
  const p = placement(w, owner, type, x, y)
  if (p.why) return p.why
  w.players[owner].credits -= p.cost
  const s = addSite(w, type, owner, p.tc, p.tr, p.cost)
  sendCrew(w, engs, s, queued)
  return null
}

/** Engineers `ids` go and build (or repair) structure `id` of ours. */
export function cmdConstruct(w: GroundWorld, owner: Owner, ids: number[], id: number, queued: boolean): string | null {
  const s = w.byId.get(id)
  if (!s || s.dead || s.owner !== owner || typeOf(s).kind !== 'structure') return 'Not your building'
  if (!needsWork(s)) return 'Nothing to build or repair there'
  const engs = own(w, owner, ids).filter((u) => !!typeOf(u).builds?.length)
  if (!engs.length) return 'Select an engineer'
  sendCrew(w, engs, s, queued)
  return null
}

/** Structure `id` trains one `type` (`count` of them with shift: 5). Each is paid for as it is
 * queued; as many as there are credits and room for. */
export function cmdTrain(w: GroundWorld, owner: Owner, id: number, type: string, count: number): string | null {
  const why = cantTrain(w, owner, id, type)
  if (why) return why
  const u = w.byId.get(id)!
  const n = clamp(Math.floor(count), 1, TRAIN_BATCH)
  for (let i = 0; i < n && !cantTrain(w, owner, id, type); i++) {
    w.players[owner].credits -= GROUND_UNIT[type].cost ?? 0
    u.queue.push(type)
  }
  return null
}

/** Cancel item `index` of structure `id`'s queue, or a site under construction when `index` is -1.
 * A queued unit is refunded in full. A site is refunded in full before work starts, and after that
 * the share of it not yet built. */
export function cmdCancel(w: GroundWorld, owner: Owner, id: number, index: number): string | null {
  const u = w.byId.get(id)
  if (!u || u.dead || u.owner !== owner || typeOf(u).kind !== 'structure') return 'Not your building'
  const p = w.players[owner]
  if (index === -1) {
    if (!u.site) return 'Not under construction'
    p.credits += u.site.started ? u.site.paid * (1 - u.site.work) : u.site.paid
    removeUnit(w, u)
    return null
  }
  if (index < 0 || index >= u.queue.length) return 'Nothing to cancel there'
  p.credits += GROUND_UNIT[u.queue[index]]?.cost ?? 0
  u.queue.splice(index, 1)
  if (index === 0) u.qt = 0
  return null
}

/** Structure `id`'s rally point. */
export function cmdRally(w: GroundWorld, owner: Owner, id: number, x: number, y: number): string | null {
  const u = w.byId.get(id)
  if (!u || u.dead || u.owner !== owner || typeOf(u).kind !== 'structure') return 'Not your building'
  u.rally = onMap(w.nav, 1, x, y)
  return null
}
