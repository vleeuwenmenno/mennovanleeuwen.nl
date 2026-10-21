import { mirrored, rng, type Pt } from '../maps.ts'
import { LEVELS, TF, TILE, terrainIndex, type GroundFeatures, type GroundMap, type GroundMapDef, type Prop, type TileGrid, type TilePt } from './types.ts'

// Builds a ground map from its sketch (types.ts GroundMapDef): the tile grid with heights, ramps,
// water, deposits and terrain, and the props scattered over it. This is sim data: the ground sim
// and the renderer both start from it, so it must come out the same on every machine. Only exactly
// rounded maths (+ - * /, Math.floor, Math.imul) and the seeded `rng` are used, never Math.random
// or Date, and the symmetric copies are made by copying values rather than recomputing them.
//
// The steps, in order:
// 1. The sketch is filled in by symmetry ('.' and missing rows are taken from their mirror copy).
// 2. Ramp cells get their two heights from their neighbours, and walls on their open sides.
// 3. Every other tile reads its height from the sketch at a position nudged by smooth noise, so
//    cliff lines wobble instead of following the 4-tile sketch grid; the nudge fades out near ramps
//    so ramps always meet the levels they join. A majority pass then smooths away slivers.
// 4. Cliff faces block the low tile at their foot, deposits are stamped, the border is unbuildable.
// 5. Terrain: rocky plateaus with dirt pockets, rocky scree spilling below every cliff foot, dirt
//    and grass by noise on the lower ground (grass kept back from cliffs).
// 6. Props, scattered by ground type, spaced, and kept off spawns, ramps and deposits.

/** Half the side, in tiles, of the square kept clear of props round each spawn (its build area). */
export const SPAWN_CLEAR = 8

/** What each prop sprite is: whether it blocks movement (and stamps TF.blocked under it), whether it
 * stands tall (a tree: drawn above units every frame instead of baked into the ground), whether it
 * is stone (tinted to the biome's rock when drawn), and how high it seems to stand (its lift
 * shadow's offset, as a fraction of its size). */
export const PROP_INFO: Record<string, { blocks: boolean; tall: boolean; stone: boolean; lift: number }> = {
  'tree-broad': { blocks: true, tall: true, stone: false, lift: 0.2 },
  'tree-round': { blocks: true, tall: true, stone: false, lift: 0.2 },
  bush: { blocks: false, tall: false, stone: false, lift: 0.1 },
  'shrub-alien': { blocks: false, tall: false, stone: false, lift: 0.08 },
  'rock-small': { blocks: false, tall: false, stone: true, lift: 0.1 },
  'rock-medium': { blocks: true, tall: false, stone: true, lift: 0.1 },
  boulder: { blocks: true, tall: false, stone: true, lift: 0.12 },
  'rock-cluster': { blocks: false, tall: false, stone: true, lift: 0.1 },
  'stone-heap': { blocks: true, tall: false, stone: true, lift: 0.1 },
  'stone-slabs': { blocks: false, tall: false, stone: true, lift: 0.05 },
  rubble: { blocks: false, tall: false, stone: true, lift: 0.04 },
  outcrop: { blocks: true, tall: false, stone: true, lift: 0.12 },
  'rock-spikes': { blocks: true, tall: false, stone: true, lift: 0.14 },
  cairn: { blocks: false, tall: false, stone: true, lift: 0.14 },
  'cracked-stone': { blocks: false, tall: false, stone: true, lift: 0.03 },
  'stones-grass': { blocks: false, tall: false, stone: true, lift: 0.08 },
}

/** Which props each kind of ground gets: [kind, smallest size, largest size, weight], sizes in world
 * units. Never trees or bushes on the plateau's stone. */
const SETS: Record<Ground, [string, number, number, number][]> = {
  plateau: [
    ['stone-heap', 44, 64, 2],
    ['stone-slabs', 50, 76, 4],
    ['rubble', 50, 76, 4],
    ['outcrop', 56, 80, 1],
    ['cracked-stone', 56, 84, 4],
    ['cairn', 30, 40, 1],
    ['rock-spikes', 44, 60, 1],
    ['stones-grass', 46, 64, 3],
    ['boulder', 54, 74, 1],
  ],
  scree: [
    ['rubble', 44, 70, 4],
    ['stone-heap', 40, 64, 3],
    ['rock-small', 20, 34, 3],
    ['rock-medium', 34, 50, 2],
    ['stone-slabs', 40, 60, 1],
  ],
  grass: [
    ['tree-broad', 100, 132, 3],
    ['tree-round', 80, 104, 3],
    ['bush', 60, 84, 3],
    ['shrub-alien', 50, 66, 1],
    ['rock-small', 22, 32, 1],
  ],
  dirt: [
    ['bush', 56, 74, 1],
    ['rock-small', 22, 34, 3],
    ['rock-medium', 36, 50, 2],
    ['rock-cluster', 50, 66, 2],
    ['shrub-alien', 46, 60, 1],
    ['boulder', 64, 90, 1],
  ],
}
type Ground = 'plateau' | 'scree' | 'grass' | 'dirt'
/** The chance that a 2 × 2 tile spot on each kind of ground gets a prop. */
const DENSITY: Record<Ground, number> = { plateau: 0.16, scree: 0.42, grass: 0.3, dirt: 0.12 }

// --- Deterministic noise -------------------------------------------------------------------------

/** A hash of a lattice point to [0, 1). */
function hash2(x: number, y: number, seed: number) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1) with a feature size of one unit of x and y. The same on every
 * machine (only exactly rounded maths), so the sim can use it; the renderer uses it too for the
 * finer blending, with its own seeds. */
