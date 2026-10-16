// The Republic: its ships, structures, Command Station, research and yards, as written (data.ts
// toughens, scales and sizes them). The Republic's own file: the rest of the game reads it through
// data.ts. Points on a ship are on the 0-10 grid over its box, x from the left and y from the nose
// (see data.ts).

import { M, P, flak, gun, laser, missile, sGun, sPart, spinal, tech, torpedo, turbo, type DefenseKind, type Deck, type FactionData, type Layout, type UnitType, type Weapon } from './kit.ts'

const DECK: Deck = { centre: [5, 5], corners: [[2.5, 2.6], [7.5, 2.6], [2.5, 7.4], [7.5, 7.4]], sides: [[0.9, 5], [9.1, 5]], wells: [[1.9, 5.2], [8.1, 5.2]], core: [5, 5.2], pd: [5, 8.3], pad: [5, 1.5] }

/**
 * The mining platform's point defence: one small flak turret, enough that one squadron of the other
 * side's fighters attacking it has about an even chance; nothing a warship would notice. Tuned per
 * faction in headless duels, because squadrons take flak very differently: five fragile droid
 * fighters fall to it far faster than three shielded Republic ones.
 */
const MINE_FLAK: Weapon = flak(1.1, 320, 0.4)

/** The Halberd's torpedo racks: each fires half the gunship's missile salvo, fixed forward along the
 * keel inside the arc its missiles always had (0.6 radians either side of the nose), so the gunship
 * turns to aim them as it always did. */
const LAUNCHER: Weapon = spinal(missile(17), (0.6 * 180) / Math.PI)

/** The mining platform: two drill rigs and an ore silo, and a small point-defence turret. Each drill
 * earns 40% of the platform's income and the silo 20%; shot-off parts earn nothing until repaired.
 * It comes without shields: the Shield generator upgrade fits a dome on the landing pad. */
function minePlatform(shielded = false): UnitType {
  const d = DECK
  return {
    id: 'r-mine', faction: 'republic', tier: 'mine', name: 'Mining Platform',
    blurb: 'Drills an ore asteroid for credits: two drill rigs and an ore silo, each worth part of the income while it works, and a small flak turret that can hold off a fighter squadron.',
    sprite: 'mine-republic', aspect: 1.051, size: 120, hull: 1000, shield: shielded ? 600 : 0, regen: shielded ? 10 : 0, speed: 0, turn: 0, pop: 0, cost: 460, build: 24, level: 1, squad: 1, sensor: 600,
    weapons: [],
    hardpoints: [
      { ...M('drill', 'drill', d.wells[0][0], d.wells[0][1], 0.3, 400), key: 'drill1' },
      { ...M('drill', 'drill', d.wells[1][0], d.wells[1][1], 0.3, 400), key: 'drill2' },
      { ...M('refinery', 'refinery', d.core[0], d.core[1], 0.1, 300), key: 'silo' },
      { ...gun('flak', d.pd[0], d.pd[1], 0.11, 250, MINE_FLAK), key: 'pd', look: 'pd' },
      ...(shielded ? [{ ...M('shield', 'shield', d.pad[0], d.pad[1], 0.17, 350), key: 'shield' }] : []),
    ],
    engines: [],
  }
}

/** The three defense platforms (see DefenseKind). */
function defensePlatform(kind: DefenseKind): UnitType {
  const d = DECK
  const [c, tl, tr, bl, br] = [d.centre, ...d.corners]
  const base = {
    faction: 'republic' as const, tier: 'defense' as const, sprite: 'defense-republic', aspect: 1.002, size: 130, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 1000, weapons: [], engines: [] as [number, number][],
  }
  const turboAt = (p: [number, number], big: boolean, w: Weapon) => gun('turbo', p[0], p[1], big ? 0.33 : 0.17, big ? 650 : 450, w)
  const flakAt = (p: [number, number], small: boolean, w: Weapon) => gun('flak', p[0], p[1], small ? 0.09 : 0.125, small ? 220 : 300, w)
  const shieldAt = (p: [number, number], big: boolean) => M('shield', 'shield', p[0], p[1], big ? 0.2 : 0.125, big ? 700 : 450)
  if (kind === 'flak')
    return {
      ...base, id: 'r-defense-flak', name: 'Flak Platform', blurb: 'Six point-defence turrets that shred fighters and bombers. Barely scratches a warship. No income.',
      hull: 1800, shield: 1100, regen: 16, cost: 650, build: 30,
      hardpoints: [shieldAt(c, true), ...[tl, tr, bl, br].map((p) => flakAt(p, false, flak(7, 420, 0.3))), ...d.sides.map((p) => flakAt(p, true, flak(6, 400, 0.35)))],
      role: { role: 'Anti-fighter', strong: ['fighters', 'bombers', 'gunships'], weak: ['frigates', 'cruisers', 'flagships'] },
    }
  if (kind === 'gun')
    return {
      ...base, id: 'r-defense-gun', name: 'Gun Platform', blurb: 'A heavy turbolaser and two lighter ones that outrange warships. Fighters slip under its guns. No income.',
      hull: 2400, shield: 1300, regen: 18, cost: 700, build: 32,
      hardpoints: [turboAt(c, true, turbo(55, 850, 2.2, 2)), turboAt(bl, false, turbo(30, 760, 2, 2)), turboAt(br, false, turbo(30, 760, 2, 2)), shieldAt(tl, false), shieldAt(tr, false)],
      role: { role: 'Anti-warship', strong: ['frigates', 'cruisers', 'flagships'], weak: ['fighters', 'bombers'] },
    }
  return {
    ...base, id: 'r-defense', name: 'Defense Platform', blurb: 'A turbolaser for warships and flak for fighters: covers both, a little weaker than the specialists. No income.',
    hull: 2000, shield: 1200, regen: 18, cost: 650, build: 30,
    hardpoints: [turboAt(c, true, turbo(30, 720, 2, 2)), flakAt(tl, false, flak(7, 380, 0.35)), flakAt(tr, false, flak(7, 380, 0.35)), shieldAt(bl, false), shieldAt(br, false)],
  }
}

