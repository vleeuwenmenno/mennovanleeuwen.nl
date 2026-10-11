// How the galactic conquest AI plays, headless: a few campaigns at every difficulty against a
// simple scripted player, with numbers on how busy and how purposeful the AI is.
//
//   node scripts/empires-galaxy-ai.ts [weeks] [runs] [turtle|expand]
//
// The scripted player keeps its best shipyard busy and has its battles auto-resolved. A turtle
// leaves every fleet at home; an expander sends its biggest fleet to the nearest planet it doesn't
// hold yet (unclaimed, or the enemy's without a station), one after another. Per AI side the
// report shows the orders it gave a minute (fleet moves and splits, ships and station work
// queued), how many fleets it had and how big they were, how many were flying at once, how often a
// fleet was sent somewhere else before it got where it was going (wander) or straight back to
// where it had just left (bounce), lone ships sent two or more lanes away, its battles won and
// lost, the planets each side held at the end and the AI's credits. Orders are counted by
// watching the galaxy rather than the AI's own books, so the numbers mean the same for any version
// of the AI (GALAXY=path/to/galaxy.ts runs another copy of the model, to compare). It fails if an AI
// gave more orders a minute than its difficulty allows, or if any side ever had more fleets at one
// planet than the cap (MAX_FLEETS).

import { buildable } from '../src/apps/games/empires/data.ts'
import type { Difficulty } from '../src/apps/games/empires/ai.ts'
import type { Fleet, Galaxy, GalaxyChoice } from '../src/apps/games/empires/galaxy.ts'

const G: typeof import('../src/apps/games/empires/galaxy.ts') = await import(process.env.GALAXY ? new URL(process.env.GALAXY, `file://${process.cwd()}/`).href : '../src/apps/games/empires/galaxy.ts')
const weeks = Number(process.argv[2] ?? 12)
const runs = Number(process.argv[3] ?? 2)
const mode = process.argv[4] === 'turtle' ? 'turtle' : 'expand'
const STEP = 0.5

// The same campaigns every time, even where the game itself rolls dice.
let seed = 99991
Math.random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

const choices: GalaxyChoice[] = [{ kind: 'rim' }, { kind: 'generated', seed: 11 }, { kind: 'generated', seed: 23 }, { kind: 'generated', seed: 41 }]
const levels: Difficulty[] = ['veryEasy', 'easy', 'medium', 'hard']

/** Where a fleet is headed in the end: its last stop, else the end of its route, else where it is. */
const dest = (f: Fleet) => (f.waypoints?.length ? f.waypoints[f.waypoints.length - 1] : f.route.length ? f.route[f.route.length - 1].planet : f.leg ? f.leg.planet : f.planet)
const moving = (f: Fleet) => !!f.leg || f.route.length > 0

/** The scripted player (side 0). */
function player(g: Galaxy) {
  const s = g.sides[0]
  const yards = g.planets.filter((p) => p.owner === 0 && p.station > 0).sort((a, b) => b.station - a.station)
  for (const p of yards.slice(0, 1)) {
    if (p.queue.length >= 2) continue
    const can = buildable(s.faction).filter((t) => t.level <= p.station && t.cost <= s.credits)
    if (can.length) G.buildAt(g, 0, p.id, can[Math.floor(g.time / 7) % can.length].id)
  }
  if (mode === 'turtle') return
  const fleets = g.fleets.filter((f) => f.owner === 0)
  const big = fleets.sort((a, b) => b.ships.length - a.ships.length)[0]
  if (!big || moving(big) || big.planet < 0 || g.planets[big.planet].owner !== 0) return
  const goal = g.planets
    .filter((p) => p.owner < 0 || (p.owner > 0 && !p.station))
    .map((p) => ({ p, d: G.lanePath(g, big.system, p.system, 0)?.length ?? 99 }))
    .filter((x) => x.d < 99)
    .sort((a, b) => a.d - b.d)[0]
  if (goal) G.moveFleet(g, 0, big.id, goal.p.id)
}

/** The most fleets one side has in orbit of one planet right now. */
function crowd(g: Galaxy) {
  const at = new Map<string, number>()
  for (const f of g.fleets) if (!f.leg && !f.route.length && f.planet >= 0) at.set(`${f.owner}:${f.planet}`, (at.get(`${f.owner}:${f.planet}`) ?? 0) + 1)
  return Math.max(0, ...at.values())
}
let crowded = 0

type Stats = { orders: number; moves: number; retargets: number; bounces: number; lone: number; fleets: number; ships: number; flying: number; samples: number; planets: number; credits: number; playerPlanets: number; won: number; lost: number }
const zero = (): Stats => ({ orders: 0, moves: 0, retargets: 0, bounces: 0, lone: 0, fleets: 0, ships: 0, flying: 0, samples: 0, planets: 0, credits: 0, playerPlanets: 0, won: 0, lost: 0 })

