import type { UnitType } from '../data.ts'
import type { BreakStyle, Mount, Part, Pt } from './types.ts'

/** What a design is given to build from: the unit type, its box in model units, and for a station
 * the level it stands at. */
export type BuildCtx = { t: UnitType; w: number; h: number; level: number }

/**
 * What a design returns: its parts (mirrored pairs already expanded with sym()), and optionally
 * per-hardpoint overrides for the mounts placed on the unit's hardpoints, its own engine glow
 * spots, and how its hull breaks up.
 */
export type ModelSpec = {
  parts: Part[]
  mount?: (hp: number) => Partial<Pick<Mount, 'detach' | 'design' | 'turns'>> | undefined
  engines?: Pt[]
  breakStyle?: BreakStyle
}

export type ModelDef = (c: BuildCtx) => ModelSpec
