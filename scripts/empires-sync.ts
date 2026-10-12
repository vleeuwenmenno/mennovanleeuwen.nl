// Checks that Empires At War battles are deterministic, which multiplayer depends on: every
// player's machine runs the same battle from the same commands, so two copies must never drift.
//
//   node scripts/empires-sync.ts [minutes] [big]
//
// With `big` (pnpm check:empires-big) the battle is fought with Big ship sizes (models/sizes.ts).
//
// 1. Two copies of the same AI-only battle run side by side and must hash the same every second.
//    This catches state kept outside the world (module-level counters, Math.random).
// 2. Midway, one copy is frozen to a snapshot and thawed into a third, which must then keep pace.
//    This catches state the snapshot misses, which would break resyncs and reconnects.
// It prints the final hash too: the same seed must give the same hash in every browser engine.

import { MAPS } from '../src/apps/games/empires/maps.ts'
import { STEP, newWorld, stateHash, tick, type World } from '../src/apps/games/empires/sim.ts'
import { newBrain, think, type Brain } from '../src/apps/games/empires/ai.ts'
import { restoreBrain, restoreWorld, snapBrain, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'

const minutes = Number(process.argv[2] ?? 6)
const big = process.argv[3] === 'big'
const ticks = Math.round((minutes * 60) / STEP)
const map = MAPS.find((m) => m.spawns.length === 4) ?? MAPS[0]
const seats = map.spawns.map((_, i) => ({ faction: i % 2 ? ('droid' as const) : ('republic' as const), team: i % 2, spawn: i }))

type Copy = { w: World; brains: Brain[] }
const make = (): Copy => ({
  w: newWorld(map, seats, { seed: 4242, ...(big ? { sizes: 'big' as const } : {}) }),
  brains: seats.map((_, i) => newBrain(i, i % 2 ? 'hard' : 'medium')),
})
const step = (c: Copy) => {
  for (const b of c.brains) think(c.w, b, STEP)
  tick(c.w)
  c.w.events.length = 0
}

const a = make()
const b = make()
let c: Copy | null = null
const freezeAt = Math.floor(ticks / 2)
let failed = false
const started = performance.now()
for (let t = 1; t <= ticks && a.w.winner === -1; t++) {
  step(a)
  step(b)
  if (c) step(c)
  if (t === freezeAt) {
    const thawed = restoreWorld(snapshotWorld(a.w))
    if (!thawed) throw new Error('snapshot did not restore')
    c = { w: thawed, brains: a.brains.map((x) => restoreBrain(JSON.parse(JSON.stringify(snapBrain(x))))) }
  }
  if (t % 30 === 0) {
    const ha = stateHash(a.w)
    if (stateHash(b.w) !== ha) {
      console.error(`DESYNC between two fresh copies at tick ${t} (${(t * STEP).toFixed(1)} s)`)
      failed = true
      break
    }
    if (c && stateHash(c.w) !== ha) {
      console.error(`DESYNC after snapshot/restore at tick ${t} (${(t * STEP).toFixed(1)} s, frozen at tick ${freezeAt})`)
      failed = true
      break
    }
  }
}
const secs = (performance.now() - started) / 1000
const alive = a.w.units.filter((u) => !u.dead).length
console.log(`${map.name}${big ? ' (Big ship sizes)' : ''}: ${(a.w.time / 60).toFixed(1)} min simulated in ${secs.toFixed(1)} s (3 copies), ${alive} units alive, winner ${a.w.winner}`)
console.log(`final hash ${stateHash(a.w).toString(16)}`)
if (failed) process.exit(1)
console.log('in sync')
