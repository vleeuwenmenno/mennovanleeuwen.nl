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
// Also test squads and a walker, for the walk cycles (the cheat panel's "Squad test", the
// ground-squads perf scene, check:ground): a squad of five troopers, one of five battle droids and a
// pack of six swarmlings, each its faction's tier 1 foot unit as planned (phase 4 makes the real
// ones), and a two-legged walker with a turret on its back.

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

/** Each faction's test squad: its tier 1 foot unit as the plan has it. */
const SQUADS: Record<FactionId, { id: string; name: string; blurb: string; hull: number; speed: number; member: string; n: number; size: number; spacing: number; gun: Weapon }> = {
  republic: {
    id: 'r-gt-troopers', name: 'Test trooper squad', blurb: 'A dev test squad: five clone troopers with pulse rifles.',
    hull: 300, speed: 62, member: 'r-gm-trooper', n: 5, size: 16, spacing: 12, gun: groundWeapon('pulse', 5, { range: 176, cooldown: 0.9 }),
  },
  droid: {
    id: 'd-gt-droids', name: 'Test battle droid squad', blurb: 'A dev test squad: five battle droids with pulse blasters.',
    hull: 260, speed: 58, member: 'd-gm-droid', n: 5, size: 16, spacing: 12, gun: groundWeapon('pulse', 4.5, { range: 176, cooldown: 0.8 }),
  },
  swarm: {
    id: 's-gt-pack', name: 'Test swarmling pack', blurb: 'A dev test pack: six swarmlings spitting acid bolts.',
    hull: 240, speed: 82, member: 's-gm-swarmling', n: 6, size: 14, spacing: 11, gun: groundWeapon('pulse', 4, { range: 128, cooldown: 0.7 }),
  },
}
/** Faction `f`'s test squad, and the walker. */
export const testSquadId = (f: FactionId) => SQUADS[f].id
export const TEST_WALKER = 'r-gt-walker'

/** Registers the test squads and the walker (once). */
export function registerSquadTest() {
  for (const f of FACTION_IDS) {
    const q = SQUADS[f]
    if (UNIT[q.id]) continue
    const scout = UNIT[`${PREFIX[f]}-g-scout`]
    UNIT[q.id] = {
      ...scout,
      id: q.id,
      name: q.name,
      blurb: q.blurb,
      aspect: 1,
      size: 36,
      hull: q.hull,
      speed: q.speed,
      turn: 3.5,
      cost: 100,
      weapons: [q.gun],
      hardpoints: [],
      role: { role: 'Infantry', strong: ['light units', 'engineers'], weak: ['heavy armour', 'splash'] },
      ground: { ...scout.ground!, radius: 14, accel: 200, sight: 8, armour: 'light', look: q.member, squad: { n: q.n, member: q.member, size: q.size, spacing: q.spacing } },
    }
  }
  if (!UNIT[TEST_WALKER]) {
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
}

/**
 * The squad test: three of `me`'s faction's test squads and the walker for `me`, three of `foe`'s
 * faction's squads for `foe`, facing each other across (x, y) and sent at each other with
 * attack-move. Returns the units spawned.
 */
export function spawnSquadTest(w: World, me: Owner, foe: Owner, x: number, y: number, per = 3): Unit[] {
  registerSquadTest()
  const out: Unit[] = []
  const nav = w.ground!.nav
  for (const [o, side] of [[me, -1], [foe, 1]] as const) {
    const ids: number[] = []
    const types = [...Array(per).fill(testSquadId(w.players[o].faction)), ...(side < 0 ? [TEST_WALKER] : [])]
    types.forEach((id: string, i) => {
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
  return out
}