export function valueNoise(seed: number) {
  return (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = x - xi
    const fy = y - yi
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = hash2(xi, yi, seed)
    const b = hash2(xi + 1, yi, seed)
    const c = hash2(xi, yi + 1, seed)
    const d = hash2(xi + 1, yi + 1, seed)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

// --- Symmetry in tile space ----------------------------------------------------------------------

/** Every copy of tile (c, r) under the map's symmetry, as tile indices, the tile itself first. */
function tileCopies(cols: number, rows: number, def: GroundMapDef, c: number, r: number): number[] {
  if (def.mirror === 'diagonal') {
    const m = (rows - 1 - c) * cols + (cols - 1 - r)
    const i = r * cols + c
    return m === i ? [i] : [i, m]
  }
  const out: number[] = []
  for (const p of mirrored({ w: cols - 1, h: rows - 1, sym: def.sym }, { x: c, y: r })) {
    const pc = Math.round(p.x)
    const pr = Math.round(p.y)
    if (pc < 0 || pr < 0 || pc >= cols || pr >= rows) continue
    const i = pr * cols + pc
    if (!out.includes(i)) out.push(i)
  }
  return out
}

/** Every copy of a world point, the point itself first, without duplicates. */
function pointCopies(def: GroundMapDef, p: Pt): Pt[] {
  const W = def.cols * TILE, H = def.rows * TILE
  if (def.mirror === 'diagonal') {
    const q = { x: W - p.y, y: H - p.x }
    return Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) < 1 ? [p] : [p, q]
  }
  const all = mirrored({ w: def.cols * TILE, h: def.rows * TILE, sym: def.sym }, p)
  return all.filter((q, i) => all.findIndex((o) => Math.abs(o.x - q.x) < 1 && Math.abs(o.y - q.y) < 1) === i)
}

// --- Ramps ---------------------------------------------------------------------------------------

/** A ramp as the renderer and screens see it: its tiles' box (walls included), which way is up
 * (`dx`, `dy`: a unit step towards the high end) and the two levels it joins. */
export type GroundRamp = { c0: number; r0: number; c1: number; r1: number; dx: number; dy: number; lo: number; hi: number }

/** The map's ramps, found from the grid: each connected group of ramp tiles, with the walls beside it. */
export function rampsOf(map: GroundMap): GroundRamp[] {
  const g = map.grid
  const seen = new Uint8Array(g.cols * g.rows)
  const out: GroundRamp[] = []
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !(g.flags[i] & TF.ramp)) continue
    let c0 = g.cols, r0 = g.rows, c1 = -1, r1 = -1
    let lo = LEVELS, hi = -1
    const stack = [i]
    seen[i] = 1
    const tiles: number[] = []
    while (stack.length) {
      const t = stack.pop()!
      tiles.push(t)
      const c = t % g.cols, r = (t - c) / g.cols
      c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r)
      lo = Math.min(lo, g.height[t]); hi = Math.max(hi, g.height[t])
      for (const [ox, oy] of N4) {
        const nc = c + ox, nr = r + oy
        if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue
        const n = nr * g.cols + nc
        if (!seen[n] && g.flags[n] & TF.ramp) (seen[n] = 1), stack.push(n)
      }
    }
    // Up is the way from the low tiles' middle to the high tiles'.
    let hx = 0, hy = 0, hn = 0, lx = 0, ly = 0, ln = 0
    for (const t of tiles) {
      const c = t % g.cols, r = (t - c) / g.cols
      if (g.height[t] === hi) (hx += c), (hy += r), hn++
      else (lx += c), (ly += r), ln++
    }
    const vx = hn && ln ? hx / hn - lx / ln : 0
    const vy = hn && ln ? hy / hn - ly / ln : -1
    const across = Math.abs(vx) >= Math.abs(vy)
    const dx = across ? Math.sign(vx) : 0
    const dy = across ? 0 : Math.sign(vy) || -1
    // Walls: blocked tiles just beside the ramp on its open sides.
    const wall = (c: number, r: number) => c >= 0 && r >= 0 && c < g.cols && r < g.rows && (g.flags[r * g.cols + c] & TF.blocked) !== 0
    if (dx === 0) {
      if (wall(c0 - 1, r0) && wall(c0 - 1, r1)) c0--
      if (wall(c1 + 1, r0) && wall(c1 + 1, r1)) c1++
    } else {
      if (wall(c0, r0 - 1) && wall(c1, r0 - 1)) r0--
      if (wall(c0, r1 + 1) && wall(c1, r1 + 1)) r1++
    }
    out.push({ c0, r0, c1, r1, dx, dy, lo, hi })
  }
  return out
}

const N4: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
const N8: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]

/** The tile box kept clear round spawn `i` (its build area): inclusive tile columns and rows. */
export function spawnArea(map: GroundMap, i: number) {
  const s = map.spawns[i]
  const c = Math.round(s.x / TILE)
  const r = Math.round(s.y / TILE)
  return { c0: c - SPAWN_CLEAR, r0: r - SPAWN_CLEAR, c1: c + SPAWN_CLEAR - 1, r1: r + SPAWN_CLEAR - 1 }
}

// --- The build -----------------------------------------------------------------------------------

type Cell = { ch: string; given: boolean }

/** The sketch as a full grid of characters, the gaps filled from their mirror copies. */
function expandSketch(def: GroundMapDef): Cell[][] {
  const sw = def.cols / def.cell
  const sh = def.rows / def.cell
  if (sw !== Math.floor(sw) || sh !== Math.floor(sh)) throw new Error(`${def.id}: the map size must be a whole number of sketch cells`)
  const cells: Cell[][] = []
  for (let j = 0; j < sh; j++) {
    const row = def.sketch[j] ?? ''
    if (row.length > sw) throw new Error(`${def.id}: sketch row ${j} is ${row.length} wide, more than ${sw}`)
    cells.push(Array.from({ length: sw }, (_, i) => ({ ch: row[i] ?? '.', given: (row[i] ?? '.') !== '.' })))
  }
  for (let j = 0; j < sh; j++)
    for (let i = 0; i < sw; i++) {
      if (cells[j][i].given) continue
      const from = mirrored({ w: sw, h: sh, sym: def.sym }, { x: i + 0.5, y: j + 0.5 })
        .map((p) => cells[Math.floor(p.y)]?.[Math.floor(p.x)])
        .find((c) => c?.given)
      if (!from) throw new Error(`${def.id}: sketch cell ${i},${j} is empty and so is every copy of it`)
      cells[j][i] = { ch: from.ch, given: false }
    }
  return cells
}

const levelOf = (ch: string) => (ch === 'S' ? 2 : ch === 'd' || ch === '~' ? 0 : ch >= '0' && ch <= '9' ? Number(ch) : -1)

/** Builds the map: the same result for the same def on every machine. */
export function buildGroundMap(def: GroundMapDef): GroundMap {
  const map = def.features ? buildFeatureMap(def) : buildSketchMap(def)
  map.grid.elev = buildElev(map)
  return map
}

