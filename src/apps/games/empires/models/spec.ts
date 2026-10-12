import type { UnitType } from '../data.ts'
import type { BreakStyle, Mount, MountDesign, Part, Pt } from './types.ts'

/** What a design is given to build from: the unit type, its box in model units, for a station the
 * level it stands at, and a design variant to try (the Codex shows each; the battle uses the
 * design's own default). */
export type BuildCtx = { t: UnitType; w: number; h: number; level: number; style?: string }

/**
 * What a design returns: its parts (mirrored pairs already expanded with sym()), and optionally
 * per-hardpoint overrides for the mounts placed on the unit's hardpoints, its own engine glow
 * spots, and how its hull breaks up.
 */
export type ModelSpec = {
  parts: Part[]
  /** Overrides for the mount on hardpoint `hp`; `scale` resizes it (a bigger hull keeping its guns
   * the size they were). */
  mount?: (hp: number) => (Partial<Pick<Mount, 'detach' | 'design' | 'turns'>> & { scale?: number }) | undefined
  /** Turrets for show beyond the unit's hardpoints, each standing for the hardpoint `maps` (see
   * Mount.extra). */
  extraMounts?: { x: number; y: number; r: number; design: MountDesign; maps: number; detach?: boolean }[]
  /** Cut lines for a 'bands' break into pieces (see Model.cuts). */
  cuts?: number
  engines?: Pt[]
  breakStyle?: BreakStyle
  /** The core sphere a 'ring' break leaves whole. */
  core?: { x: number; y: number; r: number }
}

export type ModelDef = (c: BuildCtx) => ModelSpec
