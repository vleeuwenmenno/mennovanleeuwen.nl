// Checks the faction mechanics in Empires At War's sim, each switched on for a test unit: headless,
// deterministic battles with nothing on the map but the ships a check puts there. Every mechanic is
// off for every unit as the factions are written (data/<faction>.ts); these checks turn each one on
// by giving a unit a copy of its type with the flag set (data/kit.ts UnitType and StationPlan).
//
//   node scripts/empires-mechanics.ts
//
// 1. Living hulls (UnitType regrow): no growth while still in the fight, then `rate` of the full hull
//    a second, never past what the hull can hold (a rush-launched ship's unbuilt hull stays unbuilt);
//    a unit without it doesn't grow back; a station's from the level its plan says.
// 2. A drain aura (UnitType drain): enemies in reach lose hull at `dps`, past their shields; our
//    damaged ships in reach get `heal` of it; nothing out of reach is touched; a drained-out enemy
//    dies and counts as a kill.
// 3. A station's brood (StationPlan carrier): none below its level, strike craft launched once the
//    station has grown to it, at most `max` squadrons out, the defense wing untouched; every
//    faction's flagship carrier launches its own fighters.
// 4. A fire-control aura (UnitType fireControl): our ships in reach hit `bonus` harder, out of reach
//    as usual, and two auras don't stack (the best counts).
// 5. A spinal gun (Weapon spinal): it only fires within its arc off the nose, its mount doesn't
//    turn on the model, and a ship ordered to attack turns to bring it to bear.
// 6. No shields: a warship with none and no shield generators stays at zero shields under ion and
//    laser fire and research, its hull takes the damage, nothing turns NaN, and the AI plays with it.
// 7. Determinism: the same battle with every mechanic on, run twice, and once frozen to a snapshot
//    and thawed halfway, ends the same.
// 8. Research for the mechanics (TechEffect): shieldDamage hits shields harder (and spends the shot
//    by what the shields took), aura and auraRadius strengthen and widen a fire-control aura, regrow
//    and regrowDelay speed a living hull, drain and drainHeal strengthen a drain, and the station's
//    fleetBuild builds every ship faster, and shieldAura (with auraRadius) strengthens and widens a
//    shield projector. Test research is added to the tables for the check only.
// 9. A shield-projector aura (UnitType shieldAura): our ships in reach (itself included) recharge
//    their shields `regen` faster, out of reach and enemies as usual, two auras don't stack (the
//    best counts), and a projector with all its shield generators shot off projects nothing.

import { MAPS } from '../src/apps/games/empires/maps.ts'
import { LEVEL_UP, STATIONS, TECH, UNIT, stationType, type TechEffect, type UnitType } from '../src/apps/games/empires/data.ts'
import { spinal } from '../src/apps/games/empires/data/kit.ts'
import { buildModel } from '../src/apps/games/empires/models/index.ts'
import { STEP, auraOf, cmdAttack, cmdBuild, cmdResearch, damage, drainOf, newWorld, regrowOf, shieldAuraOf, shieldFull, shieldMax, spawn, stateHash, tick, type Shot, type Unit, type World } from '../src/apps/games/empires/sim.ts'
import { newBrain, think } from '../src/apps/games/empires/ai.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import type { FactionId } from '../src/apps/games/empires/data.ts'

let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]

/** The two-player map with nothing on it: no stations, no wrecks, nothing on its way in. */
function empty(factions: [FactionId, FactionId] = ['swarm', 'droid'], seed = 7): World {
  const w = newWorld(map, factions.map((faction, i) => ({ faction, team: i, spawn: i })), { seed })
  w.units = []
  w.byId = new Map()
  w.arrivals = []
  w.wrecks = []
  return w
}

function run(w: World, secs: number, each?: (w: World) => void) {
  const n = Math.round(secs / STEP)
  for (let i = 0; i < n; i++) {
    tick(w)
    w.events.length = 0
    each?.(w)
  }
}

/** A copy of a unit type with its guns taken away (so a test unit only does the one thing). */
const unarmed = (t: UnitType): UnitType => ({ ...t, weapons: [], hardpoints: t.hardpoints.map((h) => ({ ...h, weapon: undefined })) })

/** Spawns a unit of `id`, then gives it `t` (a copy of its type with a mechanic on): its hull,
 * shields, modules and guns as that type has them. */