function buildSketchMap(def: GroundMapDef): GroundMap {
  const { cols, rows, cell } = def
  const n = cols * rows
  const cells = expandSketch(def)
  const sw = cols / cell
  const sh = rows / cell
  const at = (i: number, j: number) => cells[Math.min(sh - 1, Math.max(0, j))][Math.min(sw - 1, Math.max(0, i))].ch
  for (const row of cells) for (const c of row) if (c.ch !== '/' && levelOf(c.ch) < 0) throw new Error(`${def.id}: unknown sketch character '${c.ch}'`)

  const height = new Uint8Array(n)
  const flags = new Uint8Array(n)
  const terrain = new Uint8Array(n)
  /** Tiles whose height is settled by a ramp (the ramp itself and its walls): nothing moves them. */
  const fixed = new Uint8Array(n)

  // Ramps: each '/' cell joins the levels on either side of it along one axis, and gets walls on
  // its open sides, so it can only be entered at its ends.
  const isRamp = (i: number, j: number) => i >= 0 && j >= 0 && i < sw && j < sh && cells[j][i].ch === '/'
  for (let j = 0; j < sh; j++)
    for (let i = 0; i < sw; i++) {
      if (!isRamp(i, j)) continue
      const lv = (a: number, b: number) => (a < 0 || b < 0 || a >= sw || b >= sh || isRamp(a, b) ? -1 : levelOf(cells[b][a].ch))
      const n0 = lv(i, j - 1), s0 = lv(i, j + 1), w0 = lv(i - 1, j), e0 = lv(i + 1, j)
      const vert = n0 >= 0 && s0 >= 0 && n0 !== s0 ? Math.abs(n0 - s0) : 0
      const horz = w0 >= 0 && e0 >= 0 && w0 !== e0 ? Math.abs(w0 - e0) : 0
      if (!vert && !horz) throw new Error(`${def.id}: ramp cell ${i},${j} doesn't join two levels`)
      const upDown = vert >= horz
      const dx = upDown ? 0 : e0 > w0 ? 1 : -1
      const dy = upDown ? (s0 > n0 ? 1 : -1) : 0
      const hi = upDown ? Math.max(n0, s0) : Math.max(w0, e0)
      const lo = upDown ? Math.min(n0, s0) : Math.min(w0, e0)
      // Open sides: the two cells across the slope, unless they are ramp cells too.
      const sideA = upDown ? !isRamp(i - 1, j) : !isRamp(i, j - 1)
      const sideB = upDown ? !isRamp(i + 1, j) : !isRamp(i, j + 1)
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          const t = (j * cell + y) * cols + i * cell + x
          fixed[t] = 1
          const across = upDown ? x : y
          if ((sideA && across === 0) || (sideB && across === cell - 1)) {
            height[t] = hi
            flags[t] = TF.blocked | TF.noBuild
            terrain[t] = terrainIndex('rocky')
            continue
          }
          // How far up the ramp this tile is: the half nearer the top stands at the high level.
          const along = upDown ? y : x
          const up = (dy > 0 || dx > 0 ? along : cell - 1 - along) / (cell - 1)
          height[t] = up >= 0.5 ? hi : lo
          flags[t] = TF.ramp | TF.noBuild
          terrain[t] = terrainIndex('dirt')
        }
    }

  // How far each tile is from the nearest ramp tile (Chebyshev, in tiles, capped): the cliff wobble
  // fades out near ramps so their ends stay square with the levels they meet.
  const nearRamp = chebyshevFrom(cols, rows, (i) => fixed[i] === 1, 6)

  // Heights and water from the sketch, read at a position nudged by noise. Computed for one tile of
  // each symmetric set and copied to the others, so the copies match exactly.
  const wobX = valueNoise(def.seed * 7 + 1)
  const wobY = valueNoise(def.seed * 7 + 2)
  const AMP = 1.7
  const FREQ = 1 / 7
  const water = new Uint8Array(n)
  const done = new Uint8Array(n)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const t = r * cols + c
      if (done[t]) continue
      const damp = clamp01((nearRamp[t] - 1) / 3)
      const ox = (wobX(c * FREQ, r * FREQ) - 0.5) * 2 * AMP * damp
      const oy = (wobY(c * FREQ, r * FREQ) - 0.5) * 2 * AMP * damp
      let ch = at(Math.floor((c + 0.5 + ox) / cell), Math.floor((r + 0.5 + oy) / cell))
      if (ch === '/') ch = at(Math.floor((c + 0.5) / cell), Math.floor((r + 0.5) / cell))
      if (ch === '/') ch = '0'
      for (const k of tileCopies(cols, rows, def, c, r)) {
        done[k] = 1
        if (fixed[k]) continue
        height[k] = levelOf(ch)
        water[k] = ch === '~' ? 1 : 0
      }
    }

  // Smooth away slivers: a tile most of whose neighbours sit on another level (or are water when it
  // isn't, or the other way round) joins them. Two passes, each read from a copy, so the result
  // doesn't depend on the order the tiles are visited in and stays symmetric.
  const key = (i: number) => (water[i] ? 9 : height[i])
  for (let pass = 0; pass < 2; pass++) {
    const before = Uint8Array.from({ length: n }, (_, i) => key(i))
    for (let r = 1; r < rows - 1; r++)
      for (let c = 1; c < cols - 1; c++) {
        const t = r * cols + c
        if (fixed[t] || nearRamp[t] <= 2) continue
        const count = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        for (const [ox, oy] of N8) count[before[t + oy * cols + ox]]++
        let best = before[t]
        for (let v = 0; v < 10; v++) if (count[v] >= 5 && v !== before[t]) best = v
        if (best === before[t]) continue
        if (best === 9) (water[t] = 1), (height[t] = 0)
        else (water[t] = 0), (height[t] = best)
      }
  }
  for (let t = 0; t < n; t++) if (water[t]) flags[t] |= TF.water | TF.blocked | TF.noBuild

  // Spawns and deposits: from the cells the sketch wrote, copied by symmetry.
  const spawns: Pt[] = []
  const deposits: Pt[] = []
  for (let j = 0; j < sh; j++)
    for (let i = 0; i < sw; i++) {
      const { ch, given } = cells[j][i]
      if (!given) continue
      if (ch === 'S') for (const p of pointCopies(def, { x: (i + 0.5) * cell * TILE, y: (j + 0.5) * cell * TILE })) addUnique(spawns, p)
      // A deposit is 3 × 3 tiles round the tile just past the cell's middle.
      if (ch === 'd') for (const p of pointCopies(def, { x: (i * cell + Math.floor(cell / 2) + 0.5) * TILE, y: (j * cell + Math.floor(cell / 2) + 0.5) * TILE })) addUnique(deposits, p)
    }
  for (const d of deposits) {
    const dc = Math.floor(d.x / TILE), dr = Math.floor(d.y / TILE)
    for (let y = -2; y <= 2; y++)
      for (let x = -2; x <= 2; x++) {
        const c = dc + x, r = dr + y
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const t = r * cols + c
        if (fixed[t]) continue
        const core = Math.abs(x) <= 1 && Math.abs(y) <= 1
        height[t] = 0
        water[t] = 0
        flags[t] = core ? TF.deposit : TF.noBuild
      }
  }

  // Cliff feet: the low tile at the foot of every cliff is under the rock face (or the rubble below
  // a north-facing lip), so nothing stands on it. All four sides alike, so the sides of a mirrored
  // map stay equal although the camera sees south faces and not north ones.
  const rampish = (t: number) => (flags[t] & TF.ramp) !== 0
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const t = r * cols + c
      if (rampish(t) || flags[t] & TF.water) continue
      const higher = (nc: number, nr: number) => {
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) return false
        const u = nr * cols + nc
        return !rampish(u) && height[u] > height[t]
      }
      if (higher(c, r - 1) || higher(c - 1, r) || higher(c + 1, r) || higher(c, r + 1)) flags[t] |= TF.blocked | TF.noBuild
      // The rim too: nothing is built right at the edge of a drop.
      for (const [ox, oy] of N4) {
        const nc = c + ox, nr = r + oy
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const u = nr * cols + nc
        if (!rampish(u) && height[u] < height[t]) flags[t] |= TF.noBuild
      }
    }
  // Keep the ground at each end of a ramp unbuildable for two tiles, so a building never walls one off.
  for (let t = 0; t < n; t++) if (!fixed[t] && nearRamp[t] <= 2) flags[t] |= TF.noBuild
  for (let c = 0; c < cols; c++) (flags[c] |= TF.noBuild), (flags[(rows - 1) * cols + c] |= TF.noBuild)
  for (let r = 0; r < rows; r++) (flags[r * cols] |= TF.noBuild), (flags[r * cols + cols - 1] |= TF.noBuild)

  // --- Terrain ---
  const grid: TileGrid = { cols, rows, terrain, height, flags }
  const isFoot = (t: number) => {
    if (rampish(t)) return false
    const c = t % cols, r = (t - c) / cols
    for (const [ox, oy] of N4) {
      const nc = c + ox, nr = r + oy
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const u = nr * cols + nc
      if (!rampish(u) && height[u] > height[t] && !(flags[u] & TF.water)) return true
    }
    return false
  }
  const isRim = (t: number) => {
    const c = t % cols, r = (t - c) / cols
    for (const [ox, oy] of N4) {
      const nc = c + ox, nr = r + oy
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      if (height[nr * cols + nc] < height[t]) return true
    }
    return false
  }
  // Distance below the nearest cliff foot, walking only over ground of the foot's own level.
  const footDist = levelDistance(grid, isFoot, 12)
  const rimDist = levelDistance(grid, isRim, 12)
  const nApron = valueNoise(def.seed * 7 + 3)
  const nGrass = valueNoise(def.seed * 7 + 4)
  const nPocket = valueNoise(def.seed * 7 + 5)
  const nPatch = valueNoise(def.seed * 7 + 6)
  const ROCKY = terrainIndex('rocky'), DIRT = terrainIndex('dirt'), GRASS = terrainIndex('grass')
  done.fill(0)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const t = r * cols + c
      if (done[t]) continue
      let ter = DIRT
      if (fixed[t]) ter = terrain[t]
      else if (flags[t] & TF.deposit) ter = DIRT
      else if (height[t] === LEVELS - 1) {
        // Plateau: stone, with dirt pockets where soil gathered, kept back from the rim.
        ter = rimDist[t] >= 3 && nPocket(c / 3.5, r / 3.5) > 0.72 ? DIRT : ROCKY
      } else {
        // Scree spills 1 to 3 tiles below a cliff foot (the foot tile itself always), varying along
        // the cliff.
        const apron = 1 + 2 * clamp01((nApron(c / 5, r / 5) - 0.35) * 1.8)
        if (footDist[t] < apron) ter = ROCKY
        else if (height[t] > 0 && nPatch(c / 5, r / 5) > 0.8) ter = ROCKY
        else if (footDist[t] >= 4 && nGrass(c / 9, r / 9) > (height[t] > 0 ? 0.6 : 0.5)) ter = GRASS
      }
      for (const k of tileCopies(cols, rows, def, c, r)) (done[k] = 1), (terrain[k] = ter)
    }

  const map: GroundMap = { def, grid, props: [], spawns, deposits }
  map.props = scatterProps(map, rimDist)
  return map
}

