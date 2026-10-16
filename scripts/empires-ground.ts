// Checks that ground battles are deterministic, which multiplayer will depend on: every player's
// machine runs the same battle from the same orders, so two copies must never drift.
//
//   node scripts/empires-ground.ts [seconds]
//
// 1. The ground sim's files use no Math.random, Date, clock, DOM or engine-dependent maths.
// 2. Two copies of a scripted battle on Test Mesa (four players, vehicles of every size class) run
//    side by side for several thousand ticks and must hash the same every second. The script gives
//    many move orders (queued and not, and stops), each sent as JSON and cleaned the way the server
//    will clean it; it puts buildings up mid-battle (some right on top of units) and takes them down.
// 3. A third copy rebuilt afterwards from nothing but the logged inputs must hash the same as the
//    first at every second.
// 4. Along the way: no unit stays where it can't stand for long (a building put on it pushes it
//    off), none leaves the map, nothing turns NaN, and most move orders arrive.
// Then the same on every generated ground map, once the terrain generator is in.

import { readFileSync, readdirSync } from 'node:fs'
import { TILE, type GroundMap } from '../src/apps/games/empires/ground/types.ts'
import { MESA, testMesa } from '../src/apps/games/empires/ground/testmaps.ts'
import { anchorAt, footprintOpen, stands } from '../src/apps/games/empires/ground/nav.ts'
import { GROUND_UNIT, STEP, addStructure, isStructure, newGroundWorld, removeUnit, spawnUnit, stateHash, tick, typeOf, type GroundSeat, type GroundWorld } from '../src/apps/games/empires/ground/sim.ts'
import { cleanGroundCmd, groundCmd, runGroundCmd } from '../src/apps/games/empires/ground/commands.ts'
import { explored } from '../src/apps/games/empires/ground/fog.ts'

const seconds = Number(process.argv[2] ?? 200)
let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

// --- 1. Sources -------------------------------------------------------------------------------------

