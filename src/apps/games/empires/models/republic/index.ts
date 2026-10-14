import type { FactionModels } from '../spec.ts'
import * as base from './base.ts'
import * as craft from './craft.ts'
import * as warships from './warships.ts'

// The Republic's models, by unit id (see models/index.ts): its strike craft, station and platforms
// (craft.ts), its warships at their size (warships.ts), its engineers, yards and expansion modules
// (base.ts). A station's id covers all its levels: the design grows with the level.

export const MODELS: FactionModels = {
  defs: {
    'r-fighter': craft.fighter,
    'r-bomber': craft.bomber,
    'r-repair': craft.repair,
    'r-picket': craft.picket,
    'r-gunship': warships.gunship,
    'r-corvette': warships.corvette,
    'r-frigate': warships.frigate,
    'r-cruiser': warships.cruiser,
    'r-capital': warships.capital,
    'r-station': craft.station,
    'r-mine': craft.mine,
    'r-defense': craft.defense,
    'r-defense-flak': craft.defense,
    'r-defense-gun': craft.defense,
    'r-engineer': base.republicEngineer,
    'r-yard': base.republicYard,
    'r-cyard': base.republicCapitalYard,
  },
  expansion: base.expansion,
  // The station's level-4 frame can be drawn square or octagonal.
  styles: (t) => (t.id === 'r-station' && /-4$/.test(t.sprite) ? [...craft.STATION_FRAMES] : []),
}
