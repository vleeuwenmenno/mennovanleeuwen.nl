import type { FactionModels } from '../spec.ts'
import * as base from './base.ts'
import * as craft from './craft.ts'
import * as station from './station.ts'
import * as warships from './warships.ts'

// The Confederacy's models, by unit id (see models/index.ts): its strike craft, gunship, corvette and
// engineers (craft.ts), its warships at their size (warships.ts), the Command Hub, the Extraction
// Rig and the defense platforms (station.ts), its yards and expansion modules (base.ts), built from
// the style kit in parts.ts. A station's id covers all its levels: the design grows with the level.

export const MODELS: FactionModels = {
  defs: {
    'd-fighter': craft.fighter,
    'd-bomber': craft.bomber,
    'd-repair': craft.repair,
    'd-picket': craft.picket,
    'd-engineer': craft.engineer,
    'd-gunship': craft.gunship,
    'd-corvette': craft.corvette,
    'd-ion': warships.breaker,
    'd-frigate': warships.lancer,
    'd-cruiser': warships.harrow,
    'd-battleship': warships.tyrant,
    'd-capital': warships.dominator,
    'd-station': station.station,
    'd-mine': station.mine,
    'd-defense': station.defense,
    'd-defense-flak': station.defense,
    'd-defense-gun': station.defense,
    'd-yard': base.confedYard,
    'd-cyard': base.confedCapitalYard,
  },
  expansion: base.expansion,
}