/** The Frigate Yard: a slipway with its gantry (the hardpoint that builds: shot off, work goes at
 * half speed), a shield generator at the stern and a point-defence flak turret at each bow corner. */
function frigateYard(): UnitType {
  const pd = flak(6, 380, 0.4)
  return {
    id: 'r-yard', faction: 'republic', tier: 'yard', name: 'Bastion Frigate Yard',
    blurb: 'A slipway raised by engineers within the Command Station\'s build radius: it builds frigates and corvettes, with its own queue and rally point. Two point-defence turrets and a shield generator keep raiders off it.',
    sprite: 'republic-yard', aspect: 0.62, size: 320, hull: 4600, shield: 1500, regen: 16, speed: 0, turn: 0, pop: 0, cost: 900, build: 32, level: 2, squad: 1, sensor: 1100,
    weapons: [],
    hardpoints: [
      { ...M('dock', 'dock', 5, 4.6, 0.1, 900), key: 'slip' },
      { ...M('shield', 'shield', 5, 8.35, 0.085, 800), key: 'shield' },
      { ...gun('flak', 1.55, 1.7, 0.055, 300, pd), key: 'pd1', look: 'pd' },
      { ...gun('flak', 8.45, 1.7, 0.055, 300, pd), key: 'pd2', look: 'pd' },
    ],
    engines: [],
    role: { role: 'Frigate yard', strong: ['building frigates and corvettes'], weak: ['bombers', 'cruisers', 'being left unguarded'] },
  }
}

/** The Capital Yard: a long enclosed dock for the line's heaviest ships, bigger and better armed
 * than the Frigate Yard. Its slipway gantry builds (shot off, work goes at half speed); a shield
 * generator at the stern, a turbolaser at each bow corner and point defence at the stern corners. */
function capitalYard(): UnitType {
  const pd = flak(6, 380, 0.4)
  const tl = turbo(30, 760, 2.4, 2)
  return {
    id: 'r-cyard', faction: 'republic', tier: 'yard', name: 'Citadel Capital Yard',
    blurb: 'A great enclosed dock raised by engineers within the Command Station\'s build radius, from station level 3: it builds cruisers, and flagships once its Capital slip is fitted. Its own queue and rally point; turbolasers, point defence and a shield generator guard it.',
    sprite: 'republic-cyard', aspect: 0.7, size: 430, hull: 7400, shield: 2400, regen: 22, speed: 0, turn: 0, pop: 0, cost: 2000, build: 48, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    hardpoints: [
      { ...M('dock', 'dock', 5, 4.2, 0.11, 1400), key: 'slip' },
      { ...M('shield', 'shield', 5, 8.7, 0.085, 1100), key: 'shield' },
      { ...gun('turbo', 1.7, 1.3, 0.07, 700, tl), key: 'tl1' },
      { ...gun('turbo', 8.3, 1.3, 0.07, 700, tl), key: 'tl2' },
      { ...gun('flak', 1.9, 9.1, 0.05, 320, pd), key: 'pd1', look: 'pd' },
      { ...gun('flak', 8.1, 9.1, 0.05, 320, pd), key: 'pd2', look: 'pd' },
    ],
    engines: [],
    role: { role: 'Capital yard', strong: ['building cruisers and flagships'], weak: ['bombers', 'flagships', 'being left unguarded'] },
  }
}