function put(w: World, id: string, owner: number, x: number, y: number, a: number, t?: UnitType): Unit {
  const u = spawn(w, id, owner, x, y, a)
  if (t) {
    u.t = t
    u.hullMax = t.hull * u.mods.hull
    u.hull = u.hullMax
    u.shield = t.shield * u.mods.shield
    u.hps = t.hardpoints.map((h) => ({ hp: h.hp, max: h.hp }))
    u.guns = [...t.weapons.map((wp) => ({ w: wp, hp: -1 })), ...t.hardpoints.flatMap((h, i) => (h.weapon ? [{ w: h.weapon, hp: i }] : []))].map((g) => ({ ...g, cd: 0, burst: 0, burstT: 0, target: 0, aim: 0, focus: 0 }))
  }
  u.stance = 'hold'
  return u
}

/** The shots `from` fires over `secs` of battle. */
function shotsBy(w: World, from: Unit, secs: number): Shot[] {
  const seen = new Set<Shot>(w.shots)
  const out: Shot[] = []
  run(w, secs, (ww) => {
    for (const s of ww.shots)
      if (!seen.has(s)) {
        seen.add(s)
        if (s.from === from.id) out.push(s)
      }
  })
  return out
}
const wrap = (a: number) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI

const mid = () => ({ x: map.w / 2, y: map.h / 2 })

// --- 1. Living hulls -----------------------------------------------------------------------------------

{
  const w = empty()
  const { x, y } = mid()
  const rg = { ...UNIT['s-frigate'], regrow: { rate: 0.05, delay: 5 } }
  const u = put(w, 's-frigate', 0, x, y, 0, rg)
  // Swarm ships regrow by default: these test units don't, so each check sees one mechanic only.
  const plain = put(w, 's-frigate', 0, x, y + 400, 0, { ...UNIT['s-frigate'], regrow: undefined })
  u.hull = u.hullMax * 0.5
  plain.hull = plain.hullMax * 0.5
  u.lastHit = plain.lastHit = w.time
  run(w, 4.5)
  check('a living hull doesn\'t grow while it was hit in the last `delay` seconds', u.hull === u.hullMax * 0.5, `${(u.hull / u.hullMax).toFixed(3)}`)
  run(w, 2.5)
  // From 5 s on, 0.05 a second: 2 s of it.
  check('then it grows `rate` of its full hull a second', near(u.hull / u.hullMax, 0.6, 0.006), `${(u.hull / u.hullMax).toFixed(3)} of its hull, want 0.6`)
  run(w, 20)
  check('up to its full hull and no further', u.hull === u.hullMax)
  check('a hull without regrow stays as it was', plain.hull === plain.hullMax * 0.5)
  // A rush-launched ship: the unbuilt part of the hull is no damage to grow back.
  u.rush = { left: 999, total: 999, gap: u.hullMax * 0.2, parts: [], n: 0, work: false }
  u.hull = u.hullMax * 0.3
  u.lastHit = -99
  run(w, 30)
  check('a rush-launched hull grows only up to what is built', near(u.hull, u.hullMax * 0.8, 1e-6), `${(u.hull / u.hullMax).toFixed(3)}`)
  // A station's from a level on (StationPlan regrow).
  const plan = STATIONS.swarm
  const had = plan.regrow
  plan.regrow = { rate: 0.01, delay: 10, level: 3 }
  check('a station\'s hull grows back from the level its plan says', !stationType('swarm', 2, ['s-st-guns']).regrow && stationType('swarm', 3, []).regrow?.rate === 0.01 && !!stationType('swarm', 4, []).regrow)
  plan.regrow = had
}

// --- 2. A drain aura -------------------------------------------------------------------------------------

