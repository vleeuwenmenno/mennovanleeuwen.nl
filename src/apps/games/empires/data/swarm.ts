// The Swarm: a bio-mechanical hive that grows its ships rather than building them, every vessel a
// living organism guided by one collective mind. Its ships, structures, Command Station (the Hive
// Nexus), research and yards, as written (data.ts toughens, scales and sizes them). The Swarm's own
// file: the rest of the game reads it through data.ts. Points on a ship are on the 0-10 grid over its
// box, x from the left and y from the nose (see data.ts).
//
// Its doctrine is attrition and numbers: no shields anywhere (more hull instead), living hulls that
// grow back once out of the fight (UnitType and StationPlan `regrow`), cheap hulls that hatch fast,
// fragile strike craft, the Leech corvette's drain aura (UnitType `drain`), the Impaler's spinal
// lance, and broods of Stingers from the Broodmother, the Leviathan and the fully grown Hive
// (`carrier`).
//
// Its weapon organs are its own mount looks (Hardpoint `look`, drawn in models/swarm/mounts.ts): a
// tendril lance is a turbolaser, an acid sprayer flak, a spore cannon a missile launcher, a bio-turret
// the Feeding Node's point defence, and the brood chambers are hangars.

import { M, P, flak, gun as baseGun, laser, missile, sGun, sPart, spinal, tech, torpedo, turbo, type DefenseKind, type Deck, type FactionData, type Hardpoint, type Layout, type UnitType, type Weapon } from './kit.ts'

const DECK: Deck = { centre: [5, 5], corners: [[2.6, 2.9], [7.4, 2.9], [2.6, 7.2], [7.4, 7.2]], sides: [[0.9, 5], [9.1, 5]], wells: [[1.8, 5.1], [8.2, 5.1]], core: [5, 5], pd: [5, 8], pad: [5, 1.7] }

/** Living hulls: how fast each kind grows its hull back once nothing has hit it for `delay` seconds
 * (a share of its full hull a second). Small things knit fast, the great ones slowly. */
const REGROW = {
  craft: { rate: 0.02, delay: 9 },
  ship: { rate: 0.008, delay: 11 },
  capital: { rate: 0.004, delay: 12 },
  structure: { rate: 0.004, delay: 15 },
}

/**
 * A spore cannon: a living mortar that lobs a slow, heavy spore past shields at warships (a missile,
 * see kit.ts). On a hardpoint it turns like any turret, so it has no firing arc of its own.
 */
function spore(damage: number, range = 620, cooldown = 3.6): Weapon {
  const { arc: _arc, ...w } = missile(damage, range, cooldown)
  return w
}
/** A weapon organ on a hardpoint, in the Swarm's own looks (models/swarm/mounts.ts extras): a
 * turbolaser is a tendril lance, flak an acid sprayer. */
const gun = (art: 'turbo' | 'flak', x: number, y: number, s: number, hp: number, w: Weapon): Hardpoint => ({ ...baseGun(art, x, y, s, hp, w), look: art === 'turbo' ? 'lance' : 'acid' })
/** A spore cannon node: a violet spore bulb in chitin claws (a missile launcher that turns). */
const sporeNode = (x: number, y: number, s: number, hp: number, w: Weapon): Hardpoint => ({ ...M('turret', 'turbo', x, y, s, hp, w), look: 'spore' })
/** A brood chamber: the hangar its Stingers spawn from. */
const broodSac = (x: number, y: number, s: number, hp: number): Hardpoint => ({ ...M('hangar', 'hangar', x, y, s, hp), look: 'broodSac' })

/** The Feeding Node's point defence: one small acid sprayer, tuned like the others' (see data.ts). */
const MINE_FLAK: Weapon = flak(1.6, 320, 0.4)

/** The Feeding Node: two feeding maws sunk into the ore and a digestive sac between them, and a small
 * acid sprayer. Each maw earns 40% of the platform's income and the sac 20%; bitten-off parts earn
 * nothing until they grow back. The Swarm grows no shields: its "Shield generator" upgrade is a
 * hardened carapace instead (more hull, regrowing faster), with no dome of its own. */
function minePlatform(hardened = false): UnitType {
  const d = DECK
  return {
    id: 's-mine', faction: 'swarm', tier: 'mine', name: 'Feeding Node',
    blurb: 'Feeds on an ore asteroid for credits: two feeding maws and a digestive sac, each worth part of the income while it lives, and a small acid sprayer that can hold off a fighter squadron. Its hull grows back between attacks.',
    sprite: 'mine-swarm', aspect: 1.05, size: 120, hull: hardened ? 1650 : 1100, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, cost: 460, build: 21, level: 1, squad: 1, sensor: 600,
    weapons: [],
    hardpoints: [
      { ...M('drill', 'drill', d.wells[0][0], d.wells[0][1], 0.3, 420), key: 'drill1' },
      { ...M('drill', 'drill', d.wells[1][0], d.wells[1][1], 0.3, 420), key: 'drill2' },
      { ...M('refinery', 'refinery', d.core[0], d.core[1], 0.1, 320), key: 'silo' },
      { ...gun('flak', d.pd[0], d.pd[1], 0.11, 260, MINE_FLAK), look: 'bioturret', key: 'pd' },
    ],
    engines: [],
    regrow: hardened ? { rate: REGROW.structure.rate * 2, delay: REGROW.structure.delay } : REGROW.structure,
  }
}