function addUnique(list: Pt[], p: Pt) {
  if (!list.some((q) => Math.abs(q.x - p.x) < TILE && Math.abs(q.y - p.y) < TILE)) list.push(p)
}

/** Chebyshev distance in tiles from the tiles `from` picks, capped at `cap`. */
function chebyshevFrom(cols: number, rows: number, from: (i: number) => boolean, cap: number) {
  const d = new Uint8Array(cols * rows).fill(cap)
  const queue: number[] = []
  for (let i = 0; i < d.length; i++) if (from(i)) (d[i] = 0), queue.push(i)
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q]
    if (d[t] + 1 >= cap) continue
    const c = t % cols, r = (t - c) / cols
    for (const [ox, oy] of N8) {
      const nc = c + ox, nr = r + oy
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const u = nr * cols + nc
      if (d[u] > d[t] + 1) (d[u] = d[t] + 1), queue.push(u)
    }
  }
  return d
}

/** Like chebyshevFrom, but spreading only between tiles of the same height (and never into ramps). */
function levelDistance(g: TileGrid, from: (i: number) => boolean, cap: number) {
  const { cols, rows } = g
  const d = new Uint8Array(cols * rows).fill(cap)
  const queue: number[] = []
  for (let i = 0; i < d.length; i++) if (from(i)) (d[i] = 0), queue.push(i)
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q]
    if (d[t] + 1 >= cap) continue
    const c = t % cols, r = (t - c) / cols
    for (const [ox, oy] of N8) {
      const nc = c + ox, nr = r + oy
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const u = nr * cols + nc
      if (g.height[u] !== g.height[t] || g.flags[u] & TF.ramp) continue
      if (d[u] > d[t] + 1) (d[u] = d[t] + 1), queue.push(u)
    }
  }
  return d
}

// --- Props ---------------------------------------------------------------------------------------

/** Scatters the map's props: seeded, spaced apart, by ground type, and copied by symmetry. Blocking
 * props stamp TF.blocked and TF.noBuild on the tiles under them. */
