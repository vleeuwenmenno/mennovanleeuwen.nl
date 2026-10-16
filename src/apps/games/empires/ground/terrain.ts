import { mirrored, rng, type Pt, type Symmetry } from '../maps.ts'
import { LEVELS, TF, TILE, terrainIndex, type GroundMap, type GroundMapDef, type Prop, type TileGrid } from './types.ts'

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
function tileCopies(cols: number, rows: number, sym: Symmetry, c: number, r: number): number[] {
  const out: number[] = []
  for (const p of mirrored({ w: cols - 1, h: rows - 1, sym }, { x: c, y: r })) {
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
      for (const k of tileCopies(cols, rows, def.sym, c, r)) {
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
      for (const k of tileCopies(cols, rows, def.sym, c, r)) (done[k] = 1), (terrain[k] = ter)
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
    const copies = tileCopies(cols, rows, def.sym, c, r)
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
