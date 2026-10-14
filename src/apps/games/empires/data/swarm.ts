// The Swarm: a bio-mechanical hive that grows its ships rather than building them. Its ships,
// structures, Command Station (the Hive), research and yards, as written (data.ts toughens, scales
// and sizes them). The Swarm's own file: the rest of the game reads it through data.ts. Points on a
// ship are on the 0-10 grid over its box, x from the left and y from the nose (see data.ts).
//
// A PLACEHOLDER for now: every unit is a copy of the Confederacy's in the same slot (its numbers,
// hardpoints and abilities), under its Swarm name, drawn with the Swarm concept designs (models/
// swarm/) where there is one. Its own mechanics (no shields, living hulls that grow back, the
// Leech's drain, the Leviathan's and the Hive's broods: UnitType regrow and drain, StationPlan
// carrier and regrow) are all off until it is designed and balanced. Players only see it with the
// Swarm preview on (see factions.ts).

import { M, P, flak, gun, ion, laser, sGun, sPart, tech, torpedo, turbo, type DefenseKind, type Deck, type FactionData, type Tech, type UnitType, type Weapon } from './kit.ts'

const DECK: Deck = { centre: [5, 5.1], corners: [[2.6, 3], [7.4, 3], [2.6, 7.3], [7.4, 7.3]], sides: [[0.9, 5], [9.1, 5]], wells: [[1.8, 5], [8.2, 5]], core: [5, 5], pd: [5, 7.9], pad: [5, 1.6] }

/** The ore harvester's point defence: one small flak turret (for now the Confederacy's). */
/** A research's picture: the Confederacy's for the same slot, until the Swarm has its own. */
const droidIcon = (t: Tech): Tech => ({ ...t, icon: t.id.replace(/^s-co-/, 'd-io-').replace(/^s-/, 'd-') })

const MINE_FLAK: Weapon = flak(1.87, 320, 0.4)

/** The ore harvester: two drill rigs and an ore silo, and a small point-defence turret. Each drill
 * earns 40% of the platform's income and the silo 20%; shot-off parts earn nothing until repaired.
 * It comes without shields: the Shield generator upgrade fits a dome on the landing pad. */
