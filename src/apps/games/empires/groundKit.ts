import type { MapDef } from './maps.ts'
import type { Owner, Unit, World } from './sim.ts'
import type { Model } from './models/types.ts'
import type { GroundLayer } from './ground/types.ts'
import type { GroundPlacement, KnownBuilding } from './ground/world.ts'
import type { PowerReport } from './ground/power.ts'

// What the battle screen, the renderer and the lobby use of ground battles (ground/screen.ts),
// reached through here: ground/load.ts fills it in when ground battles are loaded (the dev lobby's
// Ground switch does), so a production build, where they aren't offered yet, carries none of it.
// Everything that draws or asks about a ground battle checks `groundKit()` first.

export type GroundKit = {
  /** The ground maps a battle can be fought on, as space maps (MapDef `ground`). */
  maps(): MapDef[]
  /** Any ground map by its id, a generated one (`gen:…`, ground/generate.ts) too; null when none. */
  map(id: string): MapDef | null
  /** A ground map's look at one pixel a tile (terrain, height, water), for the lobby's previews and
   * the minimap. */
  thumb(id: string): HTMLCanvasElement | null
  /** A new picture of the ground for the battle screen: the WebGL2 layer once it is in, else the 2D one. */
  layer(): GroundLayer
  placement(w: World, owner: Owner, unitId: string, x: number, y: number): GroundPlacement
  /** Enemy buildings `me`'s team remembers, as last seen. */
  known(w: World, me: Owner): KnownBuilding[]
  /** The fog of war as a half-dark veil over the world outside `team`'s sight (never black: the land
   * is known from orbit), drawn in world coordinates. */
  fog(ctx: CanvasRenderingContext2D, w: World, team: number, reveal: boolean): void
  /** The placement ghost's ground: each tile of the footprint green or red, and the row in front of
   * its door; in world coordinates. */
  ghost(ctx: CanvasRenderingContext2D, w: World, me: Owner, unitId: string, p: GroundPlacement, zoom: number): void
  /** The minimap's ground: the terrain and the fog, into the box (ox, oy) at `s` pixels a world unit. */
  minimap(ctx: CanvasRenderingContext2D, w: World, team: number, ox: number, oy: number, s: number, reveal: boolean): void
  /** The crystal field with kyber left under or near (x, y), or -1 (a right-click there gathers). */
  fieldAt(w: World, x: number, y: number): number
  /** The kyber crystal cluster with kyber left under (x, y) (an index into World `crystals`), or -1. */
  crystalUnder(w: World, x: number, y: number): number
  /** The kyber crystal clusters inside the box (world units), each as big as the kyber it has left
   * lets it be, in world coordinates; `zdpr`: device pixels per world unit. Under them, a line from
   * each of `me`'s gathering engineers to the cluster it works, and a marker on that cluster, in
   * `color` (our colour). */
  crystals(ctx: CanvasRenderingContext2D, w: World, zoom: number, zdpr: number, box: { x0: number; y0: number; x1: number; y1: number }, me: Owner, color: string): void
  /** Kyber an engineer carries in one load. */
  carry: number
  /** What `owner`'s power is made of and spent on now, and its research points (ground/power.ts). */
  power(w: World, owner: Owner): PowerReport
  /** Power a construction site draws while it is built. */
  siteDraw: number
  /** Why factory `s` can't start job `job` ('tier' or a GROUND_TECH id) for `owner` now, or null
   * (ground/jobs.ts); and the most tiers a factory reaches. */
  cantJob(w: World, owner: Owner, s: Unit, job: string): string | null
  tierMax: number
  /** The ground weapons' shots, beams, sprays and burns (ground/effects.ts), in world coordinates;
   * `clock`: the screen's seconds, for flicker. */
  effects(ctx: CanvasRenderingContext2D, w: World, me: Owner, zoom: number, clock: number): void
  /** A squad's members (GroundSpec `squad`, ground/squadDraw.ts) where they stand, walking; `zdpr`:
   * device pixels per world unit; `clock`: the screen's seconds. */
  squad(ctx: CanvasRenderingContext2D, u: Unit, zoom: number, zdpr: number, alpha: number, clock: number): void
  /** The pose a walker (a vehicle whose model walks, Model `walk`) is in now. */
  pose(u: Unit, m: Model, clock: number): number
  /** A squad we saw was destroyed: its last members fall. */
  fell(u: Unit, clock: number): void
  /** Fallen squad members lying where they fell, fading (under the units). */
  bodies(ctx: CanvasRenderingContext2D, zdpr: number, clock: number, box: { x0: number; y0: number; x1: number; y1: number }): void
}

let kit: GroundKit | null = null
/** Ground battles' screen code, once loaded (ground/load.ts). */
export const groundKit = () => kit
export const setGroundKit = (k: GroundKit) => void (kit = k)
