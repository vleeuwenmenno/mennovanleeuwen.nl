// Checks the Empires At War ground maps (src/apps/games/empires/ground/): headless, no browser.
//
//   node scripts/ground-map-check.ts            # every hand-made map, then a sweep of generated ones
//   node scripts/ground-map-check.ts --quick    # the hand-made maps only
//   node scripts/ground-map-check.ts --print    # also draw each hand-made map as text
//
// For every map in GROUND_MAPS:
// 1. It builds the same twice: the tile arrays and the props hash alike (the sim relies on it).
// 2. It is symmetric: every tile matches its mirror copy (point, diagonal and quad symmetry; a
//    turned map, three or six ways, can't match tile for tile on a square grid).
// 3. Every spawn reaches every other spawn and every crystal field, stepping by canStep (types.ts).
// 4. No blocking prop stands on a ramp or in a spawn's build area, and every blocking prop's tiles
//    are flagged blocked.
// 5. Each spawn's build area is open, buildable level ground.
// 6. Fair: a crystal field within 20 tiles' walk of every base, and every base about as far from
//    its nearest field and from the other bases as every other base is (generate.ts problem()).
// 7. Its kyber crystal clusters (ground/world.ts placeCrystals): every field gets CLUSTERS_MIN to
//    CLUSTERS_MAX of them holding FIELD_KYBER between them, laid out the same twice, none side by
//    side, each with open ground next to it that the first spawn reaches.
// Then generated maps (generate.ts): every recipe for 2, 3, 4 and 6 players at every size, two
// seeds each, must build the same twice and pass the same rules (problem()).

import { GEN_PLAYERS, GEN_SIZES, RECIPES, genId, generateGroundDef, problem } from '../src/apps/games/empires/ground/generate.ts'
import { GROUND_MAPS } from '../src/apps/games/empires/ground/maps.ts'
import { blockedTiles, buildGroundMap, rampsOf, spawnArea } from '../src/apps/games/empires/ground/terrain.ts'
import { TF, TILE, canStep, type GroundMap, type TileGrid } from '../src/apps/games/empires/ground/types.ts'
import { CLUSTERS_MAX, CLUSTERS_MIN, FIELD_KYBER, fieldsOf, placeCrystals } from '../src/apps/games/empires/ground/world.ts'

let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

/** FNV-1a over the grid's arrays and every prop's fields. */
function hashMap(m: GroundMap) {
  let h = 0x811c9dc5
  const byte = (b: number) => (h = Math.imul(h ^ (b & 255), 0x01000193) >>> 0)
  for (const a of [m.grid.terrain, m.grid.height, m.grid.flags]) for (const b of a) byte(b)
  const f = new Float64Array(1)
  const u = new Uint8Array(f.buffer)
  const num = (v: number) => {
    f[0] = v
    for (const b of u) byte(b)
  }
  for (const p of m.props) {
    for (let i = 0; i < p.kind.length; i++) byte(p.kind.charCodeAt(i))
    num(p.x), num(p.y), num(p.size), byte(p.blocks ? 1 : 0)
  }
  for (const s of [...m.spawns, ...m.deposits]) num(s.x), num(s.y)
  return h.toString(16).padStart(8, '0')
}

/** Every tile reachable from `start` by canStep. */
function reach(g: TileGrid, start: number) {
  const seen = new Uint8Array(g.cols * g.rows)
  const queue = [start]
  seen[start] = 1
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q]
    const c = t % g.cols, r = (t - c) / g.cols
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nc = c + dx, nr = r + dy
        if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue
        const u = nr * g.cols + nc
        if (!seen[u] && canStep(g, t, u)) (seen[u] = 1), queue.push(u)
      }
  }
  return seen
}

const tileOf = (g: TileGrid, p: { x: number; y: number }) => Math.floor(p.y / TILE) * g.cols + Math.floor(p.x / TILE)

