import type { Unit, World } from '../sim.ts'
import { jobDraw } from './jobs.ts'

// Power and research points in a ground battle, per side, worked out once a tick by the buildings'
// work (world.ts works). Lockstep rules as in sim.ts: units in `w.units` order, no Math.random, no
// Date, no DOM.
//
// - Power is made by finished buildings with `power` (GroundSpec): the Command Center a little, a
//   power generator more. A generator burns `burn` kyber a second to run; when the side can't pay a
//   tick's burn it makes nothing that tick.
// - Power is drawn by whatever is busy (`busyDraw`): a construction site while engineers build it
//   (SITE_DRAW), a building with `draw` while it trains (its queue isn't empty), a factory's upgrade
//   or research its own draw while it runs (ground/jobs.ts), and a research station all the time.
// - Short of power, every consumer of that side runs at made / used of its speed: the same ratio for
//   all, so nothing depends on the order they are in.
// - Research stations make research points (`research` a second each, at the side's ratio), banked
//   per side (Player `rp`) for the factories' upgrades to spend.

/** Power a construction site draws while engineers build it. */
export const SITE_DRAW = 3

/** A side's power this tick: made, drawn, and the share of its speed every consumer runs at. */
export type PowerState = { made: number; used: number; ratio: number }

/** The power building `s` draws now: a site being built (by `crew` engineers), a building with a
 * draw while it trains, a factory's upgrade or research while it runs, and a research station
 * always. */
export function busyDraw(s: Unit, crew: number): number {
  const g = s.t.ground
  if (!g || s.dead) return 0
  if (s.site) return s.site.started && crew > 0 ? SITE_DRAW : 0
  if (g.research) return g.draw ?? 0
  return (g.draw && s.yq?.length ? g.draw : 0) + jobDraw(s)
}

/**
 * Each side's power for this tick, and its research points: generators burn their kyber (stopping
 * when the side has none), the made and used power are added up, and research stations add their
 * points at the side's ratio. `crews`: how many engineers work on each site this tick. Returns the
 * ratio each side's consumers run at (1 with power enough), by owner; also kept on the players for
 * the screen (Player `power`).
 */
export function groundPower(w: World, dt: number, crews: Map<number, number>): number[] {
  const made = w.players.map(() => 0)
  const used = w.players.map(() => 0)
  for (const s of w.units) {
    if (s.dead || !s.foot) continue
    const g = s.t.ground!
    used[s.owner] += busyDraw(s, crews.get(s.id) ?? 0)
    if (s.site || !g.power) continue
    const p = w.players[s.owner]
    const burn = (g.burn ?? 0) * dt
    if (burn > 0) {
      // A generator that can't pay this tick's kyber makes nothing.
      if (p.credits < burn) continue
      p.credits -= burn
      p.burnt = (p.burnt ?? 0) + burn
    }
    made[s.owner] += g.power
  }
  const ratio = w.players.map((p, o) => {
    const r = used[o] > made[o] ? made[o] / used[o] : 1
    p.power = { made: made[o], used: used[o], ratio: r }
    return r
  })
  for (const s of w.units) {
    if (s.dead || !s.foot || s.site || !s.t.ground!.research) continue
    const p = w.players[s.owner]
    p.rp = (p.rp ?? 0) + s.t.ground!.research * ratio[s.owner] * dt
  }
  return ratio
}

/** What a side's power is made of and spent on now, for the screen (the top bar's tip, the economy
 * panel): read from the world, changing nothing. */
export type PowerReport = {
  made: number
  used: number
  ratio: number
  /** Power made by Command Centers and by generators running, and the generators stopped (no kyber). */
  centers: number
  generators: number
  stopped: number
  /** Power drawn by sites being built, training, the factories' upgrades and research, and research
   * stations. */
  sites: number
  training: number
  upgrades: number
  research: number
  /** Kyber a second the generators burn, and research points a second the stations make now. */
  burn: number
  rpRate: number
  /** Research points banked, and those paid for the upgrades and research under way. */
  rp: number
  rpSpent: number
}

export function powerReport(w: World, owner: number): PowerReport {
  const p = w.players[owner]
  const crews = new Map<number, number>()
  for (const u of w.units) if (!u.dead && u.gm?.busy) crews.set(u.gm.busy, (crews.get(u.gm.busy) ?? 0) + 1)
  const r: PowerReport = { made: p.power?.made ?? 0, used: p.power?.used ?? 0, ratio: p.power?.ratio ?? 1, centers: 0, generators: 0, stopped: 0, sites: 0, training: 0, upgrades: 0, research: 0, burn: 0, rpRate: 0, rp: p.rp ?? 0, rpSpent: 0 }
  for (const s of w.units) {
    if (s.dead || !s.foot || s.owner !== owner) continue
    const g = s.t.ground!
    const draw = busyDraw(s, crews.get(s.id) ?? 0)
    if (s.site) r.sites += draw
    else if (g.research) {
      r.research += draw
      r.rpRate += g.research * r.ratio
    } else {
      const job = jobDraw(s)
      r.upgrades += job
      r.training += draw - job
      r.rpSpent += s.gj?.rp ?? 0
    }
    if (s.site || !g.power) continue
    if (g.burn) {
      if (p.credits < g.burn / 30) r.stopped++
      else {
        r.generators += g.power
        r.burn += g.burn
      }
    } else r.centers += g.power
  }
  return r
}