{
  const w = empty()
  const { x, y } = mid()
  const drain = { radius: 500, dps: 40, heal: 0.5 }
  const leech = put(w, 's-corvette', 0, x, y, 0, { ...unarmed(UNIT['s-corvette']), drain })
  const ally = put(w, 's-frigate', 0, x - 250, y, 0, { ...unarmed(UNIT['s-frigate']), regrow: undefined })
  const foe = put(w, 'd-frigate', 1, x + 250, y, Math.PI, unarmed(UNIT['d-frigate']))
  const far = put(w, 'd-frigate', 1, x + 900, y, Math.PI, unarmed(UNIT['d-frigate']))
  const weak = put(w, 'd-fighter', 1, x, y + 200, 0, unarmed(UNIT['d-fighter']))
  weak.hull = 10
  ally.hull = ally.hullMax * 0.3
  const foeShield = foe.shield
  // Sight is worked out every quarter second: from then on the leech sees them.
  run(w, 0.3)
  const foe0 = foe.hull
  const ally0 = ally.hull
  run(w, 3)
  const took = foe0 - foe.hull
  check('an enemy in reach loses `dps` hull points a second', near(took, 40 * 3, 2), `${took.toFixed(1)} in 3 s, want 120`)
  check('past its shields: they are untouched', foe.shield === foeShield, `${foe.shield} of ${foeShield}`)
  // The ally is the only damaged ship of ours in reach (the fighter was drained out in the first
  // quarter second), so it gets half of what the frigate lost.
  const healed = ally.hull - ally0
  check('our damaged ship in reach gets `heal` of what was drained', near(healed, 0.5 * took, 1), `${healed.toFixed(1)} for ${took.toFixed(1)} drained`)
  check('an enemy out of reach is untouched', far.hull === far.hullMax)
  check('a drained-out enemy is destroyed', weak.dead)
  check('and counts as our kill', w.players[0].stats.killed === 1, `${w.players[0].stats.killed} kills`)
  check('the drain is on the hull it hit: it knows who did it', foe.hitBy === leech.id && foe.lastHit > 0)
}

// --- 3. A station's brood, and the flagship carriers -----------------------------------------------------

{
  const plan = STATIONS.swarm
  const had = plan.carrier
  plan.carrier = { unit: 's-fighter', every: 4, max: 2, level: 2 }
  check('below its level a station has no brood', !stationType('swarm', 1, []).carrier)
  check('from its level on it launches strike craft', stationType('swarm', 2, []).carrier?.unit === 's-fighter')
  const w = newWorld(map, [{ faction: 'swarm', team: 0, spawn: 0 }, { faction: 'republic', team: 1, spawn: 1 }], { seed: 5, credits: 99999 })
  const st = w.byId.get(w.players[0].station)!
  const brood = () => w.units.filter((u) => !u.dead && u.parent === st.id && u.t.id === 's-fighter')
  const wing = () => w.units.filter((u) => !u.dead && u.parent === st.id && u.t.kind === 'wing').length
  const wing0 = wing()
  run(w, 10)
  check('a level 1 station launches none', brood().length === 0)
  check('upgrading the station starts', cmdResearch(w, 0, LEVEL_UP) === null)
  let t = 0
  while (w.players[0].level < 2 && t++ < 3000) run(w, 0.5)
  check('the station grows to level 2', w.players[0].level === 2 && !!w.byId.get(st.id)?.t.carrier)
  run(w, 4.5)
  check('then its brood launches', brood().length === UNIT['s-fighter'].squad, `${brood().length} strike craft`)
  run(w, 40)
  const squads = new Set(brood().map((u) => u.squad)).size
  check('at most `max` squadrons of it out', squads === 2, `${squads} squadrons`)
  check('its defense wing is untouched', wing() === wing0, `${wing()} wing craft, had ${wing0}`)
  plan.carrier = had

  // Every faction's flagship, all of one side (so they don't fight), well apart.
  const v = empty()
  const { x, y } = mid()
  const flags = (['r-capital', 'd-capital', 's-capital'] as const).map((id, i) => put(v, id, 0, x + (i - 1) * 1800, y + (i - 1) * 300, 0))
  run(v, 30)
  for (const f of flags) {
    const out = v.units.filter((u) => !u.dead && u.parent === f.id)
    check(`the ${f.t.name} launches its own strike craft`, out.length > 0 && out.every((u) => u.t.id === f.t.carrier!.unit), `${out.length} ${f.t.carrier!.unit}`)
  }
}

// --- 4. A fire-control aura -------------------------------------------------------------------------------