/** The three defense nodes (see DefenseKind): grown on the same chitin deck, no shield membranes,
 * more hull, and regrowing between attacks. */
function defensePlatform(kind: DefenseKind): UnitType {
  const d = DECK
  const [c, tl, tr, bl, br] = [d.centre, ...d.corners]
  const base = {
    faction: 'swarm' as const, tier: 'defense' as const, sprite: 'defense-swarm', aspect: 1, size: 130, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 1000, weapons: [], engines: [] as [number, number][],
    shield: 0, regen: 0, regrow: REGROW.structure,
  }
  const lanceAt = (p: [number, number], big: boolean, w: Weapon) => gun('turbo', p[0], p[1], big ? 0.3 : 0.17, big ? 700 : 480, w)
  const acidAt = (p: [number, number], small: boolean, w: Weapon) => gun('flak', p[0], p[1], small ? 0.09 : 0.125, small ? 240 : 320, w)
  if (kind === 'flak')
    return {
      ...base, id: 's-defense-flak', name: 'Spore Battery', blurb: 'Six acid sprayers that dissolve fighters and bombers in clouds of caustic spores. Barely scratches a warship. No income.',
      hull: 2700, cost: 600, build: 27,
      hardpoints: [...[tl, tr, bl, br].map((p) => acidAt(p, false, flak(7, 420, 0.3))), ...d.sides.map((p) => acidAt(p, true, flak(6, 400, 0.35)))],
      role: { role: 'Anti-fighter', strong: ['fighters', 'bombers', 'gunships'], weak: ['frigates', 'cruisers', 'flagships'] },
    }
  if (kind === 'gun')
    return {
      ...base, id: 's-defense-gun', name: 'Spine Battery', blurb: 'A great tendril lance and two lighter ones that outreach warships. Fighters slip under them. No income.',
      hull: 3500, cost: 650, build: 29,
      hardpoints: [lanceAt(c, true, turbo(55, 850, 2.2, 2)), lanceAt(bl, false, turbo(30, 760, 2, 2)), lanceAt(br, false, turbo(30, 760, 2, 2))],
      role: { role: 'Anti-warship', strong: ['frigates', 'cruisers', 'flagships'], weak: ['fighters', 'bombers'] },
    }
  return {
    ...base, id: 's-defense', name: 'Guardian Node', blurb: 'A tendril lance for warships and acid sprayers for fighters: covers both, a little weaker than the specialists. No income.',
    hull: 3100, cost: 600, build: 27,
    hardpoints: [lanceAt(c, true, turbo(30, 720, 2, 2)), acidAt(tl, false, flak(7, 380, 0.35)), acidAt(tr, false, flak(7, 380, 0.35))],
  }
}

/** The Frigate Yard: the Brood Nursery, a birthing pool cupped in chitin walls. Its brood cord (the
 * hardpoint that grows ships: bitten off, growth goes at half speed) runs over the pool, and an
 * acid sprayer guards each bow horn. */
function frigateYard(): UnitType {
  const pd = flak(6, 380, 0.4)
  return {
    id: 's-yard', faction: 'swarm', tier: 'yard', name: 'Brood Nursery',
    blurb: 'A birthing pool grown by Weavers within the Hive Nexus\'s build radius: it grows frigates and corvettes, with its own queue and rally point. Two acid sprayers keep raiders off it, and its hull grows back between attacks.',
    sprite: 'swarm-yard', aspect: 0.66, size: 320, hull: 5900, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, cost: 820, build: 28, level: 2, squad: 1, sensor: 1100,
    weapons: [],
    hardpoints: [
      { ...M('dock', 'dock', 5, 4.8, 0.1, 1050), key: 'slip' },
      { ...gun('flak', 1.7, 1.6, 0.055, 340, pd), key: 'pd1' },
      { ...gun('flak', 8.3, 1.6, 0.055, 340, pd), key: 'pd2' },
    ],
    engines: [],
    regrow: REGROW.structure,
    role: { role: 'Frigate yard', strong: ['growing frigates and corvettes'], weak: ['bombers', 'cruisers', 'being left unguarded'] },
  }
}

/** The Capital Yard: the Leviathan Spawning Pit, a long, deep birthing trench for the line's
 * heaviest organisms. Its brood cord grows them (bitten off, growth goes at half speed); a tendril
 * lance on each bow horn and acid sprayers at the stern. */
