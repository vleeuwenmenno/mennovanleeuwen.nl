import type { FactionId } from '../data.ts'
import type { Palette } from './kit.ts'
import { PALETTE as droid } from './droid/palette.ts'
import { PALETTE as republic } from './republic/palette.ts'
import { PALETTE as swarm } from './swarm/palette.ts'

/** Each faction's palette (models/<faction>/palette.ts): what its models are painted in. */
export const PALETTES: Record<FactionId, Palette> = { republic, droid, swarm }
