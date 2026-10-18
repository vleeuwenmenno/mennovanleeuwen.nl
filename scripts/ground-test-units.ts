// Ground unit types for the check scripts only (check:ground, check:ground-nav), registered into
// UNIT when a script loads this file: a ground vehicle of each size class (small, vehicle, large)
// and a small 3 × 3 building. Republic, so a Republic seat may place them.

import { UNIT, type UnitType } from '../src/apps/games/empires/data.ts'
import { groundCenter } from '../src/apps/games/empires/data/kit.ts'

const vehicle = (id: string, size: 1 | 2 | 3, radius: number, speed: number, turn: number, accel: number): UnitType => ({
  id, faction: 'republic', tier: 'vehicle', name: id, blurb: '', sprite: id, aspect: 1, size: radius * 2, hull: 100, shield: 0, regen: 0, speed, turn, pop: 1, cost: 100, build: 5,
  level: 1, squad: 1, sensor: 200, weapons: [], hardpoints: [], engines: [], ground: { size, radius, accel, sight: 6 },
})

export const TEST_UNITS: UnitType[] = [
  vehicle('test-scout', 1, 11, 110, 6, 220),
  vehicle('test-rover', 2, 22, 80, 3, 140),
  vehicle('test-crawler', 3, 36, 50, 1.6, 80),
  { ...groundCenter({ id: 'test-block', faction: 'republic', name: 'Test block', blurb: '', sprite: 'test-block', hull: 1500, cost: 300, build: 10, ground: { foot: [3, 3], income: 0, supply: 0, dropOff: false, trains: [] } }), size: 96 },
]
for (const t of TEST_UNITS) UNIT[t.id] = t