{
  const w = empty()
  const { x, y } = mid()
  const gunner = put(w, 'd-frigate', 0, x, y, 0)
  const target = put(w, 'd-defense', 1, x + 450, y, 0, { ...unarmed(UNIT['d-defense']), hull: 1e9 })
  const aura = (bonus: number) => ({ ...unarmed(UNIT['d-battleship']), fireControl: { radius: 600, bonus } })
  // In reach: beside the gunner. Out of it: well off to the side (where it stays: its anchor moves too).
  const inReach = { x: x - 300, y }
  const away = { x: x - 300, y: y - 1500 }
  const moveTo = (u: Unit, p: { x: number; y: number }) => ((u.x = u.ax = p.x), (u.y = u.ay = p.y))
  const tyrant = put(w, 'd-battleship', 0, inReach.x, inReach.y, 0, aura(0.5))
  const lesser = put(w, 'd-battleship', 0, away.x, away.y, 0, aura(0.3))
  /** The turbolaser bolts the gunner fires over `secs`: their damage. */
  const bolts = (secs: number) => shotsBy(w, gunner, secs).filter((s) => s.kind === 'turbo').map((s) => s.dmg)
  const on = bolts(8)
  moveTo(tyrant, away)
  const off = bolts(8)
  moveTo(tyrant, inReach)
  moveTo(lesser, { x: inReach.x, y: inReach.y + 200 })
  const both = bolts(8)
  moveTo(tyrant, away)
  const weaker = bolts(8)
  const one = (xs: number[]) => (xs.length && xs.every((d) => d === xs[0]) ? xs[0] : NaN)
  check('the gunner fires throughout', on.length > 0 && off.length > 0 && both.length > 0 && weaker.length > 0, `${on.length}, ${off.length}, ${both.length}, ${weaker.length} bolts`)
  check('in the aura its bolts hit `bonus` harder', near(one(on) / one(off), 1.5, 1e-9), `${one(on)} against ${one(off)}`)
  check('two auras don\'t stack: the best counts', near(one(both) / one(off), 1.5, 1e-9), `${one(both)}`)
  check('the weaker aura alone gives its own bonus', near(one(weaker) / one(off), 1.3, 1e-9), `${one(weaker)}`)
  check('the target was never in danger of dying', !target.dead)
}

// --- 5. A spinal gun -------------------------------------------------------------------------------------

{
  const base = UNIT['d-ion']
  const lance = { ...base, hardpoints: base.hardpoints.map((h, i) => (i === 0 ? { ...h, weapon: spinal(h.weapon!, 10) } : { ...h, weapon: undefined })) }
  check('a spinal gun is fixed along the keel', Math.abs(lance.hardpoints[0].weapon!.arc! - (10 * Math.PI) / 180) < 1e-12 && lance.hardpoints[0].weapon!.spinal === true)
  check('its mount doesn\'t turn on the model', buildModel(lance).mounts[0].turns === false)
  const w = empty()
  const { x, y } = mid()
  // Nose to +x, the enemy straight behind it, and it can't turn.
  const s = put(w, 'd-ion', 0, x, y, 0, { ...lance, turn: 0 })
  const e = put(w, 'd-frigate', 1, x - 450, y, 0, { ...unarmed(UNIT['d-frigate']), hull: 1e9 })
  const behind = shotsBy(w, s, 6).length
  check('it holds its fire at an enemy behind it', behind === 0, `${behind} shots`)
  s.a = Math.PI
  const ahead = shotsBy(w, s, 6).length
  check('and fires once its nose is on it', ahead > 0, `${ahead} shots`)
  // Turned away again and free to turn: an attack order swings the hull round to fire.
  s.t = lance
  s.a = 0
  cmdAttack(w, 0, [s.id], e.id)
  const ordered = shotsBy(w, s, 20).length
  const off = Math.abs(wrap(s.a - Math.atan2(e.y - s.y, e.x - s.x)))
  check('ordered to attack, it turns to bring the gun to bear', ordered > 0 && off < 0.2, `${ordered} shots, ${off.toFixed(2)} rad off the target`)
}

// --- 6. No shields -----------------------------------------------------------------------------------------