function scatterProps(map: GroundMap, rimDist: Uint8Array): Prop[] {
  const { def, grid } = map
  const { cols, rows, flags, height, terrain } = grid
  const W = cols * TILE, H = rows * TILE
  const rand = rng(def.seed * 7 + 11)
  const ROCKY = terrainIndex('rocky'), GRASS = terrainIndex('grass')

  // Where nothing goes: ramps and two tiles round them, deposits and their edge, spawn areas (and a
  // tile round them), water, the border and the cliff faces.
  const keepOut = new Uint8Array(cols * rows)
  const ramps = chebyshevFrom(cols, rows, (i) => (flags[i] & TF.ramp) !== 0, 4)
  const deps = chebyshevFrom(cols, rows, (i) => (flags[i] & TF.deposit) !== 0, 4)
  for (let t = 0; t < keepOut.length; t++) if (ramps[t] <= 2 || deps[t] <= 2 || flags[t] & TF.water) keepOut[t] = 1
  for (let i = 0; i < map.spawns.length; i++) {
    const a = spawnArea(map, i)
    for (let r = a.r0 - 1; r <= a.r1 + 1; r++) for (let c = a.c0 - 1; c <= a.c1 + 1; c++) if (c >= 0 && r >= 0 && c < cols && r < rows) keepOut[r * cols + c] = 1
  }

  const groundAt = (x: number, y: number): Ground | null => {
    const c = Math.floor(x / TILE), r = Math.floor(y / TILE)
    if (c < 1 || r < 1 || c >= cols - 1 || r >= rows - 1) return null
    const t = r * cols + c
    if (keepOut[t] || flags[t] & TF.blocked) return null
    if (height[t] === LEVELS - 1) return rimDist[t] < 2 ? null : 'plateau'
    if (terrain[t] === ROCKY) return 'scree'
    return terrain[t] === GRASS ? 'grass' : 'dirt'
  }

  const props: Prop[] = []
  // A coarse bucket grid of placed props, for the spacing test.
  const B = 128
  const bw = Math.ceil(W / B), bh = Math.ceil(H / B)
  const buckets: number[][] = Array.from({ length: bw * bh }, () => [])
  const fits = (x: number, y: number, rad: number) => {
    const b0 = Math.max(0, Math.floor((x - 200) / B)), b1 = Math.min(bw - 1, Math.floor((x + 200) / B))
    const c0 = Math.max(0, Math.floor((y - 200) / B)), c1 = Math.min(bh - 1, Math.floor((y + 200) / B))
    for (let by = c0; by <= c1; by++)
      for (let bx = b0; bx <= b1; bx++)
        for (const k of buckets[by * bw + bx]) {
          const p = props[k]
          const need = (rad + p.size / 2) * 0.8
          if ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < need * need) return false
        }
    return true
  }
  const canonical = (x: number, y: number) => {
    // Only spots whose tile is the first of its symmetric copies are tried; the copies follow.
    const c = Math.floor(x / TILE), r = Math.floor(y / TILE)
    const copies = tileCopies(cols, rows, def, c, r)
    return copies.every((k) => k >= copies[0])
  }
  const place = (kind: string, x: number, y: number, size: number, blocks = PROP_INFO[kind].blocks) => {
    for (const p of pointCopies(def, { x, y })) {
      const k = props.length
      props.push({ kind, x: p.x, y: p.y, size, blocks })
      buckets[Math.min(bh - 1, Math.floor(p.y / B)) * bw + Math.min(bw - 1, Math.floor(p.x / B))].push(k)
    }
  }
  const pick = (list: [string, number, number, number][]) => {
    let total = 0
    for (const e of list) total += e[3]
    let v = rand() * total
    for (const e of list) if ((v -= e[3]) <= 0) return e
    return list[list.length - 1]
  }

  // Along the cliffs first: rubble and stone heaps at the foot of every cliff (half over the rock
  // face, or below the lip of one facing north), and now and then an outcrop or grassy stones
  // breaking the rim above it. They only decorate: the foot tile is blocked anyway, the rim open.
  const FOOT = ['rubble', 'stone-heap', 'rubble', 'rock-small', 'stone-slabs', 'rock-medium']
  const RIM = ['outcrop', 'stones-grass', 'rock-cluster']
  for (let r = 1; r < rows - 1; r++)
    for (let c = 1; c < cols - 1; c++) {
      const t = r * cols + c
      if (flags[t] & (TF.ramp | TF.water) || ramps[t] <= 2) continue
      // Which way is up: the first higher neighbour, north, east, south, west.
      const up = N4.find(([ox, oy]) => {
        const u = t + oy * cols + ox
        return !(flags[u] & TF.ramp) && height[u] > height[t]
      })
      if (!up) continue
      const x0 = (c + 0.5) * TILE, y0 = (r + 0.5) * TILE
      if (!canonical(x0, y0)) continue
      const roll = rand(), j1 = rand() - 0.5, j2 = rand(), kindRoll = rand(), sizeRoll = rand(), rimRoll = rand()
      if (roll > 0.55) continue
      const [ox, oy] = up
      // Along the cliff the spot slides by up to half a tile; away from it, 14 to 22 units below the edge.
      const away = 14 + j2 * 8
      const x = x0 - ox * (away - 16) + oy * j1 * TILE * 0.5
      const y = y0 - oy * (away - 16) + ox * j1 * TILE * 0.5
      const kind = FOOT[Math.floor(kindRoll * FOOT.length)]
      const size = kind === 'rock-small' ? 24 + sizeRoll * 10 : 40 + sizeRoll * 24
      if (!fits(x, y, size * 0.3)) continue
      place(kind, x, y, size, false)
      if (rimRoll < 0.25) place(RIM[Math.floor(sizeRoll * RIM.length)], x0 + ox * 40, y0 + oy * 40, 40 + j2 * 18, false)
    }

  // Then the open ground: one try per 2 × 2 tile spot, jittered.
  const STEP = TILE * 2
  for (let y = STEP / 2; y < H; y += STEP)
    for (let x = STEP / 2; x < W; x += STEP) {
      const px = x + (rand() - 0.5) * STEP
      const py = y + (rand() - 0.5) * STEP
      const roll = rand()
      const g = groundAt(px, py)
      if (!g || roll > DENSITY[g] || !canonical(px, py)) continue
      const [kind, lo, hi] = pick(SETS[g])
      const size = lo + rand() * (hi - lo)
      if (!fits(px, py, size / 2)) continue
      if (PROP_INFO[kind].blocks && !blockSpotFree(grid, keepOut, px, py, size)) continue
      // Its copies must land on the same kind of ground (they do on a symmetric map, but a tile
      // rounded differently could differ).
      if (pointCopies(def, { x: px, y: py }).some((p) => groundAt(p.x, p.y) !== g)) continue
      place(kind, px, py, size)
    }

  // Blocking props stamp the tiles under them.
  for (const p of props) {
    if (!p.blocks) continue
    for (const t of blockedTiles(grid, p)) flags[t] |= TF.blocked | TF.noBuild
  }
  // Drawn top to bottom, so lower props overlap the ones behind them.
  props.sort((a, b) => a.y - b.y || a.x - b.x)
  return props
}