function minePlatform(shielded = false): UnitType {
  const d = DECK
  return {
    id: 's-mine', faction: 'swarm', tier: 'mine', name: 'Ore harvester',
    blurb: 'Drills an ore asteroid for credits: two drill rigs and an ore silo, each worth part of the income while it works, and a small flak turret that can hold off a fighter squadron.',
    sprite: 'mine-swarm', aspect: 1.092, size: 120, hull: 1000, shield: shielded ? 600 : 0, regen: shielded ? 10 : 0, speed: 0, turn: 0, pop: 0, cost: 500, build: 24, level: 1, squad: 1, sensor: 600,
    weapons: [],
    hardpoints: [
      { ...M('drill', 'drill', d.wells[0][0], d.wells[0][1], 0.3, 400), key: 'drill1' },
      { ...M('drill', 'drill', d.wells[1][0], d.wells[1][1], 0.3, 400), key: 'drill2' },
      { ...M('refinery', 'refinery', d.core[0], d.core[1], 0.1, 300), key: 'silo' },
      { ...gun('flak', d.pd[0], d.pd[1], 0.11, 250, MINE_FLAK), key: 'pd' },
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
    faction: 'swarm' as const, tier: 'defense' as const, sprite: 'defense-swarm', aspect: 1.01, size: 130, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 1000, weapons: [], engines: [] as [number, number][],
  }
  const turboAt = (p: [number, number], big: boolean, w: Weapon) => gun('turbo', p[0], p[1], big ? 0.33 : 0.17, big ? 650 : 450, w)
  const flakAt = (p: [number, number], small: boolean, w: Weapon) => gun('flak', p[0], p[1], small ? 0.09 : 0.125, small ? 220 : 300, w)
  const shieldAt = (p: [number, number], big: boolean) => M('shield', 'shield', p[0], p[1], big ? 0.2 : 0.125, big ? 700 : 450)
  if (kind === 'flak')
    return {
      ...base, id: 's-defense-flak', name: 'Spine node', blurb: 'Six point-defence turrets that shred fighters and bombers. Barely scratches a warship. No income.',
      hull: 2000, shield: 800, regen: 12, cost: 650, build: 30,
      hardpoints: [shieldAt(c, true), ...[tl, tr, bl, br].map((p) => flakAt(p, false, flak(7, 420, 0.3))), ...d.sides.map((p) => flakAt(p, true, flak(6, 400, 0.35)))],
      role: { role: 'Anti-fighter', strong: ['fighters', 'bombers', 'gunships'], weak: ['frigates', 'cruisers', 'flagships'] },
    }
  if (kind === 'gun')
    return {
      ...base, id: 's-defense-gun', name: 'Lance node', blurb: 'A heavy turbolaser and two lighter ones that outrange warships. Fighters slip under its guns. No income.',
      hull: 2700, shield: 1000, regen: 14, cost: 700, build: 32,
      hardpoints: [turboAt(c, true, turbo(55, 850, 2.2, 2)), turboAt(bl, false, turbo(30, 760, 2, 2)), turboAt(br, false, turbo(30, 760, 2, 2)), shieldAt(tl, false), shieldAt(tr, false)],
      role: { role: 'Anti-warship', strong: ['frigates', 'cruisers', 'flagships'], weak: ['fighters', 'bombers'] },
    }
  return {
    ...base, id: 's-defense', name: 'Spore node', blurb: 'A turbolaser for warships and flak for fighters: covers both, a little weaker than the specialists. No income.',
    hull: 2300, shield: 900, regen: 14, cost: 650, build: 30,
    hardpoints: [turboAt(c, true, turbo(30, 720, 2, 2)), flakAt(tl, false, flak(7, 380, 0.35)), flakAt(tr, false, flak(7, 380, 0.35)), shieldAt(bl, false), shieldAt(br, false)],
  }
}

/** The Frigate Yard: a slipway with its gantry (the hardpoint that builds: shot off, work goes at
 * half speed), a shield generator at the stern and a point-defence flak turret at each bow corner. */
function frigateYard(): UnitType {
  const pd = flak(6, 380, 0.4)
  return {
    id: 's-yard', faction: 'swarm', tier: 'yard', name: 'Brood pool',
    blurb: 'A spawning pool grown by shapers within the Hive\'s build radius: it grows the frigates and corvettes, with its own queue and rally point. Two point-defence nodes and a shield generator keep raiders off it.',
    sprite: 'swarm-yard', aspect: 0.66, size: 320, hull: 5200, shield: 1100, regen: 12, speed: 0, turn: 0, pop: 0, cost: 900, build: 32, level: 2, squad: 1, sensor: 1100,
    weapons: [],
    hardpoints: [
      { ...M('dock', 'dock', 5, 4.8, 0.1, 1000), key: 'slip' },
      { ...M('shield', 'shield', 5, 8.6, 0.085, 750), key: 'shield' },
      { ...gun('flak', 1.7, 1.6, 0.055, 320, pd), key: 'pd1' },
      { ...gun('flak', 8.3, 1.6, 0.055, 320, pd), key: 'pd2' },
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
    id: 's-cyard', faction: 'swarm', tier: 'yard', name: 'Great brood pool',
    blurb: 'A vast spawning pool grown within the Hive\'s build radius, from station level 3: it grows cruisers, and dreadnoughts once its Capital slip is fitted. Its own queue and rally point; spore cannons, point defence and a shield generator guard it.',
    sprite: 'swarm-cyard', aspect: 0.74, size: 430, hull: 8200, shield: 1800, regen: 17, speed: 0, turn: 0, pop: 0, cost: 2000, build: 48, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    hardpoints: [
      { ...M('dock', 'dock', 5, 4.4, 0.11, 1500), key: 'slip' },
      { ...M('shield', 'shield', 5, 8.75, 0.085, 1000), key: 'shield' },
      { ...gun('turbo', 1.75, 1.35, 0.07, 760, tl), key: 'tl1' },
      { ...gun('turbo', 8.25, 1.35, 0.07, 760, tl), key: 'tl2' },
      { ...gun('flak', 1.9, 9.1, 0.05, 340, pd), key: 'pd1' },
      { ...gun('flak', 8.1, 9.1, 0.05, 340, pd), key: 'pd2' },
    ],
    engines: [],
    role: { role: 'Capital yard', strong: ['building cruisers and flagships'], weak: ['bombers', 'flagships', 'being left unguarded'] },
  }
}

export const SWARM: FactionData = {
  id: 'swarm',
  info: {
    name: 'Swarm',
    long: 'The Swarm',
    blurb: 'A living fleet grown, not built: cheap, fast hulls that heal themselves, and broods that never stop hatching.',
    color: '#6fd84a',
    bolt: '#a8ff5a',
    glow: '#c890ff',
    prefix: 's',
    work: '170,255,140',
    weld: { glow: 'rgb(140,255,90)', core: 'rgb(236,255,224)', mid: 'rgba(180,255,140,0.9)', edge: 'rgba(140,255,90,0)' },
    debris: '#c8b48c',
    // There is no Swarm emblem yet (emblem-swarm.webp): the Confederacy's stands in for it.
    emblem: '/games/empires/world/emblem-droid.webp',
    rival: 'republic',
    sound: { voice: 'droid', blaster: 'droid', turbo: 0.85 },
    preview: true,
  },
  ships: [
    {
      id: 's-fighter', faction: 'swarm', tier: 'fighter', name: 'Broodling', blurb: 'Five fast, disposable strike craft to a brood. Fragile, relentless, and their barbs add up against big ships.',
      sprite: 'swarm-fighter', aspect: 0.963, size: 28, hull: 38, shield: 0, regen: 0, speed: 255, turn: 4.4, pop: 1, cost: 230, build: 9, level: 1, squad: 5, sensor: 650,
      weapons: [laser(5, 230, 0.45), torpedo(16, 260)], hardpoints: [], engines: [[5, 8.4]],
    },
    {
      id: 's-gunship', faction: 'swarm', tier: 'gunship', name: 'Stinger interceptor', blurb: 'A quick hunter whose spine guns tear through strike craft.',
      sprite: 'swarm-gunship', aspect: 1.067, size: 64, hull: 395, shield: 80, regen: 5, speed: 165, turn: 2.6, pop: 2, cost: 400, build: 13, level: 1, squad: 1, sensor: 780,
      weapons: [flak(6, 290, 0.28), laser(12, 320, 1)], hardpoints: [], engines: [[5, 6.6]],
    },
    {
      id: 's-bomber', faction: 'swarm', tier: 'fighter', kind: 'bomber', name: 'Borer bomber', blurb: 'Armoured borers, three to a brood. Cheap, fragile, and their acid sacs eat through big hulls.',
      sprite: 'swarm-bomber', aspect: 0.96, size: 36, hull: 85, shield: 0, regen: 0, speed: 185, turn: 3, pop: 2, cost: 400, build: 13, level: 2, squad: 3, sensor: 620,
      weapons: [laser(4, 220, 0.6), torpedo(48, 230, 6)], hardpoints: [], engines: [[5, 8.6]],
      role: { role: 'Bomber', strong: ['cruisers', 'flagships', 'stations'], weak: ['fighters', 'gunships', 'frigates'] },
    },
    {
      id: 's-repair', faction: 'swarm', tier: 'fighter', kind: 'repair', tech: 's-re-wing', name: 'Mender drone', blurb: 'Healer drones, two to a brood. Next to harmless, but their Field repair knits the Hive and warships back together under fire.',
      sprite: 'swarm-repair', aspect: 0.779, size: 30, hull: 85, shield: 0, regen: 0, speed: 245, turn: 3.8, pop: 1, cost: 260, build: 11, level: 1, squad: 2, sensor: 650,
      weapons: [laser(2, 200, 0.8)], hardpoints: [], engines: [[5, 9.1]], ability: 'fieldRepair',
      role: { role: 'Field repairs', strong: ['long fights', 'keeping flagships alive'], weak: ['fighters', 'flak', 'everything else'] },
    },
    {
      id: 's-picket', faction: 'swarm', tier: 'fighter', kind: 'wing', name: 'Hive guard', blurb: 'The Hive\'s own defense wing: six tiny guards that defend it for free and hatch again when lost. Vicious at home, feeble far from it.',
      sprite: 'swarm-picket', aspect: 0.989, size: 20, hull: 26, shield: 0, regen: 0, speed: 275, turn: 5, pop: 0, cost: 0, build: 0, level: 1, squad: 6, sensor: 620,
      weapons: [laser(3.5, 210, 0.42)], hardpoints: [], engines: [[5, 8]],
      role: { role: 'Home defense', strong: ['fighters', 'bombers near the station'], weak: ['warships', 'being sent away from home'] },
    },
    {
      id: 's-engineer', faction: 'swarm', tier: 'fighter', kind: 'engineer', name: 'Shaper drone', blurb: 'Three shaper drones. Unarmed and fragile: they grow the brood pools round the Hive and knit structures back together.',
      sprite: 'swarm-engineer', aspect: 0.86, size: 30, hull: 72, shield: 0, regen: 0, speed: 210, turn: 3.6, pop: 1, cost: 300, build: 14, level: 1, squad: 3, sensor: 650,
      weapons: [], hardpoints: [], engines: [[5, 9.2]],
      role: { role: 'Construction', strong: ['building yards', 'repairing structures'], weak: ['anything that shoots'] },
    },
    {
      id: 's-corvette', faction: 'swarm', tier: 'frigate', kind: 'ion', name: 'Leech corvette', blurb: 'A skirmisher with tendril weapons that latches onto enemy hulls.',
      sprite: 'swarm-corvette', aspect: 0.227, size: 140, hull: 900, shield: 380, regen: 9, speed: 70, turn: 0.95, pop: 3, cost: 780, build: 22, level: 2, squad: 1, sensor: 1000,
      weapons: [],
      hardpoints: [gun('ion', 5, 2.4, 0.165, 320, ion(70)), M('shield', 'shield', 5, 4.2, 0.105, 280), gun('flak', 5, 6.0, 0.09, 160, flak(5, 300, 0.4))],
      engines: [[2.35, 9.33], [7.5, 9.33]],
      role: { role: 'Shield breaker', strong: ['shielded warships', 'stations'], weak: ['fighters', 'unshielded ships'] },
    },
    {
      id: 's-frigate', faction: 'swarm', tier: 'frigate', name: 'Aberration frigate', blurb: 'A multi-role frigate studded with weapon nodes.',
      sprite: 'swarm-frigate', aspect: 0.422, size: 135, hull: 1150, shield: 450, regen: 10, speed: 72, turn: 1.0, pop: 3, cost: 760, build: 21, level: 2, squad: 1, sensor: 950,
      weapons: [],
      hardpoints: [
        gun('turbo', 3.8, 1.3, 0.09, 260, turbo(20, 520, 1.4, 1)), gun('turbo', 6.2, 1.3, 0.09, 260, turbo(20, 520, 1.4, 1)), M('shield', 'shield', 5, 2.65, 0.09, 300),
        gun('flak', 3.04, 6.73, 0.075, 160, flak(6, 320, 0.33)), gun('flak', 6.96, 6.73, 0.075, 160, flak(6, 320, 0.33)),
      ],
      engines: [[2.84, 9.39], [4.95, 9.6], [7.0, 9.39]],
      ability: 'repairSwarm',
    },
    {
      id: 's-cruiser', faction: 'swarm', tier: 'cruiser', name: 'Matriarch cruiser', blurb: 'Heavy firepower on a regenerating hull, and tendrils that pin ships in place.',
      sprite: 'swarm-cruiser', aspect: 1.508, size: 260, hull: 2700, shield: 1100, regen: 18, speed: 49, turn: 0.55, pop: 5, cost: 1550, build: 33, level: 3, squad: 1, sensor: 1200,
      weapons: [],
      hardpoints: [
        gun('turbo', 0.83, 6.45, 0.09, 560, turbo(40)), gun('turbo', 9.17, 6.45, 0.09, 560, turbo(40)), gun('flak', 2.33, 3.94, 0.075, 220, turbo(12, 480, 1.2, 1)), gun('flak', 7.67, 3.94, 0.075, 220, turbo(12, 480, 1.2, 1)),
        M('shield', 'shield', 1.58, 5.03, 0.083, 440), M('shield', 'shield', 8.42, 5.03, 0.083, 440), P('engine', 4.47, 9.3, 420), P('engine', 5.52, 9.3, 420),
      ],
      engines: [[4.47, 9.55], [5.52, 9.55]], ability: 'tractor',
    },
    {
      id: 's-capital', faction: 'swarm', tier: 'capital', name: 'Leviathan dreadnought', blurb: 'A living command vessel. Its brood sacs never stop spawning strike craft.',
      sprite: 'swarm-capital', aspect: 0.742, size: 380, hull: 6200, shield: 2800, regen: 32, speed: 31, turn: 0.32, pop: 10, cost: 4000, build: 68, level: 4, squad: 1, sensor: 1500,
      weapons: [],
      hardpoints: [
        gun('turbo', 4.12, 5.17, 0.09, 680, turbo(52, 720)), gun('turbo', 5.88, 5.17, 0.09, 680, turbo(52, 720)), gun('turbo', 4.12, 6.72, 0.09, 680, turbo(52, 720)), gun('turbo', 5.88, 6.72, 0.09, 680, turbo(52, 720)),
        gun('flak', 2.72, 1.31, 0.068, 280, flak(6, 340, 0.9)), gun('flak', 7.28, 1.31, 0.068, 280, flak(6, 340, 0.9)), gun('flak', 1.25, 3.33, 0.068, 280, flak(6, 340, 0.9)), gun('flak', 8.75, 3.33, 0.068, 280, flak(6, 340, 0.9)),
        M('shield', 'shield', 3.97, 4.33, 0.098, 760), M('shield', 'shield', 6.03, 4.33, 0.098, 760), P('engine', 5, 9.1, 950), M('hangar', 'hangar', 3.0, 2.9, 0.135, 720), M('hangar', 'hangar', 7.0, 2.9, 0.135, 720),
      ],
      engines: [[3.67, 9.44], [4.52, 9.72], [5.43, 9.72], [6.31, 9.44]], ability: 'launchSwarm', carrier: { unit: 's-fighter', every: 20, max: 3 },
    },
  ],
  station: {
    id: 's-station',
    name: 'Hive',
    blurb: 'The heart of the Swarm. It spawns strike craft, interceptors and shaper drones; the shapers grow the brood pools for bigger ships round it. It starts as a small spawn and grows with every upgrade. Lose it and the battle is lost.',
    perPx: 460 / 1148,
    regen: 20,
    stages: [
      { box: [410, 308, 846, 876], hull: 6400, shield: 0 },
      { box: [209, 111, 1047, 1073], hull: 7500, shield: 2100 },
      { box: [104, 15, 1152, 1169], hull: 8600, shield: 3200 },
      { box: [88, 18, 1168, 1166], hull: 9600, shield: 4000 },
    ],
    modules: [
      sGun('t1', 'turbo', 764, 701, 1),
      sPart('h1', 'hangar', 'hangar', 483, 701, 120, 1200, { level: 1 }),
      sPart('sensor', 'sensor', 'sensor', 628, 457, 100, 700, { tech: 's-st-guns' }),
      sPart('refinery', 'refinery', 'refinery', 628, 781, 110, 700, { tech: 's-st-ore' }),
      sPart('s1', 'shield', 'shield', 628, 592, 110, 1100, { level: 2 }),
      sGun('t2', 'turbo', 477, 558, 2),
      sGun('f1', 'flak', 769, 558, 2),
      sPart('dock', 'dock', 'dock', 628, 872, 120, 700, { level: 2, tech: 's-st-dock' }),
      sGun('t3', 'turbo', 155, 370, 3),
      sGun('t4', 'turbo', 1100, 370, 3),
      sPart('s2', 'shield', 'shield', 628, 1055, 95, 1100, { level: 3 }),
      sGun('f2', 'flak', 628, 135, 3),
      sGun('t5', 'turbo', 148, 825, 4),
      sGun('t6', 'turbo', 1110, 825, 4),
      sGun('t7', 'turbo', 398, 993, 4),
      sGun('t8', 'turbo', 855, 993, 4),
      sGun('f3', 'flak', 400, 240, 4),
      sGun('f4', 'flak', 852, 240, 4),
    ],
  },
  structures: [minePlatform(), defensePlatform('balanced'), defensePlatform('flak'), defensePlatform('gun'), frigateYard(), capitalYard()],
  shieldedMine: minePlatform(true),
  // The Confederacy's research tree for now, renamed; its pictures are the Confederacy's (`icon`)
  // until the Swarm has its own. Each ship's second upgrade builds on its first.
  techs: [
    tech('swarm', 's-station', 's-st-guns', 'Spore batteries', 'A sensor cluster on the Hive: its cannons hit 25% harder while it stands.', 700, 45, 1, { damage: 0.25 }),
    tech('swarm', 's-station', 's-st-ore', 'Ore digestion', 'A digestion sac on the Hive: harvesters bring in 25% more credits while it stands.', 600, 40, 1, { mines: 0.25 }),
    tech('swarm', 's-station', 's-st-dock', 'Mending pools', 'A mending pool on the Hive: our ships near it heal 2% of their hull a second while it stands.', 800, 45, 2, { repair: 0.02 }, ['s-st-guns']),
    tech('swarm', 's-fighter', 's-fi-line', 'Brood cycles', 'Broodlings grow 30% faster.', 400, 30, 1, { build: -0.3 }),
    tech('swarm', 's-fighter', 's-fi-guns', 'Barbed spines', 'Broodling barbs deal 25% more damage.', 450, 35, 2, { damage: 0.25 }, ['s-fi-line']),
    tech('swarm', 's-gunship', 's-gs-shell', 'Thick carapace', 'Stingers get 25% more hull.', 450, 30, 1, { hull: 0.25 }),
    tech('swarm', 's-gunship', 's-gs-cycle', 'Twitch muscles', 'Stinger guns fire 15% faster.', 450, 30, 1, { cooldown: -0.15 }, ['s-gs-shell']),
    tech('swarm', 's-repair', 's-re-wing', 'Mender strain', 'Breeds healers in the Hive: unlocks the Mender drone and its Field repair.', 300, 25, 1, {}),
    tech('swarm', 's-bomber', 's-bo-pods', 'Caustic sacs', 'Borer acid deals 25% more damage.', 500, 35, 2, { damage: 0.25 }),
    tech('swarm', 's-corvette', 's-co-coils', 'Tendril reflexes', 'Leech weapons fire 20% faster.', 700, 40, 2, { cooldown: -0.2 }),
    tech('swarm', 's-frigate', 's-fr-plate', 'Chitin plating', 'Aberrations get 25% more hull.', 600, 40, 2, { hull: 0.25 }),
    tech('swarm', 's-frigate', 's-fr-prong', 'Node growth', 'Aberration nodes deal 20% more damage.', 650, 40, 2, { damage: 0.2 }, ['s-fr-plate']),
    tech('swarm', 's-cruiser', 's-cr-ray', 'Membrane layers', 'Matriarch shields 30% stronger, recharging faster.', 800, 45, 3, { shield: 0.3, regen: 0.3 }),
    tech('swarm', 's-cruiser', 's-cr-thrust', 'Engine sacs', 'Matriarchs fly 20% faster.', 700, 40, 3, { speed: 0.2 }, ['s-cr-ray']),
    tech('swarm', 's-capital', 's-ca-hangar', 'Brood chambers', 'Leviathans spawn faster and keep one more brood out.', 1200, 60, 4, { hangar: 1 }),
    tech('swarm', 's-capital', 's-ca-armour', 'Ancient carapace', 'Leviathans get 25% more hull.', 1200, 60, 4, { hull: 0.25 }, ['s-ca-hangar']),
    tech('swarm', 's-cyard', 's-yd-rush', 'Premature birth', 'Warships are pushed out of the pool before they are grown: the Great brood pool can rush out the warship it is growing once it is half done (Rush launch). It comes out wounded, with nodes still unformed, and needs menders or shapers to be finished. Needs a Great brood pool.', 800, 45, 3, {}),
  ].map(droidIcon),
  rushTech: 's-yd-rush',
  mineFlak: MINE_FLAK,
  // On the Frigate Yard two module sockets on the flanks and one at the stern; on the Capital Yard
  // one on each flank (the stern one stays free for now).
  yardSockets: [[0.95, 6.3], [9.05, 6.3], [5, 9.5]],
  cyardSockets: [[1.15, 5.5], [8.85, 5.5], [5, 9.45]],
  berths: {
    's-yard': { hw: 16, y0: -46, y1: 27 },
    's-cyard': { hw: 18, y0: -47, y1: 33 },
  },
  // Where the shapers work over the berths (the Confederacy's ring frames, for now).
  gantries: {
    's-yard': [-25, -2, 22],
    's-cyard': [-24, -6, 15, 28.4],
  },
  layout: {
    // The Confederacy's layouts, for the same hulls: the Leech's as the Disruptor frigate's.
    's-corvette': [
      { x: 5, y: 2.3, s: 0.13 },
      { x: 5, y: 4.6, s: 0.075 },
      { x: 5, y: 6.8, s: 0.06 },
    ],
    's-frigate': [
      { x: 3.1, y: 1.4, s: 0.06 },
      { x: 6.9, y: 1.4, s: 0.06 },
      { x: 5, y: 3.8, s: 0.065 },
      { x: 2.49, y: 6.73, s: 0.05 },
      { x: 7.51, y: 6.73, s: 0.05 },
    ],
    's-cruiser': [
      { x: 0.9, y: 6.06, s: 0.055 },
      { x: 9.1, y: 6.06, s: 0.055 },
      { x: 3.4, y: 4.25, s: 0.045 },
      { x: 6.6, y: 4.25, s: 0.045 },
      { x: 2.15, y: 5.0, s: 0.05 },
      { x: 7.85, y: 5.0, s: 0.05 },
      { x: 4.47, y: 9.3 },
      { x: 5.52, y: 9.3 },
    ],
    's-capital': [
      { x: 4.08, y: 5.85, s: 0.05 },
      { x: 5.92, y: 5.85, s: 0.05 },
      { x: 1.27, y: 5.6, s: 0.05 },
      { x: 8.73, y: 5.6, s: 0.05 },
      { x: 2.72, y: 1.31, s: 0.04 },
      { x: 7.28, y: 1.31, s: 0.04 },
      { x: 1.25, y: 3.33, s: 0.04 },
      { x: 8.75, y: 3.33, s: 0.04 },
      { x: 4.19, y: 4.7, s: 0.06 },
      { x: 5.81, y: 4.7, s: 0.06 },
      { x: 5, y: 9.1 },
      { x: 2.64, y: 2.55, s: 0.075 },
      { x: 7.36, y: 2.55, s: 0.075 },
    ],
  },
}
