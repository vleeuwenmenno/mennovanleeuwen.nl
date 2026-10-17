import type { Pt, Symmetry } from '../maps.ts'
export type { Pt, Symmetry }

// The shapes ground battles are built on, shared by the terrain builder, the sim, the ground layer
// and the screen. Ground battles run in the space game's own sim, screen, lobby and multiplayer (a
// ground battle is a battle whose map has terrain); these are the terrain's own shapes. A battle
// without terrain must behave and hash exactly as before.
//
// Coordinates: units, props and shots live in world units (floats, maths through detmath.ts),
// with x running right and y running down, as in space. The map is cut into square tiles of TILE
// world units, and everything that works per tile (terrain, height, nav, fog, the building grid)
// indexes it row by row: tile (c, r) is index r * cols + c and covers
// [c * TILE, (c + 1) * TILE) × [r * TILE, (r + 1) * TILE).

/** Tile size in world units: terrain, height, path finding, fog and the building grid all use it. */
export const TILE = 32

/** Ground textures by id; a tile's `terrain` byte is an index into this list (so never reorder it,
 * only append). The first slice draws dirt, grass and rocky. */
export const TERRAINS = ['dirt', 'grass', 'rocky', 'sand', 'snow', 'ash', 'cracked', 'urban', 'metal', 'mud', 'road'] as const
export type TerrainId = (typeof TERRAINS)[number]
export const terrainIndex = (id: TerrainId) => TERRAINS.indexOf(id)

/** Height levels: 0 low ground, 1 mid, 2 plateau. Cliffs stand where neighbouring tiles differ
 * and neither is a ramp. */
export const LEVELS = 3

/** Tile flags (bits of TileGrid `flags`). */
export const TF = {
  /** Nothing moves through it: water, lava, a blocking prop, a cliff face. Buildings are not
   * flags: they stamp the nav grid while they stand (see ground/nav.ts). */
  blocked: 1,
  /** No building may cover it (a ramp, a prop, a deposit's edge, the map border). */
  noBuild: 2,
  /** A ramp: joins two height levels, no cliff drawn across it, walkable both ways. */
  ramp: 4,
  /** Part of a kyber crystal field: gathered by engineers, nothing built on it. */
  deposit: 8,
  /** Water: blocked unless it is also a bridge or a ford, drawn as water. */
  water: 16,
  /** A bridge deck over water: walkable at the level of its banks, nothing built on it. */
  bridge: 32,
  /** A ford: shallow water, walkable but slow (the sim decides how slow), nothing built on it. */
  ford: 64,
  /** Inside a forest: blocked for vehicles and buildings, and blocks sight (the sim decides which
   * units may pass, if any). Its trees are drawn by the ground layer, not as props. */
  forest: 128,
} as const

/** The battlefield's tiles. All arrays have cols * rows entries. */
export type TileGrid = {
  cols: number
  rows: number
  /** Index into TERRAINS. */
  terrain: Uint8Array
  /** 0 .. LEVELS - 1. */
  height: Uint8Array
  /** TF bits. */
  flags: Uint8Array
  /**
   * The land's shape for drawing: the elevation at each tile corner, (cols + 1) × (rows + 1) values
   * row by row, in whole world units (0 the lowest ground). It is smooth where the ground is (slopes,
   * banks, riverbeds), and it rises steeply where `height` levels change, so cliffs are steep slopes
   * shaded by the ground layer. The sim plays by `height` and `flags`; `elev` only draws (and may later
   * aim shots over hills). Optional: tile maps built before it have none and draw flat.
   */
  elev?: Int16Array
}

/**
 * Whether a ground unit may step from tile `a` to the neighbouring tile `b` (8-way; the indices
 * must be neighbours). Neither may be blocked; heights must match unless one of the two is a ramp
 * (cliffs are walls); a diagonal step also needs both tiles it squeezes between to be open and on
 * one of the two heights, so nothing cuts the corner of a cliff or a blocked tile. The terrain's
 * reach check, path finding and movement all use this one rule.
 */
export function canStep(g: TileGrid, a: number, b: number): boolean {
  const open = (i: number) => (g.flags[i] & TF.blocked) === 0
  const joins = (i: number, j: number) => g.height[i] === g.height[j] || (g.flags[i] & TF.ramp) !== 0 || (g.flags[j] & TF.ramp) !== 0
  if (!open(a) || !open(b) || !joins(a, b)) return false
  const ac = a % g.cols, bc = b % g.cols
  if (ac === bc || a - ac === b - bc) return true
  const s1 = a - ac + bc // same row as a, column of b
  const s2 = b - bc + ac // row of b, column of a
  return open(s1) && open(s2) && joins(a, s1) && joins(s1, b) && joins(a, s2) && joins(s2, b)
}