/** The tiles a blocking prop covers: those whose middle lies within about a third of its size. */
export function blockedTiles(g: TileGrid, p: Prop): number[] {
  const rad = Math.max(TILE * 0.5, p.size * 0.3)
  const out: number[] = []
  const c0 = Math.max(0, Math.floor((p.x - rad) / TILE)), c1 = Math.min(g.cols - 1, Math.floor((p.x + rad) / TILE))
  const r0 = Math.max(0, Math.floor((p.y - rad) / TILE)), r1 = Math.min(g.rows - 1, Math.floor((p.y + rad) / TILE))
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const dx = (c + 0.5) * TILE - p.x, dy = (r + 0.5) * TILE - p.y
      if (dx * dx + dy * dy <= rad * rad) out.push(r * g.cols + c)
    }
  if (!out.length) out.push(Math.floor(p.y / TILE) * g.cols + Math.floor(p.x / TILE))
  return out
}

/** Whether a blocking prop here would cover only open ground of one level, clear of keep-out tiles. */
function blockSpotFree(g: TileGrid, keepOut: Uint8Array, x: number, y: number, size: number) {
  const tiles = blockedTiles(g, { kind: '', x, y, size, blocks: true })
  const h = g.height[tiles[0]]
  return tiles.every((t) => !keepOut[t] && !(g.flags[t] & (TF.blocked | TF.ramp)) && g.height[t] === h)
}

// --- Round 2 maps: hand-drawn shapes -------------------------------------------------------------

/** World units of elevation per height level, for drawing (TileGrid `elev`). */
export const LEVEL_H = 64

/** Distance from (px, py) to the segment a → b, and how far along it (0 to 1) the nearest point is. */
function segment(px: number, py: number, a: TilePt, b: TilePt) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy || 1
  const t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2
  const u = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = a[0] + dx * u - px, ey = a[1] + dy * u - py
  return { d: Math.sqrt(ex * ex + ey * ey), t, side: ((px - a[0]) * dy - (py - a[1]) * dx) / Math.sqrt(len2) }
}

/** Distance from a point to a polyline, and the distance along it to the nearest point. */
function polyline(px: number, py: number, pts: TilePt[]) {
  let best = Infinity, at = 0, run = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = segment(px, py, pts[i], pts[i + 1])
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
    if (s.d < best) (best = s.d), (at = run + Math.min(1, Math.max(0, s.t)) * len)
    run += len
  }
  return { d: best, along: at }
}

/** Whether a point lies inside a polygon (even-odd). */
function inside(px: number, py: number, pts: TilePt[]) {
  let inn = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inn = !inn
  }
  return inn
}

/** One tile's share of the shapes, worked out once per symmetric set and copied to the others. */
type FeatureTile = { level: number; ramp: number; rampLo: number; rampHi: number; water: number; ford: boolean; bridge: boolean; road: boolean; forest: boolean; deposit: boolean; bare: boolean; ruin: boolean }

/** Half the size of a ruin's foundation, in tiles: wide as drawn, turned by the mirror. */
export const RUIN_HALF: TilePt = [1.6, 1.15]

/** A map's shapes with every symmetric copy added (and copies that land on themselves dropped);
 * `ruinTurn` says which ruins the mirror turned (their foundation is tall, not wide). */
export type ExpandedFeatures = Required<GroundFeatures> & { ruinTurn: boolean[] }

const expanded = new WeakMap<GroundMapDef, ExpandedFeatures>()
/**
 * The map's shapes, each copied by the map's symmetry, so a map (or the editor) may draw them on
 * any side: buildGroundMap and the ground layer both read these. Copies that fall on top of each
 * other (anything on a mirror line) are kept once.
 */
export function expandFeatures(def: GroundMapDef): ExpandedFeatures {
  const hit = expanded.get(def)
  if (hit) return hit
  const f = def.features ?? {}
  const n = def.cols
  const turns = (p: TilePt): TilePt[] =>
    def.mirror === 'diagonal' ? [p, [n - p[1], def.rows - p[0]]] : mirrored({ w: def.cols, h: def.rows, sym: def.sym }, { x: p[0], y: p[1] }).map((q) => [q.x, q.y] as TilePt)
  const k = turns([0, 0]).length
  const at = (p: TilePt, i: number): TilePt => turns(p)[i] ?? p
  const key = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'number' ? Math.round(x * 2) / 2 : x))
  const uniq = <T>(list: T[], id: (t: T) => string) => list.filter((t, i) => list.findIndex((o) => id(o) === id(t)) === i)
  const sorted = (pts: TilePt[]) => key([...pts].map((q) => [Math.round(q[0] * 2) / 2, Math.round(q[1] * 2) / 2]).sort((a, b) => a[0] - b[0] || a[1] - b[1]))
  const ends = (a: TilePt, b: TilePt) => [key(a), key(b)].sort().join('|')
  const all = <T>(list: T[] | undefined, fn: (t: T, i: number) => T) => (list ?? []).flatMap((t) => Array.from({ length: k }, (_, i) => fn(t, i)))
  const ruins = (f.ruins ?? []).flatMap((p) => Array.from({ length: k }, (_, i) => ({ p: at(p, i), turn: def.mirror === 'diagonal' && i === 1 })))
  const ruinsU = uniq(ruins, (r) => key(r.p))
  const out: ExpandedFeatures = {
    plateaus: uniq(all(f.plateaus, (p, i) => ({ level: p.level, pts: p.pts.map((q) => at(q, i)) })), (p) => p.level + sorted(p.pts)),
    ramps: uniq(all(f.ramps, (r, i) => ({ from: at(r.from, i), to: at(r.to, i), width: r.width })), (r) => key([r.from, r.to])),
    rivers: uniq(all(f.rivers, (r, i) => ({ pts: r.pts.map((q) => at(q, i)), width: r.width })), (r) => ends(r.pts[0], r.pts[r.pts.length - 1]) + sorted(r.pts) + r.width),
    bridges: uniq(all(f.bridges, (b, i) => ({ from: at(b.from, i), to: at(b.to, i), width: b.width })), (b) => ends(b.from, b.to)),
    fords: uniq(all(f.fords, (d, i) => ({ at: at(d.at, i), radius: d.radius })), (d) => key(d.at)),
    roads: uniq(all(f.roads, (r, i) => ({ pts: r.pts.map((q) => at(q, i)), width: r.width })), (r) => sorted(r.pts)),
    forests: uniq(all(f.forests, (p, i) => p.map((q) => at(q, i))), sorted),
    deposits: uniq(all(f.deposits, (p, i) => at(p, i)), key),
    ruins: ruinsU.map((r) => r.p),
    ruinTurn: ruinsU.map((r) => r.turn),
    spawns: uniq(all(f.spawns, (p, i) => at(p, i)), key),
  }
  expanded.set(def, out)
  return out
}

/**
 * Builds a round 2 map from its shapes (GroundMapDef `features`): plateaus with wobbling edges, ramps,
 * rivers with a bridge and a ford, dirt roads, solid forests and kyber crystal fields. Deterministic,
 * and copied tile by tile across the map's symmetry, so both sides match exactly.
 */