function capitalYard(): UnitType {
  const pd = flak(6, 380, 0.4)
  const lance = turbo(30, 760, 2.4, 2)
  return {
    id: 's-cyard', faction: 'swarm', tier: 'yard', name: 'Leviathan Spawning Pit',
    blurb: 'A vast spawning trench grown within the Hive Nexus\'s build radius, from station level 3: it grows cruisers, and Leviathans and Broodmothers once its Capital slip has grown. Its own queue and rally point; tendril lances and acid sprayers guard it, and its hull grows back between attacks.',
    sprite: 'swarm-cyard', aspect: 0.74, size: 430, hull: 9400, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, cost: 1850, build: 42, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    hardpoints: [
      { ...M('dock', 'dock', 5, 4.4, 0.11, 1600), key: 'slip' },
      { ...gun('turbo', 1.75, 1.35, 0.07, 800, lance), key: 'tl1' },
      { ...gun('turbo', 8.25, 1.35, 0.07, 800, lance), key: 'tl2' },
      { ...gun('flak', 1.9, 9.1, 0.05, 360, pd), key: 'pd1' },
      { ...gun('flak', 8.1, 9.1, 0.05, 360, pd), key: 'pd2' },
    ],
    engines: [],
    regrow: REGROW.structure,
    role: { role: 'Capital yard', strong: ['growing cruisers and flagships'], weak: ['bombers', 'flagships', 'being left unguarded'] },
  }
}

// --- Warships -----------------------------------------------------------------------------------------
//
// Frigates and up carry every weapon organ as a hardpoint, drawn on the model where the hardpoint is
// (models/swarm/warships.ts). The layout at their size is the same as written (see `layout` below).

/**
 * Harvester frigate: a claw-shaped war organism. Two tendril lances on its claw shoulders, a spore
 * cannon on its head, two acid sprayers on its hind carapace.
 */
const HARVESTER: UnitType = {
  id: 's-frigate', faction: 'swarm', tier: 'frigate', name: 'Harvester frigate', blurb: 'A multi-limbed war organism: tendril lances on its claws, a spore cannon on its head and acid sprayers that strip fighters off it. When it is badly hurt its tissue knits furiously.',
  sprite: 'swarm-frigate', aspect: 0.62, size: 135, hull: 1300, shield: 0, regen: 0, speed: 76, turn: 1.0, pop: 3, cost: 710, build: 18, level: 2, squad: 1, sensor: 950,
  weapons: [],
  hardpoints: [
    gun('turbo', 2.58, 2.9, 0.07, 280, turbo(19, 520, 1.4, 1)), gun('turbo', 7.42, 2.9, 0.07, 280, turbo(19, 520, 1.4, 1)),
    sporeNode(5, 1.6, 0.07, 300, spore(16, 560, 3.4)),
    gun('flak', 2.42, 7.2, 0.055, 180, flak(6, 320, 0.33)), gun('flak', 7.58, 7.2, 0.055, 180, flak(6, 320, 0.33)),
  ],
  engines: [[3.6, 9.45], [5, 9.65], [6.4, 9.45]],
  ability: 'repairSwarm',
  regrow: REGROW.ship,
}

/**
 * Devourer cruiser: a long armoured spine with lateral blades. Two heavy tendril lances at the roots
 * of its mid blades, two light ones on its forward blades, two spore cannons on its hind flanks, two
 * engine sacs at the tail; tendrils that pin ships in place (Tractor lock).
 */
const DEVOURER: UnitType = {
  id: 's-cruiser', faction: 'swarm', tier: 'cruiser', name: 'Devourer cruiser', blurb: 'A long armoured spine studded with weapon organs: heavy tendril lances, spore cannons, and tendrils that pin ships in place. No shields, a vast regrowing hull.',
  sprite: 'swarm-cruiser', aspect: 0.5, size: 250, hull: 3100, shield: 0, regen: 0, speed: 50, turn: 0.55, pop: 5, cost: 1450, build: 29, level: 3, squad: 1, sensor: 1200,
  weapons: [],
  hardpoints: [
    gun('turbo', 2.4, 5.8, 0.065, 600, turbo(40)), gun('turbo', 7.6, 5.8, 0.065, 600, turbo(40)),
    gun('turbo', 3.1, 3.0, 0.05, 240, turbo(12, 480, 1.2, 1)), gun('turbo', 6.9, 3.0, 0.05, 240, turbo(12, 480, 1.2, 1)),
    sporeNode(1.9, 7.3, 0.06, 420, spore(24, 640, 3.6)), sporeNode(8.1, 7.3, 0.06, 420, spore(24, 640, 3.6)),
    P('engine', 4, 9.35, 460), P('engine', 6, 9.35, 460),
  ],
  engines: [[4, 9.6], [6, 9.6]], ability: 'tractor',
  regrow: REGROW.ship,
}

