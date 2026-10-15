import type { FactionModels } from '../spec.ts'
import * as base from './base.ts'
import * as craft from './craft.ts'
import * as warships from './warships.ts'

// The Swarm's models, by unit id (see models/index.ts): its small organisms (craft.ts), its warships
// (warships.ts), and its structures, the Hive Nexus and the expansion modules (base.ts). A station's
// id covers all its levels: the design grows with the level.

export const MODELS: FactionModels = {
  defs: {
    's-fighter': craft.fighter,
    's-bomber': craft.bomber,
    's-repair': craft.repair,
    's-picket': craft.picket,
    's-engineer': craft.engineer,
    's-gunship': craft.gunship,
    's-corvette': craft.corvette,
    's-frigate': warships.frigate,
    's-cruiser': warships.cruiser,
    's-capital': warships.capital,
    's-station': base.station,
    's-mine': base.mine,
    's-defense': base.defense,
    's-defense-flak': base.defense,
    's-defense-gun': base.defense,
    's-yard': base.yard,
    's-cyard': base.capitalYard,
  },
  expansion: base.expansion,
}