function buildFeatureMap(def: GroundMapDef): GroundMap {
  const f = expandFeatures(def)
  const { cols, rows } = def
  const n = cols * rows
  const height = new Uint8Array(n)
  const flags = new Uint8Array(n)
  const terrain = new Uint8Array(n)
  const ft: FeatureTile[] = new Array(n)
  const wobX = valueNoise(def.seed * 7 + 1), wobY = valueNoise(def.seed * 7 + 2)
  const wide = valueNoise(def.seed * 7 + 3), woods = valueNoise(def.seed * 7 + 4)
  const levelAt = (x: number, y: number) => {
    let lv = 0
    for (const p of f.plateaus ?? []) if (inside(x, y, p.pts)) lv = Math.max(lv, p.level)
    return lv
  }
  // Plateaus no ramp climbs are bare rock (ridges); the others have the low ground's grass and dirt.
  const barePlateaus = (f.plateaus ?? []).filter((p) => !(f.ramps ?? []).some((r) => inside(r.to[0], r.to[1], p.pts)))
  const done = new Uint8Array(n)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (done[i]) continue
      const px = c + 0.5, py = r + 0.5
      // Plateau edges wobble up to 1.6 tiles, forest edges more.
      const qx = px + (wobX(px / 6, py / 6) - 0.5) * 3.2, qy = py + (wobY(px / 6, py / 6) - 0.5) * 3.2
      const t: FeatureTile = { level: levelAt(qx, qy), ramp: -1, rampLo: 0, rampHi: 0, water: 0, ford: false, bridge: false, road: false, forest: false, deposit: false, bare: false, ruin: false }
      t.bare = t.level > 0 && barePlateaus.some((p) => inside(qx, qy, p.pts))
      for (const rp of f.ramps ?? []) {
        const s = segment(px, py, rp.from, rp.to)
        if (s.t < -0.05 || s.t > 1.05 || Math.abs(s.side) > rp.width / 2) continue
        t.ramp = Math.min(1, Math.max(0, s.t))
        t.rampLo = levelAt(rp.from[0], rp.from[1])
        t.rampHi = levelAt(rp.to[0], rp.to[1])
        t.level = t.ramp >= 0.5 ? t.rampHi : t.rampLo
        t.bare = false
      }
      for (const rv of f.rivers ?? []) {
        const s = polyline(px + (wobX(px / 3, py / 3) - 0.5) * 1.4, py + (wobY(px / 3, py / 3) - 0.5) * 1.4, rv.pts)
        // The river swells and narrows along its course.
        const half = (rv.width / 2) * (0.8 + 0.45 * wide(s.along / 9, 0.5))
        if (s.d < half) t.water = Math.max(t.water, Math.min(1, (half - s.d) / 2.5 + 0.15))
      }
      if (t.water) {
        t.level = 0
        t.ramp = -1
        for (const fd of f.fords ?? []) if (Math.hypot(px - fd.at[0], py - fd.at[1]) < fd.radius) t.ford = true
      }
      for (const b of f.bridges ?? []) {
        const s = segment(px, py, b.from, b.to)
        if (s.t >= 0 && s.t <= 1 && Math.abs(s.side) <= b.width / 2) (t.bridge = true), (t.road = true)
      }
      for (const rd of f.roads ?? []) if (polyline(px, py, rd.pts).d < rd.width / 2) t.road = true
      if (!t.water && t.ramp < 0) {
        const fx = px + (woods(px / 5, py / 5) - 0.5) * 5, fy = py + (woods(px / 5 + 9, py / 5) - 0.5) * 5
        for (const fo of f.forests ?? []) if (inside(fx, fy, fo)) t.forest = true
      }
      for (const d of f.deposits ?? []) if (Math.hypot(px - d[0], py - d[1]) < 1.75) t.deposit = true
      f.ruins.forEach((rn, k) => {
        const [hx, hy] = f.ruinTurn[k] ? [RUIN_HALF[1], RUIN_HALF[0]] : RUIN_HALF
        if (Math.abs(px - rn[0]) < hx + 0.5 && Math.abs(py - rn[1]) < hy + 0.5) t.ruin = true
      })
      if (t.road || t.deposit || t.ruin) t.forest = false
      for (const k of tileCopies(cols, rows, def, c, r)) (done[k] = 1), (ft[k] = t)
    }
  // How high each ramp tile stands, for drawing: ramps here may run at any angle.
  const rampElev = new Float32Array(n).fill(-1)
  for (let i = 0; i < n; i++) if (ft[i].ramp >= 0 && !ft[i].water) rampElev[i] = (ft[i].rampLo + (ft[i].rampHi - ft[i].rampLo) * ft[i].ramp) * LEVEL_H

  // Flags and heights.
  for (let i = 0; i < n; i++) {
    const t = ft[i]
    height[i] = t.level
    if (t.water) flags[i] |= TF.water | TF.noBuild | (t.ford || t.bridge ? 0 : TF.blocked)
    if (t.water && t.ford) flags[i] |= TF.ford
    if (t.bridge) flags[i] |= TF.bridge | TF.noBuild
    if (t.ramp >= 0) flags[i] |= TF.ramp | TF.noBuild
    if (t.forest) flags[i] |= TF.forest | TF.blocked | TF.noBuild
    if (t.deposit) flags[i] |= TF.deposit | TF.noBuild
    if (t.ruin) flags[i] |= TF.noBuild
  }
  // A bridge's deck stands at its banks' level and keeps the river under it.
  const isRamp = (i: number) => (flags[i] & TF.ramp) !== 0
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (isRamp(i) || flags[i] & (TF.water | TF.bridge)) continue
      // Cliff feet are blocked on all four sides alike (the slope covers them), rims unbuildable.
      for (const [ox, oy] of N4) {
        const nc = c + ox, nr = r + oy
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const u = nr * cols + nc
        if (isRamp(u)) continue
        if (height[u] > height[i]) flags[i] |= TF.blocked | TF.noBuild
        if (height[u] < height[i]) flags[i] |= TF.noBuild
      }
    }
  const nearRamp = chebyshevFrom(cols, rows, isRamp, 4)
  for (let i = 0; i < n; i++) if (!isRamp(i) && nearRamp[i] <= 2) flags[i] |= TF.noBuild
  for (let c = 0; c < cols; c++) (flags[c] |= TF.noBuild), (flags[(rows - 1) * cols + c] |= TF.noBuild)
  for (let r = 0; r < rows; r++) (flags[r * cols] |= TF.noBuild), (flags[r * cols + cols - 1] |= TF.noBuild)

  // Terrain: grass with big calm patches of dirt; packed dirt round the bases; rock on bare plateaus
  // and cliff slopes; sand along the banks and mud by the ford; roads; dirt under the crystals.
  const T = (id: Parameters<typeof terrainIndex>[0]) => terrainIndex(id)
  const nearWater = chebyshevFrom(cols, rows, (i) => (flags[i] & TF.water) !== 0 && !(flags[i] & TF.bridge), 4)
  const nearFord = chebyshevFrom(cols, rows, (i) => (flags[i] & TF.ford) !== 0, 4)
  const patch = valueNoise(def.seed * 7 + 5)
  const spawnPts = (f.spawns ?? []).flatMap((s) => pointCopies(def, { x: s[0] * TILE, y: s[1] * TILE }))
  done.fill(0)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (done[i]) continue
      const t = ft[i]
      let ter = T('grass')
      const slope = !(flags[i] & TF.water) && !isRamp(i) && N4.some(([ox, oy]) => {
        const nc = c + ox, nr = r + oy
        return nc >= 0 && nr >= 0 && nc < cols && nr < rows && !isRamp(nr * cols + nc) && height[nr * cols + nc] !== height[i]
      })
      const toBase = Math.min(...spawnPts.map((s) => Math.hypot((c + 0.5) * TILE - s.x, (r + 0.5) * TILE - s.y) / TILE))
      if (t.water) ter = t.ford || nearFord[i] <= 1 ? T('mud') : T('sand')
      else if (t.road) ter = T('road')
      else if (t.deposit) ter = T('dirt')
      else if (t.ramp >= 0) ter = T('dirt')
      else if (slope) ter = T('rocky')
      else if (t.bare) ter = T('rocky')
      else if (t.ruin) ter = T('dirt')
      else if (!t.forest && toBase < 11 + patch(c / 4, r / 4) * 3) ter = T('dirt')
      else if (t.level > 0) ter = T('grass')
      else if (nearFord[i] <= 1) ter = T('mud')
      else if (nearWater[i] <= 1) ter = T('sand')
      else if (!t.forest && patch(c / 13, r / 13) > 0.63) ter = T('dirt')
      for (const k of tileCopies(cols, rows, def, c, r)) (done[k] = 1), (terrain[k] = ter)
    }

  const spawns: Pt[] = []
  for (const s of f.spawns ?? []) for (const p of pointCopies(def, { x: s[0] * TILE, y: s[1] * TILE })) addUnique(spawns, p)
  const deposits: Pt[] = []
  for (const d of f.deposits ?? []) for (const p of pointCopies(def, { x: d[0] * TILE, y: d[1] * TILE })) addUnique(deposits, p)
  const map: GroundMap = { def, grid: { cols, rows, terrain, height, flags }, props: [], spawns, deposits }
  rampHints.set(map, rampElev)
  return map
}

