import type { FactionModels } from '../spec.ts'
import * as base from './base.ts'
import * as craft from './craft.ts'
import * as warships from './warships.ts'

// The Swarm's models, by unit id (see models/index.ts): its concept designs (craft.ts and
// warships.ts, first drawn for the Confederacy's units, on the same boxes and hardpoints), and
// placeholder copies of the Confederacy's constructor droid and yards (base.ts). A station's id
// covers all its levels: the design grows with the level.

export const MODELS: FactionModels = {
  defs: {
    's-fighter': craft.fighter,
    's-station': craft.station,
    's-bomber': craft.bomber,
    's-repair': craft.repair,
    's-picket': craft.picket,
    's-gunship': warships.gunship,
    // The Leech corvette stands on the concept's ion frigate for now.
    's-corvette': warships.ion,
    's-frigate': warships.frigate,
    's-cruiser': warships.cruiser,
    's-capital': warships.capital,
    's-mine': craft.mine,
    's-defense': craft.defense,
    's-defense-flak': craft.defense,
    's-defense-gun': craft.defense,
    's-engineer': base.engineer,
    's-yard': base.yard,
    's-cyard': base.capitalYard,
  },
  expansion: base.expansion,
}