/**
 * Impaler destroyer: a living spear, the Swarm's counterpart of the Confederacy's Breaker. A long,
 * narrow organism grown round one great spinal tendril lance, a violet crystal spike that runs from
 * its clawed head far out past the nose: it turns its whole body to aim and skewers big hulls with
 * one heavy bolt at a time. Two acid sprayers on its hind plates keep strike craft off it; no
 * shields, a thinner hull than the Harvester's that grows back, and its tissue knits furiously when
 * it is badly hurt (Frenzied knitting).
 */
const IMPALER: UnitType = {
  id: 's-destroyer', faction: 'swarm', tier: 'frigate', name: 'Impaler destroyer', blurb: 'A living spear: a long, narrow organism grown round a spinal tendril lance. It turns its whole body to aim, and each thrust of the lance skewers a big hull. Thin-skinned and slow to deal with strike craft; badly hurt, its tissue knits furiously.',
  sprite: 'swarm-destroyer', aspect: 0.3, size: 160, hull: 1250, shield: 0, regen: 0, speed: 82, turn: 1.0, pop: 3, cost: 760, build: 20, level: 2, squad: 1, sensor: 1050,
  weapons: [],
  hardpoints: [
    { ...gun('turbo', 5, 1.6, 0.09, 380, spinal(turbo(200, 720, 3.2, 1), 10)), look: 'lance' },
    gun('flak', 3.0, 7.0, 0.06, 170, flak(5.5, 300, 0.4)), gun('flak', 7.0, 7.0, 0.06, 170, flak(5.5, 300, 0.4)),
  ],
  engines: [[3.6, 9.5], [6.4, 9.5]], ability: 'repairSwarm',
  regrow: REGROW.ship,
  role: { role: 'Lance ship', strong: ['cruisers', 'flagships', 'stations'], weak: ['fighters', 'gunships', 'being flanked'] },
}

/**
 * Leviathan dreadnought: the living hive vessel of the reference sheet, the Swarm's gun flagship.
 * Four heavy tendril lances flank its hive core, four acid sprayers ride its chitin plates, two
 * spore cannon nodes crown its spine array, two brood chambers on its hind plates keep one brood of
 * Stingers by it (the Broodmother is the carrier), and three engine sacs push it.
 */
const LEVIATHAN: UnitType = {
  id: 's-capital', faction: 'swarm', tier: 'capital', name: 'Leviathan dreadnought', blurb: 'A living hive vessel round a great violet core, the Swarm\'s gun flagship: heavy tendril lances and spore cannons, a brood of Stingers at its side, and a hull that grows back between battles.',
  sprite: 'swarm-capital', aspect: 0.66, size: 380, hull: 7200, shield: 0, regen: 0, speed: 31, turn: 0.32, pop: 10, cost: 3800, build: 60, level: 4, squad: 1, sensor: 1500,
  weapons: [],
  hardpoints: [
    gun('turbo', 3.18, 3.6, 0.07, 720, turbo(64, 740)), gun('turbo', 6.82, 3.6, 0.07, 720, turbo(64, 740)), gun('turbo', 2.88, 6.4, 0.07, 720, turbo(64, 740)), gun('turbo', 7.12, 6.4, 0.07, 720, turbo(64, 740)),
    gun('flak', 1.67, 2.6, 0.045, 300, flak(6, 340, 0.9)), gun('flak', 8.33, 2.6, 0.045, 300, flak(6, 340, 0.9)), gun('flak', 0.9, 5.2, 0.045, 300, flak(6, 340, 0.9)), gun('flak', 9.1, 5.2, 0.045, 300, flak(6, 340, 0.9)),
    sporeNode(4.09, 1.8, 0.065, 640, spore(44, 780, 3.8)), sporeNode(5.91, 1.8, 0.065, 640, spore(44, 780, 3.8)),
    P('engine', 5, 9.4, 950),
    broodSac(2.27, 7.8, 0.075, 760), broodSac(7.73, 7.8, 0.075, 760),
  ],
  engines: [[3.5, 9.6], [5, 9.75], [6.5, 9.6]], ability: 'launchSwarm', carrier: { unit: 's-fighter', every: 30, max: 1 },
  regrow: REGROW.capital,
}

/**
 * Broodmother carrier: the Swarm's living carrier. A bloated, broad hive vessel swollen with brood
 * sacs and hatching chambers round a glowing violet core: four brood chambers that hatch Stingers
 * far faster than the Leviathan's and keep many more broods out. Two light tendril lances and two
 * acid sprayers are all its own guns; its hull grows back quicker than any other flagship's.
 */
