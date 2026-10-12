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
// planet than the cap (MAX_FLEETS), or if the harder AIs don't hold more of the galaxy in the end.
// Fleets sent together (the AI's main army) count as one order, and fleets pulled out of hyperspace
// by a blockade they couldn't see (the fog of war) as none: the "pulled" column counts those.
//
// Then the fog of war: its rules checked one by one, and the AI's decisions compared between two
// copies of a campaign that differ only in what it can't see (they must be the same).

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

type Stats = { orders: number; moves: number; retargets: number; bounces: number; lone: number; fleets: number; ships: number; flying: number; samples: number; planets: number; credits: number; playerPlanets: number; won: number; lost: number; pulled: number }
const zero = (): Stats => ({ orders: 0, moves: 0, retargets: 0, bounces: 0, lone: 0, fleets: 0, ships: 0, flying: 0, samples: 0, planets: 0, credits: 0, playerPlanets: 0, won: 0, lost: 0, pulled: 0 })

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
    // Fleets pulled out of hyperspace by a blockade they didn't know of (the fog of war) changed
    // where they're going without an order.
    const pulled = new Set(g.events.flatMap((e) => (e.k === 'blockaded' && e.owner === AI ? [e.fleet] : [])))
    st.pulled += pulled.size
    g.events.length = 0
    // Shipyard and station orders: queue entries not seen before.
    for (const p of g.planets)
      for (const q of p.queue) {
        if (seen.has(q)) continue
        seen.add(q)
        if (p.owner === AI) st.orders++
      }
    // Fleet orders: a fleet whose destination changed, or a new one already on its way (split off).
    // Fleets sent together from one place to another in the same tick (the AI's main army: fleets
    // too full to merge that go where the main fleet goes) are one order, as a player sends a
    // selection of fleets with one click.
    const sent = new Set<string>()
    for (const f of g.fleets) {
      if (f.owner !== AI) continue
      const was = heading.get(f.id)
      const now = dest(f)
      if (pulled.has(f.id)) {
        heading.set(f.id, { to: now, moving: moving(f) })
        continue
      }
      if (was === undefined ? moving(f) : was.to !== now) {
        const key = `${was?.to ?? `new${f.id}`}>${now}`
        const lanes = new Set([...(f.leg ? [f.leg] : []), ...f.route].map((h) => h.system)).size
        if (f.ships.length === 1 && lanes >= 2) st.lone++
        const trail = (left.get(f.id) ?? []).filter((x) => g.time - x.t < 120)
        const bounce = trail.some((x) => x.planet === now)
        if (f.from >= 0) trail.push({ planet: f.from, t: g.time })
        left.set(f.id, trail)
        if (!sent.has(key)) {
          sent.add(key)
          st.orders++
          st.moves++
          // Changed its mind on the way: it was flying somewhere else and hadn't got there.
          if (was?.moving) st.retargets++
          // Sent back to where it left in the last two minutes: shuttling.
          if (bounce) st.bounces++
        }
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
console.log('difficulty  orders/min  fleets  ships/fleet  flying  wander  bounce  lone  pulled  battles(won-lost)  planets(AI:you)  credits')
let over = false
/** The planets the AI held at the end, per difficulty, for the ranking check. */
const held: number[] = []
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
      per(all.pulled).toFixed(1).padStart(7),
      `${per(all.won).toFixed(1)}-${per(all.lost).toFixed(1)}`.padStart(18),
      `${per(all.planets).toFixed(1)}:${per(all.playerPlanets).toFixed(1)}`.padStart(16),
      per(all.credits).toFixed(0).padStart(8),
    ].join(' '),
  )
  held.push(per(all.planets))
  // The few orders it starts with in hand can tip it just over; anything more is a leak in the budget.
  const cap = G.GALAXY_AI?.[diff]?.apm
  if (!process.env.GALAXY && cap && per(all.orders) / minutes > cap + Math.max(2, cap / 4) / minutes + 0.05) {
    console.error(`FAIL ${diff}: ${(per(all.orders) / minutes).toFixed(1)} orders a minute, over its ${cap}`)
    over = true
  }
}
// The harder the AI, the more of the galaxy it holds at the end (fog or no fog): never less than the
// level below, and the hardest well ahead of the easiest (short runs can tie neighbours).
if (held.some((v, i) => i > 0 && v < held[i - 1]) || held[held.length - 1] <= held[0]) {
  console.error(`FAIL: planets held by difficulty don't rise: ${held.map((v) => v.toFixed(1)).join(', ')}`)
  over = true
} else console.log(`Difficulty ranking holds: AI planets ${held.map((v) => v.toFixed(1)).join(' ≤ ')}`)