/** Ramp tile elevations a feature map worked out while it was built (buildElev uses them). */
const rampHints = new WeakMap<GroundMap, Float32Array>()

/**
 * The land's shape for drawing (TileGrid `elev`, one value per tile corner): each tile stands at its
 * level times LEVEL_H, ramps climb evenly from foot to top, water sinks into a bed that deepens away
 * from the banks, and the corners take the average of the tiles round them. Then the ground is
 * smoothed and given a gentle roll wherever no level changes nearby, so slopes stay steep at cliffs
 * and soft everywhere else.
 */
function buildElev(map: GroundMap): Int16Array {
  const g = map.grid
  const { cols, rows } = g
  const n = cols * rows
  const tileH = new Float32Array(n)
  for (let i = 0; i < n; i++) tileH[i] = g.height[i] * LEVEL_H
  // Ramps: by how far each tile is along its ramp, foot to top.
  const hint = rampHints.get(map)
  if (hint) for (let i = 0; i < n; i++) if (hint[i] >= 0) tileH[i] = hint[i]
  for (const r of hint ? [] : rampsOf(map)) {
    for (let y = r.r0; y <= r.r1; y++)
      for (let x = r.c0; x <= r.c1; x++) {
        const i = y * cols + x
        if (!(g.flags[i] & TF.ramp)) continue
        const span = r.dx !== 0 ? r.c1 - r.c0 : r.r1 - r.r0
        const pos = r.dx > 0 ? x - r.c0 : r.dx < 0 ? r.c1 - x : r.dy > 0 ? y - r.r0 : r.r1 - y
        const t = span > 0 ? (pos + 0.5) / (span + 1) : 0.5
        tileH[i] = (r.lo + (r.hi - r.lo) * t) * LEVEL_H
      }
  }
  // Bare rocky heights (ridges with no way up) rise to a crest, higher the further from their edge.
  const fromEdge = chebyshevFrom(cols, rows, (i) => g.height[i] === 0, 6)
  const ROCKY = terrainIndex('rocky')
  for (let i = 0; i < n; i++) if (g.height[i] > 0 && g.terrain[i] === ROCKY && !(g.flags[i] & TF.ramp) && map.def.features) tileH[i] += Math.max(0, fromEdge[i] - 1) * 16
  // Water: a bed that deepens away from dry land; a ford stays shallow.
  const fromLand = chebyshevFrom(cols, rows, (i) => !(g.flags[i] & TF.water), 4)
  for (let i = 0; i < n; i++) {
    // Under a bridge the bed stays at the banks' level, so no hollow shows beside the deck.
    if (!(g.flags[i] & TF.water) || g.flags[i] & TF.bridge) continue
    tileH[i] = g.flags[i] & TF.ford ? -5 : -6 - 6 * Math.min(3, fromLand[i])
  }
  const W = cols + 1, H = rows + 1
  let e = new Float32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sum = 0, k = 0
      for (let dy = -1; dy <= 0; dy++)
        for (let dx = -1; dx <= 0; dx++) {
          const c = x + dx, r = y + dy
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue
          sum += tileH[r * cols + c]
          k++
        }
      e[y * W + x] = sum / k
    }
  // Smooth where the ground is gentle (no cliff within a corner), twice.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(e)
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        let lo = Infinity, hi = -Infinity, sum = 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const v = e[(y + dy) * W + x + dx]
            lo = Math.min(lo, v)
            hi = Math.max(hi, v)
            sum += v
          }
        if (hi - lo < LEVEL_H * 0.45) next[y * W + x] = sum / 9
      }
    e = next
  }
  // A gentle roll over open ground.
  const roll = valueNoise(map.def.seed * 7 + 9)
  const out = new Int16Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = e[y * W + x]
      const flat = y > 0 && x > 0 && y < H - 1 && x < W - 1 ? Math.abs(e[(y - 1) * W + x] - e[(y + 1) * W + x]) + Math.abs(e[y * W + x - 1] - e[y * W + x + 1]) < LEVEL_H * 0.3 : true
      out[y * W + x] = Math.round(v + (flat ? (roll(x / 10, y / 10) - 0.5) * 12 : 0))
    }
  return out
}