const BROODMOTHER: UnitType = {
  id: 's-battleship', faction: 'swarm', tier: 'capital', name: 'Broodmother carrier', blurb: 'A bloated hive vessel swollen with brood sacs: it hatches broods of Stingers far faster than the Leviathan and keeps many more of them out. Its own guns are weak; its hull grows back quickly between attacks.',
  sprite: 'swarm-battleship', aspect: 0.8, size: 330, hull: 6200, shield: 0, regen: 0, speed: 30, turn: 0.3, pop: 9, cost: 3300, build: 56, level: 4, squad: 1, sensor: 1450,
  weapons: [],
  hardpoints: [
    gun('turbo', 3.3, 2.5, 0.06, 560, turbo(26, 640, 2.2, 2)), gun('turbo', 6.7, 2.5, 0.06, 560, turbo(26, 640, 2.2, 2)),
    gun('flak', 1.25, 4.3, 0.045, 280, flak(6, 340, 0.8)), gun('flak', 8.75, 4.3, 0.045, 280, flak(6, 340, 0.8)),
    broodSac(2.0, 6.0, 0.07, 720), broodSac(8.0, 6.0, 0.07, 720), broodSac(3.05, 8.05, 0.07, 720), broodSac(6.95, 8.05, 0.07, 720),
    P('engine', 5, 9.4, 900),
  ],
  engines: [[3.7, 9.55], [5, 9.7], [6.3, 9.55]], ability: 'launchSwarm', carrier: { unit: 's-fighter', every: 10, max: 4 },
  regrow: { rate: 0.008, delay: 9 },
  role: { role: 'Carrier', strong: ['frigates', 'cruisers', 'flagships'], weak: ['flak', 'fighters', 'gunships'] },
}

/** A warship's layout at its size: the same points and sizes as written. */
const asWritten = (t: UnitType): Layout => t.hardpoints.map((h) => ({ x: h.x, y: h.y, s: h.s }))