// --- The fog of war: what each side sees -----------------------------------------------------------------
//
// The rules, one by one, on the Rim Wars: a side sees the systems it holds planets in or has fleets
// in, nothing else; what it saw stays as its last look; fleets in hyperspace are seen by nobody;
// a fleet flying through a system glimpses it; a side that loses a planet knows it; and saves keep it.
if (!process.env.GALAXY && G.updateSight) {
  const ok = (what: string, pass: boolean, detail = '') => {
    console.log(`${pass ? 'ok  ' : 'FAIL'} fog: ${what}${detail ? `: ${detail}` : ''}`)
    if (!pass) over = true
  }
  const g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'republic', difficulty: 'medium', credits: 2000 })
  const sysOf = (name: string) => g.systems.findIndex((x) => x.name === name)
  const home = sysOf('Corvanis')
  const enemyHome = sysOf('Geonar')
  const enemyCap = g.planets[g.systems[enemyHome].planets[0]]
  const theirs = g.fleets.find((f) => f.owner === 1)!
  ok('a side sees its own systems', G.sees(g, 0, home) && G.sees(g, 1, enemyHome))
  ok("and not the other side's", !G.sees(g, 0, enemyHome) && !G.sees(g, 1, home) && !G.canSee(g, 0, theirs))
  const k0 = G.known(g, 0, enemyCap)
  ok('the pre-war charts: who holds it and its station, no word of its fleets', !k0.live && k0.owner === 1 && k0.station === 3 && k0.ships === -1)
  // A fleet of ours flies into their home system: it sees it, and their fleet there.
  const ours = g.fleets.find((f) => f.owner === 0)!
  const other = g.planets[g.systems[enemyHome].planets[1]]
  ours.planet = other.id
  ours.system = enemyHome
  ours.arrived = g.time
  G.updateSight(g)
  ok('a fleet there sees the system and the fleets in it', G.sees(g, 0, enemyHome) && G.canSee(g, 0, theirs) && G.known(g, 0, enemyCap).live)
  const seenShips = G.known(g, 0, enemyCap).ships
  // It leaves: what it saw stays, dated.
  ours.planet = g.systems[home].planets[0]
  ours.system = home
  g.time += 30
  theirs.ships = [...theirs.ships, 'd-cruiser', 'd-cruiser']
  G.layoutFleets(g)
  G.updateSight(g)
  const k1 = G.known(g, 0, enemyCap)
  ok('gone again: the last look stays, not what is there now', !G.sees(g, 0, enemyHome) && !k1.live && k1.ships === seenShips && k1.t < g.time, `${k1.ships} ships seen, ${theirs.ships.length} there now`)
  // In hyperspace nobody sees a fleet, not even in a system both sides watch.
  G.moveFleet(g, 1, theirs.id, g.planets[g.systems[sysOf('Catonis')].planets[0]].id)
  for (let i = 0; i < 4 && !theirs.leg; i++) G.tickGalaxy(g, 0.5)
  ok('a fleet out on a lane is in hyperspace: unseen', !!theirs.leg && G.fleetSystem(theirs) === -1 && !G.canSee(g, 0, theirs))
  // A fleet of ours flying through a system glimpses it on the way.
  const far = g.planets[g.systems[sysOf('Rylos')].planets[0]]
  const before = G.known(g, 0, far).t
  const scout = g.fleets.find((f) => f.owner === 0)!
  g.rules.blockade = 'off'
  G.moveFleet(g, 0, scout.id, far.id)
  for (let t = 0; t < 400 && !(scout.planet === far.id && !scout.leg); t += 0.5) {
    if (g.pending >= 0) G.settlePending(g, 'auto')
    G.tickGalaxy(g, 0.5)
  }
  ok('flying in updates what it last saw there', G.known(g, 0, far).t > before)
  // A planet of ours taken while we have nothing else there: we know it's gone.
  const g2 = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'republic', difficulty: 'medium', credits: 2000 })
  const lone = g2.planets.find((p) => p.owner === 0 && p.station === 1)!
  for (const pid of g2.systems[lone.system].planets) g2.planets[pid].owner = pid === lone.id ? 0 : -1
  lone.station = 0
  const raider = g2.fleets.find((f) => f.owner === 1)!
  raider.planet = lone.id
  raider.system = lone.system
  raider.leg = null
  raider.route = []
  // (The AI sits this one out, or it would send the raider elsewhere.)
  g2.aiT[1] = 1e9
  for (let t = 0; t < 30 && lone.owner === 0; t += 0.5) G.tickGalaxy(g2, 0.5)
  ok('a side that loses a planet knows it, even with nothing left there', lone.owner === 1 && !G.sees(g2, 0, lone.system) && G.known(g2, 0, lone).owner === 1)
  // Saves keep both.
  const store = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage
  G.saveGalaxy(g)
  const back = G.loadSave(g.save.id)!
  ok('a save keeps what each side saw', JSON.stringify(back.sides.map((x) => x.intel)) === JSON.stringify(g.sides.map((x) => x.intel)))
}

