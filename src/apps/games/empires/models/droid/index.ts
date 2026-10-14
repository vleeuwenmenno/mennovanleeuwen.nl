import type { FactionModels } from '../spec.ts'
import * as base from './base.ts'
import * as craft from './craft.ts'
import * as warships from './warships.ts'

// The Confederacy's models, by unit id (see models/index.ts): its strike craft, station and
// platforms (craft.ts), its warships at their size (warships.ts), its constructor droids, yards and
// expansion modules (base.ts). A station's id covers all its levels: the design grows with the level.

export const MODELS: FactionModels = {
  defs: {
    'd-fighter': craft.fighter,
    'd-station': craft.station,
    'd-bomber': craft.bomber,
    'd-repair': craft.repair,
    'd-picket': craft.picket,
    'd-gunship': warships.gunship,
    'd-ion': warships.ion,
    'd-frigate': warships.frigate,
    'd-cruiser': warships.cruiser,
    'd-capital': warships.capital,
    // The Tyrant battleship has no design of its own yet: the Anvil cruiser's stands in for it.
    'd-battleship': warships.cruiser,
    'd-mine': craft.mine,
    'd-defense': craft.defense,
    'd-defense-flak': craft.defense,
    'd-defense-gun': craft.defense,
    'd-engineer': base.droidEngineer,
    'd-yard': base.droidYard,
    'd-cyard': base.droidCapitalYard,
  },
  expansion: base.expansion,
  // The flagship can be drawn as a ring hull or a carrier.
  styles: (t) => (t.id === 'd-capital' ? [...craft.CAPITAL_DESIGNS] : []),
}
