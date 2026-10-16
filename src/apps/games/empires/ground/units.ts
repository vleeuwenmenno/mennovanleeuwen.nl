import type { GroundUnitType } from './sim.ts'

// The ground battle's real units, as data, merged into GROUND_UNITS (sim.ts). The first slice has
// two a faction: an Engineer (a small vehicle or drone that builds and repairs) and a Command
// Center (the base: trains engineers, earns a trickle of credits, and holds the command range other
// buildings must go up in). Ids are the ones build.ts's SLICE_IDS names.
//
// Numbers are in the ballpark of the space game's: an engineer squad there costs 300 for three craft
// (one vehicle here, 150 or so), a station earns 6 credits a second at level 1, and a mining platform
// costs 460 and a yard 900 (a Command Center, a whole new base, 1,200). Sight is in tiles; a
// building's footprint in tiles, its door on the south side (it faces south and never turns).

/** Credits a battle starts with when the lobby picks nothing: the space game's START_CREDITS. */
export const GROUND_START_CREDITS = 1600

/** How far a building's command range reaches when its type names none, in tiles (the plan's
 * "others 6"). */
export const DEFAULT_RANGE = 6

const engineer = (o: Omit<GroundUnitType, 'kind' | 'size' | 'accel' | 'sight'> & Partial<GroundUnitType>): GroundUnitType => ({
  kind: 'vehicle', size: 1, accel: 220, sight: 8, ...o,
})

const center = (o: Omit<GroundUnitType, 'kind' | 'size' | 'radius' | 'speed' | 'accel' | 'turn' | 'sight' | 'foot'>): GroundUnitType => ({
  kind: 'structure', size: 3, radius: 96, speed: 0, accel: 0, turn: 0, sight: 10, foot: [6, 6], range: 14, standalone: true, ...o,
})

export const SLICE_UNITS: GroundUnitType[] = [
  // Republic: a tracked crane rig crewed by clone engineers, sturdy and steady.
  engineer({
    id: 'r-g-engineer', faction: 'republic', name: 'Mason field engineer',
    blurb: 'A tracked utility rig with a crane arm and a welding torch. Unarmed: it raises Command Centers within reach of your base and welds damaged buildings back together.',
    radius: 11, speed: 88, turn: 4, hull: 150, cost: 150, build: 12, builds: ['r-g-center'],
  }),
  center({
    id: 'r-g-center', faction: 'republic', name: 'Command Center',
    blurb: 'A white armoured block with a landing pad and a comms dish. It trains engineers, earns a steady trickle of credits, and buildings go up within 14 tiles of it.',
    hull: 5200, cost: 1200, build: 60, income: 6, trains: ['r-g-engineer'],
  }),
  // Confederacy: a hovering fabricator droid, quick and light.
  engineer({
    id: 'd-g-engineer', faction: 'droid', name: 'Forger builder droid',
    blurb: 'A hovering fabricator droid with cutting arms and a plate rack. Unarmed and light, but quick: it raises Command Hubs and patches damaged buildings.',
    radius: 10, speed: 104, accel: 260, turn: 5.2, hull: 110, cost: 140, build: 11, builds: ['d-g-center'],
  }),
  center({
    id: 'd-g-center', faction: 'droid', name: 'Command Hub',
    blurb: 'An eight-sided industrial deck round a sphere core. It trains builder droids, earns a steady trickle of credits, and buildings go up within 14 tiles of it.',
    hull: 5000, cost: 1200, build: 60, income: 6, trains: ['d-g-engineer'],
  }),
  // Swarm: a low crawler that spits resin; it builds like the others in the slice (plan D3).
  engineer({
    id: 's-g-engineer', faction: 'swarm', name: 'Shaper drone',
    blurb: 'A low crawler with mandibles that spits resin. Cheap and quick to grow: it raises Hive Nexuses and knits damaged ones back together.',
    radius: 10, speed: 96, accel: 240, turn: 4.8, hull: 120, cost: 130, build: 10, builds: ['s-g-center'],
  }),
  center({
    id: 's-g-center', faction: 'swarm', name: 'Hive Nexus',
    blurb: 'A chitin mound round a glowing violet core. It grows Shaper drones, earns a steady trickle of credits, and buildings go up within 14 tiles of it.',
    hull: 5400, cost: 1200, build: 60, income: 6, trains: ['s-g-engineer'],
  }),
]