function print(m: GroundMap) {
  const g = m.grid
  const rows: string[] = []
  const propAt = new Map<number, string>()
  for (const p of m.props) propAt.set(tileOf(g, p), p.blocks ? '#' : '*')
  for (const s of m.spawns) propAt.set(tileOf(g, s), 'S')
  for (const d of m.deposits) propAt.set(tileOf(g, d), 'D')
  for (let r = 0; r < g.rows; r++) {
    let line = ''
    for (let c = 0; c < g.cols; c++) {
      const t = r * g.cols + c
      const f = g.flags[t]
      line += propAt.get(t) ?? (f & TF.bridge ? 'B' : f & TF.ford ? 'f' : f & TF.forest ? 'T' : f & TF.water ? '~' : f & TF.ramp ? '/' : f & TF.blocked ? 'x' : f & TF.deposit ? 'd' : ' .:'[g.height[t]])
    }
    rows.push(line)
  }
  console.log(rows.join('\n'))
}

/** What is wrong with a map's crystal clusters, or null. */
function crystalProblem(m: GroundMap): string | null {
  const g = m.grid
  const fields = fieldsOf(m)
  const cs = placeCrystals(m, fields)
  if (JSON.stringify(cs) !== JSON.stringify(placeCrystals(m, fieldsOf(m)))) return 'clusters laid out differently twice'
  const on = new Set(cs.map((c) => c.r * g.cols + c.c))
  const seen = reach(g, tileOf(g, m.spawns[0]))
  for (let f = 0; f < fields.length; f++) {
    const mine = cs.filter((c) => c.f === f)
    const sum = mine.reduce((n, c) => n + c.left, 0)
    if (mine.length < CLUSTERS_MIN || mine.length > CLUSTERS_MAX || sum !== FIELD_KYBER) return `field ${f}: ${mine.length} clusters holding ${sum}`
    for (const c of mine) {
      if (mine.some((o) => o !== c && Math.abs(o.c - c.c) + Math.abs(o.r - c.r) <= 1)) return `field ${f}: two clusters side by side at ${c.c},${c.r}`
      let open = false
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c.c + dc, rr = c.r + dr
          if ((!dc && !dr) || cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue
          const t = rr * g.cols + cc
          if (!on.has(t) && !(g.flags[t] & TF.blocked) && seen[t]) open = true
        }
      if (!open) return `field ${f}: the cluster at ${c.c},${c.r} has no open ground next to it`
    }
  }
  return null
}

