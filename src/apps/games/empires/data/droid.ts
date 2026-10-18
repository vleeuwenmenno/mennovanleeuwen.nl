// The Confederacy (its id stays `droid`, and its units' `d-`, so saves and multiplayer keep working):
// its ships, structures, Command Hub, research and yards, as written (data.ts toughens, scales and
// sizes them). The Confederacy's own file: the rest of the game reads it through data.ts. Points on a
// ship are on the 0-10 grid over its box, x from the left and y from the nose (see data.ts).
//
// A coalition of breakaway systems, private yards and corporate powers, and its doctrine is
// offensive pressure and concentrated fire: heavy guns that hit hard and early, missiles and an ion
// lance that get past shields, fast strike craft for flanking. What it gives up for that is staying
// power: thinner shields than the Republic's, weaker repair crews, and ships that fare badly caught
// alone.

import { M, P, flak, gun, ion, laser, missile, sGun, sPart, spinal, tech, torpedo, turbo, type DefenseKind, type Deck, type FactionData, type UnitType, type Weapon, groundCenter, groundEngineer, groundSupply, groundGenerator, groundResearch, groundFactory, groundScout, groundWeapon, groundFast, groundSquad, groundMedium, groundHeavy } from './kit.ts'

const DECK: Deck = { centre: [5, 5.1], corners: [[2.6, 3], [7.4, 3], [2.6, 7.3], [7.4, 7.3]], sides: [[0.9, 5], [9.1, 5]], wells: [[1.8, 5], [8.2, 5]], core: [5, 5], pd: [5, 7.9], pad: [5, 1.6] }

/**
 * The Extraction Rig's point defence: one small flak turret, enough that one squadron of the other
 * side's fighters attacking it has about an even chance; nothing a warship would notice. Tuned per
 * faction in headless duels, because squadrons take flak very differently.
 */
const MINE_FLAK: Weapon = flak(1.6, 320, 0.4)

/** A missile turret's battery: missiles that slip most of their punch past shields, from a turret
 * that turns (a fighter's missiles fire only ahead, a turret's anywhere). */
const cells = (damage: number, range = 500, cooldown = 3.2): Weapon => ({ ...missile(damage, range, cooldown), arc: undefined })

/** The Extraction Rig: two drill rigs and an ore silo, and a small point-defence turret. Each drill
 * earns 40% of the platform's income and the silo 20%; shot-off parts earn nothing until repaired.
 * It comes without shields: the Shield generator upgrade fits a dome on the landing pad. */
