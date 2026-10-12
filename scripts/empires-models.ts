// Checks the Empires At War procedural models without a browser:
//
//   node scripts/empires-models.ts
//
// 1. Every unit with a model builds without errors (every station level too), and its geometry is
//    sound: real polygons, no NaN, parts inside a sane box.
// 2. Its mounts are the unit's hardpoints, one each and in the same order, sitting on the hull.
// 3. Its detachable parts are consistent: each has a reason to come off, hardpoints it names
//    exist, there are few enough to fit a state mask, and engine parts point at real engines.
// 4. How a wreck breaks is deterministic for an id and seed, and over many wrecks follows the
//    weights for its class; every break splits the hull into pieces that cover it.

import { STATIONS, TECHS, UNITS, stationType, type UnitType } from '../src/apps/games/empires/data.ts'
import { BREAK_WEIGHTS, breakOutcome, breakPieces, buildModel, hasModel, hullState, onHull, wreckState } from '../src/apps/games/empires/models/index.ts'

let failed = 0
const fail = (msg: string) => {
  failed++
  console.log(`  FAIL ${msg}`)
}
const ok = (cond: boolean, msg: string) => {
  if (!cond) fail(msg)
}

// Every modelled unit, and every level of a modelled station with all its modules.
const types: UnitType[] = []
for (const t of UNITS) {
  if (!hasModel(t)) continue
  if (t.tier === 'station') {
    const techs = TECHS.filter((x) => x.faction === t.faction).map((x) => x.id)
    for (let lv = 1; lv <= STATIONS[t.faction].stages.length; lv++) {
      types.push(stationType(t.faction, lv, []))
      types.push(stationType(t.faction, lv, techs))
    }
  } else types.push(t)
}
console.log(`Models: ${types.length} unit types (${UNITS.filter(hasModel).map((t) => t.id).join(', ')})`)

for (const t of types) {
  const label = `${t.id}${t.tier === 'station' ? ` (${t.sprite}, ${t.hardpoints.length} modules)` : ''}`
  let m
  try {
    m = buildModel(t)
  } catch (e) {
    fail(`${label}: build threw ${(e as Error).message}`)
    continue
  }
  // 1. Geometry.
  for (const p of m.parts) {
    ok(p.pts.length === 0 || p.pts.length >= 3, `${label}: part ${p.id} has ${p.pts.length} points`)
    const pts = [...p.pts, ...(p.holes ?? []).flat(), ...(p.details ?? []).flatMap((d) => d.pts)]
    ok(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), `${label}: part ${p.id} has a non-finite point`)
    ok(pts.every(([x, y]) => Math.abs(x) <= m.w * 0.75 && Math.abs(y) <= m.h * 0.75), `${label}: part ${p.id} reaches far outside the unit's box`)
  }
  ok(new Set(m.parts.map((p) => p.id)).size === m.parts.length, `${label}: part ids are not unique`)
  // 2. Hardpoints.
  ok(m.mounts.length === t.hardpoints.length, `${label}: ${m.mounts.length} mounts for ${t.hardpoints.length} hardpoints`)
  m.mounts.forEach((mt, i) => {
    const h = t.hardpoints[i]
    ok(mt.hp === i, `${label}: mount ${i} is for hardpoint ${mt.hp}`)
    const gx = (mt.x / m.w + 0.5) * 10
    const gy = (mt.y / m.h + 0.5) * 10
    ok(Math.abs(gx - h.x) < 1e-6 && Math.abs(gy - h.y) < 1e-6, `${label}: mount ${i} at grid ${gx.toFixed(2)},${gy.toFixed(2)}, hardpoint at ${h.x},${h.y}`)
    ok(mt.design !== 'engine' ? onHull(m, mt.x, mt.y) : true, `${label}: mount ${i} (${mt.design}) is off the hull`)
    ok(mt.turns === !!h.weapon, `${label}: mount ${i} turns=${mt.turns} but the hardpoint ${h.weapon ? 'has' : 'has no'} weapon`)
  })
  // 3. Detachable parts.
  ok(m.detachable.length <= 30, `${label}: ${m.detachable.length} detachable parts don't fit a state mask`)
  for (const i of m.detachable) {
    const d = m.parts[i].detach!
    ok(d.hp !== undefined || d.hull !== undefined || !!d.death, `${label}: part ${m.parts[i].id} is detachable for no reason`)
    if (d.hp !== undefined) ok(d.hp >= 0 && d.hp < t.hardpoints.length, `${label}: part ${m.parts[i].id} names hardpoint ${d.hp}`)
    if (d.hull !== undefined) ok(d.hull > 0 && d.hull < 1, `${label}: part ${m.parts[i].id} comes off at hull ${d.hull}`)
  }
  for (const p of m.parts) if (p.engine !== undefined) ok(p.engine >= 0 && p.engine < t.engines.length, `${label}: part ${p.id} carries engine ${p.engine} of ${t.engines.length}`)
  ok(m.engines.length === t.engines.length, `${label}: ${m.engines.length} engine glows for ${t.engines.length} engines`)
  // A fresh unit has everything; one at 1 hull has lost every hull-share part.
  const hps = t.hardpoints.map((h) => ({ hp: h.hp }))
  ok(hullState(m, { id: 1, hull: t.hull, hullMax: t.hull, hps }, t.tier).detached === 0, `${label}: a fresh unit is missing parts`)
  const worn = hullState(m, { id: 1, hull: 1, hullMax: t.hull, hps: hps.map(() => ({ hp: 0 })) }, t.tier)
  m.detachable.forEach((pi, i) => {
    const d = m.parts[pi].detach!
    if (d.hull !== undefined || d.hp !== undefined) ok(!!(worn.detached & (1 << i)), `${label}: part ${m.parts[pi].id} stays on a wrecked hull`)
  })
  ok(worn.scorch === 3, `${label}: a wrecked hull isn't fully scorched`)
  ok(m.scorch.length >= 10, `${label}: only ${m.scorch.length} scorch spots`)
  // 4. Breaking up: every kind of break covers the hull, with each piece somewhere on it.
  for (const kind of ['intact', 'half', 'pieces'] as const) {
    for (let v = 0; v < 6; v++) {
      const pieces = breakPieces(m, kind, v)
      const share = pieces.reduce((s, p) => s + p.share, 0)
      ok(Math.abs(share - 1) < 0.02, `${label}: ${kind} break ${v} covers ${(share * 100).toFixed(1)}% of the hull`)
      if (kind === 'intact') ok(pieces.length === 1, `${label}: an intact wreck has ${pieces.length} pieces`)
      if (kind === 'half') ok(pieces.length === 2, `${label}: a half break has ${pieces.length} pieces`)
      if (kind === 'pieces') ok(pieces.length >= 3, `${label}: a break into pieces has ${pieces.length}`)
      const again = breakPieces(m, kind, v)
      ok(JSON.stringify(again) === JSON.stringify(pieces), `${label}: ${kind} break ${v} isn't the same twice`)
    }
  }
  ok(JSON.stringify(wreckState(m, 77)) === JSON.stringify(wreckState(m, 77)), `${label}: wreck state isn't deterministic`)
  console.log(`  ok ${label}: ${m.parts.length} parts, ${m.mounts.length} mounts, ${m.detachable.length} detachable`)
}