{
  const dir = new URL('../src/apps/games/empires/ground/', import.meta.url)
  const sim = ['sim.ts', 'nav.ts', 'fog.ts', 'commands.ts']
  const bad: string[] = []
  const banned = /Math\.(random|sin|cos|tan|atan2?|hypot|exp|pow|log)\b|\bDate\b|performance\.|\bdocument\b|\bwindow\b|localStorage|requestAnimationFrame|\*\*/
  for (const f of readdirSync(dir).filter((f) => sim.includes(f))) {
    readFileSync(new URL(f, dir), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // Code only: comment lines and trailing comments left out.
        const code = /^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
        if (banned.test(code)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
  }
  check('the ground sim uses no Math.random, Date, clock, DOM or engine-dependent maths', !bad.length, bad.slice(0, 3).join(' | '))
}

// --- The scripted battle ------------------------------------------------------------------------------

/** One input to a battle: an order from a seat (as sent on the wire), or a building put up or taken down. */
type Input =
  | { t: number; k: 'cmd'; owner: number; json: string }
  | { t: number; k: 'add'; type: string; owner: number; tc: number; tr: number }
  | { t: number; k: 'remove'; id: number }

const SEATS: GroundSeat[] = [
  { faction: 'republic', team: 0 },
  { faction: 'droid', team: 1 },
  { faction: 'swarm', team: 0 },
  { faction: 'droid', team: 1 },
]
const ARMY = ['test-scout', 'test-scout', 'test-scout', 'test-rover', 'test-rover', 'test-rover', 'test-rover', 'test-crawler', 'test-crawler', 'test-scout', 'test-rover', 'test-crawler']

/** A new battle on `map` with every seat's army laid out round its start spot. */
function setUp(map: GroundMap, starts: { x: number; y: number }[]) {
  const w = newGroundWorld(map, SEATS, { seed: 4242, credits: 1000 })
  SEATS.forEach((_, o) => {
    const s = starts[o % starts.length]
    ARMY.forEach((type, i) => spawnUnit(w, type, o, s.x + ((i % 4) - 1.5) * 48, s.y + (Math.floor(i / 4) - 1) * 48, (o * Math.PI) / 2))
  })
  return w
}

/** Runs an input on a world. */
function apply(w: GroundWorld, x: Input) {
  if (x.k === 'cmd') {
    const c = cleanGroundCmd(JSON.parse(x.json), w)
    if (c) runGroundCmd(w, x.owner, c)
  } else if (x.k === 'add') addStructure(w, x.type, x.owner, x.tc, x.tr)
  else {
    const u = w.byId.get(x.id)
    if (u) removeUnit(w, u)
  }
}

type Stats = { arrived: number; gaveUp: number; orders: number; added: number; removed: number; maxBad: number; badUnit: string; offMap: number; nan: number }

/**
 * Plays the scripted battle on two copies at once for `ticks`: the script picks its inputs from its
 * own random stream (never the world's) and what copy A shows, and gives each input to both copies
 * at the same tick. Returns copy A's hash every second, the inputs, and what happened.
 */
function play(map: () => GroundMap, starts: { x: number; y: number }[], ticks: number) {
  const a = setUp(map(), starts)
  const b = setUp(map(), starts)
  let s = 20261017
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const inputs: Input[] = []
  const hashes: number[] = []
  const stats: Stats = { arrived: 0, gaveUp: 0, orders: 0, added: 0, removed: 0, maxBad: 0, badUnit: '', offMap: 0, nan: 0 }
  const bad = new Map<number, number>()
  let drift = -1
  for (let t = 0; t < ticks; t++) {
    const now: Input[] = []
    // Orders: every 10 ticks, one seat moves some of its units (every 7th order a stop).
    if (t % 10 === 0) {
      const owner = Math.floor(rnd() * SEATS.length)
      const mine = a.units.filter((u) => u.owner === owner && !isStructure(u))
      const ids = mine.filter(() => rnd() < 0.5).map((u) => u.id)
      if (ids.length) {
        const order = stats.orders++ % 7 === 6 ? groundCmd('stop', ids) : groundCmd('move', ids, rnd() * a.w, rnd() * a.h, rnd() < 0.3)
        now.push({ t, k: 'cmd', owner, json: JSON.stringify(order) })
      }
    }
    // Junk an honest server cleans away: never runs.
    if (t % 97 === 0) now.push({ t, k: 'cmd', owner: 0, json: JSON.stringify(pick([{ f: 'move', a: [[1], 'x', 3] }, { f: 'nuke', a: [] }, { f: 'move', a: [[-5], 1, 1] }, { f: 'stop', a: [[1], 2] }])) })
    // Buildings: every 4 seconds one goes up, half the time right on top of a unit; from 20 seconds
    // on, every 6 seconds the oldest standing comes down.
    if (t > 0 && t % 120 === 0) {
      const owner = Math.floor(rnd() * SEATS.length)
      const [fw, fh] = GROUND_UNIT['test-block'].foot!
      for (let tries = 0; tries < 40; tries++) {
        let tc: number
        let tr: number
        if (rnd() < 0.5) {
          const u = pick(a.units.filter((u) => !isStructure(u)))
          tc = Math.floor(u.x / TILE) - 1
          tr = Math.floor(u.y / TILE) - 1
        } else {
          tc = Math.floor(rnd() * a.map.grid.cols)
          tr = Math.floor(rnd() * a.map.grid.rows)
        }
        if (!footprintOpen(a.nav, tc, tr, fw, fh)) continue
        now.push({ t, k: 'add', type: 'test-block', owner, tc, tr })
        break
      }
    }
    if (t >= 600 && t % 180 === 90) {
      const oldest = a.units.find((u) => isStructure(u) && !u.dead)
      if (oldest) now.push({ t, k: 'remove', id: oldest.id })
    }
    for (const x of now) {
      apply(a, x)
      apply(b, x)
      inputs.push(x)
      if (x.k === 'add') stats.added++
      if (x.k === 'remove') stats.removed++
    }
    tick(a)
    tick(b)
    for (const e of a.events) {
      if (e.k === 'arrived') stats.arrived++
      if (e.k === 'gaveUp') stats.gaveUp++
    }
    a.events.length = 0
    b.events.length = 0
    // Where units stand.
    for (const u of a.units) {
      if (isStructure(u)) continue
      if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !Number.isFinite(u.heading) || !Number.isFinite(u.speed)) stats.nan++
      if (u.x < 0 || u.y < 0 || u.x > a.w || u.y > a.h) stats.offMap++
      const k = typeOf(u).size
      const n = stands(a.nav, k, anchorAt(a.nav, k, u.x, u.y)) ? 0 : (bad.get(u.id) ?? 0) + 1
      bad.set(u.id, n)
      if (n > stats.maxBad) {
        stats.maxBad = n
        stats.badUnit = `${u.type} ${u.id} at ${(u.x / TILE).toFixed(1)}, ${(u.y / TILE).toFixed(1)}, tick ${t}`
      }
    }
    if ((t + 1) % 30 === 0) {
      const h = stateHash(a)
      hashes.push(h)
      if (drift < 0 && h !== stateHash(b)) drift = t + 1
    }
  }
  return { a, hashes, inputs, stats, drift }
}

/** A battle rebuilt from its inputs alone, hashed every second. */
function replay(map: () => GroundMap, starts: { x: number; y: number }[], inputs: Input[], ticks: number) {
  const w = setUp(map(), starts)
  const hashes: number[] = []
  let q = 0
  for (let t = 0; t < ticks; t++) {
    while (q < inputs.length && inputs[q].t === t) apply(w, inputs[q++])
    tick(w)
    w.events.length = 0
    if ((t + 1) % 30 === 0) hashes.push(stateHash(w))
  }
  return hashes
}

function run(name: string, map: () => GroundMap, starts: { x: number; y: number }[]) {
  const ticks = Math.round(seconds / STEP)
  const t0 = performance.now()
  const { a, hashes, inputs, stats, drift } = play(map, starts, ticks)
  const ms = performance.now() - t0
  check(`${name}: two copies stay in step for ${ticks} ticks`, drift < 0, drift < 0 ? `final hash ${hashes[hashes.length - 1].toString(16)}` : `drifted by tick ${drift}`)
  const t1 = performance.now()
  const again = replay(map, starts, inputs, ticks)
  const first = again.findIndex((h, i) => h !== hashes[i])
  check(`${name}: a copy rebuilt from the ${inputs.length} logged inputs matches every second`, first < 0 && again.length === hashes.length, first < 0 ? '' : `differs at second ${first + 1}`)
  const replayMs = performance.now() - t1
  const cmds = inputs.filter((x) => x.k === 'cmd').length
  console.log(`  ${cmds} orders sent, ${stats.arrived} arrivals, ${stats.gaveUp} given up; ${stats.added} buildings up, ${stats.removed} down; ${a.units.length} units at the end`)
  console.log(`  ${(ms / ticks / 2).toFixed(3)} ms a tick (two copies: ${(ms / 1000).toFixed(1)} s), replay ${(replayMs / 1000).toFixed(1)} s`)
  check(`${name}: no unit stays where it can't stand for more than 3 s`, stats.maxBad <= 90, stats.maxBad ? `longest ${(stats.maxBad * STEP).toFixed(2)} s: ${stats.badUnit}` : '')
  check(`${name}: nothing leaves the map or turns NaN`, !stats.offMap && !stats.nan, `${stats.offMap} off the map, ${stats.nan} NaN`)
  check(`${name}: move orders arrive (at least 3 in 4 that end)`, stats.arrived > 50 && stats.arrived >= 3 * stats.gaveUp, `${stats.arrived} arrived, ${stats.gaveUp} gave up`)
  check(`${name}: buildings went up and came down`, stats.added >= 10 && stats.removed >= 5)
  const seen = a.fog.explored.map((_, team) => {
    let n = 0
    for (let i = 0; i < a.map.grid.cols * a.map.grid.rows; i++) if (explored(a.fog, team, i)) n++
    return n
  })
  check(`${name}: both teams explored some of the map`, seen.every((n) => n > 0), seen.map((n, t) => `team ${t}: ${Math.round((n / (a.map.grid.cols * a.map.grid.rows)) * 100)}%`).join(', '))
}

const at = (c: number, r: number) => ({ x: (c + 0.5) * TILE, y: (r + 0.5) * TILE })
{
  // The hash itself notices the smallest difference.
  const starts = [at(MESA.low.c, MESA.low.r), at(MESA.high.c, MESA.high.r)]
  const a = setUp(testMesa(), starts)
  const b = setUp(testMesa(), starts)
  for (let t = 0; t < 30; t++) [a, b].forEach(tick)
  const same = stateHash(a) === stateHash(b)
  b.units[3].x += 1e-9
  const nudged = stateHash(a) !== stateHash(b)
  b.units[3].x = a.units[3].x
  b.fog.explored[1][0] ^= 1
  check('the hash tells apart worlds a billionth of a unit or one explored tile apart', same && nudged && stateHash(a) !== stateHash(b))
}
run('Test Mesa', testMesa, [at(MESA.low.c, MESA.low.r), at(MESA.high.c, MESA.high.r), at(20, 14), at(42, 31)])

// --- Generated maps -------------------------------------------------------------------------------------

async function groundMaps(): Promise<{ build: () => GroundMap; name: string }[] | null> {
  try {
    const terrain = (await import('../src/apps/games/empires/ground/terrain.ts')) as Record<string, unknown>
    const maps = (await import('../src/apps/games/empires/ground/maps.ts')) as Record<string, unknown>
    const build = terrain.buildGroundMap as ((d: unknown) => GroundMap) | undefined
    if (!build) return null
    const defs = Object.values(maps).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((d): d is { id: string; name: string; sketch: string[] } => !!d && typeof d === 'object' && Array.isArray((d as { sketch?: unknown }).sketch))
    const seen = new Set<string>()
    return defs.filter((d) => !seen.has(d.id) && seen.add(d.id)).map((d) => ({ build: () => build(d), name: d.name }))
  } catch {
    return null
  }
}
const built = await groundMaps()
if (!built) console.log('SKIP generated ground maps (ground/terrain.ts and ground/maps.ts not in yet)')
else for (const m of built) run(m.name, m.build, m.build().spawns)

if (failed) {
  console.log('ground sync check FAILED')
  process.exit(1)
}
console.log('ground sync check passed: in sync')
