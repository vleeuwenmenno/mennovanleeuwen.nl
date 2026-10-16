// The battle maps played out by AIs, to see that each one is fair and plays: AI-only skirmishes,
// headless and deterministic, on every spawn of a map, with each game played twice: the second time
// every admiral moves a spawn on (in a duel the two trade places), so every spawn plays as often on
// one side as on the other, and with the first admiral as often as without.
//
//   node scripts/empires-maps.ts [minutes] [seeds] [maps] [layouts] [difficulty] [profile]
//
//   minutes     how long a game may run before it counts as a stall (default 40)
//   seeds       seeds per map and layout (default 2); each seed's battle has one faction on every
//               seat (Republic, Confederacy, Swarm in turn), so only the spawns differ
//   maps        map ids, comma separated (default every map)
//   layouts     comma separated (default 1v1,full):
//                 1v1   two admirals on spawns as far apart as the map has (on two-spawn maps, the map)
//                 near  two admirals on neighbouring spawns (the first two)
//                 full  every spawn taken, sides alternating round the map (3v3, 2v2, 3v2, 2v1);
//                       on an odd number of spawns the odd one out moves round from seed to seed
//   difficulty  the AIs' difficulty (default medium)
//   profile     the AIs' style (default balanced): every admiral plays the same
//
// It reports per map and layout: how many games ended (a side's stations all destroyed) and how
// long they took, how often each spawn's side won, and per admiral the ore and beacons held at
// their most, the expansions and ships built and the kills: AIs on a map that works expand, fight
// and finish. Games run in parallel worker threads (TOURNAMENT_WORKERS sets how many).

import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { availableParallelism } from 'node:os'

type Job = { i: number; map: string; layout: string; seed: number; diff: string; profile: string; faction: string; spawns: number[]; teams: number[]; minutes: number }
type Seat = { spawn: number; team: number; ore: number; beacons: number; mods: number; built: number; kills: number; alive: boolean }
type Result = { job: Job; winner: number; time: number; seats: Seat[]; ms: number }

const dir = `${new URL('.', import.meta.url).pathname}../src/apps/games/empires/`

async function play(job: Job): Promise<Result> {
  const t0 = performance.now()
  const { MAP } = await import(`${dir}maps.ts`)
  const { STEP, newWorld, tick } = await import(`${dir}sim.ts`)
  const { DIFFICULTY, newBrain, think } = await import(`${dir}ai.ts`)
  const map = MAP[job.map]
  const w = newWorld(map, job.spawns.map((spawn, i) => ({ faction: job.faction, team: job.teams[i], spawn, incomeMul: DIFFICULTY[job.diff].income })), { seed: job.seed })
  const brains = job.spawns.map((_, i) => newBrain(i, job.diff, job.profile))
  const seats: Seat[] = job.spawns.map((spawn, i) => ({ spawn, team: job.teams[i], ore: 0, beacons: 0, mods: 0, built: 0, kills: 0, alive: true }))
  const end = Math.round((job.minutes * 60) / STEP)
  for (let t = 1; t <= end && w.winner === -1; t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    for (const e of w.events) {
      if (e.k === 'expanded' && seats[e.owner]) seats[e.owner].mods++
      if (e.k === 'built' && seats[e.owner]) seats[e.owner].built++
    }
    w.events.length = 0
    if (t % 30) continue
    // Ore and beacons held: platforms are the player's own units on a node; beacons are held by a side.
    seats.forEach((s, o) => {
      const ore = w.nodes.filter((n: { owner: number; site: number }) => n.site && w.byId.get(n.site)?.owner === o).length
      const bc = w.beacons.filter((b: { owner: number }) => b.owner === s.team).length
      s.ore = Math.max(s.ore, ore)
      s.beacons = Math.max(s.beacons, bc)
    })
  }
  seats.forEach((s, o) => {
    s.kills = w.players[o].stats.killed
    s.alive = w.players[o].alive
  })
  return { job, winner: w.winner, time: w.time, seats, ms: performance.now() - t0 }
}

