// The ground AI against itself: AI-only 1v1 ground battles, headless and deterministic, for
// balancing the ground game (factions, tiers, weapons) and the ground AI.
//
//   node scripts/empires-ground-tournament.ts [minutes] [seeds] [difficulty] [maps]
//
//   minutes     how long a battle may run before it counts as a stall (default 45)
//   seeds       seeds per map and pairing (default 2)
//   difficulty  the AI difficulty, both sides' (default medium) or two joined by a dash (medium-easy:
//               the first faction of each pairing plays the first, so each side's wins show how
//               the levels compare)
//   maps        comma separated ground map ids (default every hand-made ground map)
//
// Every ordered pairing of different factions plays on every map, so each faction plays each
// other from both spawns. It reports each faction's wins and losses (a stall goes to the side with
// clearly more army and building value left, or counts as a draw), each pairing, how long battles
// took, the fighting units each faction built by tier, and the kills by the weapon of the killer.
// Battles run in parallel worker threads (TOURNAMENT_WORKERS sets how many).

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { availableParallelism } from 'node:os'

type Job = { i: number; map: string; seed: number; diff: string; factions: [string, string]; minutes: number }
type Side = { faction: string; built: Record<string, number>; kills: Record<string, number>; worth: number; buildings: number; techs: number; tiers: number }
type Result = { job: Job; winner: number; time: number; stall: boolean; sides: Side[] }

const here = new URL('.', import.meta.url).pathname
const dir = `${here}../src/apps/games/empires/`

/** What a ground unit is, for the tables: its tier, or what it is if it has none. */
function kindOf(t: { id: string; ground?: { tier?: number; foot?: unknown; builds?: unknown[] }; role?: { role: string } }) {
  if (t.ground?.foot) return 'building'
  if (t.ground?.builds?.length) return 'engineer'
  if (t.role?.role === 'Scout') return 'scout'
  return `tier ${t.ground?.tier ?? 1}`
}

async function play(job: Job): Promise<Result> {
  const { STEP, newWorld, tick } = await import(`${dir}sim.ts`)
  const { DIFFICULTY, newBrain, think } = await import(`${dir}ai.ts`)
  const { groundMapDef } = await import(`${dir}ground/world.ts`)
  const { UNIT } = await import(`${dir}data.ts`)
  const map = groundMapDef(job.map)
  const diffs = job.diff.includes('-') ? job.diff.split('-') : [job.diff, job.diff]
  const w = newWorld(map, job.factions.map((f, i) => ({ faction: f, team: i, spawn: i, incomeMul: DIFFICULTY[diffs[i]].income })), { seed: job.seed, credits: 1600 })
  const brains = job.factions.map((_, i) => newBrain(i, diffs[i], 'balanced'))
  const sides: Side[] = job.factions.map((f) => ({ faction: f, built: {}, kills: {}, worth: 0, buildings: 0, techs: 0, tiers: 0 }))
  const alive = new Map<number, (typeof w.units)[number]>()
  const end = Math.round((job.minutes * 60) / STEP)
  for (let t = 1; t <= end && w.winner === -1; t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    for (const e of w.events) if (e.k === 'trained' && sides[e.owner]) {
      const k = kindOf(UNIT[e.unit] ?? { id: e.unit })
      sides[e.owner].built[k] = (sides[e.owner].built[k] ?? 0) + 1
    }
    w.events.length = 0
    // Kills, by the weapon of whoever dealt the last blow.
    if (t % 6 === 0) {
      for (const u of w.units) if (!u.dead && !alive.has(u.id)) alive.set(u.id, u)
      for (const [id, u] of alive) {
        if (!u.dead) continue
        alive.delete(id)
        const by = w.byId.get(u.hitBy)
        if (!by || !sides[by.owner]) continue
        const gun = by.guns.find((g: { w: { ground?: string } }) => g.w.ground)
        const k = gun?.w.ground ?? 'other'
        sides[by.owner].kills[k] = (sides[by.owner].kills[k] ?? 0) + 1
      }
    }
  }
  for (const s of sides) s.worth = 0
  for (const u of w.units) {
    if (u.dead || !sides[u.owner]) continue
    sides[u.owner].worth += u.site ? 0 : u.t.cost * (u.hull / u.hullMax)
    if (u.foot && !u.site) sides[u.owner].buildings++
    if (u.foot && (u.t.ground?.tier ?? 1) > 1) sides[u.owner].tiers += (u.t.ground.tier ?? 1) - 1
  }
  w.players.forEach((p: { techs: string[] }, i: number) => sides[i] && (sides[i].techs = p.techs.length))
  let winner = w.winner
  const stall = winner === -1
  if (stall) {
    const [a, b] = sides.map((s) => s.worth)
    winner = a > b * 1.5 ? 0 : b > a * 1.5 ? 1 : -1
  }
  return { job, winner, time: w.time, stall, sides }
}