/** The Bastion's stages, each with the name it goes by at that level. */
const STAGES = [
  { name: 'Bastion Outpost', box: [419, 417, 834, 833] as [number, number, number, number], hull: 6000, shield: 0 },
  { name: 'Bastion Command Post', box: [278, 276, 975, 974] as [number, number, number, number], hull: 7000, shield: 2400 },
  { name: 'Bastion Command Station', box: [135, 60, 1118, 1190] as [number, number, number, number], hull: 8000, shield: 3600 },
  { name: 'Bastion Citadel', box: [44, 27, 1209, 1223] as [number, number, number, number], hull: 9000, shield: 4500 },
]

/** The Republic's ships, in the order the build menus list them at one level and price. Every
 * hardpoint is written where it sits on the ship at its size (models/sizes.ts), so the layout the
 * sizes use (`layout` below) is the hardpoints as written. */
const SHIPS: UnitType[] = [
  {
    id: 'r-fighter', faction: 'republic', tier: 'fighter', name: 'Lance interceptor', blurb: 'Clone fighters, three to a squadron. Lasers for dogfights, proton torpedoes that slip through capital shields.',
    sprite: 'republic-fighter', aspect: 0.7, size: 30, hull: 60, shield: 22, regen: 2, speed: 270, turn: 4.2, pop: 1, cost: 260, build: 10, level: 1, squad: 3, sensor: 700,
    weapons: [laser(7), torpedo(24)], hardpoints: [], engines: [[5, 9.6]],
  },
  {
    id: 'r-gunship', faction: 'republic', tier: 'gunship', name: 'Halberd gunship', blurb: 'Ball-turret flak against fighters, and two torpedo racks on the wing roots whose missiles punch through shields.',
    sprite: 'republic-gunship', aspect: 0.715, size: 64, hull: 300, shield: 120, regen: 6, speed: 175, turn: 2.6, pop: 2, cost: 400, build: 14, level: 1, squad: 1, sensor: 800,
    // Its flak is the ball turret on the nose; its missiles fly from the two torpedo racks on the
    // wing roots, fixed forward (the gunship turns to aim them), each half of the salvo.
    weapons: [flak(7, 300, 0.3)],
    hardpoints: [{ ...gun('turbo', 2.45, 5.9, 0.13, 55, LAUNCHER), look: 'torpedo' }, { ...gun('turbo', 7.55, 5.9, 0.13, 55, LAUNCHER), look: 'torpedo' }],
    engines: [[3.75, 9.7], [5, 9.8], [6.25, 9.7]],
  },
  {
    id: 'r-bomber', faction: 'republic', tier: 'fighter', kind: 'bomber', name: 'Hammer bomber', blurb: 'Armoured bombers, two to a squadron. Heavy proton bombs for capital ships and stations; easy prey for fighters.',
    sprite: 'republic-bomber', aspect: 0.715, size: 42, hull: 165, shield: 44, regen: 3, speed: 165, turn: 2.6, pop: 2, cost: 450, build: 16, level: 2, squad: 2, sensor: 650,
    weapons: [laser(5, 220, 0.6), torpedo(75, 240, 6)], hardpoints: [], engines: [[3.3, 9.6], [6.8, 9.6]],
    role: { role: 'Bomber', strong: ['cruisers', 'flagships', 'stations'], weak: ['fighters', 'gunships', 'frigates'] },
  },
  {
    id: 'r-repair', faction: 'republic', tier: 'fighter', kind: 'repair', tech: 'r-re-wing', name: 'Suture repair fighter', blurb: 'Engineer craft, two to a squadron. Barely armed, but its Field repair welds stations and warships back together in the middle of a fight.',
    sprite: 'republic-repair', aspect: 0.774, size: 32, hull: 70, shield: 25, regen: 2, speed: 240, turn: 3.6, pop: 1, cost: 280, build: 12, level: 1, squad: 2, sensor: 700,
    weapons: [laser(2, 200, 0.8)], hardpoints: [], engines: [[3.3, 8.2], [6.85, 8.2]], ability: 'fieldRepair',
    role: { role: 'Field repairs', strong: ['long fights', 'keeping flagships alive'], weak: ['fighters', 'flak', 'everything else'] },
  },
  {
    id: 'r-picket', faction: 'republic', tier: 'fighter', kind: 'wing', name: 'Aegis picket', blurb: 'The station\'s own defense wing: five light interceptors that guard it for free and come back from its hangar when lost. Fierce at home, feeble far from it.',
    sprite: 'republic-picket', aspect: 0.767, size: 22, hull: 37, shield: 11, regen: 1, speed: 285, turn: 4.8, pop: 0, cost: 0, build: 0, level: 1, squad: 5, sensor: 650,
    weapons: [laser(4, 220, 0.45)], hardpoints: [], engines: [[5, 8.5]],
    role: { role: 'Home defense', strong: ['fighters', 'bombers near the station'], weak: ['warships', 'being sent away from home'] },
  },
  {
    id: 'r-engineer', faction: 'republic', tier: 'fighter', kind: 'engineer', name: 'Mason engineer', blurb: 'Clone engineers in three boxy utility craft. Unarmed and fragile: they build the yards round the Command Station and weld structures back together.',
    sprite: 'republic-engineer', aspect: 0.82, size: 30, hull: 60, shield: 15, regen: 1.5, speed: 215, turn: 3.6, pop: 1, cost: 300, build: 14, level: 1, squad: 3, sensor: 700,
    weapons: [], hardpoints: [], engines: [[3.3, 9.3], [6.7, 9.3]],
    role: { role: 'Construction', strong: ['building yards', 'repairing structures'], weak: ['anything that shoots'] },
  },
  {
    id: 'r-corvette', faction: 'republic', tier: 'gunship', kind: 'support', name: 'Mercy corvette', blurb: 'Repair tender: its work crews patch up the hulls of nearby ships. Lightly armed; keep it behind the line.',
    sprite: 'republic-corvette', aspect: 0.653, size: 86, hull: 520, shield: 260, regen: 8, speed: 135, turn: 1.8, pop: 2, cost: 550, build: 18, level: 2, squad: 1, sensor: 900,
    weapons: [flak(5, 280, 0.4)], hardpoints: [], engines: [[3.5, 9.4], [5, 9.5], [6.6, 9.4]],
    support: { range: 520, repair: 16, max: 6 },
    role: { role: 'Repair tender', strong: ['long fights'], weak: ['fighters', 'anything that catches it alone'] },
  },
  {
    id: 'r-frigate', faction: 'republic', tier: 'frigate', name: 'Warden frigate', blurb: 'Escort bristling with point defence. Fighters melt around it.',
    sprite: 'republic-frigate', aspect: 0.671, size: 130, hull: 1020, shield: 650, regen: 14, speed: 76, turn: 1.0, pop: 3, cost: 820, build: 22, level: 2, squad: 1, sensor: 1000,
    weapons: [],
    // Six turrets in three pairs (the turbolaser battery split over the forward pair), two shield
    // bulbs amidships, sharing the one generator's strength, and three engine pods, each of which
    // can be shot off.
    hardpoints: [
      gun('turbo', 3.65, 3.6, 0.06, 150, turbo(16, 560, 2.2, 1)), gun('turbo', 6.35, 3.6, 0.06, 150, turbo(16, 560, 2.2, 1)),
      gun('flak', 3.35, 6.3, 0.05, 160, flak(6, 340, 0.3)), gun('flak', 6.65, 6.3, 0.05, 160, flak(6, 340, 0.3)),
      { ...gun('flak', 1.95, 7.9, 0.05, 160, flak(6, 340, 0.3)), look: 'pd' }, { ...gun('flak', 8.05, 7.9, 0.05, 160, flak(6, 340, 0.3)), look: 'pd' },
      M('shield', 'shield', 2.9, 4.9, 0.065, 160), M('shield', 'shield', 7.1, 4.9, 0.065, 160),
      P('engine', 3.2, 9.0, 80), P('engine', 5, 9.0, 80), P('engine', 6.8, 9.0, 80),
    ],
    engines: [[3.2, 9.7], [5, 9.75], [6.8, 9.7]],
    ability: 'flakBarrage',
  },
  // The Sentinel destroyer: the fleet's shield escort, the Republic's second frigate-tier ship (built
  // at the Frigate Yard like the Warden). Three shield projectors speed the shields of every ship of
  // ours round it while one of them stands; one turbolaser and four point-defence turrets of its own.
  {
    id: 'r-destroyer', faction: 'republic', tier: 'frigate', name: 'Sentinel destroyer', blurb: 'A shield escort. Its three projector domes feed the shields of every ship of ours round it: they recharge twice as fast. Light guns and point defence; shoot its projectors off and the fleet loses the cover.',
    sprite: 'republic-destroyer', aspect: 0.5, size: 140, hull: 960, shield: 720, regen: 15, speed: 80, turn: 1.0, pop: 3, cost: 850, build: 23, level: 2, squad: 1, sensor: 1050,
    weapons: [],
    // A turbolaser on the bow, the three projector domes (two on the flanks, the big one on the
    // spine), four point-defence turrets and two engine pods.
    hardpoints: [
      gun('turbo', 5, 2.5, 0.06, 200, turbo(15, 560, 2.2, 2)),
      { ...M('shield', 'shield', 2.95, 5.3, 0.085, 230), look: 'projector' }, { ...M('shield', 'shield', 7.05, 5.3, 0.085, 230), look: 'projector' },
      { ...M('shield', 'shield', 5, 6.65, 0.1, 300), look: 'projector' },
      { ...gun('flak', 3.75, 3.85, 0.045, 150, flak(6, 340, 0.3)), look: 'pd' }, { ...gun('flak', 6.25, 3.85, 0.045, 150, flak(6, 340, 0.3)), look: 'pd' },
      { ...gun('flak', 2.2, 7.7, 0.045, 150, flak(6, 340, 0.3)), look: 'pd' }, { ...gun('flak', 7.8, 7.7, 0.045, 150, flak(6, 340, 0.3)), look: 'pd' },
      P('engine', 3.55, 9.0, 110), P('engine', 6.45, 9.0, 110),
    ],
    engines: [[3.55, 9.7], [6.45, 9.7]],
    shieldAura: { radius: 560, regen: 1 },
    role: { role: 'Shield escort', strong: ['long fights', 'fighters', 'keeping shields up'], weak: ['ion', 'bombers', 'being caught alone'] },
  },
  {
    id: 'r-cruiser', faction: 'republic', tier: 'cruiser', name: 'Paladin cruiser', blurb: 'Line warship with heavy turbolasers. Knock out its shield bulbs first.',
    sprite: 'republic-cruiser', aspect: 0.376, size: 220, hull: 2500, shield: 1500, regen: 24, speed: 52, turn: 0.6, pop: 5, cost: 1650, build: 34, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    // Two turbolasers on the forward hull, two on the wings, flak aft on the wings, two shield
    // bulbs down the spine, and three engine pods sharing what were two engines' strength.
    hardpoints: [
      gun('turbo', 3.75, 3.5, 0.05, 300, turbo(24)), gun('turbo', 6.25, 3.5, 0.05, 300, turbo(24)), gun('turbo', 2.2, 6.0, 0.055, 300, turbo(24)), gun('turbo', 7.8, 6.0, 0.055, 300, turbo(24)),
      { ...gun('flak', 2.6, 7.75, 0.04, 200, flak(6, 320, 0.8)), look: 'pd' }, { ...gun('flak', 7.4, 7.75, 0.04, 200, flak(6, 320, 0.8)), look: 'pd' },
      M('shield', 'shield', 5, 4.85, 0.06, 460), M('shield', 'shield', 5, 6.55, 0.06, 460), P('engine', 3.3, 9.05, 280), P('engine', 5, 9.1, 280), P('engine', 6.7, 9.05, 280),
    ],
    engines: [[3.3, 9.72], [5, 9.78], [6.7, 9.72]], ability: 'shieldBoost',
  },
  {
    id: 'r-capital', faction: 'republic', tier: 'capital', name: 'Sovereign dreadnought', blurb: 'Dagger-hulled flagship. Turbolaser batteries and its own fighter wing.',
    sprite: 'republic-capital', aspect: 0.629, size: 380, hull: 5400, shield: 3600, regen: 40, speed: 34, turn: 0.33, pop: 10, cost: 4200, build: 70, level: 4, squad: 1, sensor: 1500,
    weapons: [],
    // Four heavy turbolaser batteries in two pairs down the deck, flak forward and on the aft
    // flanks, shield bulbs aft, the hangar amidships, and six engine pods sharing what was one
    // engine block's strength (appended after the hangar, so the older hardpoints keep their places).
    hardpoints: [
      { ...gun('turbo', 3.75, 3.65, 0.06, 720, turbo(58, 760)), look: 'triple' }, { ...gun('turbo', 6.25, 3.65, 0.06, 720, turbo(58, 760)), look: 'triple' }, { ...gun('turbo', 3.2, 5.65, 0.06, 720, turbo(58, 760)), look: 'triple' }, { ...gun('turbo', 6.8, 5.65, 0.06, 720, turbo(58, 760)), look: 'triple' },
      { ...gun('flak', 4.2, 2.35, 0.04, 300, flak(6, 340, 0.9)), look: 'pd' }, { ...gun('flak', 5.8, 2.35, 0.04, 300, flak(6, 340, 0.9)), look: 'pd' }, { ...gun('flak', 1.95, 7.0, 0.04, 300, flak(6, 340, 0.9)), look: 'pd' }, { ...gun('flak', 8.05, 7.0, 0.04, 300, flak(6, 340, 0.9)), look: 'pd' },
      M('shield', 'shield', 3.05, 7.75, 0.07, 820), M('shield', 'shield', 6.95, 7.75, 0.07, 820), P('engine', 4.45, 9.05, 160), M('hangar', 'hangar', 5, 4.65, 0.08, 760),
      P('engine', 2.3, 9.0, 160), P('engine', 3.38, 9.05, 160), P('engine', 5.55, 9.05, 160), P('engine', 6.62, 9.05, 160), P('engine', 7.7, 9.0, 160),
    ],
    engines: [[2.3, 9.7], [3.38, 9.76], [4.45, 9.8], [5.55, 9.8], [6.62, 9.76], [7.7, 9.7]], ability: 'broadside', carrier: { unit: 'r-fighter', every: 28, max: 2 },
  },
  // The Resolute battleship: the command carrier. Shares the flagships' tier and their limit of one
  // (built at the Capital Yard like the Sovereign); fewer and lighter guns than the Sovereign, a
  // flight deck of Lance squadrons and a command bridge whose fire control makes every gun of ours
  // round it hit harder.
  {
    id: 'r-battleship', faction: 'republic', tier: 'capital', name: 'Resolute battleship', blurb: 'A command carrier. Its flight deck keeps three Lance squadrons in the air, and its command bridge directs the guns of every warship round it: they hit 15% harder. Lighter guns than the Sovereign\'s.',
    sprite: 'republic-battleship', aspect: 0.56, size: 280, hull: 4600, shield: 2800, regen: 32, speed: 37, turn: 0.38, pop: 9, cost: 3300, build: 60, level: 4, squad: 1, sensor: 1450,
    weapons: [],
    // Two heavy turbolasers forward and two lighter ones on the aft flanks, point defence at the bow
    // and the stern corners, shield bulbs aft, the two flight bays down the deck and four engine pods.
    hardpoints: [
      { ...gun('turbo', 3.6, 3.0, 0.06, 640, turbo(50, 740)), look: 'triple' }, { ...gun('turbo', 6.4, 3.0, 0.06, 640, turbo(50, 740)), look: 'triple' },
      gun('turbo', 2.45, 6.3, 0.05, 420, turbo(30, 700)), gun('turbo', 7.55, 6.3, 0.05, 420, turbo(30, 700)),
      { ...gun('flak', 4.25, 1.75, 0.035, 280, flak(6, 340, 0.8)), look: 'pd' }, { ...gun('flak', 5.75, 1.75, 0.035, 280, flak(6, 340, 0.8)), look: 'pd' },
      { ...gun('flak', 1.75, 7.75, 0.04, 280, flak(6, 340, 0.8)), look: 'pd' }, { ...gun('flak', 8.25, 7.75, 0.04, 280, flak(6, 340, 0.8)), look: 'pd' },
      M('shield', 'shield', 3.3, 7.7, 0.06, 640), M('shield', 'shield', 6.7, 7.7, 0.06, 640),
      M('hangar', 'hangar', 5, 3.95, 0.07, 700), M('hangar', 'hangar', 5, 5.55, 0.07, 700),
      P('engine', 2.9, 9.05, 200), P('engine', 4.3, 9.1, 200), P('engine', 5.7, 9.1, 200), P('engine', 7.1, 9.05, 200),
    ],
    engines: [[2.9, 9.72], [4.3, 9.78], [5.7, 9.78], [7.1, 9.72]],
    ability: 'launchSwarm', carrier: { unit: 'r-fighter', every: 20, max: 3 },
    fireControl: { radius: 650, bonus: 0.15 },
    role: { role: 'Command carrier', strong: ['fighters', 'frigates', 'cruisers'], weak: ['bombers', 'flagships'] },
  },
]

