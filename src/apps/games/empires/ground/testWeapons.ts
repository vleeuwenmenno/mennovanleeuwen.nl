import { FACTION_IDS, UNIT, type FactionId, type UnitType } from '../data.ts'
import { GROUND_WEAPONS, groundWeapon, type GroundWeaponKind, type Weapon } from '../data/kit.ts'
import { cmdMove, spawn, type Owner, type Unit, type World } from '../sim.ts'
import { standsAt } from './nav.ts'
import { TILE } from './types.ts'

// Test units for the seven ground weapons, so each can be seen at work before the units that carry
// them exist: dev builds only (the dev cheat panel's "Weapon test", the ground-combat perf scene and
// check:ground register them). One per weapon and faction, drawn as that faction's Scout with the
// weapon on a turret on its back, medium armour, slow. Not in any lobby or Codex.

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