if (!isMainThread) {
  parentPort!.on('message', async (job: Job | null) => {
    if (!job) return process.exit(0)
    parentPort!.postMessage(await play(job))
  })
} else {
  const minutes = Number(process.argv[2] ?? 40)
  const seeds = Number(process.argv[3] ?? 2)
  const { MAPS } = await import(`${dir}maps.ts`)
  const { FACTION_IDS } = await import(`${dir}data.ts`)
  const ids: string[] = process.argv[4] ? process.argv[4].split(',') : MAPS.map((m: { id: string }) => m.id)
  const layouts = (process.argv[5] ?? '1v1,full').split(',')
  const diff = process.argv[6] ?? 'medium'
  const profile = process.argv[7] ?? 'balanced'
  const jobs: Job[] = []
  for (const id of ids) {
    const map = MAPS.find((m: { id: string }) => m.id === id)
    if (!map) throw new Error(`No map ${id}`)
    const n: number = map.spawns.length
    for (const layout of layouts) {
      if ((layout === 'full' || layout === 'near') && n === 2) continue // The same as 1v1.
      for (let s = 1; s <= seeds; s++) {
        const faction: string = FACTION_IDS[(s - 1) % FACTION_IDS.length]
        for (const swap of [0, 1]) {
          let spawns: number[]
          let teams: number[]
          // The second game of each pair moves every admiral on a spawn, so the first admiral (whose
          // ships the sim happens to move first) plays for both sides.
          if (layout === 'near') {
            spawns = swap ? [1, 0] : [0, 1]
            teams = [0, 1]
          } else if (layout === '1v1') {
            // As far apart as the map has: opposite on an even ring, two apart on a five-way one,
            // across the diagonal on four corners.
            const far = n === 2 ? 1 : map.sym === 'quad' ? 3 : n % 2 ? Math.floor(n / 2) : n / 2
            spawns = swap ? [far, 0] : [0, far]
            teams = [0, 1]
          } else {
            spawns = Array.from({ length: n }, (_, i) => (i + swap) % n)
            const shift = n % 2 ? (s - 1) % n : 0
            teams = spawns.map((sp) => ((sp - shift + n) % n) % 2)
          }
          jobs.push({ i: jobs.length, map: id, layout, seed: s * 101 + jobs.length, diff, profile, faction, spawns, teams, minutes })
        }
      }
    }
  }
  const nw = Math.min(jobs.length, Number(process.env.TOURNAMENT_WORKERS ?? Math.max(1, availableParallelism() - 4)))
  console.log(`${jobs.length} games on ${ids.join(', ')} (${layouts.join(', ')}; ${seeds} seeds, each played from both sides), ${diff} ${profile}, up to ${minutes} min each, ${nw} workers`)
  const results: Result[] = []
  const t0 = Date.now()
  await new Promise<void>((done) => {
    let next = 0
    for (let k = 0; k < nw; k++) {
      const wk = new Worker(new URL(import.meta.url))
      const feed = () => (next < jobs.length ? wk.postMessage(jobs[next++]) : wk.postMessage(null))
      wk.on('message', (r: Result) => {
        results.push(r)
        if (results.length % 6 === 0) process.stderr.write(`  ${results.length}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`)
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
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : '-')
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  console.log('\nmap        layout  games  ended  avg min  sim s/game  win% by spawn (its side won)                ore  beacons  expansions  ships  kills (per admiral, peak)')
  let failed = false
  for (const id of ids)
    for (const layout of layouts) {
      const rs = results.filter((r) => r.job.map === id && r.job.layout === layout)
      if (!rs.length) continue
      const ended = rs.filter((r) => r.winner >= 0)
      const spawnIds = [...new Set(rs.flatMap((r) => r.job.spawns))].sort((a, b) => a - b)
      const bySpawn = spawnIds.map((sp) => {
        const games = ended.filter((r) => r.job.spawns.includes(sp))
        const won = games.filter((r) => r.job.teams[r.job.spawns.indexOf(sp)] === r.winner).length
        return `${sp + 1}:${pct(won, games.length)}`
      })
      const seats = rs.flatMap((r) => r.seats)
      const f = (k: keyof Seat) => avg(seats.map((s) => Number(s[k]))).toFixed(1)
      console.log(
        `${id.padEnd(10)} ${layout.padEnd(6)} ${String(rs.length).padStart(6)} ${String(ended.length).padStart(6)} ${avg(ended.map((r) => r.time / 60)).toFixed(1).padStart(8)} ${(avg(rs.map((r) => r.ms)) / 1000).toFixed(0).padStart(11)}  ${bySpawn.join(' ').padEnd(42)} ${f('ore').padStart(5)} ${f('beacons').padStart(8)} ${f('mods').padStart(11)} ${f('built').padStart(6)} ${f('kills').padStart(6)}`,
      )
      if (ended.length < rs.length) failed = true
    }
  const stalls = results.filter((r) => r.winner < 0)
  if (stalls.length) {
    console.log(`\nstalls (${stalls.length})`)
    for (const r of stalls) console.log(`  ${r.job.map} ${r.job.layout} seed ${r.job.seed} ${r.job.faction}: ${r.seats.map((s) => `${s.spawn + 1}/${s.team}${s.alive ? '' : ' out'}`).join(' ')}`)
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s${failed ? '; some games did not end' : ''}`)
}
