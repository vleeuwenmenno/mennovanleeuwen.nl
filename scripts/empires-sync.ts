// Checks that Empires At War battles are deterministic, which multiplayer depends on: every
// player's machine runs the same battle from the same commands, so two copies must never drift.
//
//   node scripts/empires-sync.ts [minutes]
//
// 1. Two copies of the same AI-only battle run side by side and must hash the same every second.
//    This catches state kept outside the world (module-level counters, Math.random).
// 2. Midway, one copy is frozen to a snapshot and thawed into a third, which must then keep pace.
//    This catches state the snapshot misses, which would break resyncs and reconnects.
// It prints the final hash too: the same seed must give the same hash in every browser engine.
// The Republic and the Confederacy play it; then a shorter battle with the Swarm in it is checked
// the same way (its hash printed apart, so the first stays comparable), then six admirals, three
// against three, on the first six-spawn map (a hash of its own too), and then a battle started rich,
// so the admirals put up defense stations, upgrade them and fit their modules early, frozen while
// they stand.

import { MAPS, type MapDef } from '../src/apps/games/empires/maps.ts'
import { STEP, defensesOf, newWorld, stateHash, tick, type World } from '../src/apps/games/empires/sim.ts'
import { PROFILE_IDS, newBrain, think, type Brain } from '../src/apps/games/empires/ai.ts'
import { outdatedSnapshot, restoreBrain, restoreWorld, snapBrain, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import type { FactionId } from '../src/apps/games/empires/data.ts'

const minutes = Number(process.argv[2] ?? 6)
const map = MAPS.find((m) => m.spawns.length === 4) ?? MAPS[0]
type Seat = { faction: FactionId; team: number; spawn: number }
const seatsOf = (sides: FactionId[], m: MapDef = map): Seat[] => m.spawns.map((_, i) => ({ faction: sides[i % sides.length], team: i % 2, spawn: i }))

type Copy = { w: World; brains: Brain[] }
/** How a battle is set up: its map, starting credits, and each seat's profile (PROFILE_IDS, by seat). */
type Opts = { m?: MapDef; credits?: number; profiles?: number[] }
const make = (seats: Seat[], { m = map, credits, profiles = [0, 2, 1, 1] }: Opts = {}): Copy => ({
  w: newWorld(m, seats, { seed: 4242, ...(credits ? { credits } : {}) }),
  // Every AI profile plays in it: defensive and balanced on one side, offensive and balanced on the other.
  brains: seats.map((_, i) => newBrain(i, i % 2 ? 'hard' : 'medium', PROFILE_IDS[profiles[i % 4]])),
})
const step = (c: Copy, forts?: Forts) => {
  for (const b of c.brains) think(c.w, b, STEP)
  tick(c.w)
  if (forts)
    for (const e of c.w.events) {
      if (e.k === 'built' && e.unit.endsWith('-orbital')) forts.built++
      if (e.k === 'fortified') (e.what.endsWith('fitted') ? forts.fitted++ : forts.ups++)
    }
  c.w.events.length = 0
}

let failed = false
/** Plays three copies of one battle with `seats` for `mins` minutes (see above), and says if any drifted. */
/** What the defense stations went through in a battle: built, levels gained, modules fitted, and how
 * many stood (with work under way) when it was frozen. */
type Forts = { built: number; ups: number; fitted: number; frozen: number; busy: number }
/** `freeze`: how far into the battle the third copy is thawed from a snapshot. */
function lockstep(seats: Seat[], mins: number, label: string, opts: Opts & { freeze?: number } = {}): Copy & { forts: Forts } {
  const ticks = Math.round((mins * 60) / STEP)
  const m = opts.m ?? map
  const freeze = opts.freeze ?? 0.5
  const a = make(seats, opts)
  const b = make(seats, opts)
  const forts: Forts = { built: 0, ups: 0, fitted: 0, frozen: 0, busy: 0 }
  let c: Copy | null = null
  const freezeAt = Math.floor(ticks * freeze)
  const started = performance.now()
  for (let t = 1; t <= ticks && a.w.winner === -1; t++) {
    step(a, forts)
    step(b)
    if (c) step(c)
    if (t === freezeAt) {
      const thawed = restoreWorld(snapshotWorld(a.w))
      if (!thawed) throw new Error('snapshot did not restore')
      c = { w: thawed, brains: a.brains.map((x) => restoreBrain(JSON.parse(JSON.stringify(snapBrain(x))))) }
      const standing = a.w.players.flatMap((_, o) => defensesOf(a.w, o))
      forts.frozen = standing.filter((u) => !u.site).length
      forts.busy = standing.filter((u) => u.site || u.dq?.length).length
    }
    if (t % 30 === 0) {
      const ha = stateHash(a.w)
      if (stateHash(b.w) !== ha) {
        console.error(`DESYNC (${label}) between two fresh copies at tick ${t} (${(t * STEP).toFixed(1)} s)`)
        failed = true
        break
      }
      if (c && stateHash(c.w) !== ha) {
        console.error(`DESYNC (${label}) after snapshot/restore at tick ${t} (${(t * STEP).toFixed(1)} s, frozen at tick ${freezeAt})`)
        failed = true
        break
      }
    }
  }
  const secs = (performance.now() - started) / 1000
  const alive = a.w.units.filter((u) => !u.dead).length
  console.log(`${m.name}, ${label}: ${(a.w.time / 60).toFixed(1)} min simulated in ${secs.toFixed(1)} s (3 copies), ${alive} units alive, winner ${a.w.winner}`)
  return { ...a, forts }
}

const a = lockstep(seatsOf(['republic', 'droid']), minutes, 'Republic and Confederacy')
console.log(`final hash ${stateHash(a.w).toString(16)}`)
const three = lockstep(seatsOf(['republic', 'droid', 'swarm', 'swarm']), Math.max(1, minutes / 2), 'with the Swarm')
console.log(`final hash with the Swarm ${stateHash(three.w).toString(16)}`)
const huge = MAPS.find((m) => m.spawns.length === 6)
if (huge) {
  const six = lockstep(seatsOf(['republic', 'droid', 'swarm'], huge), Math.max(1, minutes / 2), 'six admirals', { m: huge })
  console.log(`final hash with six admirals ${stateHash(six.w).toString(16)}`)
}
const rich = lockstep(seatsOf(['republic', 'droid', 'swarm', 'droid']), Math.max(2, (minutes * 4) / 3), 'with defense stations', { credits: 10000, freeze: 0.7, profiles: [0, 0, 0, 1] })
const f = rich.forts
console.log(`defense stations: ${f.built} built, ${f.ups} upgrades, ${f.fitted} modules fitted; ${f.frozen} standing and ${f.busy} with work under way when frozen`)
if (!failed && (!f.built || !f.ups || !f.fitted || !f.frozen)) {
  console.error('the battle with defense stations never built, upgraded and fitted them before the freeze')
  failed = true
}
// Battles saved before there was one ship size: one fought at Big sizes (snapshot version 1 with
// `sizes: 'big'`) carries on; one fought at Classic sizes is refused, and said to be outdated.
const saved = JSON.parse(snapshotWorld(a.w))
const asOld = (sizes?: string) => JSON.stringify({ ...saved, v: 1, ...(sizes ? { sizes } : {}) })
const oldBig = restoreWorld(asOld('big'))
if (!oldBig || stateHash(oldBig) !== stateHash(a.w) || outdatedSnapshot(asOld('big'))) {
  console.error('a battle saved at Big ship sizes before there was only one no longer carries on')
  failed = true
}
if (restoreWorld(asOld()) || restoreWorld(asOld('classic')) || !outdatedSnapshot(asOld()) || outdatedSnapshot(snapshotWorld(a.w))) {
  console.error('a battle saved at Classic ship sizes is not refused as outdated')
  failed = true
}
if (failed) process.exit(1)
console.log('in sync (defense stations built, upgraded and fitted); old saves: Big carries on, Classic is refused')
