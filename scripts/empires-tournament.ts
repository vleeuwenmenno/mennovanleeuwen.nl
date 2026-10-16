// The AI profiles against each other: AI-only 1v1 skirmishes, headless and deterministic, for
// balancing. Every pairing of the profiles (mirrors too), at each difficulty, on both two-player
// maps, a few seeds each, for every pairing of factions, every game played twice with the profiles
// swapped between the factions (a mirror: the spawns).
//
//   node scripts/empires-tournament.ts [minutes] [seeds] [difficulties] [factions]
//
//   minutes       how long a game may run before it counts as a stall (default 40)
//   seeds         seeds per map (default 3)
//   difficulties  comma separated (default medium,hard)
//   factions      the faction pairings, comma separated, each two factions joined by a dash
//                 (default every pairing: republic-droid,republic-swarm,droid-swarm)
//
// It reports each profile's wins and losses in games played out to the end (a station destroyed)
// and in stalls (no winner by the time limit: then the side with clearly more fleet and structure
// value left leads); each pairing; each faction pairing (which faction led); when the first frigate came out; who researched Rushed
// construction and how often it rushed; which expansions each profile built; the defense wing
// craft lost; and the waves sent out. Games run in parallel worker threads (TOURNAMENT_WORKERS sets
// how many). EMPIRES=path/to/empires runs another copy of the game, to compare. MAPS=id,id plays
// those maps instead of the two-spawn ones; on a map with more spawns, on two as far apart as it has.
// DEFENSE=0 (or 1, 2, 3, 4, 6) sets the lobby's defense station limit (the default when left out).

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { availableParallelism } from 'node:os'

type Job = { i: number; map: string; seed: number; diff: string; profiles: [string, string]; factions: [string, string]; spawns: number[]; minutes: number; dir: string }
type Side = { profile: string; faction: string; flags: Record<string, number>; frigate: number; rushTech: number; rushes: number; mods: string[]; wingLost: number; waves: number; techs: number; level: number; worth: number }
type Result = { job: Job; winner: number; time: number; sides: Side[] }

const here = new URL('.', import.meta.url).pathname
const dir = process.env.EMPIRES ? new URL(process.env.EMPIRES.replace(/\/?$/, '/'), `file://${process.cwd()}/`).pathname : `${here}../src/apps/games/empires/`

async function play(job: Job): Promise<Result> {
  const { MAPS } = await import(`${job.dir}maps.ts`)
  const { STEP, newWorld, tick } = await import(`${job.dir}sim.ts`)
  const { DIFFICULTY, newBrain, think } = await import(`${job.dir}ai.ts`)
  const { UNIT } = await import(`${job.dir}data.ts`)
  const map = MAPS.find((m: { name: string }) => m.name === job.map)
  const factions = job.factions
  const w = newWorld(map, factions.map((f, i) => ({ faction: f, team: i, spawn: job.spawns[i], incomeMul: DIFFICULTY[job.diff].income })), { seed: job.seed, ...(process.env.DEFENSE !== undefined ? { defense: Number(process.env.DEFENSE) } : {}) })
  const brains = job.profiles.map((p, i) => newBrain(i, job.diff, p))
  const sides: Side[] = job.profiles.map((p, i) => ({ profile: p, faction: factions[i], flags: {}, frigate: -1, rushTech: -1, rushes: 0, mods: [], wingLost: 0, waves: 0, techs: 0, level: 1, worth: 0 }))
  const wings = [new Set<number>(), new Set<number>()]
  const attacking = [false, false]
  const end = Math.round((job.minutes * 60) / STEP)
  for (let t = 1; t <= end && w.winner === -1; t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    for (const e of w.events) {
      const s = sides[e.owner]
      if (!s) continue
      if (e.k === 'built' && UNIT[e.unit]?.tier === 'frigate' && s.frigate < 0) s.frigate = w.time
      if (e.k === 'built' && (UNIT[e.unit]?.tier === 'capital' || UNIT[e.unit]?.tier === 'frigate')) s.flags[e.unit] = (s.flags[e.unit] ?? 0) + 1
      if (e.k === 'tech' && /yd-rush/.test(e.id)) s.rushTech = w.time
      if (e.k === 'tech' && !/yd-rush/.test(e.id)) s.techs++
      if (e.k === 'rushed') s.rushes++
      if (e.k === 'expanded') s.mods.push(e.id)
      if (e.k === 'level') s.level = e.level
    }
    w.events.length = 0
    brains.forEach((b: { attacking: boolean }, i: number) => {
      if (b.attacking && !attacking[i]) sides[i].waves++
      attacking[i] = b.attacking
    })
    if (t % 10) continue
    // Defense wing craft: one gone from the field since the last look was shot down.
    for (const o of [0, 1]) {
      const now = new Set<number>(w.units.filter((u: { dead: boolean; owner: number; t: { kind?: string } }) => !u.dead && u.owner === o && u.t.kind === 'wing').map((u: { id: number }) => u.id))
      for (const id of wings[o]) if (!now.has(id)) sides[o].wingLost++
      wings[o] = now
    }
  }
  for (const o of [0, 1]) sides[o].worth = w.units.filter((u: { dead: boolean; owner: number }) => !u.dead && u.owner === o).reduce((s: number, u: { t: { cost: number; squad: number } }) => s + u.t.cost / u.t.squad, 0)
  return { job, winner: w.winner, time: w.time, sides }
}

