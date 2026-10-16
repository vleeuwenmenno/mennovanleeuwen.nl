// Fog of war on the ground: kept in the sim, so the AI and the order checks see what a team sees.
// Per team, a count of the eyes on each tile (live sight) and a bit per tile for explored ground.
//
// Each unit stamps a disc of tiles round itself, its sight radius in tiles, precomputed per radius.
// Height limits sight: a viewer sees tiles at its own level or lower, plus higher tiles that border
// a tile at its level (the row along the top of a cliff). A ramp counts as both the levels it joins;
// a viewer on a ramp sees from the top one. So a base on a plateau stays hidden until someone walks
// up the ramp. Sight never changes with buildings, so which tiles each level sees is worked out
// once, from the terrain.
//
// Cheap on purpose: a unit's disc is taken off and stamped again only when it changes tile (or its
// sight changes), at the sim's fog refresh, four times a second. No DOM: the server runs it too.

import { LEVELS, TF, TILE, type TileGrid } from './types.ts'

/** A unit's stamped disc: where, how far, for whom. Kept on the unit (see placeEye). */
export type Eye = { tile: number; r: number; team: number }

export type GroundFog = {
  cols: number
  rows: number
  /** Per team: how many eyes see each tile. */
  eyes: Uint16Array[]
  /** Per team: explored tiles, one bit each (tile i is bit i & 7 of byte i >> 3). */
  explored: Uint8Array[]
  /** Per level: 1 on each tile a viewer at that level can see (in range). */
  vis: Uint8Array[]
  /** The level a viewer standing on each tile sees from. */
  view: Uint8Array
}

export function newFog(g: TileGrid, teams: number): GroundFog {
  const n = g.cols * g.rows
  const { lo, hi } = levels(g)
  const vis = Array.from({ length: LEVELS }, (_, v) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (lo[i] <= v) {
        out[i] = 1
        continue
      }
      // Higher ground: only the row that borders ground at the viewer's level.
      const c = i % g.cols
      const r = (i - c) / g.cols
      for (let dr = -1; dr <= 1 && !out[i]; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc
          const nr = r + dr
          if ((!dc && !dr) || nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue
          const j = nr * g.cols + nc
          if (lo[j] <= v && v <= hi[j]) {
            out[i] = 1
            break
          }
        }
    }
    return out
  })
  return {
    cols: g.cols,
    rows: g.rows,
    eyes: Array.from({ length: teams }, () => new Uint16Array(n)),
    explored: Array.from({ length: teams }, () => new Uint8Array((n + 7) >> 3)),
    vis,
    view: hi,
  }
}

/** Each tile's lowest and highest level: the same for plain ground. A ramp spans the levels it
 * joins: every tile of one ramp (its ramp tiles touching side by side) gets the lowest and highest
 * level among its own tiles and the open ground round it, so a wide ramp's middle counts as both. */
function levels(g: TileGrid) {
  const n = g.cols * g.rows
  const lo = Uint8Array.from(g.height)
  const hi = Uint8Array.from(g.height)
  const done = new Uint8Array(n)
  const isRamp = (i: number) => (g.flags[i] & TF.ramp) !== 0
  for (let s = 0; s < n; s++) {
    if (!isRamp(s) || done[s]) continue
    const tiles = [s]
    done[s] = 1
    let min = g.height[s]
    let max = g.height[s]
    for (let q = 0; q < tiles.length; q++) {
      const i = tiles[q]
      const c = i % g.cols
      const r = (i - c) / g.cols
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue
        const j = nr * g.cols + nc
        if (isRamp(j)) {
          if (!done[j]) {
            done[j] = 1
            tiles.push(j)
          }
        } else if (!(g.flags[j] & TF.blocked)) {
          min = Math.min(min, g.height[j])
          max = Math.max(max, g.height[j])
        }
      }
    }
    for (const i of tiles) {
      lo[i] = min
      hi[i] = max
    }
  }
  return { lo, hi }
}

/** Disc offsets by radius in tiles, as pairs (dc, dr): tiles whose centre is within r + 0.5 tiles. */
const DISCS = new Map<number, Int8Array>()
export function disc(r: number): Int8Array {
  let d = DISCS.get(r)
  if (d) return d
  const out: number[] = []
  const lim = (r + 0.5) * (r + 0.5)
  for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) if (dc * dc + dr * dr <= lim) out.push(dc, dr)
  d = Int8Array.from(out)
  DISCS.set(r, d)
  return d
}

/** Adds (d 1) or takes off (-1) an eye's disc. Adding marks the tiles explored too. */
function stamp(fog: GroundFog, e: Eye, d: 1 | -1) {
  const { cols, rows } = fog
  const eyes = fog.eyes[e.team]
  const explored = fog.explored[e.team]
  const vis = fog.vis[fog.view[e.tile]]
  const ec = e.tile % cols
  const er = (e.tile - ec) / cols
  const offs = disc(e.r)
  for (let k = 0; k < offs.length; k += 2) {
    const c = ec + offs[k]
    const r = er + offs[k + 1]
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue
    const i = r * cols + c
    if (!vis[i]) continue
    eyes[i] += d
    if (d > 0) explored[i >> 3] |= 1 << (i & 7)
  }
}

/** Puts `holder`'s eye on `tile` with sight `r` for `team`, moving it from where it was. Does
 * nothing when it's already there with that sight. */
export function placeEye(fog: GroundFog, holder: { eye?: Eye }, team: number, tile: number, r: number) {
  const e = holder.eye
  if (e && e.tile === tile && e.r === r && e.team === team) return
  if (e) stamp(fog, e, -1)
  const next = { tile, r, team }
  stamp(fog, next, 1)
  holder.eye = next
}

/** Takes `holder`'s eye off the map (a unit that died or was removed). */
export function dropEye(fog: GroundFog, holder: { eye?: Eye }) {
  if (!holder.eye) return
  stamp(fog, holder.eye, -1)
  holder.eye = undefined
}

/** Whether `team` sees tile `i` now. */
export const sees = (fog: GroundFog, team: number, i: number) => (fog.eyes[team]?.[i] ?? 0) > 0

/** Whether `team` has ever seen tile `i`. */
export const explored = (fog: GroundFog, team: number, i: number) => ((fog.explored[team]?.[i >> 3] ?? 0) & (1 << (i & 7))) !== 0

/** Whether `team` sees the world point (x, y). */
export function seesAt(fog: GroundFog, team: number, x: number, y: number) {
  const c = Math.floor(x / TILE)
  const r = Math.floor(y / TILE)
  return c >= 0 && r >= 0 && c < fog.cols && r < fog.rows && sees(fog, team, r * fog.cols + c)
}