/** A warship with no shields and no shield generators. */
const bare = (id: string): UnitType => {
  const t = UNIT[id]
  return { ...t, shield: 0, regen: 0, hardpoints: t.hardpoints.filter((h) => h.kind !== 'shield') }
}
{
  const w = empty()
  const { x, y } = mid()
  w.players[1].techs.push('d-fr-plate')
  const n = put(w, 'd-frigate', 1, x, y, Math.PI, bare('d-frigate'))
  n.mods = { ...n.mods, shield: 1.3, regen: 1.3 }
  put(w, 'd-ion', 0, x - 500, y, 0)
  put(w, 'r-gunship', 0, x - 220, y + 60, 0)
  let worst = 0
  run(w, 20, () => (worst = Math.max(worst, n.shield)))
  check('a ship without shields never has any', worst === 0 && shieldFull(n) === 0 && shieldMax(n) === 0)
  check('its hull takes the fire', n.dead || n.hull < n.hullMax)
  check('nothing turns NaN', w.units.every((u) => Number.isFinite(u.hull) && Number.isFinite(u.shield) && Number.isFinite(u.x)))

  // The AI plays a battle with its warships shieldless.
  const v = newWorld(map, [{ faction: 'swarm', team: 0, spawn: 0 }, { faction: 'droid', team: 1, spawn: 1 }], { seed: 9, credits: 6000 })
  for (const u of v.units) if (u.owner === 0 && u.t.tier !== 'station' && u.t.kind !== 'wing') (u.t = bare(u.t.id)), (u.shield = 0)
  const brains = [newBrain(0, 'hard'), newBrain(1, 'hard')]
  let threw = ''
  try {
    for (let i = 0; i < Math.round(180 / STEP) && v.winner === -1; i++) {
      for (const b of brains) think(v, b, STEP)
      tick(v)
      v.events.length = 0
    }
  } catch (err) {
    threw = (err as Error).stack ?? String(err)
  }
  check('the AI plays three minutes with shieldless warships', !threw && v.units.every((u) => Number.isFinite(u.hull) && Number.isFinite(u.shield)), threw.split('\n').slice(0, 3).join(' '))
}

// --- 7. Determinism ----------------------------------------------------------------------------------------

/** A battle with every mechanic on at once: living hulls, a drain, fire control, a spinal gun, a
 * shield projector. */
function mixed(): World {
  const w = empty()
  const { x, y } = mid()
  put(w, 's-frigate', 0, x, y, 0, { ...UNIT['s-frigate'], regrow: { rate: 0.03, delay: 3 } })
  put(w, 's-corvette', 0, x - 200, y + 150, 0, { ...UNIT['s-corvette'], drain: { radius: 450, dps: 25, heal: 0.6 } })
  put(w, 'd-battleship', 1, x + 700, y, Math.PI, { ...UNIT['d-battleship'], fireControl: { radius: 700, bonus: 0.25 } })
  const base = UNIT['d-ion']
  put(w, 'd-ion', 1, x + 600, y + 200, Math.PI, { ...base, hardpoints: base.hardpoints.map((h, i) => (i === 0 ? { ...h, weapon: spinal(h.weapon!, 12) } : h)) })
  put(w, 'd-frigate', 1, x + 650, y - 200, Math.PI)
  put(w, 'r-destroyer', 1, x + 800, y + 100, Math.PI, { ...UNIT['r-destroyer'], shieldAura: { radius: 600, regen: 1 } })
  for (const u of w.units) u.stance = 'roam'
  return w
}
{
  const a = mixed()
  const b = mixed()
  run(a, 60)
  run(b, 30)
  const c = restoreWorld(snapshotWorld(b))!
  run(b, 30)
  run(c, 30)
  check('the same battle twice ends the same', stateHash(a) === stateHash(b), `${stateHash(a)} / ${stateHash(b)}`)
  check('and frozen and thawed halfway too', stateHash(a) === stateHash(c), `${stateHash(c)}`)
  check('something happened in it', a.units.some((u) => u.hull < u.hullMax) || a.units.length < 5)
}

// --- 8. Research for the mechanics ---------------------------------------------------------------------

/** Test research for unit type `forId`, researched by player `o` of `w` (added to the table for this
 * check only: no faction has it as written). Units spawned after it carry it. */
