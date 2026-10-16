import type { Pt, Symmetry } from '../maps.ts'
export type { Pt, Symmetry }

// The shapes the ground battle mode is built on, shared by its terrain, sim, render and screen.
// Ground battles have a sim of their own (ground/sim.ts): the space sim (sim.ts) is not touched.
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
export const TERRAINS = ['dirt', 'grass', 'rocky', 'sand', 'snow', 'ash', 'cracked', 'urban', 'metal'] as const
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
  /** Part of a resource deposit (Extractors go here, phase 3). */
  deposit: 8,
  /** Water: blocked, drawn as water. */
  water: 16,
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
}

/** A ground map built from its def: the same on every machine for the same def. */
export type GroundMap = {
  def: GroundMapDef
  grid: TileGrid
  props: Prop[]
  /** Start spots, in world units, one per side. */
  spawns: Pt[]
  /** Deposits' centres, in world units (unused until phase 3). */
  deposits: Pt[]
}
