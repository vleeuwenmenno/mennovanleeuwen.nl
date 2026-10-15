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
  // What the Codex calls the parts (the longest matching start of a part's id wins).
  partNames: [
    ['prong', 'Bow prong'], ['wing', 'Swept wing'], ['fuselage', 'Fuselage'], ['engine', 'Engine module'], ['canopy', 'Cockpit'],
    ['cannon', 'Fork cannon'], ['spine', 'Exposed spine'], ['hull', 'Hull frame'], ['fin', 'Stabiliser fin'], ['pod', 'Armoured gun pod'],
    ['podNose', 'Gun pod prow'], ['lance', 'Spinal ion lance'], ['muzzle', 'Lance muzzle'], ['housing', 'Lance housing'], ['boom', 'Bow boom'],
    ['tip', 'Boom tip'], ['brace', 'Cross brace'], ['sponson', 'Gun sponson'], ['nacelle', 'Side nacelle'], ['nacelleTip', 'Nacelle tail'],
    ['bridge', 'Bridge core'], ['mast', 'Sensor mast'], ['antenna', 'Sensor mast'], ['strut', 'Pod strut'], ['cells', 'Missile cells'],
    ['tower', 'Fire-control tower'], ['crown', 'Sensor crown'], ['dish', 'Targeting dish'], ['array', 'Antenna array'], ['block', 'Armour block'],
    ['bow', 'Bow armour'], ['deck', 'Gun deck'], ['barrel', 'Heavy cannon'], ['rack', 'Missile rack'], ['keel', 'Keel'], ['mid', 'Repair bay'],
    ['side', 'Side armour'], ['aft', 'Aft segment'], ['tub', 'Flak tub'], ['crane', 'Salvage crane'], ['pincer', 'Salvage pincer'],
    ['claw', 'Welding claw'], ['arm', 'Work arm'], ['clamp', 'Clamp arm'], ['core', 'Core hull'], ['dome', 'Sensor dome'], ['tail', 'Tail fork'],
    ['body', 'Body'], ['blade', 'Side blade'], ['charge', 'Shaped charge'], ['stub', 'Ordnance pylon'], ['cab', 'Bridge cab'],
    ['armN', 'North arm'], ['armS', 'Hangar arm'], ['armW', 'Side arm'], ['armE', 'Side arm'], ['reactor', 'Reactor'], ['dockArm', 'Dock arm'],
    ['gantry', 'Construction gantry'], ['defence', 'Defence module'], ['capN', 'Armoured cap'], ['capS', 'Armoured cap'], ['spire', 'Sensor spire'],
    ['southBlock', 'Shield block'], ['prodHall', 'Production module'], ['prodStrut', 'Module strut'], ['store', 'Storage module'],
    ['storeStrut', 'Module strut'], ['bastion', 'Bastion'], ['spike', 'Antenna spike'], ['conveyor', 'Ore conveyor'], ['frame', 'Rig frame'],
    ['leg', 'Clamp leg'], ['girder', 'Girder'], ['hub', 'Hub'], ['pad', 'Landing pad'], ['gunbox', 'Gun block'], ['wall', 'Dock wall'],
    ['truss', 'Truss'], ['jaw', 'Mouth jaw'], ['bed', 'Berth'], ['port', 'Module port'], ['pdPod', 'Gun block'],
  ],
}