export const SWARM: FactionData = {
  id: 'swarm',
  info: {
    name: 'Swarm',
    long: 'The Swarm',
    blurb: 'A living fleet grown, not built: cheap, fast-hatching hulls with no shields that grow back between fights, and broods that never stop coming.',
    color: '#b34cda',
    bolt: '#d263f0',
    glow: '#c890ff',
    prefix: 's',
    work: '165,229,95',
    weld: { glow: 'rgb(151,237,116)', core: 'rgb(236,255,224)', mid: 'rgba(180,240,140,0.9)', edge: 'rgba(151,237,116,0)' },
    debris: '#b8aab7',
    emblem: '/games/empires/world/emblem-swarm.webp',
    rival: 'republic',
    sound: { turbo: 0.8 },
    // Its weapon organs and body parts have names of their own; what they do is the shared guns'.
    names: {
      weapon: { laser: 'Barbs', turbo: 'Tendril lance', flak: 'Acid spray', missile: 'Spores', ion: 'Ion organ' },
      mount: { turbo: 'Tendril lance', flak: 'Acid sprayer', missile: 'Spore cannon', ion: 'Ion organ' },
      part: { turret: 'Tendril lance', shield: 'Membrane', engine: 'Engine sac', hangar: 'Brood chamber', refinery: 'Digestive organ', dock: 'Regeneration pool', sensor: 'Sensory stalk', drill: 'Feeding maw' },
      site: {
        yield: { name: 'Deeper maws', blurb: 'This node feeds 30% more per level.' },
        armor: { name: 'Chitin plating', blurb: 'This node and its organs take 50% more punishment.' },
        shield: { name: 'Hardened carapace', blurb: 'Grows a thick carapace in place of a shield dome: this node gets 50% more hull, and it grows back twice as fast.' },
      },
      ability: {
        repairSwarm: { name: 'Frenzied knitting', blurb: 'Its tissue knits furiously: it restores 30% of its hull over 10 s.' },
        tractor: { name: 'Tendril grip', blurb: 'Tendrils seize the enemy ships nearby: they crawl at a third of their speed for 7 s.' },
        launchSwarm: { name: 'Brood burst', blurb: 'Empties the brood chambers: two extra broods of its Stingers at once.' },
      },
    },
  },
  ships: [
    {
      id: 's-fighter', faction: 'swarm', tier: 'fighter', name: 'Stinger interceptor', blurb: 'Five darting predators to a brood. Fragile and cheap, they hatch fast, and their barbs and venom stings add up against big ships.',
      sprite: 'swarm-fighter', aspect: 0.8, size: 26, hull: 38, shield: 0, regen: 0, speed: 265, turn: 4.5, pop: 1, cost: 220, build: 8, level: 1, squad: 5, sensor: 650,
      weapons: [laser(5, 230, 0.45), torpedo(14, 260)], hardpoints: [], engines: [[5, 9.1]],
      regrow: REGROW.craft,
    },
    {
      id: 's-gunship', faction: 'swarm', tier: 'gunship', name: 'Ravager gunship', blurb: 'An elongated hunter with acid sprayers on its forelimbs and a bio-turret of spines on its back: it tears strike craft apart.',
      sprite: 'swarm-gunship', aspect: 0.75, size: 62, hull: 420, shield: 0, regen: 0, speed: 170, turn: 2.6, pop: 2, cost: 390, build: 12, level: 1, squad: 1, sensor: 780,
      weapons: [flak(6, 290, 0.28), laser(12, 320, 1)], hardpoints: [], engines: [[3.9, 9.4], [6.1, 9.4]],
      regrow: REGROW.ship,
    },
    {
      id: 's-bomber', faction: 'swarm', tier: 'fighter', kind: 'bomber', name: 'Brood bomber', blurb: 'Bloated spore carriers, three to a brood. Cheap and fragile; their caustic spore sacs eat through big hulls.',
      sprite: 'swarm-bomber', aspect: 0.95, size: 34, hull: 85, shield: 0, regen: 0, speed: 180, turn: 3, pop: 2, cost: 390, build: 12, level: 2, squad: 3, sensor: 620,
      weapons: [laser(4, 220, 0.6), torpedo(46, 230, 6)], hardpoints: [], engines: [[5, 9.2]],
      regrow: REGROW.craft,
      role: { role: 'Bomber', strong: ['cruisers', 'flagships', 'stations'], weak: ['fighters', 'gunships', 'frigates'] },
    },
    {
      id: 's-repair', faction: 'swarm', tier: 'fighter', kind: 'repair', tech: 's-re-wing', name: 'Mender repair organism', blurb: 'Healers in leaf-shaped shells, two to a brood. Next to harmless, but their Field repair knits the Hive Nexus and warships back together under fire.',
      sprite: 'swarm-repair', aspect: 0.85, size: 28, hull: 90, shield: 0, regen: 0, speed: 245, turn: 3.8, pop: 1, cost: 240, build: 10, level: 1, squad: 2, sensor: 650,
      weapons: [laser(2, 200, 0.8)], hardpoints: [], engines: [[5, 9.2]], ability: 'fieldRepair',
      regrow: REGROW.craft,
      role: { role: 'Field repairs', strong: ['long fights', 'keeping flagships alive'], weak: ['fighters', 'flak', 'everything else'] },
    },
    {
      id: 's-picket', faction: 'swarm', tier: 'fighter', kind: 'wing', name: 'Seeker picket', blurb: 'The Hive\'s own sentinels: six tiny seekers that guard it for free and hatch again when lost. Vicious at home, feeble far from it.',
      sprite: 'swarm-picket', aspect: 0.9, size: 20, hull: 28, shield: 0, regen: 0, speed: 280, turn: 5, pop: 0, cost: 0, build: 0, level: 1, squad: 6, sensor: 640,
      weapons: [laser(3.5, 210, 0.42)], hardpoints: [], engines: [[5, 9]],
      regrow: REGROW.craft,
      role: { role: 'Home defense', strong: ['fighters', 'bombers near the station'], weak: ['warships', 'being sent away from home'] },
    },
    {
      id: 's-engineer', faction: 'swarm', tier: 'fighter', kind: 'engineer', name: 'Weaver engineer', blurb: 'Three spinner organisms. Unarmed and fragile: they weave the Hive\'s nurseries and spawning pits out of living silk and knit structures back together.',
      sprite: 'swarm-engineer', aspect: 0.9, size: 28, hull: 75, shield: 0, regen: 0, speed: 215, turn: 3.6, pop: 1, cost: 270, build: 12, level: 1, squad: 3, sensor: 650,
      weapons: [], hardpoints: [], engines: [[5, 9.2]],
      regrow: REGROW.craft,
      role: { role: 'Construction', strong: ['building yards', 'repairing structures'], weak: ['anything that shoots'] },
    },
    {
      id: 's-corvette', faction: 'swarm', tier: 'gunship', kind: 'support', name: 'Leech corvette', blurb: 'A segmented support hunter. Its feeding tendrils drain the hull of every enemy near it, past their shields, and pass the biomass on to our wounded ships. Lightly armed; keep it close behind the line.',
      sprite: 'swarm-corvette', aspect: 0.7, size: 84, hull: 600, shield: 0, regen: 0, speed: 140, turn: 1.8, pop: 2, cost: 520, build: 16, level: 2, squad: 1, sensor: 900,
      weapons: [laser(5, 260, 0.5)], hardpoints: [], engines: [[3.9, 9.4], [6.1, 9.4]],
      drain: { radius: 420, dps: 6, heal: 1.4 },
      regrow: REGROW.ship,
      role: { role: 'Drain support', strong: ['long fights', 'shielded ships'], weak: ['fighters', 'anything that catches it alone'] },
    },
    IMPALER,
    HARVESTER,
    DEVOURER,
    LEVIATHAN,
    // The Broodmother: the carrier flagship. Shares the flagships' tier and their limit of one (it
    // is grown at the Spawning Pit like them); weak guns, many fast broods.
    BROODMOTHER,
  ],
  station: {
    id: 's-station',
    name: 'Hive Nexus',
    blurb: 'The heart of the Swarm, a living orbital organism. It hatches Stingers, Ravagers and Weavers; the Weavers grow the nurseries for bigger ships round it. It starts as a small seed and grows with every upgrade, its hull growing back between attacks, and fully grown it spawns broods of its own. It has no shields. Lose it and the battle is lost.',
    perPx: 460 / 1148,
    regen: 0,
    // Every stage is centred on the same point of the frame (628, 592), from the small Hive Seed to
    // the towering Hive Nexus.
    stages: [
      { name: 'Hive Seed', box: [423, 387, 833, 797], hull: 6200, shield: 0 },
      { name: 'Brood Nest', box: [303, 267, 953, 917], hull: 8000, shield: 0 },
      { name: 'Hive Cluster', box: [153, 117, 1103, 1067], hull: 10300, shield: 0 },
      { name: 'Hive Nexus', box: [88, 18, 1168, 1166], hull: 12300, shield: 0 },
    ],
    modules: [
      sGun('t1', 'turbo', 628 + 112, 592 + 96, 1),
      sPart('h1', 'hangar', 'hangar', 628 - 112, 592 + 96, 110, 1300, { level: 1 }),
      sPart('sensor', 'sensor', 'sensor', 628, 592 - 140, 96, 750, { tech: 's-st-guns' }),
      sPart('refinery', 'refinery', 'refinery', 628 - 138, 592 - 50, 96, 750, { tech: 's-st-ore' }),
      sPart('sac1', 'hangar', 'hangar', 628 - 205, 592 + 205, 100, 1200, { level: 2 }),
      sGun('t2', 'turbo', 628 - 250, 592 - 70, 2),
      sGun('f1', 'flak', 628 + 250, 592 - 70, 2),
      sPart('dock', 'dock', 'dock', 628, 592 + 250, 110, 750, { level: 2, tech: 's-st-dock' }),
      sGun('t3', 'turbo', 628 - 400, 592 - 170, 3),
      sGun('t4', 'turbo', 628 + 400, 592 - 170, 3),
      sPart('sac2', 'hangar', 'hangar', 628 + 205, 592 + 205, 100, 1200, { level: 3 }),
      sGun('f2', 'flak', 628, 592 - 390, 3),
      sGun('t5', 'turbo', 628 - 470, 592 + 190, 4),
      sGun('t6', 'turbo', 628 + 470, 592 + 190, 4),
      sGun('t7', 'turbo', 628 - 260, 592 + 430, 4),
      sGun('t8', 'turbo', 628 + 260, 592 + 430, 4),
      sGun('f3', 'flak', 628 - 230, 592 - 400, 4),
      sGun('f4', 'flak', 628 + 230, 592 - 400, 4),
    ],
    // Fully grown, the Hive Nexus spawns broods of Stingers by itself, and from the start its hull
    // grows back between attacks.
    carrier: { unit: 's-fighter', every: 30, max: 2, level: 4 },
    regrow: { ...REGROW.structure, level: 1 },
  },
  structures: [minePlatform(), defensePlatform('balanced'), defensePlatform('flak'), defensePlatform('gun'), frigateYard(), capitalYard()],
  shieldedMine: minePlatform(true),
  // Regeneration, numbers, fast production and adaptation; no shield research at all. A bit cheaper
  // and quicker than the others' (it grows rather than builds). Each ship's second upgrade builds on
  // its first.
  techs: [
    tech('swarm', 's-station', 's-st-guns', 'Sensory stalks', 'A sensory stalk grows on the Hive Nexus: its spine batteries hit 25% harder while it stands.', 650, 40, 1, { damage: 0.25 }),
    tech('swarm', 's-station', 's-st-ore', 'Digestive organs', 'A digestive organ on the Hive Nexus: Feeding Nodes bring in 25% more credits while it stands.', 600, 36, 1, { mines: 0.25 }),
    tech('swarm', 's-station', 's-hv-surge', 'Hive surge', 'The Hive Nexus quickens every brood: all our ships hatch 10% faster.', 700, 40, 2, { fleetBuild: -0.1 }, ['s-st-ore']),
    tech('swarm', 's-station', 's-st-dock', 'Regeneration pools', 'A regeneration pool on the Hive Nexus: our ships near it regrow 2% of their hull a second while it stands.', 750, 40, 2, { repair: 0.02 }, ['s-st-ore']),
    // On the Hive Nexus, but for the whole Swarm: every living hull of ours, ships and structures.
    tech('swarm', 's-station', 's-hv-regrow', 'Rapid regrowth', 'Every living hull of ours, ships and structures alike, grows back 50% faster, and starts 30% sooner after a fight.', 900, 50, 3, { regrow: 0.5, regrowDelay: -0.3 }, ['s-st-dock']),
    tech('swarm', 's-fighter', 's-fi-line', 'Brood cycles', 'Stingers hatch 30% faster.', 350, 25, 1, { build: -0.3 }),
    tech('swarm', 's-fighter', 's-fi-guns', 'Barbed spines', 'Stinger barbs and stings deal 25% more damage.', 450, 32, 2, { damage: 0.25 }, ['s-fi-line']),
    tech('swarm', 's-gunship', 's-gs-shell', 'Thickened carapace', 'Ravagers grow 25% more hull.', 400, 28, 1, { hull: 0.25 }),
    tech('swarm', 's-gunship', 's-gs-cycle', 'Twitch muscles', 'Ravager weapon organs fire 15% faster.', 450, 28, 1, { cooldown: -0.15 }, ['s-gs-shell']),
    tech('swarm', 's-repair', 's-re-wing', 'Mender strain', 'Breeds healers in the Hive Nexus: unlocks the Mender and its Field repair.', 300, 22, 1, {}),
    tech('swarm', 's-bomber', 's-bo-pods', 'Caustic spores', 'Brood spore sacs deal 25% more damage.', 500, 32, 2, { damage: 0.25 }),
    tech('swarm', 's-corvette', 's-co-coils', 'Engorged sacs', 'Leeches grow 30% more hull, so they live long enough to feed.', 550, 36, 2, { hull: 0.3 }),
    tech('swarm', 's-corvette', 's-co-drain', 'Deeper tendrils', 'Leech tendrils bite 30% harder, and pass on 20% more of what they drain.', 600, 38, 2, { drain: 0.3, drainHeal: 0.2 }, ['s-co-coils']),
    tech('swarm', 's-frigate', 's-fr-plate', 'Chitin layering', 'Harvesters grow 25% more hull.', 550, 36, 2, { hull: 0.25 }),
    tech('swarm', 's-frigate', 's-fr-prong', 'Adaptive organs', 'Harvester weapon organs adapt to their prey: 20% more damage.', 600, 36, 2, { damage: 0.2 }, ['s-fr-plate']),
    tech('swarm', 's-destroyer', 's-de-barb', 'Barbed lance', 'Impaler lances grow hooked barbs that tear as they go in: 25% more damage.', 650, 38, 2, { damage: 0.25 }),
    tech('swarm', 's-destroyer', 's-de-sinew', 'Coiled sinews', 'The sinews that drive the Impaler\'s lance coil tighter: it thrusts 20% faster.', 650, 38, 2, { cooldown: -0.2 }, ['s-de-barb']),
    tech('swarm', 's-cruiser', 's-cr-ray', 'Acid glands', 'Devourer weapon organs deal 20% more damage.', 800, 42, 3, { damage: 0.2 }),
    tech('swarm', 's-cruiser', 's-cr-thrust', 'Engine sacs', 'Devourers swim 20% faster.', 650, 36, 3, { speed: 0.2 }, ['s-cr-ray']),
    tech('swarm', 's-capital', 's-ca-hangar', 'Brood chambers', 'Leviathans spawn Stingers faster and keep a second brood out.', 1100, 55, 4, { hangar: 1 }),
    tech('swarm', 's-capital', 's-ca-armour', 'Ancient carapace', 'Leviathans grow 25% more hull.', 1100, 55, 4, { hull: 0.25 }, ['s-ca-hangar']),
    tech('swarm', 's-battleship', 's-bs-brood', 'Endless brood', 'Broodmothers hatch Stingers faster and keep one more brood out.', 1100, 55, 4, { hangar: 1 }),
    tech('swarm', 's-battleship', 's-bs-womb', 'Swollen wombs', 'Broodmothers grow 20% more hull, and it grows back 50% faster.', 1100, 55, 4, { hull: 0.2, regrow: 0.5 }, ['s-bs-brood']),
    tech('swarm', 's-cyard', 's-yd-rush', 'Premature birth', 'Warships are pushed out of the pit before they are fully grown: the Leviathan Spawning Pit can rush out the warship it is growing once it is half grown (Rush launch). It comes out wounded, its weapon organs still unformed, and needs Menders or Weavers to finish it. Needs a Leviathan Spawning Pit.', 750, 40, 3, {}),
  ],
  rushTech: 's-yd-rush',
  mineFlak: MINE_FLAK,
  // On the Brood Nursery two module sockets on the flanks and one at the stern; on the Spawning Pit
  // one on each flank (the stern one stays free for now).
  yardSockets: [[0.95, 6.3], [9.05, 6.3], [5, 9.5]],
  cyardSockets: [[1.15, 5.5], [8.85, 5.5], [5, 9.45]],
  berths: {
    's-yard': { hw: 16, y0: -46, y1: 27 },
    's-cyard': { hw: 18, y0: -47, y1: 33 },
  },
  // Where the brood ribs arch over the pools: the Weavers' silk comes down from them onto the ship
  // being grown.
  gantries: {
    's-yard': [-25, -2, 20],
    's-cyard': [-26, -6, 14, 28],
  },
  layout: {
    's-destroyer': asWritten(IMPALER),
    's-frigate': asWritten(HARVESTER),
    's-cruiser': asWritten(DEVOURER),
    's-capital': asWritten(LEVIATHAN),
    's-battleship': asWritten(BROODMOTHER),
  },
}