for (const def of GROUND_MAPS) {
  console.log(`\n${def.name} (${def.id}, ${def.cols} × ${def.rows} tiles)`)
  const t0 = performance.now()
  const a = buildGroundMap(def)
  const ms = performance.now() - t0
  const b = buildGroundMap(def)
  const g = a.grid
  if (process.argv.includes('--print')) print(a)
  const ha = hashMap(a), hb = hashMap(b)
  check('builds the same twice', ha === hb, `hash ${ha}, ${ms.toFixed(0)} ms, ${a.props.length} props`)

  // Symmetry, tile by tile, for point and quad symmetry and the diagonal mirror.
  if (def.sym === 'point' || def.sym === 'quad' || def.mirror === 'diagonal') {
    let bad = 0
    for (let t = 0; t < g.cols * g.rows; t++) {
      const c = t % g.cols, r = (t - c) / g.cols
      const copies = def.mirror === 'diagonal' ? [(g.rows - 1 - c) * g.cols + (g.cols - 1 - r)] : def.sym === 'point' ? [g.cols * g.rows - 1 - t] : [r * g.cols + (g.cols - 1 - c), (g.rows - 1 - r) * g.cols + c]
      for (const m of copies) if (g.height[t] !== g.height[m] || g.flags[t] !== g.flags[m] || g.terrain[t] !== g.terrain[m]) bad++
    }
    check('every tile matches its mirror copy', bad === 0, bad ? `${bad} differ` : '')
  }
  // Round 1 sketch maps were laid out before crystals were gathered: no field near the bases yet.
  const fair = problem(a, { nearField: !!def.features })
  check(def.features ? 'fair and playable (crystals near each base, fair distances)' : 'fair and playable (fair distances; a round 1 map, no field near the bases)', !fair, fair ?? '')

  check('has spawns and deposits', a.spawns.length >= 2 && a.deposits.length > 0, `${a.spawns.length} spawns, ${a.deposits.length} deposits, ${rampsOf(a).length} ramps`)
  const crystals = crystalProblem(a)
  check('its crystal clusters: a few a field, holding the field\'s kyber, none side by side, each with open ground to mine from', !crystals, crystals ?? `${placeCrystals(a, fieldsOf(a)).length} clusters on ${a.deposits.length} fields`)
  for (let i = 0; i < a.spawns.length; i++) {
    const seen = reach(g, tileOf(g, a.spawns[i]))
    const others = a.spawns.filter((_, j) => j !== i).every((s) => seen[tileOf(g, s)])
    const deps = a.deposits.filter((d) => !seen[tileOf(g, d)])
    check(`spawn ${i + 1} reaches every other spawn`, others)
    check(`spawn ${i + 1} reaches every deposit`, deps.length === 0, deps.length ? `misses ${deps.map((d) => `${Math.floor(d.x / TILE)},${Math.floor(d.y / TILE)}`).join(' ')}` : '')
  }

  const blockers = a.props.filter((p) => p.blocks)
  const onRamp = blockers.filter((p) => blockedTiles(g, p).some((t) => g.flags[t] & TF.ramp))
  check('no blocking prop on a ramp', onRamp.length === 0, onRamp.map((p) => p.kind).join(', '))
  const unstamped = blockers.filter((p) => blockedTiles(g, p).some((t) => !(g.flags[t] & TF.blocked)))
  check('every blocking prop blocks its tiles', unstamped.length === 0)
  for (let i = 0; i < a.spawns.length; i++) {
    const ar = spawnArea(a, i)
    const inside = (t: number) => {
      const c = t % g.cols, r = (t - c) / g.cols
      return c >= ar.c0 && c <= ar.c1 && r >= ar.r0 && r <= ar.r1
    }
    const inArea = blockers.filter((p) => blockedTiles(g, p).some(inside))
    check(`no blocking prop in spawn ${i + 1}'s build area`, inArea.length === 0, inArea.map((p) => p.kind).join(', '))
    let closed = 0
    for (let r = ar.r0; r <= ar.r1; r++)
      for (let c = ar.c0; c <= ar.c1; c++) {
        const t = r * g.cols + c
        if (g.flags[t] & (TF.blocked | TF.noBuild) || g.height[t] !== g.height[tileOf(g, a.spawns[i])]) closed++
      }
    check(`spawn ${i + 1}'s build area is open level ground`, closed === 0, closed ? `${closed} tiles not` : '')
  }
}

// --- Generated maps -----------------------------------------------------------------------------

if (!process.argv.includes('--quick')) {
  console.log('\nGenerated maps')
  const t0 = performance.now()
  let n = 0, bad = 0
  for (const recipe of RECIPES)
    for (const players of GEN_PLAYERS)
      for (const size of GEN_SIZES)
        for (const seed of [1, 2]) {
          const rules = { recipe, players, size, seed }
          const a = buildGroundMap(generateGroundDef(rules))
          const b = buildGroundMap(generateGroundDef(rules))
          const why = problem(a) ?? crystalProblem(a)
          n++
          if (why || hashMap(a) !== hashMap(b) || a.spawns.length !== players) bad++, check(genId(rules), false, why ?? (a.spawns.length !== players ? `${a.spawns.length} spawns` : 'builds differently twice'))
        }
  check(`every generated map builds the same twice and passes`, !bad, `${n} maps, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
}

if (failed) {
  console.log('\nGround map check failed.')
  process.exit(1)
}
console.log('\nAll ground maps pass.')