if (!isMainThread) {
  parentPort!.on('message', async (job: Job | null) => {
    if (!job) return process.exit(0)
    parentPort!.postMessage(await play(job))
  })
} else {
  const minutes = Number(process.argv[2] ?? 40)
  const seeds = Number(process.argv[3] ?? 3)
  const diffs = (process.argv[4] ?? 'medium,hard').split(',')
  const { FACTION_IDS } = await import(`${dir}data.ts`)
  const ids: string[] = FACTION_IDS ?? ['republic', 'droid']
  const sides: [string, string][] = process.argv[5]
    ? process.argv[5].split(',').map((p) => p.split('-') as [string, string])
    : ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as [string, string]))
  const { MAPS } = await import(`${dir}maps.ts`)
  type M = { id: string; name: string; sym: string; spawns: unknown[] }
  const only = process.env.MAPS?.split(',')
  const picked: M[] = only ? only.map((id) => MAPS.find((m: M) => m.id === id) ?? (() => { throw new Error(`No map ${id}`) })()) : MAPS.filter((m: M) => m.spawns.length === 2)
  const maps: string[] = picked.map((m) => m.name)
  /** The spawn facing the first: opposite on an even ring, across the diagonal on four corners. */
  const far = (m: M) => {
    const n = m.spawns.length
    return n === 2 ? 1 : m.sym === 'quad' ? 3 : n % 2 ? Math.floor(n / 2) : n / 2
  }
  const farOf = new Map(picked.map((m) => [m.name, far(m)]))
  const P = ['defensive', 'balanced', 'offensive']
  const pairs: [string, string][] = []
  for (let a = 0; a < P.length; a++) for (let b = a; b < P.length; b++) pairs.push([P[a], P[b]])
  const jobs: Job[] = []
  for (const factions of sides)
    for (const diff of diffs)
      for (const map of maps)
        for (let s = 1; s <= seeds; s++)
          for (const [a, b] of pairs)
            // (A mirror swaps the spawns instead: the same profiles swapped would be the same game.)
            for (const swap of [false, true]) jobs.push({ i: jobs.length, map, seed: s * 101 + maps.indexOf(map) * 7, diff, profiles: swap && a !== b ? [b, a] : [a, b], factions, spawns: swap && a === b ? [farOf.get(map)!, 0] : [0, farOf.get(map)!], minutes, dir })
  const n = Math.min(jobs.length, Number(process.env.TOURNAMENT_WORKERS ?? Math.max(1, availableParallelism() - 4)))
  console.log(`${jobs.length} games (${sides.map((f) => f.join(' v ')).join(', ')} x ${pairs.length} pairings x ${diffs.join('/')} x ${maps.join(', ')} x ${seeds} seeds x both sides), up to ${minutes} min each, ${n} workers`)
  const results: Result[] = []
  const t0 = Date.now()
  await new Promise<void>((done) => {
    let next = 0
    let running = 0
    for (let k = 0; k < n; k++) {
      const wk = new Worker(new URL(import.meta.url))
      const feed = () => {
        if (next < jobs.length) {
          running++
          wk.postMessage(jobs[next++])
        } else wk.postMessage(null)
      }
      wk.on('message', (r: Result) => {
        results.push(r)
        running--
        if (results.length % 12 === 0) process.stderr.write(`  ${results.length}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`)
        feed()
        if (results.length === jobs.length) done()
      })
      wk.on('error', (e) => {
        console.error(e)
        process.exit(1)
      })
      feed()
    }
  })
  results.sort((a, b) => a.job.i - b.job.i)

  /** Who won: a station destroyed, else (a stall) the side with clearly more left, else nobody. */
  const lead = (r: Result) => (r.winner >= 0 ? r.winner : Math.abs(r.sides[0].worth - r.sides[1].worth) < 500 ? -1 : r.sides[0].worth > r.sides[1].worth ? 0 : 1)
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : '-')
  const med = (xs: number[]) => {
    const s = xs.filter((x) => x >= 0).sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : -1
  }
  const mmss = (t: number) => (t < 0 ? '-' : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`)

  for (const diff of [...diffs, 'all']) {
    const rs = results.filter((r) => diff === 'all' || r.job.diff === diff)
    console.log(`\n=== ${diff} (${rs.length} games) ===`)
    console.log('profile      games  won-lost (ended)  stalls led-trailed-even  overall won-lost  win% (cross games)')
    for (const p of P) {
      let gm = 0, w = 0, l = 0, sw = 0, sl = 0, se = 0, cw = 0, cg = 0
      for (const r of rs) {
        if (r.job.profiles[0] === r.job.profiles[1]) continue
        const i = r.job.profiles.indexOf(p)
        if (i < 0) continue
        gm++
        const x = lead(r)
        if (r.winner >= 0) r.winner === i ? w++ : l++
        else x === -1 ? se++ : x === i ? sw++ : sl++
        cg++
        if (x === i) cw++
      }
      console.log(`${p.padEnd(12)} ${String(gm).padStart(5)}  ${`${w}-${l}`.padStart(16)}  ${`${sw}-${sl}-${se}`.padStart(22)}  ${`${w + sw}-${l + sl}`.padStart(16)}  ${pct(cw, cg).padStart(6)}`)
    }
    console.log('pairing                   ended(A-B)  stalls  avg min   first faction of its pairing leads')
    for (const [a, b] of pairs) {
      const ps = rs.filter((r) => [...r.job.profiles].sort().join() === [a, b].sort().join())
      let aw = 0, bw = 0, st = 0, rep = 0
      for (const r of ps) {
        if (r.winner < 0) st++
        else if (a === b) r.winner === 0 ? aw++ : bw++
        else r.job.profiles[r.winner] === a ? aw++ : bw++
        if (lead(r) === 0) rep++
      }
      const avg = ps.reduce((s, r) => s + r.time, 0) / Math.max(1, ps.length) / 60
      console.log(`${`${a} v ${b}`.padEnd(25)} ${`${aw}-${bw}`.padStart(11)}  ${String(st).padStart(6)}  ${avg.toFixed(1).padStart(7)}   ${rep}/${ps.length}`)
    }
    console.log('factions                  games  first-second-even (led)  ended  avg min')
    for (const f of sides) {
      const fs = rs.filter((r) => r.job.factions.join() === f.join())
      if (!fs.length) continue
      let a = 0, b = 0, e = 0
      for (const r of fs) {
        const x = lead(r)
        if (x === -1) e++
        else x === 0 ? a++ : b++
      }
      const avg = fs.reduce((t, r) => t + r.time, 0) / fs.length / 60
      console.log(`${f.join(' v ').padEnd(25)} ${String(fs.length).padStart(5)}  ${`${a}-${b}-${e}`.padStart(23)}  ${String(fs.filter((r) => r.winner >= 0).length).padStart(5)}  ${avg.toFixed(1).padStart(7)}`)
    }
    console.log('profile      1st frigate (median)  rush researched (median at)  rushes/game  wing lost/game  waves/game  techs/game  level at end')
    for (const p of P) {
      const ss = rs.flatMap((r) => r.sides.filter((s) => s.profile === p))
      const avg = (f: (s: Side) => number) => (ss.reduce((t, s) => t + f(s), 0) / Math.max(1, ss.length)).toFixed(1)
      console.log(
        `${p.padEnd(12)} ${mmss(med(ss.map((s) => s.frigate))).padStart(20)}  ${`${pct(ss.filter((s) => s.rushTech >= 0).length, ss.length)} (${mmss(med(ss.map((s) => s.rushTech)))})`.padStart(27)}  ${avg((s) => s.rushes).padStart(11)}  ${avg((s) => s.wingLost).padStart(14)}  ${avg((s) => s.waves).padStart(10)}  ${avg((s) => s.techs).padStart(10)}  ${avg((s) => s.level).padStart(12)}`,
      )
    }
    // Frigate-tier ships and flagships built, by faction and type: a side with more than one of a
    // tier should field each of them now and then.
    const flagFs = [...new Set(rs.flatMap((r) => r.sides.map((s) => s.faction)))]
    console.log(`frigate-tier ships and flagships built (per side and game)\n${flagFs.map((f) => {
      const ss = rs.flatMap((r) => r.sides.filter((s) => s.faction === f))
      const all = [...new Set(ss.flatMap((s) => Object.keys(s.flags)))].sort()
      return `  ${f.padEnd(10)} ${all.map((u) => `${u} ${(ss.reduce((t, s) => t + (s.flags[u] ?? 0), 0) / Math.max(1, ss.length)).toFixed(2)}`).join('  ') || 'none'}`
    }).join('\n')}`)
    const ids = [...new Set(rs.flatMap((r) => r.sides.flatMap((s) => s.mods)))].sort()
    console.log(`expansions built (share of sides that built each)\n${''.padEnd(12)} ${ids.map((m) => m.padStart(13)).join('')}`)
    for (const p of P) {
      const ss = rs.flatMap((r) => r.sides.filter((s) => s.profile === p))
      console.log(`${p.padEnd(12)} ${ids.map((m) => pct(ss.filter((s) => s.mods.includes(m)).length, ss.length).padStart(13)).join('')}`)
    }
  }
  const stalls = results.filter((r) => r.winner < 0)
  if (stalls.length) {
    console.log(`\nstalls (${stalls.length})`)
    for (const r of stalls)
      console.log(`  ${r.job.diff} ${r.job.map} seed ${r.job.seed}: ${r.sides.map((s) => `${s.profile}/${s.faction} L${s.level} worth ${Math.round(s.worth)} waves ${s.waves}`).join('  vs  ')}`)
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s`)
}