/** A placed prop (rock, tree, rubble). `kind` names its sprite in public/games/empires/ground/props/.
 * Position and size in world units; `blocks`: it stamps TF.blocked on the tiles under it (a tree,
 * a boulder), otherwise it is only drawn (rubble, cracked stone). */
export type Prop = { kind: string; x: number; y: number; size: number; blocks: boolean }

/**
 * A hand-made ground map, written as a coarse sketch for one side and copied to the others by its
 * symmetry (as space maps are, maps.ts). Each sketch character covers `cell` × `cell` tiles:
 * height `0` `1` `2`, `/` a ramp (its height is worked out from its neighbours), `~` water,
 * `S` a spawn on the plateau, `d` a deposit on low ground. Terrain, the wobble of the cliff lines and
 * the props come from `seed`, deterministically (no Math.random).
 */
export type GroundMapDef = {
  id: string
  name: string
  blurb: string
  cols: number
  rows: number
  /** Tiles per sketch character. */
  cell: number
  sym: Symmetry
  seed: number
  /** Rows of sketch characters (see above), covering the whole map before symmetry fills it. */
  sketch: string[]
  /** Which textures and props the map uses (the first slice: 'temperate': dirt, grass, rocky). */
  biome: 'temperate'
  /** A mirror the space maps' symmetries don't have: 'diagonal' mirrors a square map across the line
   * from its top right corner to its bottom left, so two bases in the other corners face each other
   * across it and anything lying on that line (a river's bridge and ford) is shared by both. When
   * set, `sym` is 'none'. */
  mirror?: 'diagonal'
  /** Shapes drawn by hand over the sketch (round 2 maps), in tile units: see GroundFeatures. */
  features?: GroundFeatures
}

/** A point in tile units: [column, row], fractions allowed. */
export type TilePt = [number, number]

/**
 * A map's hand-drawn shapes, in tile units, laid over its sketch in this order: plateaus raise the
 * ground (their edges become cliffs, wobbled by the seed), ramps cut slopes up them, rivers carve
 * water (deep in the middle, shallow at the banks) with bridges and fords across, roads are dirt
 * tracks, forests are solid woods (blocked), and deposits are kyber crystal fields. Shapes may be
 * drawn over the whole map; the map's symmetry then copies one side's tiles onto the other, so the
 * sides always match exactly.
 */
export type GroundFeatures = {
  /** Raised ground: a polygon and the level it stands at (1 or 2). */
  plateaus?: { level: number; pts: TilePt[] }[]
  /** A ramp from `from` (its foot, on the lower ground) to `to` (its top), `width` tiles wide. */
  ramps?: { from: TilePt; to: TilePt; width: number }[]
  /** A river along a polyline, `width` tiles wide. */
  rivers?: { pts: TilePt[]; width: number }[]
  /** A bridge from bank to bank, `width` tiles wide. */
  bridges?: { from: TilePt; to: TilePt; width: number }[]
  /** A ford: the stretch of river within `radius` tiles of `at` is shallow and walkable. */
  fords?: { at: TilePt; radius: number }[]
  /** A dirt road along a polyline, `width` tiles wide. */
  roads?: { pts: TilePt[]; width: number }[]
  /** A forest: a polygon of solid wood. */
  forests?: TilePt[][]
  /** Kyber crystal fields: their middles. */
  deposits?: TilePt[]
  /** Start spots on the plateaus. */
  spawns?: TilePt[]
}

/**
 * The picture of the ground under a battle (WebGL2, with a flat 2D fallback where WebGL2 is
 * missing). The battle screen owns one per ground battle, puts its canvas right under the 2D battle
 * canvas at the same size, and calls `draw` each frame before drawing the 2D layer, with the same
 * camera: (x, y) is the world point at the middle of the view and `zoom` CSS pixels per world unit,
 * as the space renderer's Camera. Everything that moves or belongs to a player (units, buildings,
 * effects, fog, the HUD) stays on the 2D canvas over it. Past the map's edge it draws the map
 * mirrored, greyed and darkened, with a subtle edge line.
 */
export interface GroundLayer {
  readonly canvas: HTMLCanvasElement
  /** Whether it draws with WebGL2 (false: the flat fallback). */
  readonly gl: boolean
  /** Builds its textures for a map; call once per battle, before the first draw. */
  setMap(map: GroundMap): void
  /** `w`, `h`: the view in CSS pixels; `dpr`: device pixels per CSS pixel (the screen caps it at 2). */
  draw(cam: { x: number; y: number; zoom: number }, w: number, h: number, dpr: number, time: number): void
  /** Frees its GPU resources. */
  dispose(): void
}

/** A ground map built from its def: the same on every machine for the same def. */
export type GroundMap = {
  def: GroundMapDef
  grid: TileGrid
  props: Prop[]
  /** Start spots, in world units, one per side. */
  spawns: Pt[]
  /** Kyber crystal fields' centres, in world units (their tiles carry TF.deposit). */
  deposits: Pt[]
}
