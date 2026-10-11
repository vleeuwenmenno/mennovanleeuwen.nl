// How busy the battle AI's hands are, and whether the difficulties still rank: AI-only 1v1
// skirmishes on the two-player map, headless and deterministic.
//
//   node scripts/empires-battle-ai.ts [games] [minutes]
//
// For each pairing it plays `games` battles (a seed each, sides swapped every other game) for up
// to `minutes`, and reports the wins, and each difficulty's actions a minute (every command its
// admiral gave: moves, attacks, abilities, builds, research, platforms, repairs) on average and in
// its busiest minute, against its cap. A battle still going at the end goes to the side with more
// fleet and structure value left (a near tie counts as even).

import { MAPS } from '../src/apps/games/empires/maps.ts'
import { STEP, newWorld, tick } from '../src/apps/games/empires/sim.ts'
import { DIFFICULTY, newBrain, think, type Difficulty } from '../src/apps/games/empires/ai.ts'

const games = Number(process.argv[2] ?? 8)
const minutes = Number(process.argv[3] ?? 20)
const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const pairs: [Difficulty, Difficulty][] = [
  ['hard', 'medium'],
  ['medium', 'easy'],
  ['easy', 'veryEasy'],
]
const SAMPLE = Math.round(10 / STEP)

for (const [a, b] of pairs) {
  const wins: Record<string, number> = { [a]: 0, [b]: 0, even: 0 }
  const acts: Record<string, number> = { [a]: 0, [b]: 0 }
  const busiest: Record<string, number> = { [a]: 0, [b]: 0 }
  let time = 0
  for (let n = 1; n <= games; n++) {
    const diffs = n % 2 ? [a, b] : [b, a]
    const seats = diffs.map((d, i) => ({ faction: i ? ('droid' as const) : ('republic' as const), team: i, spawn: i, incomeMul: DIFFICULTY[d].income }))
    const w = newWorld(map, seats, { seed: n * 101 })
    const brains = diffs.map((d, i) => newBrain(i, d))
    // Actions taken so far, every 10 s: the busiest minute is the biggest rise over six samples.
    const trail: number[][] = brains.map(() => [0])
    const end = Math.round((minutes * 60) / STEP)
    for (let t = 1; t <= end && w.winner === -1; t++) {
      for (const br of brains) think(w, br, STEP)
      tick(w)
      w.events.length = 0
      if (t % SAMPLE) continue
      brains.forEach((br, i) => {
        const tr = trail[i]
        tr.push(br.acts)
        busiest[diffs[i]] = Math.max(busiest[diffs[i]], br.acts - tr[Math.max(0, tr.length - 7)])
      })
    }
    time += w.time
    brains.forEach((br, i) => (acts[diffs[i]] += br.acts))
    let winner = w.winner
    if (winner === -1) {
      const worth = (o: number) => w.units.filter((u) => !u.dead && u.owner === o).reduce((s, u) => s + u.t.cost / u.t.squad, 0)
      const d = worth(0) - worth(1)
      winner = Math.abs(d) < 500 ? -1 : d > 0 ? 0 : 1
    }
    if (winner === -1) wins.even++
    else wins[diffs[winner]]++
  }
  const hands = (d: Difficulty) => `${d} ${(acts[d] / (time / 60)).toFixed(0)}/min (busiest minute ${busiest[d]}, cap ${DIFFICULTY[d].apm})`
  console.log(`${a} vs ${b}: ${wins[a]}-${wins[b]} (${wins.even} even), average battle ${(time / games / 60).toFixed(1)} min; actions ${hands(a)}, ${hands(b)}`)
}
