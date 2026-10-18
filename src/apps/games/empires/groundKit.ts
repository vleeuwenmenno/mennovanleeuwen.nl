import type { MapDef } from './maps.ts'
import type { Owner, World } from './sim.ts'
import type { GroundLayer } from './ground/types.ts'
import type { GroundPlacement, KnownBuilding } from './ground/world.ts'

// What the battle screen, the renderer and the lobby use of ground battles (ground/screen.ts),
// reached through here: ground/load.ts fills it in when ground battles are loaded (the dev lobby's
// Ground switch does), so a production build, where they aren't offered yet, carries none of it.
// Everything that draws or asks about a ground battle checks `groundKit()` first.

export type GroundKit = {
  /** The ground maps a battle can be fought on, as space maps (MapDef `ground`). */
  maps(): MapDef[]
  /** A ground map's look at one pixel a tile (terrain, height, water), for the lobby's previews and
   * the minimap. */
  thumb(id: string): HTMLCanvasElement | null
  /** A new picture of the ground for the battle screen: the WebGL2 layer once it is in, else the 2D one. */
  layer(): GroundLayer
  placement(w: World, owner: Owner, unitId: string, x: number, y: number): GroundPlacement
  commandAreas(w: World, owner: Owner): { x: number; y: number; r: number }[]
  /** Enemy buildings `me`'s team remembers, as last seen. */
  known(w: World, me: Owner): KnownBuilding[]
  /** The fog of war as a half-dark veil over the world outside `team`'s sight (never black: the land
   * is known from orbit), drawn in world coordinates. */
  fog(ctx: CanvasRenderingContext2D, w: World, team: number, reveal: boolean): void
  /** The placement ghost's ground: our command ranges (for a building that needs one), each tile of
   * the footprint green or red, and the row in front of its door; in world coordinates. */
  ghost(ctx: CanvasRenderingContext2D, w: World, me: Owner, unitId: string, p: GroundPlacement, zoom: number): void
  /** The minimap's ground: the terrain and the fog, into the box (ox, oy) at `s` pixels a world unit. */
  minimap(ctx: CanvasRenderingContext2D, w: World, team: number, ox: number, oy: number, s: number, reveal: boolean): void
  /** The crystal field with kyber left under or near (x, y), or -1 (a right-click there gathers). */
  fieldAt(w: World, x: number, y: number): number
  /** How full each tile's crystals are, for the ground layer, when it changed since the last call;
   * null when it didn't. */
  kyber(w: World): Uint8Array | null
  /** Kyber an engineer carries in one load. */
  carry: number
}

let kit: GroundKit | null = null
/** Ground battles' screen code, once loaded (ground/load.ts). */
export const groundKit = () => kit
export const setGroundKit = (k: GroundKit) => void (kit = k)