function run(choice: GalaxyChoice, diff: Difficulty): Stats {
  const g = G.newGalaxy({ choice, size: 'standard', faction: 'republic', difficulty: diff, credits: 2000 })
  const st = zero()
  const AI = 1
  const heading = new Map<number, { to: number; moving: boolean }>()
  const seen = new WeakSet<object>()
  /** Where each fleet was sent from lately, and when: a move straight back there is a bounce. */
  const left = new Map<number, { planet: number; t: number }[]>()
  for (const p of g.planets) for (const q of p.queue) seen.add(q)
  for (const f of g.fleets) heading.set(f.id, { to: dest(f), moving: moving(f) })
  const end = weeks * G.WEEK * G.DAY
  let sampleT = 0
  while (g.time < end && g.winner === -1) {
    player(g)
    if (g.pending >= 0) G.settlePending(g, 'auto')
    G.tickGalaxy(g, STEP)
    crowded = Math.max(crowded, crowd(g))
    for (const e of g.events) if (e.k === 'battle' && e.winner !== undefined && e.owners.includes(AI)) e.winner === AI ? st.won++ : st.lost++
    g.events.length = 0
    // Shipyard and station orders: queue entries not seen before.
    for (const p of g.planets)
      for (const q of p.queue) {
        if (seen.has(q)) continue
        seen.add(q)
        if (p.owner === AI) st.orders++
      }
    // Fleet orders: a fleet whose destination changed, or a new one already on its way (split off).
    for (const f of g.fleets) {
      if (f.owner !== AI) continue
      const was = heading.get(f.id)
      const now = dest(f)
      if (was === undefined ? moving(f) : was.to !== now) {
        st.orders++
        st.moves++
        // Changed its mind on the way: it was flying somewhere else and hadn't got there.
        if (was?.moving) st.retargets++
        // Sent back to where it left in the last two minutes: shuttling.
        const trail = (left.get(f.id) ?? []).filter((x) => g.time - x.t < 120)
        if (trail.some((x) => x.planet === now)) st.bounces++
        if (f.from >= 0) trail.push({ planet: f.from, t: g.time })
        left.set(f.id, trail)
        const lanes = new Set([...(f.leg ? [f.leg] : []), ...f.route].map((h) => h.system)).size
        if (f.ships.length === 1 && lanes >= 2) st.lone++
      }
      heading.set(f.id, { to: now, moving: moving(f) })
    }
    sampleT -= STEP
    if (sampleT <= 0) {
      sampleT = 10
      const fs = g.fleets.filter((f) => f.owner === AI)
      st.fleets += fs.length
      st.ships += fs.reduce((n, f) => n + f.ships.length, 0)
      st.flying += fs.filter(moving).length
      st.samples++
    }
  }
  st.planets = g.planets.filter((p) => p.owner === AI).length
  st.playerPlanets = g.planets.filter((p) => p.owner === 0).length
  st.credits = g.sides[AI].credits
  return st
}

const minutes = (weeks * G.WEEK * G.DAY) / 60
console.log(`${weeks} weeks (${minutes.toFixed(0)} game minutes) per campaign, ${choices.length} galaxies x ${runs} runs, AI vs a scripted ${mode === 'turtle' ? 'turtle' : 'expander'}`)
console.log('difficulty  orders/min  fleets  ships/fleet  flying  wander  bounce  lone  battles(won-lost)  planets(AI:you)  credits')
let over = false
for (const diff of levels) {
  const all = zero()
  let n = 0
  for (let r = 0; r < runs; r++)
    for (const c of choices) {
      seed = 99991 + r * 7 + n
      const s = run(c, diff)
      for (const k of Object.keys(all) as (keyof Stats)[]) all[k] += s[k]
      n++
    }
  const per = (v: number) => v / n
  const pct = (v: number) => `${((v / Math.max(1, all.moves)) * 100).toFixed(0)}%`
  console.log(
    [
      diff.padEnd(10),
      (per(all.orders) / minutes).toFixed(1).padStart(10),
      (all.fleets / all.samples).toFixed(1).padStart(7),
      (all.ships / Math.max(1, all.fleets)).toFixed(1).padStart(12),
      (all.flying / all.samples).toFixed(1).padStart(7),
      pct(all.retargets).padStart(7),
      pct(all.bounces).padStart(7),
      per(all.lone).toFixed(1).padStart(5),
      `${per(all.won).toFixed(1)}-${per(all.lost).toFixed(1)}`.padStart(18),
      `${per(all.planets).toFixed(1)}:${per(all.playerPlanets).toFixed(1)}`.padStart(16),
      per(all.credits).toFixed(0).padStart(8),
    ].join(' '),
  )
  // The few orders it starts with in hand can tip it just over; anything more is a leak in the budget.
  const cap = G.GALAXY_AI?.[diff]?.apm
  if (!process.env.GALAXY && cap && per(all.orders) / minutes > cap + Math.max(2, cap / 4) / minutes + 0.05) {
    console.error(`FAIL ${diff}: ${(per(all.orders) / minutes).toFixed(1)} orders a minute, over its ${cap}`)
    over = true
  }
}
// Older copies of the model (GALAXY=...) may have no cap.
const cap = G.MAX_FLEETS ?? Infinity
console.log(`Most fleets a side had at one planet: ${crowded} (cap ${cap})`)
if (crowded > cap) {
  console.error(`FAIL: ${crowded} fleets of one side at one planet, over the cap of ${cap}`)
  over = true
}
if (over) process.exit(1)