let testTechs = 0
function research(w: World, o: number, forId: string, effect: TechEffect) {
  const id = `test-${++testTechs}`
  TECH[id] = { id, faction: w.players[o].faction, for: forId, name: id, blurb: '', cost: 0, time: 0, level: 1, effect }
  w.players[o].techs.push(id)
}
{
  // shieldDamage: shields take 50% more, and the shot is spent by what they took.
  const w = empty(['republic', 'droid'])
  const { x, y } = mid()
  research(w, 0, 'r-frigate', { shieldDamage: 0.5 })
  const gunner = put(w, 'r-frigate', 0, x, y, 0)
  const plain = put(w, 'r-frigate', 1, x, y + 2000, 0)
  const target = put(w, 'd-frigate', 1, x + 450, y, Math.PI, { ...unarmed(UNIT['d-frigate']), hull: 1e6, shield: 1e6 })
  check('shieldDamage research is on the unit', gunner.mods.shieldDamage === 1.5 && plain.mods.shieldDamage === undefined)
  const shots = shotsBy(w, gunner, 6)
  check('its shots carry it', shots.length > 0 && shots.every((q) => q.sh === 1.5), `${shots.length} shots`)
  const v = empty(['republic', 'droid'])
  const t1 = put(v, 'd-frigate', 1, x, y, 0, unarmed(UNIT['d-frigate']))
  t1.shield = 1000
  damage(v, t1, 100, 'laser', -1, x - 100, y, 0, 0, 1.5)
  check('a shield takes `shieldDamage` more of a bolt', t1.shield === 850, `${t1.shield} left of 1000`)
  t1.shield = 30
  const h0 = t1.hull
  damage(v, t1, 100, 'laser', -1, x - 100, y, 0, 0, 1.5)
  check('and the hull gets what the shield didn\'t use up', t1.shield === 0 && near(h0 - t1.hull, 80, 1e-9), `${(h0 - t1.hull).toFixed(2)} on the hull, want 80`)
  t1.shield = 1000
  damage(v, t1, 100, 'ion', -1, x - 100, y, 0, 0, 1)
  check('without it, ion still bites twice as deep into shields', t1.shield === 800)
}
{
  // aura and auraRadius: a stronger, wider fire-control aura.
  const w = empty()
  const { x, y } = mid()
  research(w, 0, 'd-battleship', { aura: 0.1, auraRadius: 0.5 })
  const gunner = put(w, 'd-frigate', 0, x, y, 0)
  put(w, 'd-defense', 1, x + 450, y, 0, { ...unarmed(UNIT['d-defense']), hull: 1e9 })
  // 800 from the gunner: out of the written 600, inside the researched 900.
  const tyrant = put(w, 'd-battleship', 0, x - 800, y, 0, { ...unarmed(UNIT['d-battleship']), fireControl: { radius: 600, bonus: 0.5 } })
  const a = auraOf(tyrant)!
  check('aura research adds to the bonus and widens the reach', near(a.bonus, 0.6, 1e-12) && near(a.radius, 900, 1e-9), `${a.bonus}, ${a.radius}`)
  const on = shotsBy(w, gunner, 8).filter((q) => q.kind === 'turbo').map((q) => q.dmg)
  tyrant.x = tyrant.ax = x - 800
  tyrant.y = tyrant.ay = y - 2500
  const off = shotsBy(w, gunner, 8).filter((q) => q.kind === 'turbo').map((q) => q.dmg)
  check('a ship in the wider reach hits the researched bonus harder', on.length > 0 && off.length > 0 && near(on[0] / off[0], 1.6, 1e-9), `${on[0]} against ${off[0]}`)
}
{
  // regrow and regrowDelay: grows twice as fast, after half the wait.
  const w = empty()
  const { x, y } = mid()
  research(w, 0, 's-frigate', { regrow: 1, regrowDelay: -0.5 })
  const u = put(w, 's-frigate', 0, x, y, 0, { ...UNIT['s-frigate'], regrow: { rate: 0.05, delay: 5 } })
  const g = regrowOf(u)!
  check('regrow research speeds the regrowth and shortens the wait', near(g.rate, 0.1, 1e-12) && near(g.delay, 2.5, 1e-12), `${g.rate}, ${g.delay}`)
  u.hull = u.hullMax * 0.5
  u.lastHit = w.time
  run(w, 2.3)
  check('no growth before the shorter wait is out', u.hull === u.hullMax * 0.5)
  run(w, 1.2)
  check('then twice the written rate', near(u.hull / u.hullMax, 0.6, 0.012), `${(u.hull / u.hullMax).toFixed(3)}, want 0.6`)
}
{
  // drain and drainHeal: bites harder, heals more of it.
  const w = empty()
  const { x, y } = mid()
  research(w, 0, 's-corvette', { drain: 0.5, drainHeal: 0.5 })
  const leech = put(w, 's-corvette', 0, x, y, 0, { ...unarmed(UNIT['s-corvette']), drain: { radius: 500, dps: 40, heal: 0.5 } })
  const ally = put(w, 's-frigate', 0, x - 250, y, 0, { ...unarmed(UNIT['s-frigate']), regrow: undefined })
  const foe = put(w, 'd-frigate', 1, x + 250, y, Math.PI, unarmed(UNIT['d-frigate']))
  ally.hull = ally.hullMax * 0.2
  const d = drainOf(leech)!
  check('drain research strengthens the bite and the heal', d.dps === 60 && near(d.heal, 0.75, 1e-12), `${d.dps}, ${d.heal}`)
  run(w, 0.3)
  const f0 = foe.hull
  const a0 = ally.hull
  run(w, 3)
  check('an enemy in reach loses the researched dps', near(f0 - foe.hull, 180, 3), `${(f0 - foe.hull).toFixed(1)}, want 180`)
  check('and our damaged ship gets the researched share', near(ally.hull - a0, 0.75 * (f0 - foe.hull), 1.5), `${(ally.hull - a0).toFixed(1)}`)
}
{
  // The station's regrow research (Rapid regrowth) reaches every living hull of the side, ships
  // already out included, on top of their own.
  const w = newWorld(map, [{ faction: 'swarm', team: 0, spawn: 0 }, { faction: 'droid', team: 1, spawn: 1 }], { seed: 3, credits: 99999 })
  const p = w.players[0]
  const { x, y } = mid()
  const out = put(w, 's-frigate', 0, x, y, 0)
  p.level = 3
  p.techs.push(...(TECH['s-hv-regrow'].requires ?? []))
  check('Rapid regrowth can be researched', cmdResearch(w, 0, 's-hv-regrow') === null)
  run(w, TECH['s-hv-regrow'].time + 2)
  const g = regrowOf(out)!
  const st = regrowOf(w.byId.get(p.station)!)!
  const want = UNIT['s-frigate'].regrow!
  check('a ship already out regrows faster and sooner', p.techs.includes('s-hv-regrow') && near(g.rate, want.rate * 1.5, 1e-12) && near(g.delay, want.delay * 0.7, 1e-12), `${g.rate}, ${g.delay}`)
  check('and so does the station itself', near(st.rate, STATIONS.swarm.regrow!.rate * 1.5, 1e-12), `${st.rate}`)
  const fresh = put(w, 's-cruiser', 0, x, y + 500, 0)
  check('and a ship grown after it', near(regrowOf(fresh)!.rate, UNIT['s-cruiser'].regrow!.rate * 1.5, 1e-12))
}
{
  // fleetBuild on the station: every ship is built faster, on top of its own build research.
  const w = newWorld(map, [{ faction: 'republic', team: 0, spawn: 0 }, { faction: 'droid', team: 1, spawn: 1 }], { seed: 3, credits: 99999 })
  const p = w.players[0]
  research(w, 0, 'r-station', { fleetBuild: -0.25 })
  research(w, 0, 'r-gunship', { build: -0.1 })
  check('a gunship can be ordered', cmdBuild(w, 0, 'r-gunship') === null)
  check('a fighter squadron can be ordered', cmdBuild(w, 0, 'r-fighter') === null)
  const q = [...(w.byId.get(p.station)?.yq ?? []), ...p.queue]
  const gun = q.find((i) => i.unit === 'r-gunship')
  const fig = q.find((i) => i.unit === 'r-fighter')
  check('fleetBuild speeds every ship, added to its own build research', !!gun && !!fig && near(gun.total, UNIT['r-gunship'].build * 0.65, 1e-9) && near(fig.total, UNIT['r-fighter'].build * 0.75, 1e-9), `${gun?.total} and ${fig?.total}`)
}

