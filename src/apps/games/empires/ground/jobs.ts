import { GROUND_TECH, UNIT, type UnitType } from '../data.ts'
import { giveBack, remod, spend, type Owner, type Player, type Unit, type World } from '../sim.ts'

// A factory's upgrades in a ground battle: one job at a time (Unit `gj`), either the upgrade to its
// next tier (GroundSpec `tierUp`) or a piece of research for the units it trains (GROUND_TECH),
// each paid with research points (the research stations make them) and kyber when started, taking
// time, drawing power while it runs (ground/power.ts busyDraw) and slowed when power is short, and
// refunded in full when called off. Lockstep rules as in sim.ts: units in `w.units` order, no
// Math.random, no Date, no DOM.
//
// A factory's tier is its type's (GroundSpec `tier`): an upgrade swaps it for the same factory at
// the next tier (`factoryType`), with more hull and a grown model, as the space game's stations grow
// with their level. Research done joins the side's `techs` and works through the space game's
// research path (sim.ts techBonus and remod).

/** Hull a factory has at each tier, as a share of its tier 1 hull. */
const TIER_HULL = [1, 1.25, 1.5]
/** Most tiers a factory reaches. */
export const TIER_MAX = 3

const typed = new Map<string, UnitType>()
/**
 * Factory type `id` at `tier`: the same factory with its tier, more hull and the look of that tier
 * (its model grows, models/<faction>/ground.ts). Made once per id and tier, so every copy of a battle
 * shares it.
 */
export function factoryType(id: string, tier: number): UnitType {
  const base = UNIT[id]
  if (tier <= (base.ground!.tier ?? 1)) return base
  const key = `${id}:${tier}`
  let t = typed.get(key)
  if (!t) typed.set(key, (t = { ...base, hull: Math.round(base.hull * TIER_HULL[tier - 1]), ground: { ...base.ground!, tier } }))
  return t
}

/** The tier building `s` stands at (1 for anything without one). */
export const tierAt = (s: Unit) => s.t.ground?.tier ?? 1

/** What job `job` at building `s` costs and draws: its next tier ('tier') or a piece of research. */
export function jobCost(s: Unit, job: string): { rp: number; cost: number; time: number; draw: number; name: string } | null {
  const g = s.t.ground
  if (!g?.factory) return null
  if (job === 'tier') {
    // The game's own type's prices: a battle saved before them carries a copy of the type without.
    const up = (UNIT[s.t.id]?.ground?.tierUp ?? g.tierUp)?.[tierAt(s) - 1]
    return up ? { ...up, name: `Tier ${tierAt(s) + 1}` } : null
  }
  const r = GROUND_TECH[job]
  return r && r.for === s.t.id ? { rp: r.rp, cost: r.cost, time: r.time, draw: r.draw, name: r.name } : null
}

/** Power factory `s` draws for its job now (none without one). */
export const jobDraw = (s: Unit) => (s.gj ? (jobCost(s, s.gj.id)?.draw ?? 0) : 0)

/** Why factory `s` can't take job `job` for `owner` now, or null. Locks first (what the screen shows
 * greyed out with its reason), then what can change (a job running, research points, kyber). */
export function cantJob(w: World, owner: Owner, s: Unit, job: string): string | null {
  const p = w.players[owner]
  if (s.dead || s.owner !== owner || !s.foot) return 'No factory of ours'
  if (s.site) return 'Not built yet'
  if (!s.t.ground?.factory) return 'Only factories upgrade'
  if (job === 'tier' && tierAt(s) >= TIER_MAX) return 'At the top tier'
  const c = jobCost(s, job)
  if (!c) return 'Not done here'
  if (job !== 'tier') {
    if (p.techs.includes(job)) return 'Already researched'
    const r = GROUND_TECH[job]
    if (tierAt(s) < r.tier) return `Needs the ${s.t.name} at tier ${r.tier}`
    // The same research at another factory of ours of this type.
    if (w.units.some((u) => !u.dead && u.owner === owner && u.gj?.id === job)) return 'Already under way'
  }
  if (s.gj) return `Busy: ${jobCost(s, s.gj.id)?.name ?? 'working'}`
  if ((p.rp ?? 0) < c.rp) return `Needs ${c.rp} research points`
  if (p.credits < c.cost) return 'Not enough kyber'
  return null
}

/** Factory `s` starts job `job`, paid now (cmdGroundJob). */
export function startJob(w: World, owner: Owner, s: Unit, job: string): string | null {
  const why = cantJob(w, owner, s, job)
  if (why) return why
  const p = w.players[owner]
  const c = jobCost(s, job)!
  p.rp = (p.rp ?? 0) - c.rp
  spend(w, p, c.cost, 'research', `${s.t.name}: ${c.name}`)
  s.gj = { id: job, left: c.time, total: c.time, rp: c.rp, cost: c.cost }
  return null
}

/** Factory `s` calls its job off: what it paid comes back in full (cmdCancelGroundJob). */
export function cancelJob(w: World, owner: Owner, s: Unit): string | null {
  if (s.owner !== owner || !s.gj) return 'Nothing under way'
  refund(w, w.players[owner], s)
  return null
}

function refund(w: World, p: Player, s: Unit) {
  const j = s.gj!
  p.rp = (p.rp ?? 0) + j.rp
  giveBack(w, p, j.cost, 'research', `Cancelled: ${s.t.name}: ${jobCost(s, j.id)?.name ?? j.id}`)
  delete s.gj
}

/** One tick of every factory's job, at the side's power ratio (`power`, by owner, from groundPower):
 * a job done raises the factory's tier or adds the research. */
export function jobsTick(w: World, dt: number, power: number[]) {
  const n = w.units.length
  for (let i = 0; i < n; i++) {
    const s = w.units[i]
    if (s.dead || !s.gj || s.site) continue
    s.gj.left = Math.max(0, s.gj.left - dt * power[s.owner])
    if (s.gj.left > 1e-9) continue
    const job = s.gj.id
    delete s.gj
    if (job === 'tier') raise(w, s)
    else finish(w, s.owner, job)
  }
}

/** Factory `s` up a tier: its type at the new tier, its hull grown by as much (keeping its damage). */
function raise(w: World, s: Unit) {
  const t = factoryType(s.t.id, tierAt(s) + 1)
  const max = t.hull * s.mods.hull
  s.hull += max - s.hullMax
  s.hullMax = max
  s.t = t
  w.events.push({ k: 'tierUp', owner: s.owner, unit: t.id, tier: t.ground!.tier!, x: s.x, y: s.y })
}

/** Research `id` done for `owner`: the side's, and every unit of the types its factory trains takes it. */
function finish(w: World, owner: Owner, id: string) {
  const p = w.players[owner]
  p.techs.push(id)
  const trains = UNIT[GROUND_TECH[id].for].ground?.trains ?? []
  for (const u of w.units) if (!u.dead && u.owner === owner && trains.includes(u.t.id)) remod(w, u)
  w.events.push({ k: 'tech', owner, id })
}
