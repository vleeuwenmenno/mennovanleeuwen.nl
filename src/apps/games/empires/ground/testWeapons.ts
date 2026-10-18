import { FACTION_IDS, UNIT, type FactionId, type UnitType } from '../data.ts'
import { GROUND_WEAPONS, gun, groundWeapon, type GroundWeaponKind, type Weapon } from '../data/kit.ts'
import { cmdMove, spawn, type Owner, type Unit, type World } from '../sim.ts'
import { standsAt } from './nav.ts'
import { TILE } from './types.ts'

// Test units for the seven ground weapons, so each can be seen at work before the units that carry
// them exist: dev builds only (the dev cheat panel's "Weapon test", the ground-combat perf scene and
// check:ground register them). One per weapon and faction, drawn as that faction's Scout with the
// weapon on a turret on its back, medium armour, slow. Not in any lobby or Codex.
//
// Also a test walker (a two-legged walker with a turret on its back) to show walk cycles on a
// vehicle, and spawns of the real tier 1 units for the cheat panel's "Squad test" and "Tier 1 test",
// the ground-squads perf scene and check:ground.

/** Each weapon's test gun: its damage (a beam's and a spray's a second). */
const TEST_GUN: Record<GroundWeaponKind, Weapon> = {
  pulse: groundWeapon('pulse', 10),
  beam: groundWeapon('beam', 30),
  rocket: groundWeapon('rocket', 40),
  shell: groundWeapon('shell', 55),
  artillery: groundWeapon('artillery', 60),
  swarm: groundWeapon('swarm', 7),
  spray: groundWeapon('spray', 25),
}

const PREFIX: Record<FactionId, string> = { republic: 'r', droid: 'd', swarm: 's' }
/** The test unit carrying weapon `k` for faction `f`. */
export const testWeaponId = (f: FactionId, k: GroundWeaponKind) => `${PREFIX[f]}-gt-${k}`

/** Registers the test units (once). */
export function registerWeaponTest() {
  for (const f of FACTION_IDS)
    for (const k of GROUND_WEAPONS) {
      const id = testWeaponId(f, k)
      if (UNIT[id]) continue
      const scout = UNIT[`${PREFIX[f]}-g-scout`]
      const t: UnitType = {
        ...scout,
        id,
        name: `Test ${k}`,
        blurb: `A dev test unit carrying the ${k} ground weapon.`,
        hull: 600,
        speed: 70,
        turn: 2.5,
        cost: 100,
        weapons: [],
        hardpoints: [{ kind: 'turret', art: k === 'artillery' || k === 'shell' ? 'turbo' : 'flak', x: 5, y: 6, s: 0.32, hp: 400, weapon: TEST_GUN[k] }],
        ground: { ...scout.ground!, armour: 'medium', sight: 10, look: scout.id },
      }
      UNIT[id] = t
    }
}

/**
 * The weapon test: one test unit per weapon for `me` and one per weapon for `foe`, in two rows facing
 * each other across (x, y), sent at each other with attack-move. Returns the units spawned.
 */
export function spawnWeaponTest(w: World, me: Owner, foe: Owner, x: number, y: number): Unit[] {
  registerWeaponTest()
  const out: Unit[] = []
  const nav = w.ground!.nav
  for (const [o, side] of [[me, -1], [foe, 1]] as const) {
    const ids: number[] = []
    GROUND_WEAPONS.forEach((k, i) => {
      const id = testWeaponId(w.players[o].faction, k)
      // Artillery stands further back: it can't fire close.
      let px = x + side * TILE * (k === 'artillery' ? 12 : 6)
      let py = y + (i - 3) * TILE * 1.5
      for (let s = 0; s < 6 && !standsAt(nav, 1, px, py); s++) px -= side * TILE
      if (!standsAt(nav, 1, px, py)) py += TILE
      const u = spawn(w, id, o, px, py, side < 0 ? 0 : Math.PI)
      ids.push(u.id)
      out.push(u)
    })
    cmdMove(w, o, ids, x - side * TILE * 4, y, true)
  }
  return out
}

/** Each faction's tier 1 units: its foot squad (foot factory) and its fast vehicle (vehicle factory). */
export const TIER1: Record<FactionId, { foot: string; vehicle: string }> = {
  republic: { foot: 'r-g-troopers', vehicle: 'r-g-raider' },
  droid: { foot: 'd-g-droids', vehicle: 'd-g-razor' },
  swarm: { foot: 's-g-swarmlings', vehicle: 's-g-racer' },
}
export const TEST_WALKER = 'r-gt-walker'