function minePlatform(shielded = false): UnitType {
  const d = DECK
  return {
    id: 'd-mine', faction: 'droid', tier: 'mine', name: 'Extraction Rig',
    blurb: 'Strip-mines an ore asteroid for credits: two drill rigs and an ore silo, each worth part of the income while it works, and a small flak turret that can hold off a fighter squadron.',
    sprite: 'mine-droid', aspect: 1.092, size: 120, hull: 1000, shield: shielded ? 550 : 0, regen: shielded ? 9 : 0, speed: 0, turn: 0, pop: 0, cost: 500, build: 24, level: 1, squad: 1, sensor: 600,
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

/** The three defense platforms (see DefenseKind): a little harder-hitting than the Republic's, on
 * thinner shields. */
function defensePlatform(kind: DefenseKind): UnitType {
  const d = DECK
  const [c, tl, tr, bl, br] = [d.centre, ...d.corners]
  const base = {
    faction: 'droid' as const, tier: 'defense' as const, sprite: 'defense-droid', aspect: 1.01, size: 130, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 1000, weapons: [], engines: [] as [number, number][],
  }
  const turboAt = (p: [number, number], big: boolean, w: Weapon) => gun('turbo', p[0], p[1], big ? 0.33 : 0.17, big ? 650 : 450, w)
  const flakAt = (p: [number, number], small: boolean, w: Weapon) => gun('flak', p[0], p[1], small ? 0.09 : 0.125, small ? 220 : 300, w)
  const shieldAt = (p: [number, number], big: boolean) => M('shield', 'shield', p[0], p[1], big ? 0.2 : 0.125, big ? 700 : 450)
  if (kind === 'flak')
    return {
      ...base, id: 'd-defense-flak', name: 'Shredder Battery', blurb: 'Six flak turrets that shred fighters and bombers. Barely scratches a warship. No income.',
      hull: 2000, shield: 700, regen: 10, cost: 650, build: 30,
      hardpoints: [shieldAt(c, true), ...[tl, tr, bl, br].map((p) => flakAt(p, false, flak(7.5, 420, 0.3))), ...d.sides.map((p) => flakAt(p, true, flak(6.5, 400, 0.35)))],
      role: { role: 'Anti-fighter', strong: ['fighters', 'bombers', 'gunships'], weak: ['frigates', 'cruisers', 'flagships'] },
    }
  if (kind === 'gun')
    return {
      ...base, id: 'd-defense-gun', name: 'Siege Battery', blurb: 'A heavy triple battery and two lighter ones that outrange warships. Fighters slip under its guns. No income.',
      hull: 2700, shield: 850, regen: 12, cost: 700, build: 32,
      hardpoints: [{ ...turboAt(c, true, turbo(60, 850, 2.2, 2)), look: 'triple' }, turboAt(bl, false, turbo(33, 760, 2, 2)), turboAt(br, false, turbo(33, 760, 2, 2)), shieldAt(tl, false), shieldAt(tr, false)],
      role: { role: 'Anti-warship', strong: ['frigates', 'cruisers', 'flagships'], weak: ['fighters', 'bombers'] },
    }
  return {
    ...base, id: 'd-defense', name: 'Bulwark Platform', blurb: 'A heavy battery for warships and flak for fighters: covers both, a little weaker than the specialists. No income.',
    hull: 2300, shield: 800, regen: 12, cost: 650, build: 30,
    hardpoints: [turboAt(c, true, turbo(33, 720, 2, 2)), flakAt(tl, false, flak(7.5, 380, 0.35)), flakAt(tr, false, flak(7.5, 380, 0.35)), shieldAt(bl, false), shieldAt(br, false)],
  }
}

/** The Forge Shipyard: a slipway with its gantry (the hardpoint that builds: shot off, work goes at
 * half speed), a shield generator at the stern and a point-defence flak turret at each bow corner. */
function frigateYard(): UnitType {
  const pd = flak(6, 380, 0.4)
  return {
    id: 'd-yard', faction: 'droid', tier: 'yard', name: 'Forge Shipyard',
    blurb: 'A private-yard slipway raised by Forger engineers within the Command Hub\'s build radius: it builds the frigates, destroyers and corvettes, with its own queue and rally point. Two flak turrets and a shield generator keep raiders off it.',
    sprite: 'droid-yard', aspect: 0.66, size: 320, hull: 5200, shield: 1000, regen: 11, speed: 0, turn: 0, pop: 0, cost: 900, build: 32, level: 2, squad: 1, sensor: 1100,
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

/** The Dominion Shipworks: a long armoured dock for the line's heaviest ships, bigger and better
 * armed than the Forge Shipyard. Its slipway gantry builds (shot off, work goes at half speed); a
 * shield generator at the stern, a heavy battery at each bow corner and flak at the stern corners. */
function capitalYard(): UnitType {
  const pd = flak(6, 380, 0.4)
  const tl = turbo(33, 760, 2.4, 2)
  return {
    id: 'd-cyard', faction: 'droid', tier: 'yard', name: 'Dominion Shipworks',
    blurb: 'An armoured war dock raised within the Command Hub\'s build radius, from hub level 3: it builds cruisers, and battleships and dreadnoughts once its Capital slip is fitted. Its own queue and rally point; heavy batteries, flak and a shield generator guard it.',
    sprite: 'droid-cyard', aspect: 0.74, size: 430, hull: 8200, shield: 1600, regen: 15, speed: 0, turn: 0, pop: 0, cost: 2000, build: 48, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    hardpoints: [
      { ...M('dock', 'dock', 5, 4.4, 0.11, 1500), key: 'slip' },
      { ...M('shield', 'shield', 5, 8.75, 0.085, 1000), key: 'shield' },
      { ...gun('turbo', 1.75, 1.35, 0.07, 760, tl), key: 'tl1', look: 'triple' },
      { ...gun('turbo', 8.25, 1.35, 0.07, 760, tl), key: 'tl2', look: 'triple' },
      { ...gun('flak', 1.9, 9.1, 0.05, 340, pd), key: 'pd1' },
      { ...gun('flak', 8.1, 9.1, 0.05, 340, pd), key: 'pd2' },
    ],
    engines: [],
    role: { role: 'Capital yard', strong: ['building cruisers and flagships'], weak: ['bombers', 'flagships', 'being left unguarded'] },
  }
}

// Where each warship's hardpoints sit, on the 0-10 grid of its box, with their sizes: the same
// numbers serve as the hardpoints as written and as their layout at full size (see `layout`).
type At = { x: number; y: number; s?: number }
const BREAKER: At[] = [{ x: 5, y: 1.6, s: 0.09 }, { x: 5, y: 4.9, s: 0.075 }, { x: 5, y: 6.3, s: 0.075 }, { x: 5, y: 7.6, s: 0.07 }, { x: 5, y: 8.6, s: 0.055 }]
const LANCER: At[] = [{ x: 2.5, y: 3.8, s: 0.07 }, { x: 7.5, y: 3.8, s: 0.07 }, { x: 5, y: 5.6, s: 0.07 }, { x: 2.2, y: 7.4, s: 0.055 }, { x: 7.8, y: 7.4, s: 0.055 }]
const HARROW: At[] = [
  { x: 1.43, y: 4.4, s: 0.08 }, { x: 8.57, y: 4.4, s: 0.08 }, { x: 5, y: 2.2, s: 0.07 }, { x: 5, y: 7.2, s: 0.07 },
  { x: 1.43, y: 6.4, s: 0.055 }, { x: 8.57, y: 6.4, s: 0.055 }, { x: 5, y: 4.8, s: 0.07 }, { x: 3.57, y: 9.4 }, { x: 6.43, y: 9.4 },
]
const TYRANT: At[] = [
  { x: 2.8, y: 2.8, s: 0.065 }, { x: 7.2, y: 2.8, s: 0.065 }, { x: 2, y: 6, s: 0.065 }, { x: 8, y: 6, s: 0.065 },
  { x: 3.4, y: 1.4, s: 0.045 }, { x: 6.6, y: 1.4, s: 0.045 }, { x: 3.2, y: 7.6, s: 0.06 }, { x: 6.8, y: 7.6, s: 0.06 }, { x: 3.6, y: 9.4 }, { x: 6.4, y: 9.4 },
]
const DOMINATOR: At[] = [
  { x: 3.39, y: 2.4, s: 0.07 }, { x: 6.61, y: 2.4, s: 0.07 }, { x: 2.26, y: 4.4, s: 0.07 }, { x: 7.74, y: 4.4, s: 0.07 }, { x: 2.74, y: 6.8, s: 0.07 }, { x: 7.26, y: 6.8, s: 0.07 },
  { x: 4.03, y: 1, s: 0.04 }, { x: 5.97, y: 1, s: 0.04 }, { x: 0.81, y: 5.4, s: 0.04 }, { x: 9.19, y: 5.4, s: 0.04 },
  { x: 3.87, y: 5.4, s: 0.06 }, { x: 6.13, y: 5.4, s: 0.06 }, { x: 5, y: 9.4 }, { x: 5, y: 7.6, s: 0.1 },
]

/** Ground battles: the Confederacy's hovering fabricator droid, quick and light, its Command Hub and
 * its Supply Relay. */
const GROUND: UnitType[] = [
  groundEngineer({
    id: 'd-g-engineer', faction: 'droid', name: 'Forger builder droid', sprite: 'droid-g-engineer',
    blurb: 'A hovering fabricator droid with cutting arms and a plate rack. Unarmed and light, but quick: it cuts kyber crystals and ferries them to a Command Hub, raises buildings and patches damaged ones.',
    hull: 110, cost: 140, build: 11, speed: 104, turn: 5.2, ground: { radius: 10, accel: 260, builds: ['d-g-supply', 'd-g-generator', 'd-g-botfactory', 'd-g-foundry', 'd-g-research', 'd-g-center'] },
  }),
  groundCenter({
    id: 'd-g-center', faction: 'droid', name: 'Command Hub', sprite: 'droid-g-center',
    blurb: 'An eight-sided industrial deck round a sphere core. It trains builder droids, takes in the kyber they cut and supports 5 units.',
    hull: 5000, cost: 1200, build: 60, ground: { trains: ['d-g-engineer', 'd-g-scout'] },
    // A light defence turret on its roof (ground/combat.ts).
    hardpoints: [{ ...gun('flak', 2.9, 7.1, 0.13, 900, groundWeapon('pulse', 22, { range: 352, cooldown: 0.8 })), key: 'tur' }],
  }),
  groundSupply({
    id: 'd-g-supply', faction: 'droid', name: 'Supply Relay', sprite: 'droid-g-supply',
    blurb: 'A hexagonal power and parts relay with a humming mast. Each one supports 10 more units.',
    hull: 1400, cost: 100, build: 25, ground: {},
  }),
  groundGenerator({
    id: 'd-g-generator', faction: 'droid', name: 'Power Relay', sprite: 'droid-g-generator',
    blurb: 'A squat reactor stack with heavy conduits. It powers the base and burns a trickle of kyber to run.',
    hull: 1100, cost: 150, build: 20, ground: {},
  }),
  groundResearch({
    id: 'd-g-research', faction: 'droid', name: 'Data Core', sprite: 'droid-g-research',
    blurb: 'A shielded computing block round a glowing core. It makes research points while powered; the factories spend them on upgrades.',
    hull: 1600, cost: 200, build: 30, ground: {},
  }),
  groundFactory({
    id: 'd-g-botfactory', faction: 'droid', name: 'Bot Factory', sprite: 'droid-g-botfactory', makes: 'foot',
    blurb: 'An eight-sided assembly deck round a stamping press, with a wide shutter in its side. Battle droids march out of it in squads, fresh off the line; it draws power while it works.',
    hull: 2300, cost: 230, build: 32, ground: { trains: ['d-g-droids', 'd-g-salvo', 'd-g-bulwark'] },
  }),
  groundFactory({
    id: 'd-g-foundry', faction: 'droid', name: 'Vehicle Foundry', sprite: 'droid-g-foundry', makes: 'vehicle',
    blurb: 'A heavy smelting block with glowing furnace vents and a wide hangar shutter. It casts the Confederacy\'s tanks and speeders, which roll out of the shutter; it draws power while it works.',
    hull: 3100, cost: 380, build: 42, ground: { trains: ['d-g-razor', 'd-g-breaker', 'd-g-juggernaut'] },
  }),
  groundScout({
    id: 'd-g-scout', faction: 'droid', name: 'Probe droid', sprite: 'droid-g-scout',
    blurb: 'A hovering probe droid with a pulse blaster under its sensor head. Fast and far-sighted, cheap and thin-skinned: a scout and an engineer hunter.',
    hull: 120, cost: 85, build: 8, speed: 150, turn: 5.5, ground: { radius: 10, sight: 13 },
    weapons: [groundWeapon('pulse', 14.5, { arc: 0.4, cooldown: 0.7 })],
  }),
  // Tier 1: the fast units of the Bot Factory and the Vehicle Foundry (trained there, phase 4a).
  groundSquad({
    id: 'd-g-droids', faction: 'droid', name: 'Battle droid squad', sprite: 'droid-g-droids',
    blurb: 'Five battle droids with pulse blasters: cheap, fast to build, and made to be spent. Each droid lost is a blaster less.',
    hull: 250, cost: 95, build: 10, speed: 66, turn: 4, ground: {},
    squad: { n: 5, member: 'd-gm-droid', size: 16, spacing: 12 },
    role: { role: 'Infantry', strong: ['light units', 'engineers', 'numbers'], weak: ['splash', 'heavy armour'] },
    weapons: [groundWeapon('pulse', 2.7, { range: 176, cooldown: 0.8 })],
  }),
  groundFast({
    id: 'd-g-razor', faction: 'droid', name: 'Razor hover bike', sprite: 'droid-g-razor',
    blurb: 'A droid on a fast hover bike, twin pulse guns under its prongs and a pod of light rockets. Strikes and runs; the rockets bite into armour, but it bursts under fire.',
    hull: 220, cost: 120, build: 12, speed: 180, turn: 4.5, ground: { radius: 12 },
    role: { role: 'Raider', strong: ['hit and run', 'armour (rockets)'], weak: ['massed fire', 'splash'] },
    weapons: [groundWeapon('pulse', 6, { arc: 0.35, cooldown: 0.6 }), groundWeapon('pulse', 6, { arc: 0.35, cooldown: 0.6 }), groundWeapon('rocket', 16, { range: 224, arc: 0.6 })],
  }),
  // Tier 2: the anti-swarm units of the Bot Factory and the Vehicle Foundry (once they reach tier 2).
  groundMedium({
    id: 'd-g-salvo', faction: 'droid', name: 'Salvo droid', sprite: 'droid-g-salvo',
    blurb: 'A two-legged droid walker with a swarm rocket pod on each shoulder. It turns to face its target and empties both pods over a group at once.',
    hull: 600, cost: 220, build: 22, speed: 62, turn: 3, ground: { radius: 17 },
    role: { role: 'Anti-swarm', strong: ['groups', 'light units', 'squads'], weak: ['armour', 'fast flankers'] },
    weapons: [groundWeapon('swarm', 5, { burst: 4, arc: 0.6, cooldown: 3.6 }), groundWeapon('swarm', 5, { burst: 4, arc: 0.6, cooldown: 3.6 })],
  }),
  groundMedium({
    id: 'd-g-breaker', faction: 'droid', name: 'Breaker tank', sprite: 'droid-g-breaker',
    blurb: 'A broad tracked tank with a swarm rocket battery in its turret. Its salvos rain over packs of light units; heavy armour shrugs them off.',
    hull: 760, cost: 300, build: 28, speed: 78, turn: 2.5, ground: {},
    role: { role: 'Anti-swarm', strong: ['groups', 'light units', 'squads'], weak: ['heavy armour', 'beams'] },
    hardpoints: [{ ...gun('flak', 5, 5.2, 0.36, 500, groundWeapon('swarm', 6, { burst: 8, range: 288, splash: 40, cooldown: 4.4 })), key: 'tur', look: 'missileBox' }],
    weapons: [],
  }),
  // Tier 3: the heavy units of the Bot Factory and the Vehicle Foundry (the big ones, phase 5c).
  groundHeavy({
    id: 'd-g-bulwark', faction: 'droid', name: 'Bulwark droid', sprite: 'droid-g-bulwark',
    blurb: 'A hulking two-legged war droid that carries a great slab of a shield on one arm and a beam projector on the other. The beam burns hotter the longer it holds a target, so it melts armour; it has to turn its whole body to aim, and it is slow.',
    hull: 1300, cost: 380, build: 40, speed: 46, turn: 2, ground: { radius: 30 },
    aspect: 0.86,
    role: { role: 'Assault droid', strong: ['heavy armour', 'anti-swarm units'], weak: ['fast rocket raiders', 'long range'] },
    weapons: [groundWeapon('beam', 28, { range: 160, arc: 0.6 })],
  }),
  groundHeavy({
    id: 'd-g-juggernaut', faction: 'droid', name: 'Juggernaut crawler', sprite: 'droid-g-juggernaut',
    blurb: 'A wide tracked crawler of riveted plate, a heavy beam projector in its turret and two small pulse guns at its back corners. It grinds forward and burns through anything armoured that stands in front of it; fast raiders with rockets swarm it.',
    hull: 1450, cost: 480, build: 48, speed: 42, turn: 1.3, ground: { size: 3, radius: 38 },
    aspect: 0.84,
    role: { role: 'Crawler', strong: ['heavy armour', 'buildings', 'anti-swarm units'], weak: ['fast rocket raiders', 'flanking'] },
    hardpoints: [
      { ...gun('turbo', 5, 4.4, 0.36, 900, groundWeapon('beam', 26, { range: 176 })), look: 'triple', key: 'main' },
      { ...gun('flak', 2.2, 8.1, 0.16, 400, groundWeapon('pulse', 7, { range: 192, cooldown: 0.6 })), look: 'pd', key: 'pdL' },
      { ...gun('flak', 7.8, 8.1, 0.16, 400, groundWeapon('pulse', 7, { range: 192, cooldown: 0.6 })), look: 'pd', key: 'pdR' },
    ],
    weapons: [],
  }),
]

export const DROID: FactionData = {
  id: 'droid',
  info: {
    name: 'Confederacy',
    long: 'The Confederation of Independent Systems',
    blurb: 'Breakaway systems, private yards and corporate powers. Heavy guns, shield-breakers and fast strike craft on thin shields: it hits first and hardest.',
    color: '#f07732',
    bolt: '#ff8d39',
    glow: '#4be1ee',
    prefix: 'd',
    work: '255,141,57',
    weld: { glow: 'rgb(255,141,57)', core: 'rgb(255,236,205)', mid: 'rgba(255,170,100,0.9)', edge: 'rgba(240,119,50,0)' },
    debris: '#737c86',
    emblem: '/games/empires/world/emblem-droid.webp',
    rival: 'republic',
    sound: { turbo: 0.92 },
    // The names on the faction sheet: dual and triple cannon turrets, flak, missile and point
    // defence turrets, strike launchers.
    names: {
      weapon: { laser: 'Blaster cannons', turbo: 'Heavy cannons', missile: 'Missiles', ion: 'Ion lance' },
      mount: { turbo: 'Dual cannon turret', flak: 'Flak turret', missile: 'Missile turret', ion: 'Ion lance' },
      part: { dock: 'Salvage crane', sensor: 'Fire-control mast', refinery: 'Strip refinery', engine: 'Engine module' },
      look: { triple: 'Triple cannon turret', missileBox: 'Missile turret', pd: 'Point defence turret', strike: 'Strike launcher' },
      ability: { broadside: { name: 'Alpha strike', blurb: 'Overcharged batteries: its guns deal 60% more damage for 10 s.' } },
    },
  },
  ships: [
    {
      id: 'd-fighter', faction: 'droid', tier: 'fighter', name: 'Talon interceptor', blurb: 'Fork-nosed interceptors, three to a squadron. The fastest strike craft in the sky: hard-hitting cannons and torpedoes, and no shields at all.',
      sprite: 'droid-fighter', aspect: 0.8, size: 28, hull: 66, shield: 0, regen: 0, speed: 300, turn: 4.6, pop: 1, cost: 250, build: 9, level: 1, squad: 3, sensor: 680,
      weapons: [laser(7.5, 230, 0.42), torpedo(24, 260)], hardpoints: [], engines: [[5, 9.4]],
    },
    {
      id: 'd-gunship', faction: 'droid', tier: 'gunship', name: 'Raptor gunship', blurb: 'A forward weapon platform: flak against fighters, and a missile rack up front that slips past shields. Fast, thinly shielded.',
      sprite: 'droid-gunship', aspect: 0.95, size: 64, hull: 350, shield: 60, regen: 4, speed: 188, turn: 2.7, pop: 2, cost: 400, build: 13, level: 1, squad: 1, sensor: 800,
      weapons: [flak(7, 290, 0.28), missile(32, 420, 3.6)], hardpoints: [], engines: [[3.6, 9.4], [6.4, 9.4]],
    },
    {
      id: 'd-corvette', faction: 'droid', tier: 'gunship', kind: 'support', name: 'Reclaimer corvette', blurb: 'A salvage tender: its crane crews patch up nearby ships from scrap. Slower work than a Republic tender, and lightly armed; keep it behind the line.',
      sprite: 'droid-corvette', aspect: 0.62, size: 82, hull: 470, shield: 140, regen: 5, speed: 145, turn: 1.9, pop: 2, cost: 500, build: 17, level: 2, squad: 1, sensor: 880,
      weapons: [flak(5, 280, 0.4)], hardpoints: [], engines: [[3.3, 9.4], [6.7, 9.4]],
      support: { range: 460, repair: 12, max: 4 },
      role: { role: 'Salvage tender', strong: ['long fights'], weak: ['fighters', 'anything that catches it alone'] },
    },
    {
      id: 'd-bomber', faction: 'droid', tier: 'fighter', kind: 'bomber', name: 'Havoc bomber', blurb: 'Twin-fuselage bombers, two to a squadron, their ordnance slung outside the hull. Heavy shaped charges for capital ships and stations; easy prey for fighters.',
      sprite: 'droid-bomber', aspect: 0.9, size: 40, hull: 149, shield: 17, regen: 2, speed: 192, turn: 2.8, pop: 2, cost: 440, build: 15, level: 2, squad: 2, sensor: 640,
      weapons: [laser(5, 220, 0.6), torpedo(80, 250, 6)], hardpoints: [], engines: [[3.2, 9.4], [6.8, 9.4]],
      role: { role: 'Bomber', strong: ['cruisers', 'flagships', 'stations'], weak: ['fighters', 'gunships', 'frigates'] },
    },
    {
      id: 'd-repair', faction: 'droid', tier: 'fighter', kind: 'repair', tech: 'd-re-wing', name: 'Patchwork repair fighter', blurb: 'Salvage craft bolted together from spares, two to a squadron. Next to harmless, but their Field repair welds stations and warships back together under fire.',
      sprite: 'droid-repair', aspect: 0.8, size: 30, hull: 75, shield: 0, regen: 0, speed: 250, turn: 3.8, pop: 1, cost: 260, build: 11, level: 1, squad: 2, sensor: 650,
      weapons: [laser(2, 200, 0.8)], hardpoints: [], engines: [[5, 9.2]], ability: 'fieldRepair',
      role: { role: 'Field repairs', strong: ['long fights', 'keeping flagships alive'], weak: ['fighters', 'flak', 'everything else'] },
    },
    {
      id: 'd-picket', faction: 'droid', tier: 'fighter', kind: 'wing', name: 'Spectre picket', blurb: 'The Command Hub\'s own defense wing: five light pickets that guard it for free and launch again from its hangar when lost. Vicious at home, feeble far from it.',
      sprite: 'droid-picket', aspect: 0.75, size: 22, hull: 33, shield: 0, regen: 0, speed: 290, turn: 5, pop: 0, cost: 0, build: 0, level: 1, squad: 5, sensor: 640,
      weapons: [laser(4.2, 215, 0.42)], hardpoints: [], engines: [[5, 9]],
      role: { role: 'Home defense', strong: ['fighters', 'bombers near the station'], weak: ['warships', 'being sent away from home'] },
    },
    {
      id: 'd-engineer', faction: 'droid', tier: 'fighter', kind: 'engineer', name: 'Forger engineer', blurb: 'Three yard tugs with cutting arms and plate racks. Unarmed and fragile: they raise the yards round the Command Hub and weld structures back together.',
      sprite: 'droid-engineer', aspect: 0.85, size: 30, hull: 70, shield: 0, regen: 0, speed: 220, turn: 3.6, pop: 1, cost: 300, build: 14, level: 1, squad: 3, sensor: 650,
      weapons: [], hardpoints: [], engines: [[3.5, 9.3], [6.5, 9.3]],
      role: { role: 'Construction', strong: ['building yards', 'repairing structures'], weak: ['anything that shoots'] },
    },
    {
      id: 'd-ion', faction: 'droid', tier: 'frigate', kind: 'ion', name: 'Breaker destroyer', blurb: 'A line ship built round a spinal ion lance: it turns its whole hull to aim, and strips a warship\'s shields in a few shots. Two dual cannons for the bare hull underneath.',
      sprite: 'droid-ion', aspect: 0.26, size: 150, hull: 1000, shield: 300, regen: 7, speed: 80, turn: 1.0, pop: 3, cost: 800, build: 22, level: 2, squad: 1, sensor: 1050,
      weapons: [],
      hardpoints: [
        gun('ion', BREAKER[0].x, BREAKER[0].y, 0.09, 360, spinal(ion(90, 700, 2.8), 12)),
        gun('turbo', BREAKER[1].x, BREAKER[1].y, 0.075, 260, turbo(18, 540, 1.8, 2)),
        gun('turbo', BREAKER[2].x, BREAKER[2].y, 0.075, 260, turbo(18, 540, 1.8, 2)),
        M('shield', 'shield', BREAKER[3].x, BREAKER[3].y, 0.07, 260),
        { ...gun('flak', BREAKER[4].x, BREAKER[4].y, 0.055, 160, flak(5, 300, 0.4)), look: 'pd' },
      ],
      engines: [[3.3, 9.6], [6.7, 9.6]],
      role: { role: 'Shield breaker', strong: ['shielded warships', 'stations'], weak: ['fighters', 'being flanked'] },
    },
    {
      id: 'd-frigate', faction: 'droid', tier: 'frigate', name: 'Lancer frigate', blurb: 'A split-bow escort: a dual cannon on each boom for concentrated fire, flak aft. Overcharge its cannons for a killing broadside.',
      sprite: 'droid-frigate', aspect: 0.5, size: 135, hull: 1000, shield: 400, regen: 8, speed: 84, turn: 1.1, pop: 3, cost: 830, build: 21, level: 2, squad: 1, sensor: 980,
      weapons: [],
      hardpoints: [
        gun('turbo', LANCER[0].x, LANCER[0].y, 0.07, 260, turbo(20, 540, 1.8, 2)), gun('turbo', LANCER[1].x, LANCER[1].y, 0.07, 260, turbo(20, 540, 1.8, 2)),
        M('shield', 'shield', LANCER[2].x, LANCER[2].y, 0.07, 280),
        gun('flak', LANCER[3].x, LANCER[3].y, 0.055, 160, flak(7.5, 320, 0.33)), gun('flak', LANCER[4].x, LANCER[4].y, 0.055, 160, flak(7.5, 320, 0.33)),
      ],
      engines: [[3.6, 9.5], [5, 9.6], [6.4, 9.5]],
      ability: 'broadside',
    },
    {
      id: 'd-cruiser', faction: 'droid', tier: 'cruiser', name: 'Harrow cruiser', blurb: 'A long armoured spine between two gun pods: heavy triple batteries, missile turrets that slip past shields, a tractor projector that pins ships for the kill, and thin shields. Strike its shield generator first.',
      sprite: 'droid-cruiser', aspect: 0.5, size: 250, hull: 2400, shield: 850, regen: 14, speed: 56, turn: 0.6, pop: 5, cost: 1550, build: 33, level: 3, squad: 1, sensor: 1200,
      weapons: [],
      hardpoints: [
        ...HARROW.slice(0, 2).map((p) => ({ ...gun('turbo', p.x, p.y, 0.08, 520, turbo(33)), look: 'triple' as const })),
        ...HARROW.slice(2, 4).map((p) => ({ ...gun('turbo', p.x, p.y, 0.07, 320, cells(24, 520)), look: 'missileBox' as const })),
        gun('flak', HARROW[4].x, HARROW[4].y, 0.055, 200, flak(6, 320, 0.6)), gun('flak', HARROW[5].x, HARROW[5].y, 0.055, 200, flak(6, 320, 0.6)),
        M('shield', 'shield', HARROW[6].x, HARROW[6].y, 0.07, 480),
        P('engine', HARROW[7].x, HARROW[7].y, 420), P('engine', HARROW[8].x, HARROW[8].y, 420),
      ],
      engines: [[3.57, 9.6], [6.43, 9.6]], ability: 'tractor',
    },
    {
      id: 'd-capital', faction: 'droid', tier: 'capital', name: 'Dominator dreadnought', blurb: 'A massive multi-section assault ship: six heavy batteries, a hangar of Talons, and armour where others carry shields. Overcharge its batteries to break a line.',
      sprite: 'droid-capital', aspect: 0.62, size: 380, hull: 5800, shield: 2200, regen: 26, speed: 33, turn: 0.32, pop: 10, cost: 4000, build: 68, level: 4, squad: 1, sensor: 1500,
      weapons: [],
      hardpoints: [
        ...DOMINATOR.slice(0, 6).map((p) => ({ ...gun('turbo', p.x, p.y, 0.07, 680, turbo(48, 740)), look: 'triple' as const })),
        ...DOMINATOR.slice(6, 10).map((p, i) => ({ ...gun('flak', p.x, p.y, 0.04, 280, flak(6, 340, 0.8)), ...(i < 2 ? { look: 'pd' as const } : {}) })),
        M('shield', 'shield', DOMINATOR[10].x, DOMINATOR[10].y, 0.06, 760), M('shield', 'shield', DOMINATOR[11].x, DOMINATOR[11].y, 0.06, 760),
        P('engine', DOMINATOR[12].x, DOMINATOR[12].y, 950),
        M('hangar', 'hangar', DOMINATOR[13].x, DOMINATOR[13].y, 0.1, 760),
      ],
      engines: [[3, 9.55], [4, 9.65], [5, 9.7], [6, 9.65], [7, 9.55]], ability: 'broadside', carrier: { unit: 'd-fighter', every: 24, max: 2 },
    },
    // The Tyrant battleship: fleet support. Shares the flagships' tier and their limit of one (it is
    // built at the Shipworks like them); lighter guns than the Dominator, and a fire-control aura
    // that makes every gun of ours round it hit harder.
    {
      id: 'd-battleship', faction: 'droid', tier: 'capital', name: 'Tyrant battleship', blurb: 'A fleet command ship. Its fire-control tower coordinates the guns of every warship round it: they hit 20% harder. Four heavy batteries of its own.',
      sprite: 'droid-battleship', aspect: 0.5, size: 270, hull: 4200, shield: 1300, regen: 18, speed: 40, turn: 0.42, pop: 8, cost: 3000, build: 56, level: 4, squad: 1, sensor: 1400,
      weapons: [],
      hardpoints: [
        ...TYRANT.slice(0, 4).map((p, i) => ({ ...gun('turbo', p.x, p.y, 0.065, 600, turbo(40, 700)), ...(i < 2 ? { look: 'triple' as const } : {}) })),
        ...TYRANT.slice(4, 6).map((p) => gun('flak', p.x, p.y, 0.045, 260, flak(6, 340, 0.7))),
        M('shield', 'shield', TYRANT[6].x, TYRANT[6].y, 0.06, 560), M('shield', 'shield', TYRANT[7].x, TYRANT[7].y, 0.06, 560),
        P('engine', TYRANT[8].x, TYRANT[8].y, 520), P('engine', TYRANT[9].x, TYRANT[9].y, 520),
      ],
      engines: [[3.6, 9.6], [6.4, 9.6]],
      fireControl: { radius: 700, bonus: 0.2 },
      role: { role: 'Fleet support', strong: ['frigates', 'cruisers', 'stations'], weak: ['fighters', 'bombers'] },
    },
  ],
  station: {
    id: 'd-station',
    name: 'Dominion Command Hub',
    blurb: 'The Confederacy\'s armoured command and production hub. It builds strike craft, gunships and Forger engineers; the engineers raise the yards for bigger ships round it. It grows from an Outpost into a Stronghold, a Warbase and a Fortress, more heavily armed at every step. Lose it and the battle is lost.',
    perPx: 460 / 1148,
    regen: 16,
    // Every stage centred on the frame's middle (628, 592); the model is drawn in frame pixels from it.
    stages: [
      { name: 'Dominion Outpost', box: [398, 292, 858, 892], hull: 6600, shield: 0 },
      { name: 'Dominion Stronghold', box: [208, 162, 1048, 1022], hull: 7800, shield: 1900 },
      { name: 'Dominion Warbase', box: [108, 32, 1148, 1152], hull: 9000, shield: 2800 },
      { name: 'Dominion Fortress', box: [88, 12, 1168, 1172], hull: 10200, shield: 3500 },
    ],
    modules: [
      // Level 1, the Outpost: a battery on the north arm, the hangar in the south arm.
      sGun('t1', 'turbo', 628, 392, 1),
      sPart('h1', 'hangar', 'hangar', 628, 812, 120, 1200, { level: 1 }),
      // Research modules on the core's corners.
      sPart('sensor', 'sensor', 'sensor', 518, 482, 100, 700, { tech: 'd-st-guns' }),
      sPart('refinery', 'refinery', 'refinery', 738, 702, 110, 700, { tech: 'd-st-ore' }),
      sPart('dock', 'dock', 'dock', 738, 482, 110, 700, { level: 2, tech: 'd-st-dock' }),
      // Level 2, the Stronghold: the shield generator on the reactor, defence modules on the dock arms.
      sPart('s1', 'shield', 'shield', 628, 592, 110, 1100, { level: 2 }),
      sGun('t2', 'turbo', 298, 592, 2),
      sGun('f1', 'flak', 958, 592, 2),
      // Level 3, the Warbase: batteries on the production modules, flak at the north spire, a second
      // shield generator on the south arm.
      sGun('t3', 'turbo', 338, 302, 3),
      sGun('t4', 'turbo', 918, 302, 3),
      sPart('s2', 'shield', 'shield', 628, 1032, 95, 1100, { level: 3 }),
      sGun('f2', 'flak', 628, 122, 3),
      // Level 4, the Fortress: bastions on the outer flanks and guns on the storage modules.
      sGun('t5', 'turbo', 148, 752, 4),
      sGun('t6', 'turbo', 1108, 752, 4),
      sGun('t7', 'turbo', 338, 902, 4),
      sGun('t8', 'turbo', 918, 902, 4),
      sGun('f3', 'flak', 148, 432, 4),
      sGun('f4', 'flak', 1108, 432, 4),
    ],
  },
  structures: [minePlatform(), defensePlatform('balanced'), defensePlatform('flak'), defensePlatform('gun'), frigateYard(), capitalYard()],
  shieldedMine: minePlatform(true),
  // Offence first: damage, rate of fire, reach and speed; its sustain research is deliberately
  // weaker than the Republic's (the salvage cranes mend 1.5% a second, the Republic's docks 2%).
  // Each ship's second upgrade builds on its first. Ids kept from before stay for saves, even where
  // the upgrade changed (Overcharged batteries keeps d-ca-armour).
  techs: [
    tech('droid', 'd-station', 'd-st-guns', 'Fire-control mast', 'A fire-control mast on the hub: its batteries hit 25% harder while the mast stands.', 700, 45, 1, { damage: 0.25 }),
    tech('droid', 'd-station', 'd-st-ore', 'Strip refineries', 'A refinery module on the hub: Extraction Rigs bring in 25% more credits while it stands.', 600, 40, 1, { mines: 0.25 }),
    tech('droid', 'd-station', 'd-st-dock', 'Salvage cranes', 'A salvage crane on the hub: our ships near it repair 1.5% of their hull a second while it stands.', 800, 45, 2, { repair: 0.015 }, ['d-st-guns']),
    tech('droid', 'd-fighter', 'd-fi-line', 'Overdriven thrusters', 'Talons fly 20% faster.', 350, 25, 1, { speed: 0.2 }),
    tech('droid', 'd-fighter', 'd-fi-guns', 'Hot-loaded cannons', 'Talon cannons and torpedoes deal 25% more damage.', 450, 35, 2, { damage: 0.25 }, ['d-fi-line']),
    tech('droid', 'd-gunship', 'd-gs-shell', 'Forward capacitors', 'Raptor guns deal 20% more damage.', 450, 30, 1, { damage: 0.2 }),
    tech('droid', 'd-gunship', 'd-gs-cycle', 'Rapid cyclers', 'Raptor guns fire 15% faster.', 450, 30, 1, { cooldown: -0.15 }, ['d-gs-shell']),
    tech('droid', 'd-repair', 'd-re-wing', 'Salvage wing', 'Fits out a salvage wing in the hub\'s hangar: unlocks the Patchwork repair fighter and its Field repair.', 300, 25, 1, {}),
    tech('droid', 'd-bomber', 'd-bo-pods', 'Shaped-charge warheads', 'Havoc torpedoes deal 25% more damage.', 500, 35, 2, { damage: 0.25 }),
    tech('droid', 'd-bomber', 'd-bo-burn', 'Strike boosters', 'Havocs fly 20% faster.', 400, 30, 2, { speed: 0.2 }, ['d-bo-pods']),
    tech('droid', 'd-corvette', 'd-co-crews', 'Salvage crews', 'Reclaimers repair 30% faster.', 550, 35, 2, { repair: 0.3 }),
    tech('droid', 'd-ion', 'd-io-coils', 'Supercooled lance', 'Breaker guns fire 20% faster.', 700, 40, 2, { cooldown: -0.2 }),
    tech('droid', 'd-ion', 'd-io-range', 'Focusing array', 'Breaker guns reach 15% further.', 650, 40, 2, { range: 0.15 }, ['d-io-coils']),
    tech('droid', 'd-ion', 'd-io-break', 'Shield breakers', 'Breaker guns tear into shields 30% harder; the hull underneath takes the same as before.', 700, 40, 2, { shieldDamage: 0.3 }, ['d-io-coils']),
    tech('droid', 'd-frigate', 'd-fr-prong', 'Boom accelerators', 'Lancer guns deal 20% more damage.', 650, 40, 2, { damage: 0.2 }),
    tech('droid', 'd-frigate', 'd-fr-plate', 'Bolted armour', 'Lancers get 25% more hull.', 600, 40, 2, { hull: 0.25 }, ['d-fr-prong']),
    tech('droid', 'd-cruiser', 'd-cr-ray', 'Siege capacitors', 'Harrow guns deal 20% more damage.', 900, 50, 3, { damage: 0.2 }),
    tech('droid', 'd-cruiser', 'd-cr-thrust', 'Flanking drives', 'Harrows fly 20% faster.', 700, 40, 3, { speed: 0.2 }, ['d-cr-ray']),
    tech('droid', 'd-battleship', 'd-bs-net', 'Battle network', 'Tyrant guns reach 15% further.', 1100, 55, 4, { range: 0.15 }),
    tech('droid', 'd-battleship', 'd-bs-fire', 'Fire-control net', 'The Tyrant\'s fire-control tower links more of the fleet: its aura reaches 20% further and adds 5% more damage.', 1100, 55, 4, { aura: 0.05, auraRadius: 0.2 }, ['d-bs-net']),
    tech('droid', 'd-capital', 'd-ca-hangar', 'Assault hangars', 'Dominators launch Talons faster and keep one more squadron out.', 1200, 60, 4, { hangar: 1 }),
    tech('droid', 'd-capital', 'd-ca-armour', 'Overcharged batteries', 'Dominator guns fire 15% faster.', 1200, 60, 4, { cooldown: -0.15 }, ['d-ca-hangar']),
    tech('droid', 'd-cyard', 'd-yd-rush', 'Hot-launch protocols', 'The yard crews are paid to ship hulls before they are done: the Dominion Shipworks can rush out the warship it is building once it is half done (Rush launch). It comes out damaged, with guns still in scaffolding, and needs repair craft to be finished. Needs a Dominion Shipworks.', 800, 45, 3, {}),
  ],
  rushTech: 'd-yd-rush',
  mineFlak: MINE_FLAK,
  // On the Forge Shipyard two module sockets on the flanks and one at the stern; on the Dominion
  // Shipworks one on each flank (the stern one stays free for now).
  yardSockets: [[0.95, 6.3], [9.05, 6.3], [5, 9.5]],
  cyardSockets: [[1.15, 5.5], [8.85, 5.5], [5, 9.45]],
  berths: {
    'd-yard': { hw: 16, y0: -46, y1: 27 },
    'd-cyard': { hw: 18, y0: -47, y1: 33 },
  },
  // Gantry frames span the berths.
  gantries: {
    'd-yard': [-25, -2, 22],
    'd-cyard': [-24, -6, 15, 28.4],
  },
  layout: {
    'd-ion': BREAKER,
    'd-frigate': LANCER,
    'd-cruiser': HARROW,
    'd-capital': DOMINATOR,
    'd-battleship': TYRANT,
  },
  // The Bulwark defense station (Galactic conquest): an armoured gun hub that grows sponsons on girders.
  ground: GROUND,
  orbital: {
    name: 'Bulwark defense station',
    blurb: 'A fortified gun hub in orbit beside the Command Hub, bolted together from the Dominion\'s armoured blocks. Each level adds module slots, and each slot takes the module we pick for it.',
    regen: 16,
    stages: [
      { name: 'Bulwark Gun Post', hull: 2900, shield: 0, cost: 750, time: 40, station: 1 },
      { name: 'Bulwark Battle Station', hull: 4600, shield: 0, cost: 950, time: 50, station: 2 },
      { name: 'Bulwark Keep', hull: 6700, shield: 0, cost: 1400, time: 65, station: 3 },
    ],
    modules: [
      { id: 'battery', name: 'Heavy cannon battery', blurb: 'A triple heavy cannon that hits warships hard and early.', cost: 450, time: 22, kind: 'turret', art: 'turbo', look: 'triple', hp: 750, r: 10, weapon: turbo(46, 800, 2.4, 2) },
      { id: 'flak', name: 'Shredder flak', blurb: 'Rapid flak that tears strike craft apart.', cost: 350, time: 16, kind: 'turret', art: 'flak', hp: 480, r: 8, weapon: flak(8, 420, 0.3) },
      { id: 'launcher', name: 'Missile battery', blurb: 'A box launcher whose missiles slip past shields to the hull.', cost: 450, time: 22, kind: 'turret', art: 'turbo', look: 'missileBox', hp: 560, r: 9, weapon: missile(32, 700, 4) },
      { id: 'shield', name: 'Shield generator', blurb: 'Projects 1,100 shields round the station. Shot off, its shields go.', cost: 380, time: 18, kind: 'shield', art: 'shield', hp: 600, r: 9, shield: 1100, regen: 10 },
      { id: 'hangar', name: 'Talon hangar', blurb: 'Keeps a squadron of Talon interceptors in the air round the station, launching a new one when it is lost.', cost: 550, time: 24, kind: 'hangar', art: 'hangar', hp: 700, r: 10, carrier: 'd-fighter' },
    ],
  },
}
