// The size of the battlefield, in three dials. Everything that depends on them reads them from
// here, so trying another scale is a one-line change. No DOM, so the server and the headless sims
// load this too. Changing any of them changes every battle, so the multiplayer check's hash
// (`pnpm check:empires`) changes with it; battles saved before keep the map they were saved with.

/**
 * How much bigger every battle map is than it was drawn, in each direction, on top of the maps'
 * own spread (SPREAD in maps.ts). Everything placed on the map moves out with it: spawns, ore,
 * beacons, wrecks, asteroid fields, nebulas and the start areas, and the distances the AI and the
 * sim measure across the map (how far from home counts as "home", where fleets gather). Ships,
 * stations, platforms, ore and rocks keep their size, so there's more open space between them.
 */
export const MAP_SCALE = 1.25

/**
 * How much further every gun reaches and every sensor sees than the numbers in data.ts: weapons
 * (strike craft, warships, platforms and the station's guns), sensors, ability ranges, repair
 * tenders, the defense wing's home radius, and what the sim derives from ranges (how far ships
 * chase, look round and break off). Research bonuses stay percentages on top of this.
 */
export const RANGE_SCALE = 1.1

/** How much faster every ship flies than the numbers in data.ts. */
export const SPEED_SCALE = 1.0

/** A distance across the map (see MAP_SCALE). */
export const mapDist = (d: number) => d * MAP_SCALE
/** A distance that goes with how far guns and sensors reach (see RANGE_SCALE). */
export const rangeDist = (d: number) => d * RANGE_SCALE
