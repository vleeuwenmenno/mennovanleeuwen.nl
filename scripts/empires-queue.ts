// Checks the shipyard queue of Galactic conquest, headless: a station upgrade queued behind ships
// (charged when queued, started once the ships are done, raising the level when it completes),
// refunds on cancel, one upgrade at a time, and old saves whose queue entries have no kind.
//
//   node scripts/empires-queue.ts
//
// Every check prints a line; it exits with 1 if any of them failed.

import * as G from '../src/apps/games/empires/galaxy.ts'
import type { Galaxy } from '../src/apps/games/empires/galaxy.ts'
import { UNIT } from '../src/apps/games/empires/data.ts'

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
} as Storage

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}

function campaign() {
  const g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'republic', difficulty: 'easy', credits: 20000 })
  const cap = g.planets.find((p) => p.owner === 0 && p.station > 0)!
  return { g, cap }
}
const queued = (g: Galaxy, id: number) => g.planets[id].queue.map((q) => q.unit)

{
  const { g, cap } = campaign()
  const level = cap.station
  const up = G.STATION_COST[level + 1]
  const unit = 'r-fighter'
  check('two ships queue', G.buildAt(g, 0, cap.id, unit) === null && G.buildAt(g, 0, cap.id, unit) === null)
  const c1 = g.sides[0].credits
  check('the upgrade queues behind ships', G.cantUpgradeStation(g, 0, cap.id) === null && G.upgradeStation(g, 0, cap.id) === null)
  check('it is charged when queued', g.sides[0].credits === c1 - up, `${c1} -> ${g.sides[0].credits}`)
  check('it sits at the back of the queue', queued(g, cap.id).join() === `${unit},${unit},station`)
  check('only one upgrade at a time', G.upgradeStation(g, 0, cap.id) === 'Already being built')
  check('ships can still queue behind it', G.buildAt(g, 0, cap.id, unit) === null && queued(g, cap.id).length === 4)
  const higher = Object.values(UNIT).find((t) => t.id.startsWith('r-') && t.level === level + 1)
  check('higher-level ships stay locked meanwhile', !higher || (G.cantBuildAt(g, 0, cap.id, higher.id) ?? '').includes('wait for the upgrade'))

  const before = g.sides[0].credits
  G.cancelBuild(g, 0, cap.id, 2)
  check('cancelling refunds the upgrade', g.sides[0].credits === before + up && !queued(g, cap.id).includes('station'))
  check('and it can be queued again', G.upgradeStation(g, 0, cap.id) === null)

  // The ships finish first, then the upgrade runs and raises the level.
  let levelWhenShipsDone = -1
  for (let t = 0; t < 400 && g.planets[cap.id].station === level; t += 0.5) {
    G.tickGalaxy(g, 0.5)
    if (levelWhenShipsDone < 0 && !queued(g, cap.id).some((u) => u !== 'station')) levelWhenShipsDone = g.planets[cap.id].station
  }
  check('the upgrade ran after the ships', levelWhenShipsDone === level)
  check('the station level rose', g.planets[cap.id].station === level + 1, `${level} -> ${g.planets[cap.id].station}`)
}

// A running upgrade can be cancelled for a refund, and the level stays.
{
  const { g, cap } = campaign()
  const level = cap.station
  G.upgradeStation(g, 0, cap.id)
  const credits = g.sides[0].credits
  G.cancelBuild(g, 0, cap.id, 0)
  check('cancelling a running upgrade refunds it', g.sides[0].credits === credits + G.STATION_COST[level + 1] && cap.station === level && !cap.queue.length)
}

// Old saves hold queue entries as plain units (no kind), and they load and run as before.
{
  const { g, cap } = campaign()
  G.buildAt(g, 0, cap.id, 'r-fighter')
  G.saveGalaxy(g)
  const back = G.loadSave(g.save.id)
  const p = back?.planets.find((x) => x.id === cap.id)
  check('a save loads with its queue', !!p && p.queue.length === 1 && p.queue[0].unit === 'r-fighter')
}

if (failed) {
  console.error(`${failed} check${failed > 1 ? 's' : ''} failed`)
  process.exit(1)
}
console.log('All shipyard queue checks passed')