/** The warships' hardpoints at their size: where they are written (see SHIPS). */
const LAYOUT: Record<string, Layout> = Object.fromEntries(SHIPS.filter((t) => t.hardpoints.length).map((t) => [t.id, t.hardpoints.map(({ x, y, s }) => ({ x, y, s }))]))

export const REPUBLIC: FactionData = {
  id: 'republic',
  info: {
    name: 'Republic',
    long: 'The Republic Navy',
    blurb: 'Tough, shielded warships flown by clone crews. Fewer ships, each one worth more.',
    color: '#e0453c',
    bolt: '#5fc8ff',
    glow: '#6ad0ff',
    prefix: 'r',
    work: '130,205,255',
    weld: { glow: 'rgb(110,190,255)', core: 'rgb(232,246,255)', mid: 'rgba(150,210,255,0.9)', edge: 'rgba(110,190,255,0)' },
    debris: '#d8d2c8',
    emblem: '/games/empires/world/emblem-republic.webp',
    rival: 'droid',
    sound: { turbo: 1 },
    // The shared names are the Republic's; only its heavy triple mount has a name of its own.
    names: { look: { triple: 'Heavy turbolaser' } },
  },
  ships: SHIPS,
  station: {
    id: 'r-station',
    name: 'Bastion Command Station',
    blurb: 'Your command post. It builds strike craft, gunships and engineers; the engineers raise the yards for bigger ships round it. It starts as a small core and grows with every upgrade. Lose it and the battle is lost.',
    perPx: 460 / 1196,
    regen: 22,
    stages: STAGES,
    // Every stage of the frame is centred on (626.5, 625). Level 1 sits its first modules round the
    // core, level 2 at the ends of its arms, level 3 on the battery deck to the north and the docks
    // to the south, level 4 on the outer frame (see models/republic/station.ts).
    modules: [
      sGun('t1', 'turbo', 738.5, 720, 1),
      sPart('h1', 'hangar', 'hangar', 514.5, 720, 120, 1200, { level: 1 }),
      sPart('sensor', 'sensor', 'sensor', 514.5, 530, 100, 700, { tech: 'r-st-guns' }),
      sPart('refinery', 'refinery', 'refinery', 738.5, 530, 110, 700, { tech: 'r-st-ore' }),
      sPart('s1', 'shield', 'shield', 626.5, 320, 100, 1100, { level: 2 }),
      sGun('t2', 'turbo', 346.5, 625, 2),
      sGun('f1', 'flak', 906.5, 625, 2),
      sPart('dock', 'dock', 'dock', 626.5, 915, 120, 700, { level: 2, tech: 'r-st-dock' }),
      sGun('t3', 'turbo', 552.5, 117, 3),
      sGun('t4', 'turbo', 700.5, 1083, 3),
      sPart('s2', 'shield', 'shield', 700.5, 117, 95, 1100, { level: 3 }),
      sGun('f2', 'flak', 552.5, 1083, 3),
      sGun('t5', 'turbo', 242.5, 352, 4),
      sGun('t6', 'turbo', 1010.5, 352, 4),
      sGun('t7', 'turbo', 242.5, 898, 4),
      sGun('t8', 'turbo', 1010.5, 898, 4),
      sGun('f3', 'flak', 368.5, 224, 4),
      sGun('f4', 'flak', 884.5, 224, 4),
    ],
  },
  structures: [minePlatform(), defensePlatform('balanced'), defensePlatform('flak'), defensePlatform('gun'), frigateYard(), capitalYard()],
  shieldedMine: minePlatform(true),
  // Each ship's second upgrade builds on its first. The repair docks need the station's guns: a dock
  // is only worth having where the station can cover it.
  techs: [
    tech('republic', 'r-station', 'r-st-guns', 'Turbolaser emplacements', 'A targeting array on a habitat by the Bastion\'s core: its turbolasers hit 25% harder while the array stands.', 700, 45, 1, { damage: 0.25 }),
    tech('republic', 'r-station', 'r-st-ore', 'Advanced refineries', 'A refinery on a habitat by the Bastion\'s core: mining platforms bring in 25% more credits while it stands.', 600, 40, 1, { mines: 0.25 }),
    tech('republic', 'r-station', 'r-st-dock', 'Repair docks', 'A repair dock on the Bastion\'s south docking module: our ships near it repair 2% of their hull a second while it stands.', 800, 45, 2, { repair: 0.02 }, ['r-st-guns']),
    tech('republic', 'r-fighter', 'r-fi-hull', 'Reinforced hulls', 'Lance interceptors get 25% more hull.', 400, 30, 1, { hull: 0.25 }),
    tech('republic', 'r-fighter', 'r-fi-torp', 'Proton payload', 'Lasers and torpedoes deal 25% more damage.', 500, 35, 2, { damage: 0.25 }, ['r-fi-hull']),
    tech('republic', 'r-gunship', 'r-gs-flak', 'Flak tracking', 'Halberd guns deal 20% more damage.', 450, 30, 1, { damage: 0.2 }),
    tech('republic', 'r-gunship', 'r-gs-burn', 'Afterburners', 'Halberds fly 20% faster.', 350, 25, 1, { speed: 0.2 }, ['r-gs-flak']),
    tech('republic', 'r-repair', 'r-re-wing', 'Engineer wing', 'Trains clone engineers for the hangar: unlocks the Suture repair fighter and its Field repair.', 300, 25, 1, {}),
    tech('republic', 'r-bomber', 'r-bo-payload', 'Heavy payload', 'Hammer bombs deal 25% more damage.', 550, 35, 2, { damage: 0.25 }),
    tech('republic', 'r-corvette', 'r-co-crews', 'Veteran work crews', 'Mercy corvettes repair 40% faster.', 600, 40, 2, { repair: 0.4 }),
    tech('republic', 'r-frigate', 'r-fr-shield', 'Deflector upgrade', 'Warden shields 30% stronger, recharging faster.', 600, 40, 2, { shield: 0.3, regen: 0.3 }),
    tech('republic', 'r-frigate', 'r-fr-pd', 'Point-defence computers', 'Warden guns fire 15% faster.', 650, 40, 2, { cooldown: -0.15 }, ['r-fr-shield']),
    tech('republic', 'r-cruiser', 'r-cr-cap', 'Heavy capacitors', 'Paladin turbolasers deal 20% more damage.', 900, 50, 3, { damage: 0.2 }),
    tech('republic', 'r-cruiser', 'r-cr-armour', 'Armour plating', 'Paladins get 25% more hull.', 800, 45, 3, { hull: 0.25 }, ['r-cr-cap']),
    tech('republic', 'r-capital', 'r-ca-range', 'Fleet targeting array', 'Sovereign guns reach 15% further.', 1200, 60, 4, { range: 0.15 }),
    tech('republic', 'r-capital', 'r-ca-bulbs', 'Reinforced shield bulbs', 'Sovereign shields 30% stronger, recharging faster.', 1200, 60, 4, { shield: 0.3, regen: 0.3 }, ['r-ca-range']),
    tech('republic', 'r-destroyer', 'r-de-proj', 'Projector arrays', 'Sentinel projectors pour more power into the fleet\'s shields: ships in their reach recharge 150% faster instead of 100%.', 650, 40, 2, { shieldAura: 0.5 }),
    tech('republic', 'r-destroyer', 'r-de-field', 'Wide-field emitters', 'Sentinel projectors reach 25% further, and its own shields are 20% stronger.', 600, 40, 2, { auraRadius: 0.25, shield: 0.2 }, ['r-de-proj']),
    tech('republic', 'r-battleship', 'r-bs-cmd', 'Fleet command', 'The Resolute\'s command bridge links more of the fleet: its fire control reaches 20% further and adds 5% more damage.', 1100, 55, 4, { aura: 0.05, auraRadius: 0.2 }),
    tech('republic', 'r-battleship', 'r-bs-deck', 'Flight deck crews', 'Resolutes launch Lance squadrons faster and keep one more squadron out.', 1100, 55, 4, { hangar: 1 }, ['r-bs-cmd']),
    tech('republic', 'r-cyard', 'r-yd-rush', 'Rushed construction', 'Crews trained to launch a warship before it is finished: the Capital Yard can rush out the ship it is building once it is half done (Rush launch). It comes out damaged, with turrets still in scaffolding, and needs repair crews to be finished. Needs a Citadel Capital Yard.', 800, 45, 3, {}),
  ],
  rushTech: 'r-yd-rush',
  mineFlak: MINE_FLAK,
  // On the Frigate Yard two module sockets on the flanks and one at the stern; on the Capital Yard
  // one on each flank (the stern one stays free for now).
  yardSockets: [[1.0, 6.1], [9.0, 6.1], [5, 9.45]],
  cyardSockets: [[1.15, 5.7], [8.85, 5.7], [5, 9.45]],
  berths: {
    'r-yard': { hw: 15.5, y0: -47, y1: 27 },
    'r-cyard': { hw: 18, y0: -48, y1: 32 },
  },
  // Gantry cranes span the berths.
  gantries: {
    'r-yard': [-22, -4, 16],
    'r-cyard': [-27, -8, 11, 25],
  },
  layout: LAYOUT,
  // The Bastion defense station (Galactic conquest): a command hub that grows gun decks on truss arms.
  orbital: {
    name: 'Bastion defense station',
    blurb: 'An armoured defense station in orbit beside the Command Station, built from the Bastion\'s standard modules. Each level adds module slots, and each slot takes the module we pick for it.',
    regen: 20,
    stages: [
      { name: 'Bastion Watchpost', hull: 2600, shield: 0, cost: 700, time: 40, station: 1 },
      { name: 'Bastion Battle Station', hull: 4200, shield: 0, cost: 900, time: 50, station: 2 },
      { name: 'Bastion Redoubt', hull: 6200, shield: 0, cost: 1300, time: 65, station: 3 },
    ],
    modules: [
      { id: 'battery', name: 'Turbolaser battery', blurb: 'A heavy twin turbolaser that outranges warships.', cost: 450, time: 22, kind: 'turret', art: 'turbo', hp: 700, r: 10, weapon: turbo(40, 820, 2.2, 2) },
      { id: 'flak', name: 'Flak battery', blurb: 'Quick-firing flak that shreds fighters and bombers.', cost: 350, time: 16, kind: 'turret', art: 'flak', hp: 450, r: 8, weapon: flak(8, 420, 0.3) },
      { id: 'launcher', name: 'Torpedo launcher', blurb: 'Proton torpedoes that slip through shields to hit the hull.', cost: 450, time: 22, kind: 'turret', art: 'turbo', look: 'torpedo', hp: 550, r: 9, weapon: missile(30, 700, 4) },
      { id: 'shield', name: 'Shield generator', blurb: 'Projects 1,400 shields round the station, recharging between hits. Shot off, its shields go.', cost: 400, time: 18, kind: 'shield', art: 'shield', hp: 650, r: 9, shield: 1400, regen: 12 },
      { id: 'hangar', name: 'Hangar bay', blurb: 'Keeps a squadron of Lance interceptors in the air round the station, launching a new one when it is lost.', cost: 550, time: 24, kind: 'hangar', art: 'hangar', hp: 700, r: 10, carrier: 'r-fighter' },
    ],
  },
}