// --- The fog of war: the AI decides the same whatever it can't see -------------------------------------
//
// Through a campaign at each difficulty, every 20 s the galaxy is copied twice, and in one copy
// everything the AI can't see is changed: the player's fleets outside its sight get three cruisers
// more, planets in systems it doesn't see change hands between the player and nobody and get other
// stations and shipyard queues, and the player's credits triple. The AI then takes its look in both
// copies; if it read anything hidden, its orders (fleet moves and splits, ships and stations queued)
// or its plans would differ. A control does the same to what it does see, to show the comparison
// notices a difference when there is one.
if (!process.env.GALAXY && G.thinkAi) {
  const AI = 1
  /** The AI's orders and plans, without ids (a split off fleet gets a different id in each copy). */
  const mind = (g: Galaxy) => {
    const m = g.sides[AI].mind
    const fleets = g.fleets.filter((f) => f.owner === AI).map((f) => `${[...f.ships].sort().join('+')}@${f.planet}>${dest(f)}`).sort()
    const yards = g.planets.filter((p) => p.owner === AI).map((p) => `${p.id}:${p.queue.map((q) => q.unit).join('+')}`)
    return JSON.stringify({ fleets, yards, credits: g.sides[AI].credits, m: m && { goal: m.goal, target: m.target, stage: m.stage, wave: m.wave, budget: m.budget, orders: m.orders, claims: Object.values(m.claims).sort() } })
  }
  const hide = (g: Galaxy, visible: boolean) => {
    let changed = 0
    for (const f of g.fleets) {
      if (f.owner === AI || G.canSee(g, AI, f) !== visible) continue
      f.ships = [...f.ships, 'r-cruiser', 'r-cruiser', 'r-cruiser']
      changed++
    }
    for (const p of g.planets) {
      if (p.owner === AI || G.sees(g, AI, p.system) !== visible) continue
      if (!visible) p.owner = p.owner === 0 ? -1 : 0
      p.station = (p.station + 2) % 5
      p.queue = [{ unit: 'r-frigate', left: 5, total: 30 }]
      changed++
    }
    if (!visible) g.sides[0].credits *= 3
    G.layoutFleets(g)
    return changed
  }
  let looks = 0
  let differed = 0
  let hidden = 0
  let control = 0
  for (const diff of levels) {
    for (const choice of [choices[0], choices[2]]) {
      seed = 4242
      const g = G.newGalaxy({ choice, size: 'standard', faction: 'republic', difficulty: diff, credits: 2000 })
      let next = 20
      while (g.time < 8 * G.WEEK * G.DAY && g.winner === -1) {
        player(g)
        if (g.pending >= 0) G.settlePending(g, 'auto')
        G.tickGalaxy(g, STEP)
        g.events.length = 0
        if (g.time < next) continue
        next += 20
        const a = structuredClone(g)
        const b = structuredClone(g)
        hidden += hide(b, false)
        G.thinkAi(a, AI)
        G.thinkAi(b, AI)
        looks++
        if (mind(a) !== mind(b)) differed++
        // The control: the same changes to what it sees.
        const c = structuredClone(g)
        const d = structuredClone(g)
        if (hide(d, true)) {
          G.thinkAi(c, AI)
          G.thinkAi(d, AI)
          if (mind(c) !== mind(d)) control++
        }
      }
    }
  }
  console.log(`Fog of war: ${looks} AI looks, ${hidden} hidden things changed, ${differed} looks decided differently; changing what it sees changed ${control} looks`)
  if (differed) {
    console.error(`FAIL: the AI decided differently in ${differed} of ${looks} looks when only hidden things changed: it reads through the fog`)
    over = true
  }
  if (!hidden) {
    console.error('FAIL: the fog check changed nothing hidden, so it proved nothing')
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
