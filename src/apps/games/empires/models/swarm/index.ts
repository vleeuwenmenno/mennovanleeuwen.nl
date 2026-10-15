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
    's-destroyer': warships.impaler,
    's-frigate': warships.frigate,
    's-cruiser': warships.cruiser,
    's-capital': warships.capital,
    's-battleship': warships.broodmother,
    's-station': base.station,
    's-mine': base.mine,
    's-defense': base.defense,
    's-defense-flak': base.defense,
    's-defense-gun': base.defense,
    's-yard': base.yard,
    's-cyard': base.capitalYard,
  },
  expansion: base.expansion,
  // What the Codex calls the parts of a Swarm organism (the longest matching prefix of a part's id).
  partNames: [
    ['flesh', 'Tissue'], ['under', 'Dark chitin'], ['seg', 'Spine segment'], ['core', 'Violet core'], ['coreBed', 'Core membrane'], ['coreSocket', 'Core socket'],
    ['claw', 'Claw'], ['clawTip', 'Claw tip'], ['hook', 'Hooked horn'], ['horn', 'Horn'], ['crown', 'Crown spike'], ['mandible', 'Mandible'], ['jaw', 'Mandible'], ['head', 'Head plate'],
    ['shoulder', 'Shoulder plate'], ['upper', 'Upper claw plate'], ['middle', 'Claw plate'], ['lower', 'Lower claw plate'], ['rim', 'Core rim plate'],
    ['fore', 'Forward blade'], ['foreTip', 'Blade tip'], ['mid', 'Flank blade'], ['midTip', 'Blade tip'], ['hind', 'Hind blade'], ['tail', 'Tail blade'], ['flank', 'Flank blade'], ['aft', 'Hind blade'],
    ['wing', 'Claw wing'], ['blade', 'Chitin blade'], ['pincer', 'Pincer'], ['leaf', 'Leaf shell'], ['node', 'Regen node'], ['nodeSocket', 'Regen node socket'], ['heart', 'Healing core'],
    ['tendril', 'Tendril'], ['whisker', 'Feeler'], ['feeler', 'Feeler'], ['feeder', 'Feeding tendril'], ['limb', 'Limb'], ['leg', 'Leg'], ['membrane', 'Wing membrane'], ['barb', 'Barb'],
    ['sac', 'Engine sac'], ['sacs', 'Spore sacs'], ['vent', 'Biomass vent'], ['seat', 'Node collar'], ['acid', 'Acid sprayer'], ['turret', 'Bio-turret'], ['mouth', 'Sucker mouth'], ['gullet', 'Gullet'],
    ['abdomen', 'Abdomen'], ['spinneret', 'Spinneret'], ['eye', 'Eye'], ['body', 'Body'], ['ring', 'Sentinel ring'], ['belly', 'Belly plate'], ['shell', 'Shell plate'], ['arm', 'Limb'],
    ['petal', 'Chitin petal'], ['nucleus', 'Nucleus'], ['armour', 'Armour plate'], ['web', 'Tissue web'], ['armPad', 'Gun knuckle'], ['knuckle', 'Gun knuckle'], ['sacPod', 'Brood sac'], ['sacStem', 'Sac stalk'],
    ['stem', 'Stalk'], ['spine', 'Spine array'], ['fringe', 'Tendril'], ['lowLimb', 'Lower limb'], ['hindLimb', 'Hind limb'], ['lowKnuckle', 'Gun knuckle'], ['hindKnuckle', 'Gun knuckle'], ['crownHorn', 'Crown horn'], ['armOut', 'Limb'], ['armSpike', 'Spike'],
    ['root', 'Root tendril'], ['bridge', 'Tissue bridge'], ['pod', 'Feeding pod'], ['knob', 'Turret knob'], ['plate', 'Chitin plate'], ['floor', 'Deck tissue'], ['rib', 'Brood rib'], ['cradle', 'Node cradle'], ['side', 'Side node'], ['hub', 'Hub'], ['spores', 'Spore sacs'], ['spike', 'Spine'], ['stalk', 'Sensory stalk'],
    ['lance', 'Spinal tendril lance'], ['lanceRoot', 'Lance bulb'], ['lanceTip', 'Lance point'], ['barbLow', 'Barb'], ['grip', 'Lance claw'], ['hatch', 'Hatching chamber'], ['hatchLip', 'Hatching lip'], ['hatchAft', 'Hatching chamber'], ['hatchAftLip', 'Hatching lip'],
    ['bed', 'Birthing pool'], ['wall', 'Chitin wall'], ['spur', 'Wall claw'], ['hornPad', 'Node pad'], ['womb', 'Womb'], ['bud', 'Module bud'], ['sternPad', 'Node pad'],
  ],
}