if (!isMainThread) {
  parentPort!.on('message', async (job: Job) => parentPort!.postMessage(await play(job)))
} else {
  const minutes = Number(process.argv[2] ?? 45)
  const seeds = Number(process.argv[3] ?? 2)
  const diff = process.argv[4] ?? 'medium'
  const { GROUND_MAPS } = await import(`${dir}ground/maps.ts`)
  const maps: string[] = process.argv[5]?.split(',') ?? GROUND_MAPS.map((m: { id: string }) => m.id)
  const F = ['republic', 'droid', 'swarm']
  const jobs: Job[] = []
  for (const map of maps)
    for (let s = 0; s < seeds; s++)
      for (const a of F) for (const b of F) if (a !== b) jobs.push({ i: jobs.length, map, seed: 1000 + s * 17, diff, factions: [a, b], minutes })
  const n = Math.min(jobs.length, Number(process.env.TOURNAMENT_WORKERS) || Math.max(1, availableParallelism() - 1))
  const results: Result[] = []
  const started = Date.now()
  await new Promise<void>((done) => {
    let next = 0
    for (let k = 0; k < n; k++) {
      const wk = new Worker(new URL(import.meta.url), { workerData: {} })
      const feed = () => (next < jobs.length ? wk.postMessage(jobs[next++]) : wk.terminate())
      wk.on('message', (r: Result) => {
        results.push(r)
        process.stdout.write(`\r${results.length}/${jobs.length} battles`)
        if (results.length === jobs.length) done()
        feed()
      })
      feed()
    }
  })
  void workerData
  console.log(`\n${jobs.length} battles on ${maps.join(', ')}, ${diff}, up to ${minutes} min, in ${Math.round((Date.now() - started) / 1000)} s\n`)
  // Factions.
  const row = (name: string, rs: { won: boolean; lost: boolean; time: number }[]) => {
    const won = rs.filter((r) => r.won).length
    const lost = rs.filter((r) => r.lost).length
    return `${name.padEnd(22)} ${String(won).padStart(3)} won ${String(lost).padStart(3)} lost ${String(rs.length - won - lost).padStart(3)} drawn  ${String(Math.round((won / Math.max(1, won + lost)) * 100)).padStart(3)}%`
  }
  if (diff.includes('-')) {
    const [d0, d1] = diff.split('-')
    const won = results.filter((r) => r.winner === 0).length
    const lost = results.filter((r) => r.winner === 1).length
    console.log(`${d0} against ${d1}: ${won} won, ${lost} lost, ${results.length - won - lost} drawn\n`)
  }
  console.log('Faction                  wins (of decided)')
  for (const f of F) {
    const rs = results.flatMap((r) => r.sides.map((s, i) => (s.faction === f ? { won: r.winner === i, lost: r.winner === 1 - i, time: r.time } : null)).filter((x) => !!x))
    console.log(row(f, rs as { won: boolean; lost: boolean; time: number }[]))
  }
  console.log('\nPairing (first faction)')
  for (const a of F)
    for (const b of F) {
      if (a >= b) continue
      const rs = results.filter((r) => r.job.factions.includes(a) && r.job.factions.includes(b)).map((r) => {
        const i = r.job.factions.indexOf(a)
        return { won: r.winner === i, lost: r.winner === 1 - i, time: r.time }
      })
      console.log(row(`${a} v ${b}`, rs))
    }
  console.log('\nMap')
  for (const m of maps) {
    const rs = results.filter((r) => r.job.map === m)
    const ended = rs.filter((r) => !r.stall)
    const mins = ended.map((r) => r.time / 60).sort((x, y) => x - y)
    console.log(`${m.padEnd(22)} ${ended.length}/${rs.length} ended, median ${mins.length ? mins[Math.floor(mins.length / 2)].toFixed(1) : '-'} min (${mins.length ? mins[0].toFixed(1) : '-'} to ${mins.length ? mins[mins.length - 1].toFixed(1) : '-'})`)
  }
  for (const r of results.filter((x) => x.stall)) console.log(`  stall: ${r.job.map} seed ${r.job.seed} ${r.job.factions.join(' v ')}, worth ${r.sides.map((x) => Math.round(x.worth)).join(' v ')}`)
  const all = results.filter((r) => !r.stall).map((r) => r.time / 60).sort((x, y) => x - y)
  console.log(`all maps               ${all.length}/${results.length} ended, median ${all.length ? all[Math.floor(all.length / 2)].toFixed(1) : '-'} min; ${results.filter((r) => r.stall).length} stalls`)
  console.log('\nBuilt per battle (fighting units)')
  const kinds = ['scout', 'tier 1', 'tier 2', 'tier 3']
  console.log(`${'faction'.padEnd(22)} ${kinds.map((k) => k.padStart(7)).join(' ')}  techs  factory tiers`)
  for (const f of F) {
    const ss = results.flatMap((r) => r.sides.filter((s) => s.faction === f))
    const avg = (k: string) => (ss.reduce((n, s) => n + (s.built[k] ?? 0), 0) / ss.length).toFixed(1)
    console.log(`${f.padEnd(22)} ${kinds.map((k) => avg(k).padStart(7)).join(' ')}  ${(ss.reduce((n, s) => n + s.techs, 0) / ss.length).toFixed(1).padStart(5)}  ${(ss.reduce((n, s) => n + s.tiers, 0) / ss.length).toFixed(1).padStart(5)}`)
  }
  console.log('\nKills by the killer\'s weapon (all battles)')
  const weapons = ['pulse', 'beam', 'rocket', 'shell', 'artillery', 'swarm', 'spray', 'other']
  const total: Record<string, number> = {}
  for (const r of results) for (const s of r.sides) for (const [k, v] of Object.entries(s.kills)) total[k] = (total[k] ?? 0) + v
  console.log(weapons.map((k) => `${k} ${total[k] ?? 0}`).join(', '))
}
