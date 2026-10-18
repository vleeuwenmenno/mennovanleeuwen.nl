// Checks the ground battle's procedural models without a browser:
//
//   node scripts/ground-models-check.ts
//
// 1. Every ground unit type (data/<faction>.ts, UnitType `ground`) has a model through the normal
//    model lookup (models/index.ts modelFor), and every model is for a ground type of the same faction.
// 2. Each builds without errors, the same twice, and its geometry is sound: real polygons, no NaN,
//    parts inside a sane box round the model's, unique part ids, parts sorted by z, facets and
//    details with real points.
// 3. Buildings fill their footprint (a model drawn on its footprint covers most of it) and vehicles
//    are mostly hull, so neither is drawn as a speck on its box.
// 4. The kyber crystal clusters' shapes (models/kyber.ts) build and are sound the same way, one for
//    every shape the sim lays out (ground/world.ts CRYSTAL_SHAPES).

import { UNITS } from '../src/apps/games/empires/data.ts'
import { modelFor } from '../src/apps/games/empires/models/index.ts'
import { buildGroundModel, crystalModel, crystalShapes, groundModelIds } from '../src/apps/games/empires/models/ground.ts'
import { CRYSTAL_SHAPES } from '../src/apps/games/empires/ground/world.ts'
import type { Model } from '../src/apps/games/empires/models/types.ts'
import { inPart } from '../src/apps/games/empires/models/kit.ts'
import type { Pt } from '../src/apps/games/empires/models/types.ts'

let failed = 0
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    failed++
    console.log(`  FAIL ${msg}`)
  }
}

const real = UNITS.filter((t) => !!t.ground)
const groundModel = (id: string) => modelFor(real.find((t) => t.id === id)!)
// 1. Coverage both ways.
for (const t of real) ok(!!groundModel(t.id), `${t.id} (${t.name}) has no model`)
for (const id of groundModelIds()) {
  const t = real.find((u) => u.id === id)
  ok(!!t, `model ${id} is for no ground unit type`)
  if (t) ok(buildGroundModel(id).faction === t.faction, `model ${id} is in ${buildGroundModel(id).faction}'s folder, the unit is ${t.faction}'s`)
}

const finite = (pts: Pt[]) => pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
/** Checks one model built by `build`: sound, the same twice, filling at least `minFill` of its box. */
function sound(label: string, build: () => Model, minFill: number, name: string) {
  let m: Model
  try {
    m = build()
  } catch (e) {
    ok(false, `${label}: building its model threw ${(e as Error).message}`)
    return
  }
  const t = { id: label }
  // 2. Deterministic and sound.
  ok(JSON.stringify(m) === JSON.stringify(build()), `${t.id}: builds differently twice`)
  const ids = new Set<string>()
  const lim = Math.max(m.w, m.h) * 0.6
  m.parts.forEach((p, i) => {
    ok(!ids.has(p.id), `${t.id}: part id ${p.id} used twice`)
    ids.add(p.id)
    ok(i === 0 || m.parts[i - 1].z <= p.z, `${t.id}: parts not sorted by z at ${p.id}`)
    ok(p.pts.length === 0 || p.pts.length >= 3, `${t.id}: part ${p.id} is not a polygon`)
    ok(finite(p.pts), `${t.id}: part ${p.id} has a NaN point`)
    ok(p.pts.every(([x, y]) => Math.abs(x) <= lim && Math.abs(y) <= lim), `${t.id}: part ${p.id} reaches outside its box`)
    for (const f of p.facets ?? []) ok(f.pts.length >= 3 && finite(f.pts) && Number.isFinite(f.slope[0]) && Number.isFinite(f.slope[1]), `${t.id}: a facet of ${p.id} is broken`)
    for (const d of p.details ?? []) ok(d.pts.length > 0 && finite(d.pts), `${t.id}: a detail of ${p.id} is broken`)
  })
  ok(m.parts.length >= 5, `${t.id}: only ${m.parts.length} parts`)
  // 3. How much of its box it fills.
  const N = 40
  let hit = 0
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * m.w
      const y = ((j + 0.5) / N - 0.5) * m.h
      if (m.parts.some((p) => p.pts.length >= 3 && inPart(p, x, y))) hit++
    }
  const fill = hit / (N * N)
  ok(fill >= minFill, `${t.id}: fills only ${Math.round(fill * 100)}% of its box`)
  console.log(`  ${t.id.padEnd(14)} ${String(m.parts.length).padStart(3)} parts, fills ${Math.round(fill * 100)}% of its box (${name})`)
}
for (const t of real) if (groundModel(t.id)) sound(t.id, () => buildGroundModel(t.id), t.ground?.foot ? 0.55 : 0.3, t.name)

// 4. The crystal clusters.
ok(crystalShapes() === CRYSTAL_SHAPES, `the sim lays out ${CRYSTAL_SHAPES} cluster shapes, there are ${crystalShapes()} models`)
for (let k = 0; k < crystalShapes(); k++) sound(`kyber:${k}`, () => crystalModel(k), 0.18, `kyber crystal cluster, shape ${k + 1}`)

console.log(failed ? `\n${failed} check(s) failed` : '\nAll ground model checks passed')
if (failed) process.exit(1)
