// AI sanity run: whole AI-vs-AI skirmishes to the end, headless. Reports the winner,
// how long it took, and each side's peak fleet (pop and ship count) against its cap. Every pairing
// of factions plays the same three games (republic vs droid first, as it always did).
//
//   node scripts/empires-ai-run.ts [minutes] [pairings]
//
//   pairings  comma separated, each two factions joined by a dash (default: every pairing,
//             republic-droid,republic-swarm,droid-swarm)

import { MAPS } from '../src/apps/games/empires/maps.ts'
import { STEP, newWorld, tick } from '../src/apps/games/empires/sim.ts'
import { DIFFICULTY, newBrain, think, type Difficulty, type Profile } from '../src/apps/games/empires/ai.ts'
import { FACTION_IDS, isShip, type FactionId } from '../src/apps/games/empires/data.ts'

const minutes = Number(process.argv[2] ?? 40)
const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const all: [FactionId, FactionId][] = FACTION_IDS.flatMap((a, i) => FACTION_IDS.slice(i + 1).map((b) => [a, b] as [FactionId, FactionId]))
const pairings = process.argv[3] ? process.argv[3].split(',').map((p) => p.split('-') as [FactionId, FactionId]) : all
const runs: [Difficulty, Profile, Profile, number][] = [
  ['medium', 'balanced', 'balanced', 11],
  ['medium', 'offensive', 'defensive', 22],
  ['medium', 'defensive', 'offensive', 33],
]
for (const [fa, fb] of pairings) {
  for (const [diff, pa, pb, seed] of runs) {
    const w = newWorld(map, [
      { faction: fa, team: 0, spawn: 0, incomeMul: DIFFICULTY[diff].income },
      { faction: fb, team: 1, spawn: 1, incomeMul: DIFFICULTY[diff].income },
    ], { seed })
    const brains = [newBrain(0, diff, pa), newBrain(1, diff, pb)]
    const peakPop = [0, 0]
    const peakShips = [0, 0]
    const peakEng = [0, 0]
    let capSeen = [0, 0]
    const t0 = Date.now()
    for (let t = 0; t < (minutes * 60) / STEP && w.winner === -1; t++) {
      for (const b of brains) think(w, b, STEP)
      tick(w)
      w.events.length = 0
      if (t % 30 === 0)
        for (const o of [0, 1]) {
          const mine = w.units.filter((u) => !u.dead && u.owner === o)
          peakPop[o] = Math.max(peakPop[o], w.players[o].pop)
          peakShips[o] = Math.max(peakShips[o], mine.filter((u) => isShip(u.t)).length)
          peakEng[o] = Math.max(peakEng[o], mine.filter((u) => u.t.kind === 'engineer').length)
          capSeen[o] = Math.max(capSeen[o], w.players[o].popCap)
        }
    }
    console.log(
      `${fa} vs ${fb}, ${diff} ${pa} vs ${pb} (seed ${seed}): winner team ${w.winner} after ${(w.time / 60).toFixed(1)} min (${((Date.now() - t0) / 1000).toFixed(1)} s to run); ` +
        `peak pop ${peakPop.join(' / ')} of cap ${capSeen.join(' / ')}, peak ships ${peakShips.join(' / ')}, peak engineers ${peakEng.join(' / ')}`,
    )
  }
}