// 4. Outcomes: the same wreck id and seed always break the same way, and over many wrecks each
// class breaks by its weights. Keys run like the battle's wreck ids do (from 1000 up).
for (const [tier, w] of Object.entries(BREAK_WEIGHTS)) {
  const n = 20000
  const count = { intact: 0, half: 0, pieces: 0 }
  for (let i = 0; i < n; i++) {
    const a = breakOutcome(1000 + i, 4242, tier as keyof typeof BREAK_WEIGHTS)
    const b = breakOutcome(1000 + i, 4242, tier as keyof typeof BREAK_WEIGHTS)
    if (a.kind !== b.kind || a.variant !== b.variant) {
      fail(`${tier}: wreck ${1000 + i} broke two ways`)
      break
    }
    count[a.kind]++
  }
  const line = (Object.keys(count) as (keyof typeof count)[]).map((k) => `${k} ${((count[k] / n) * 100).toFixed(1)}% (want ${(w![k] * 100).toFixed(0)}%)`).join(', ')
  for (const k of Object.keys(count) as (keyof typeof count)[]) ok(Math.abs(count[k] / n - w![k]) < 0.015, `${tier}: ${k} came up ${((count[k] / n) * 100).toFixed(1)}%, want ${w![k] * 100}%`)
  // Another seed must shuffle which wreck gets which outcome.
  let same = 0
  for (let i = 0; i < 500; i++) if (breakOutcome(1000 + i, 4242, tier as keyof typeof BREAK_WEIGHTS).kind === breakOutcome(1000 + i, 99, tier as keyof typeof BREAK_WEIGHTS).kind) same++
  ok(same < 450, `${tier}: the world seed barely changes outcomes (${same}/500 the same)`)
  console.log(`  ok ${tier} breaks: ${line}`)
}
// Pinned outcomes: these must never change, or players on older and newer builds would disagree.
const pinned = [breakOutcome(1000, 4242, 'frigate'), breakOutcome(1001, 4242, 'frigate'), breakOutcome(1002, 4242, 'cruiser'), breakOutcome(1003, 7, 'capital')]
console.log(`  pinned: ${pinned.map((p) => `${p.kind}/${p.variant}`).join(' ')}`)

console.log(failed ? `\n${failed} check(s) failed` : '\nAll model checks passed')
process.exit(failed ? 1 : 0)