/** Registers the test walker (once). */
export function registerWalkerTest() {
  if (UNIT[TEST_WALKER]) return
  const scout = UNIT['r-g-scout']
  UNIT[TEST_WALKER] = {
    ...scout,
    id: TEST_WALKER,
    name: 'Test walker',
    blurb: 'A dev test walker: two legs, a pulse cannon turret on its back.',
    aspect: 0.8,
    size: 40,
    hull: 520,
    speed: 52,
    turn: 2.2,
    cost: 200,
    weapons: [],
    hardpoints: [{ ...gun('flak', 5, 4.6, 0.32, 400, groundWeapon('pulse', 14, { range: 224, cooldown: 1 })), key: 'tur' }],
    role: { role: 'Walker', strong: ['light units'], weak: ['rockets'] },
    ground: { ...scout.ground!, radius: 15, accel: 160, sight: 9, armour: 'medium', look: undefined },
  }
}

/** Spawns `types` for `o` in a column on its side (`side` -1 left, 1 right) of (x, y), sent across
 * with attack-move. */
function column(w: World, o: Owner, side: -1 | 1, types: string[], x: number, y: number, out: Unit[]) {
  const nav = w.ground!.nav
  const ids: number[] = []
  types.forEach((id, i) => {
    let px = x + side * TILE * 7
    let py = y + (i - (types.length - 1) / 2) * TILE * 2.2
    for (let s = 0; s < 6 && !standsAt(nav, 1, px, py); s++) px -= side * TILE
    if (!standsAt(nav, 1, px, py)) py += TILE
    const u = spawn(w, id, o, px, py, side < 0 ? 0 : Math.PI)
    ids.push(u.id)
    out.push(u)
  })
  cmdMove(w, o, ids, x - side * TILE * 4, y, true)
}

/**
 * The squad test: `per` of `me`'s faction's foot squads and the test walker for `me`, `per` of
 * `foe`'s faction's squads for `foe`, facing each other across (x, y) and sent at each other with
 * attack-move. Returns the units spawned.
 */
export function spawnSquadTest(w: World, me: Owner, foe: Owner, x: number, y: number, per = 3): Unit[] {
  registerWalkerTest()
  const out: Unit[] = []
  column(w, me, -1, [...Array(per).fill(TIER1[w.players[me].faction].foot), TEST_WALKER], x, y, out)
  column(w, foe, 1, Array(per).fill(TIER1[w.players[foe].faction].foot), x, y, out)
  return out
}

/** The tier 1 test: all six tier 1 units (every faction's foot squad and fast vehicle) for `me` and
 * the same six for `foe`, facing each other across (x, y) and sent at each other. */
export function spawnTierTest(w: World, me: Owner, foe: Owner, x: number, y: number): Unit[] {
  const six = FACTION_IDS.flatMap((f) => [TIER1[f].foot, TIER1[f].vehicle])
  const out: Unit[] = []
  column(w, me, -1, six, x, y, out)
  column(w, foe, 1, six, x, y, out)
  return out
}

/** Each faction's tier 3 units, the heavy ones: its foot factory's and its vehicle factory's. */
export const TIER3: Record<FactionId, { foot: string; vehicle: string }> = {
  republic: { foot: 'r-g-lancers', vehicle: 'r-g-bastion' },
  droid: { foot: 'd-g-bulwark', vehicle: 'd-g-juggernaut' },
  swarm: { foot: 's-g-ravager', vehicle: 's-g-behemoth' },
}

/** The tier 3 test: all six tier 3 units for `me` and the same six for `foe`, facing each other
 * across (x, y) and sent at each other. They are big, so they stand further apart. */
export function spawnTier3Test(w: World, me: Owner, foe: Owner, x: number, y: number): Unit[] {
  const six = FACTION_IDS.flatMap((f) => [TIER3[f].foot, TIER3[f].vehicle])
  const out: Unit[] = []
  for (const [o, side] of [[me, -1], [foe, 1]] as const) {
    const nav = w.ground!.nav
    const ids: number[] = []
    six.forEach((id, i) => {
      const k = UNIT[id].ground!.size
      // Artillery stands further back: it can't fire close.
      let px = x + side * TILE * (UNIT[id].hardpoints.some((h) => h.weapon?.ground === 'artillery') ? 13 : 8)
      let py = y + (i - 2.5) * TILE * 3.4
      for (let s = 0; s < 8 && !standsAt(nav, k, px, py); s++) px -= side * TILE
      if (!standsAt(nav, k, px, py)) py += TILE
      const u = spawn(w, id, o, px, py, side < 0 ? 0 : Math.PI)
      ids.push(u.id)
      out.push(u)
    })
    cmdMove(w, o, ids, x - side * TILE * 4, y, true)
  }
  return out
}