// --- 9. A shield-projector aura ----------------------------------------------------------------------------

/** Shield points `u` recharges over `secs`, from empty, kept in the fight (so the out-of-combat
 * doubling stays off) and with its shields not rebooting. */
function recharge(w: World, us: Unit[], secs: number): number[] {
  for (const u of us) {
    u.shield = 0
    u.shieldOut = -99
  }
  run(w, secs, () => {
    for (const u of us) u.lastHit = w.time
  })
  return us.map((u) => u.shield)
}
{
  const w = empty(['republic', 'droid'])
  const { x, y } = mid()
  const projector = (regen: number) => ({ ...unarmed(UNIT['r-destroyer']), shieldAura: { radius: 600, regen } })
  const inReach = { x: x - 300, y }
  const away = { x: x - 300, y: y - 2500 }
  const moveTo = (u: Unit, p: { x: number; y: number }) => ((u.x = u.ax = p.x), (u.y = u.ay = p.y))
  const sentinel = put(w, 'r-destroyer', 0, inReach.x, inReach.y, 0, projector(1))
  const lesser = put(w, 'r-destroyer', 0, away.x, away.y, 0, projector(0.5))
  const ally = put(w, 'r-frigate', 0, x, y, 0, unarmed(UNIT['r-frigate']))
  const foe = put(w, 'd-frigate', 1, x, y + 250, Math.PI, unarmed(UNIT['d-frigate']))
  const far = put(w, 'r-frigate', 0, x + 2000, y, 0, unarmed(UNIT['r-frigate']))
  const base = (u: Unit) => u.t.regen * u.mods.regen * 2
  const [a1, f1, x1, s1] = recharge(w, [ally, foe, far, sentinel], 2)
  check('a ship of ours in reach recharges `regen` faster', near(a1, base(ally) * 2, base(ally) * 2 * 0.03), `${a1.toFixed(1)} in 2 s, want ${base(ally) * 2}`)
  check('the projector itself too', near(s1, base(sentinel) * 2, base(sentinel) * 2 * 0.03), `${s1.toFixed(1)}`)
  check('an enemy in reach doesn\'t', near(f1, base(foe), base(foe) * 0.03), `${f1.toFixed(1)}, want ${base(foe)}`)
  check('a ship of ours out of reach doesn\'t', near(x1, base(far), base(far) * 0.03), `${x1.toFixed(1)}`)
  moveTo(lesser, { x: inReach.x, y: inReach.y + 150 })
  const [both] = recharge(w, [ally], 2)
  check('two auras don\'t stack: the best counts', near(both, base(ally) * 2, base(ally) * 2 * 0.03), `${both.toFixed(1)}`)
  moveTo(sentinel, away)
  const [weaker] = recharge(w, [ally], 2)
  check('the weaker aura alone gives its own boost', near(weaker, base(ally) * 1.5, base(ally) * 1.5 * 0.03), `${weaker.toFixed(1)}, want ${base(ally) * 1.5}`)
  // Its projectors all shot off: nothing.
  for (let i = 0; i < lesser.t.hardpoints.length; i++) if (lesser.t.hardpoints[i].kind === 'shield') lesser.hps[i].hp = 0
  const [none] = recharge(w, [ally], 2)
  check('with every projector shot off it projects nothing', near(none, base(ally), base(ally) * 0.03), `${none.toFixed(1)}, want ${base(ally)}`)
  lesser.hps[lesser.t.hardpoints.findIndex((h) => h.kind === 'shield')].hp = 50
  const [one] = recharge(w, [ally], 2)
  check('one projector standing is enough', near(one, base(ally) * 1.5, base(ally) * 1.5 * 0.03), `${one.toFixed(1)}`)
  check('the Sentinel destroyer has a projector as written', !!UNIT['r-destroyer'].shieldAura && UNIT['r-destroyer'].hardpoints.some((h) => h.look === 'projector'))
}
{
  // shieldAura and auraRadius research: a stronger, wider shield projector.
  const w = empty(['republic', 'droid'])
  const { x, y } = mid()
  research(w, 0, 'r-destroyer', { shieldAura: 0.5, auraRadius: 0.5 })
  const ally = put(w, 'r-frigate', 0, x, y, 0, unarmed(UNIT['r-frigate']))
  // 800 from the ally: out of the written 600, inside the researched 900.
  const s = put(w, 'r-destroyer', 0, x - 800, y, 0, { ...unarmed(UNIT['r-destroyer']), shieldAura: { radius: 600, regen: 1 } })
  const a = shieldAuraOf(s)!
  check('shieldAura research adds to the regen and auraRadius widens the reach', near(a.regen, 1.5, 1e-12) && near(a.radius, 900, 1e-9), `${a.regen}, ${a.radius}`)
  const [got] = recharge(w, [ally], 2)
  const want = ally.t.regen * ally.mods.regen * 2 * 2.5
  check('a ship in the wider reach recharges the researched boost faster', near(got, want, want * 0.03), `${got.toFixed(1)}, want ${want}`)
}

console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
