// Checks Empires At War's defense stations in skirmishes (the Galactic conquest stations, put up by
// engineers round the Command Station), headless and deterministic:
//
//   node scripts/empires-sk-defense.ts
//
// - The lobby's limit: Off hides them (refused by the sim and by the protocol, none for the AI); a
//   limit of X counts the ones going up too, and frees up when one is lost; matches and lobbies
//   without the field get the default.
// - Placement: inside the build radius, clear of the station, ore and the map's edge, with room for
//   the size it grows to.
// - Levels need the station's level; slots 1, 2 and 4; a module fitted, swapped, refused where it
//   doesn't fit; work called off is refunded, and so is work lost with the station.
// - In combat: a battery fires, a shield generator gives shields, a hangar launches its squadron,
//   the Swarm's regeneration pool adds hull and regrowth.
// - A repair crew (and engineers) rebuild shot-off modules.
// - The AI builds them within the limit, and none when they're off.
// - On a map with five or six spawns: every player has its own limit; the admirals build within it,
//   each round its own station.
// - A battle saved before them (no `defense` in the world) loads with them off; one saved with
//   stations standing and work under way carries on in step.
//
// Every check prints a line; it exits with 1 if any of them failed.

import { BUILD_RADIUS, DEFENSE_DEFAULT, ORBITALS, REBUILD_MODULE, defenseId, defenseModTime, defenseTime, orbitalMod, orbitalSlots, type FactionId } from '../src/apps/games/empires/data.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { cleanCmd } from '../src/apps/games/empires/commands.ts'
import { matchWorld, type MatchInfo } from '../src/apps/games/empires/match.ts'
import { newBrain, think } from '../src/apps/games/empires/ai.ts'
import { DEFAULT_RULES } from '../src/apps/games/empires/maps.ts'
import {
  REPAIR_TIME, STEP, cantFortify, cmdCancelFort, cmdFortFit, cmdFortUp, cmdPlace, cmdRepair, cmdConstruct, damage, defenseCap, defensesOf, fortLock, newWorld, placement, spawn, spawnGroup, stateHash, tick,
  type Unit, type World,
} from '../src/apps/games/empires/sim.ts'

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}

const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const fresh = (defense?: number, factions: [FactionId, FactionId] = ['republic', 'droid']): World => {
  const w = newWorld(map, [
    { faction: factions[0], team: 0, spawn: 0 },
    { faction: factions[1], team: 1, spawn: 1 },
  ], { seed: 77, credits: 30000, ...(defense !== undefined ? { defense } : {}) })
  for (const p of w.players) p.level = 3
  return w
}
const run = (w: World, secs: number, until?: () => boolean) => {
  for (let t = 0; t < secs / STEP; t++) {
    tick(w)
    w.events.length = 0
    if (until?.()) return true
  }
  return false
}
const st = (w: World, o = 0) => w.byId.get(w.players[o].station)!
const prefix = (w: World, o: number) => ({ republic: 'r', droid: 'd', swarm: 's' })[w.players[o].faction]
const engineers = (w: World, o = 0, n = 1) => {
  const s = st(w, o)
  return Array.from({ length: n }, (_, i) => spawnGroup(w, `${prefix(w, o)}-engineer`, o, s.x + 250, s.y + 60 * i, 0)).flat()
}
const ids = (us: Unit[]) => us.map((u) => u.id)
/** Spots for a defense station round the station, the first `n` that fit (each clear of the ones before). */
const spots = (w: World, o = 0, n = 1, skip: { x: number; y: number }[] = []) => {
  const s = st(w, o)
  const out: { x: number; y: number }[] = []
  const toward = Math.atan2(w.h / 2 - s.y, w.w / 2 - s.x)
  for (let d = 600; d < 1700 && out.length < n; d += 90)
    for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.4, -2.4, 3]) {
      if (out.length >= n) break
      const x = s.x + Math.cos(toward + off) * d
      const y = s.y + Math.sin(toward + off) * d
      if ([...out, ...skip].some((q) => Math.hypot(q.x - x, q.y - y) < 700)) continue
      if (!placement(w, o, defenseId(w.players[o].faction), x, y).why) out.push({ x, y })
    }
  if (out.length < n) throw new Error('no spot for a defense station')
  return out
}
/** A defense station of ours, built: placed, welded up by two squadrons. */
const built = (w: World, o = 0) => {
  const at = spots(w, o, 1, defensesOf(w, o))[0]
  const e = engineers(w, o, 2)
  const why = cmdPlace(w, o, ids(e), defenseId(w.players[o].faction), at.x, at.y)
  if (why) throw new Error(why)
  const u = defensesOf(w, o).find((x) => x.site)!
  run(w, 120, () => !u.site)
  return u
}
const finish = (w: World, u: Unit) => run(w, 120, () => !u.dq?.length)

// --- Off, and the limit ----------------------------------------------------------------------------------
{
  const w = fresh(0)
  const at = spots(fresh(), 0)[0]
  const eng = engineers(w)
  check('Off: no defense stations in this battle', defenseCap(w) === 0 && (fortLock(w, 0) ?? '').includes('off'), fortLock(w, 0) ?? 'allowed')
  check('Off: placing one is refused', (placement(w, 0, defenseId('republic'), at.x, at.y).why ?? '').includes('off') && cmdPlace(w, 0, ids(eng), defenseId('republic'), at.x, at.y) !== null && !defensesOf(w, 0).length)
  check('Off: the orders never pass the protocol', !cleanCmd({ f: 'place', a: [ids(eng), 'r-orbital', at.x, at.y, false] }, w) && !cleanCmd({ f: 'fortUp', a: [1] }, w) && !cleanCmd({ f: 'fortFit', a: [1, 0, 'flak'] }, w) && !cleanCmd({ f: 'cancelFort', a: [1, 0] }, w))
  const on = fresh()
  check('a new battle has the default limit', defenseCap(on) === DEFENSE_DEFAULT && DEFENSE_DEFAULT === 2)
  check('on: the orders pass the protocol', !!cleanCmd({ f: 'place', a: [ids(eng), 'r-orbital', at.x, at.y, false] }, on) && !!cleanCmd({ f: 'fortFit', a: [1, 0, 'flak'] }, on) && !cleanCmd({ f: 'fortFit', a: [1, 0, 'laser'] }, on) && !cleanCmd({ f: 'place', a: [ids(eng), 'x-orbital', at.x, at.y, false] }, on))
  const info = (stations?: number): MatchInfo => ({ id: 'x', seed: 5, map: map.id, gen: { ...DEFAULT_RULES }, credits: 1600, seats: [
    { kind: 'human', player: 'a', name: 'A', faction: 'republic', team: 0, spawn: 0, difficulty: 'medium' },
    { kind: 'ai', player: '', name: 'B', faction: 'droid', team: 1, spawn: 1, difficulty: 'medium' },
  ], ...(stations !== undefined ? { stations } : {}) })
  check('a match without the field gets the default', defenseCap(matchWorld(info())) === DEFENSE_DEFAULT)
  check('a match with them off has none', defenseCap(matchWorld(info(0))) === 0 && defenseCap(matchWorld(info(6))) === 6)
  check('a tampered limit falls back to the default', defenseCap(matchWorld(info(5))) === DEFENSE_DEFAULT && defenseCap(matchWorld(info(-1))) === DEFENSE_DEFAULT)
}
{
  const w = fresh(2)
  const [a, b, c] = spots(w, 0, 3)
  const eng = engineers(w)
  const id = defenseId('republic')
  const cost = ORBITALS.republic.stages[0].cost
  const c0 = w.players[0].credits
  check('engineers place a defense station', cmdPlace(w, 0, ids(eng), id, a.x, a.y) === null && defensesOf(w, 0).length === 1)
  check('it is paid for when placed', w.players[0].credits === c0 - cost, `${c0} -> ${w.players[0].credits}`)
  check('a second one too', cmdPlace(w, 0, ids(eng), id, b.x, b.y, true) === null && defensesOf(w, 0).length === 2)
  const why = placement(w, 0, id, c.x, c.y).why ?? ''
  check('the limit counts the ones going up', why.includes('2/2') && cmdPlace(w, 0, ids(eng), id, c.x, c.y) !== null, why)
  check('the build card says why', (fortLock(w, 0) ?? '').includes('2/2'))
  const site = defensesOf(w, 0)[0]
  damage(w, site, 1e9, 'turbo', -1, site.x, site.y, 1)
  run(w, 0.2)
  check('one lost frees a place, and leaves no ruin', defensesOf(w, 0).length === 1 && !placement(w, 0, id, c.x, c.y).why && !(w.ruins ?? []).length)
  const one = fresh(1)
  const e1 = engineers(one)
  const [p1, p2] = spots(one, 0, 2)
  cmdPlace(one, 0, ids(e1), id, p1.x, p1.y)
  check('a limit of 1 allows one', cmdPlace(one, 0, ids(e1), id, p2.x, p2.y) !== null && defensesOf(one, 0).length === 1)
  check('each player has a limit of their own', !placement(one, 1, 'd-orbital', ...(() => { const q = spots(one, 1)[0]; return [q.x, q.y] as const })()).why)
}

// --- Placement --------------------------------------------------------------------------------------------
{
  const w = fresh()
  const s = st(w)
  const id = defenseId('republic')
  const ok = spots(w)[0]
  check('a spot inside the radius is valid', placement(w, 0, id, ok.x, ok.y).why === null)
  const d = Math.hypot(ok.x - s.x, ok.y - s.y)
  const far = { x: s.x + ((ok.x - s.x) / d) * 2400, y: s.y + ((ok.y - s.y) / d) * 2400 }
  check('outside the radius is refused', (placement(w, 0, id, far.x, far.y).why ?? '').includes('build radius'), placement(w, 0, id, far.x, far.y).why ?? 'allowed')
  check('on the station is refused', (placement(w, 0, id, s.x + 40, s.y).why ?? '').includes('structure'))
  w.nodes.push({ ...w.nodes[0], id: w.nodes.length, x: ok.x + 60, y: ok.y })
  check('on ore is refused', (placement(w, 0, id, ok.x, ok.y).why ?? '').includes('ore'))
  w.nodes.pop()
  check('at the map edge is refused', !!placement(w, 0, id, 30, 30).why)
  check('the enemy can\'t build in our radius', !!placement(w, 1, 'd-orbital', ok.x, ok.y).why)
  check('nor ours', (placement(w, 1, id, ok.x, ok.y).why ?? '').includes('can\'t be built'))
  const e = engineers(w)
  cmdPlace(w, 0, ids(e), id, ok.x, ok.y)
  // Room for its last level: another one just past its first level's footprint is too close.
  const l1 = defensesOf(w, 0)[0]
  const near = { x: ok.x + l1.t.size * 0.9, y: ok.y }
  check('it keeps room for the size it grows to', (placement(w, 0, id, near.x, near.y).why ?? '').includes('structure'), placement(w, 0, id, near.x, near.y).why ?? 'allowed')
  check('so does a yard placed next to it', (placement(w, 0, 'r-yard', near.x, near.y).why ?? '').length > 0)
  const other = spots(w, 0, 1, [ok])[0]
  w.players[0].credits = 10
  check('without the credits it is refused', (placement(w, 0, id, other.x, other.y).why ?? '') === 'Not enough credits')
}

// --- Building, levels, slots, modules --------------------------------------------------------------------
{
  const w = fresh()
  const p = w.players[0]
  const u = built(w)
  check('two squadrons weld it up', !u.site && u.building === 0, `${u.t.name}`)
  check('it goes up at level 1 with one empty slot', u.t.orbital?.level === 1 && u.t.orbital.slots.length === 1 && u.t.orbital.slots[0] === null && u.t.hardpoints.length === 0)
  check('its build time is the galaxy\'s over SHIP_TIME', u.t.build === defenseTime('republic', 1) && defenseTime('republic', 1) === Math.round(ORBITALS.republic.stages[0].time / 1.5), `${u.t.build} s`)
  check('slot 2 needs level 2', (cantFortify(w, 0, u.id, { k: 'mod', slot: 1, mod: 'flak' }) ?? '').includes('level 2'))
  p.level = 1
  check('level 2 needs station level 2', (cantFortify(w, 0, u.id, { k: 'up' }) ?? '').includes('station level 2'))
  p.level = 2
  const c0 = p.credits
  check('a battery goes into slot 1', cmdFortFit(w, 0, u.id, 0, 'battery') === null && p.credits === c0 - orbitalMod('republic', 'battery').cost)
  check('the same slot can\'t take two at once', (cantFortify(w, 0, u.id, { k: 'mod', slot: 0, mod: 'flak' }) ?? '').includes('already'))
  check('the upgrade queues behind it', cmdFortUp(w, 0, u.id) === null && u.dq?.length === 2)
  check('a slot the queued upgrade brings may be fitted', cmdFortFit(w, 0, u.id, 1, 'flak') === null && u.dq?.length === 3)
  check('the queue holds three', (() => {
    const w3 = fresh()
    const q = built(w3)
    cmdFortUp(w3, 0, q.id)
    finish(w3, q)
    cmdFortUp(w3, 0, q.id)
    finish(w3, q)
    for (const s of [0, 1, 2]) cmdFortFit(w3, 0, q.id, s, 'flak')
    return q.dq?.length === 3 && (cantFortify(w3, 0, q.id, { k: 'mod', slot: 3, mod: 'flak' }) ?? '').includes('full')
  })())
  check('the battery takes its time', u.dq![0].total === defenseModTime('republic', 'battery'))
  finish(w, u)
  check('level 2: two slots, battery and flak fitted', u.t.orbital?.level === 2 && orbitalSlots(2) === 2 && u.t.orbital.slots.join() === 'battery,flak' && u.guns.length === 2, u.t.orbital?.slots.join())
  check('its hull grew with the level', u.hullMax > ORBITALS.republic.stages[0].hull * 1.3 && u.hull > u.hullMax * 0.9, `${Math.round(u.hull)} / ${Math.round(u.hullMax)}`)
  check('level 3 needs station level 3', (cantFortify(w, 0, u.id, { k: 'up' }) ?? '').includes('station level 3'))
  p.level = 3
  cmdFortUp(w, 0, u.id)
  finish(w, u)
  check('level 3: four slots', u.t.orbital?.level === 3 && u.t.orbital.slots.length === 4 && orbitalSlots(3) === 4)
  check('no level 4', (cantFortify(w, 0, u.id, { k: 'up' }) ?? '').includes('highest'))
  cmdFortFit(w, 0, u.id, 2, 'launcher')
  cmdFortFit(w, 0, u.id, 3, 'shield')
  finish(w, u)
  check('all four slots fitted', u.t.orbital?.slots.join() === 'battery,flak,launcher,shield' && u.t.hardpoints.length === 4)
  // Swap: flak out of slot 2 for a hangar.
  const keyBefore = u.t.hardpoints.map((h) => h.key).join()
  check('a filled slot takes a swap', cmdFortFit(w, 0, u.id, 1, 'hangar') === null)
  check('the same module is refused', (cantFortify(w, 0, u.id, { k: 'mod', slot: 0, mod: 'battery' }) ?? '').includes('Already fitted'))
  finish(w, u)
  check('the swap replaced it', u.t.orbital?.slots[1] === 'hangar' && u.t.hardpoints.map((h) => h.key).join() !== keyBefore && u.t.hardpoints.some((h) => h.key === 's1:hangar') && !u.t.hardpoints.some((h) => h.key === 's1:flak'))
  // Cancelling: a full refund; an upgrade called off takes the modules waiting for it with it.
  const w2 = fresh()
  const v = built(w2)
  const c1 = w2.players[0].credits
  cmdFortUp(w2, 0, v.id)
  cmdFortFit(w2, 0, v.id, 1, 'flak')
  check('calling off the upgrade refunds it and the module waiting for its slot', cmdCancelFort(w2, 0, v.id, 0) === null && !v.dq?.length && w2.players[0].credits === c1)
  check('the enemy can\'t call ours off', (() => { cmdFortUp(w2, 0, v.id); return cmdCancelFort(w2, 1, v.id, 0) !== null && v.dq?.length === 1 })())
  damage(w2, v, 1e9, 'turbo', -1, v.x, v.y, 1)
  run(w2, 0.2)
  const back = w2.players[0].ledger.find((x) => x.what.startsWith('Lost with the station'))
  check('work lost with the station is paid back', v.dead && back?.amount === ORBITALS.republic.stages[1].cost, back ? `+${back.amount}` : 'no refund')
}

// --- In combat ---------------------------------------------------------------------------------------------
const armed = (w: World, mods: ('battery' | 'flak' | 'launcher' | 'shield' | 'hangar')[], o = 0) => {
  const u = built(w, o)
  cmdFortUp(w, o, u.id)
  finish(w, u)
  cmdFortUp(w, o, u.id)
  finish(w, u)
  mods.forEach((m, s) => cmdFortFit(w, o, u.id, s, m))
  finish(w, u)
  return u
}
{
  const w = fresh()
  const u = armed(w, ['battery', 'shield', 'hangar', 'launcher'])
  check('a shield generator gives it shields', u.t.shield === Math.round(1400 * 1.15) && u.t.orbital?.slots.includes('shield'), `${u.t.shield}`)
  const s0 = u.shield
  run(w, 10)
  check('they charge up', u.shield > s0, `${Math.round(s0)} -> ${Math.round(u.shield)}`)
  check('a hangar launches its squadron', run(w, 5, () => w.units.some((f) => f.parent === u.id && !f.dead)) && w.units.filter((f) => f.parent === u.id).every((f) => f.t.id === 'r-fighter'))
  const foe = spawn(w, 'd-frigate', 1, u.x + 500, u.y, 0)
  foe.stance = 'hold'
  const h0 = foe.hull + foe.shield
  run(w, 8)
  check('the battery and launcher fire on an enemy frigate in reach', foe.dead || foe.hull + foe.shield < h0 - 200, `${Math.round(h0)} -> ${Math.round(foe.hull + foe.shield)}`)
  // Shot off: the shields go.
  const sh = u.t.hardpoints.findIndex((h) => h.kind === 'shield')
  damage(w, u, u.shield + u.hps[sh].hp + 5, 'turbo', sh, u.x, u.y, 1)
  check('a shield generator shot off takes the shields with it', u.hps[sh].hp <= 0 && u.shield === 0)
  // A repair crew rebuilds it.
  const p = w.players[0]
  const rwhy = cmdRepair(w, 0, u.id)
  check('a repair crew can be sent', rwhy === null, rwhy ?? '')
  run(w, REPAIR_TIME + 1)
  check('it rebuilds every shot-off module', u.hps.every((h) => h.hp === h.max) && u.hull === u.hullMax)
  // Engineers rebuild one too, for part of its price.
  const bat = u.t.hardpoints.findIndex((h) => h.key === 's0:battery')
  u.hps[bat].hp = 0
  const e = engineers(w)
  cmdConstruct(w, 0, ids(e), u.id)
  check('engineers weld a shot-off module back', run(w, 90, () => u.hps[bat].hp > 0))
  const paid = p.ledger.find((x) => x.what === 'Rebuilding: Turbolaser battery')
  check('for its share of its price', paid?.amount === -Math.round(orbitalMod('republic', 'battery').cost * REBUILD_MODULE), paid ? `${-paid.amount} credits` : 'not paid')
  // The Swarm's regeneration pool.
  const sw = fresh(undefined, ['swarm', 'droid'])
  const g = armed(sw, ['shield'])
  const bare = ORBITALS.swarm.stages[2].hull * 1.15
  check('the Swarm\'s pool adds hull', g.t.orbital?.slots[0] === 'shield' && g.t.hull > bare * 1.1 && g.t.shield === 0, `${g.t.hull} against ${Math.round(bare)}`)
  check('and its hull regrows faster', !!g.t.regrow && g.t.regrow.rate > (ORBITALS.swarm.regrow?.rate ?? 0))
  g.hull = g.hullMax * 0.5
  const r0 = g.hull
  run(sw, 20)
  check('it grows back out of combat', g.hull > r0, `${Math.round(r0)} -> ${Math.round(g.hull)}`)
}

// --- The AI ------------------------------------------------------------------------------------------------
const aiBattle = (defense: number, mins: number) => {
  const w = newWorld(map, [{ faction: 'republic', team: 0, spawn: 0 }, { faction: 'droid', team: 1, spawn: 1 }], { seed: 31, credits: 10000, defense })
  const brains = [newBrain(0, 'hard', 'defensive'), newBrain(1, 'medium', 'defensive')]
  let most = 0
  let built = 0
  let fitted = 0
  let ups = 0
  for (let t = 0; t < (mins * 60) / STEP && w.winner === -1; t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    for (const e of w.events) {
      if (e.k === 'built' && e.unit.endsWith('-orbital')) built++
      if (e.k === 'fortified') (e.what.endsWith('fitted') ? fitted++ : ups++)
    }
    w.events.length = 0
    if (t % 30 === 0) most = Math.max(most, ...w.players.map((_, o) => defensesOf(w, o).length))
  }
  return { most, built, fitted, ups }
}
{
  const on = aiBattle(1, 14)
  check('the AI builds defense stations', on.built > 0, `${on.built} built, ${on.fitted} modules, ${on.ups} upgrades`)
  check('it fits modules into them', on.fitted > 0)
  check('within the limit', on.most <= 1, `at most ${on.most}`)
  const off = aiBattle(0, 10)
  check('none when they are off', off.built === 0 && off.most === 0)
}

// --- A map with five or six spawns ---------------------------------------------------------------------------
{
  const big = MAPS.find((m) => m.spawns.length === 6) ?? MAPS.find((m) => m.spawns.length === 5)
  check('there is a five- or six-spawn map', !!big)
  if (big) {
    const sides: FactionId[] = ['republic', 'droid', 'swarm']
    const seats = big.spawns.map((_, i) => ({ faction: sides[i % 3], team: i % 2, spawn: i }))
    const w = newWorld(big, seats, { seed: 12, credits: 30000, defense: 2 })
    for (const p of w.players) p.level = 3
    // Every player builds up to the limit round its own station, and no further.
    let all = true
    let capped = true
    for (let o = 0; o < seats.length; o++) {
      const at = spots(w, o, 3)
      const e = engineers(w, o)
      const id = defenseId(w.players[o].faction)
      all &&= cmdPlace(w, o, ids(e), id, at[0].x, at[0].y) === null && cmdPlace(w, o, ids(e), id, at[1].x, at[1].y, true) === null
      capped &&= (cmdPlace(w, o, ids(e), id, at[2].x, at[2].y) ?? '').includes('2/2')
    }
    check(`${big.name} (${big.spawns.length} spawns): every player places two`, all && w.players.every((_, o) => defensesOf(w, o).length === 2))
    check(`${big.name}: a third is refused for each of them`, capped)
    // The admirals, all of them, with a limit of 1 each: within it, and each one inside its own build radius.
    const ai = newWorld(big, seats, { seed: 12, credits: 10000, defense: 1 })
    const brains = seats.map((_, i) => newBrain(i, 'hard', i % 2 ? 'defensive' : 'balanced'))
    let most = 0
    let far = 0
    let built = 0
    for (let t = 0; t < (12 * 60) / STEP && ai.winner === -1; t++) {
      for (const b of brains) think(ai, b, STEP)
      tick(ai)
      for (const e of ai.events) {
        if (e.k !== 'built' || !e.unit.endsWith('-orbital')) continue
        built++
        const st = ai.byId.get(ai.players[e.owner].station)
        if (st && Math.hypot(e.x - st.x, e.y - st.y) > BUILD_RADIUS + 1) far++
      }
      ai.events.length = 0
      if (t % 30 === 0) most = Math.max(most, ...ai.players.map((_, o) => defensesOf(ai, o).length))
    }
    check(`${big.name}: the admirals build them`, built > 0, `${built} built`)
    check(`${big.name}: within the limit of 1`, most <= 1, `at most ${most}`)
    check(`${big.name}: each near its own station`, far === 0, `${far} far off`)
  }
}

// --- Saved battles -----------------------------------------------------------------------------------------
{
  // From before them: no `defense` in the world.
  const w = fresh()
  const raw = JSON.parse(snapshotWorld(w))
  delete raw.defense
  const old = restoreWorld(JSON.stringify(raw))!
  check('a battle saved before them loads', !!old)
  check('with them off', defenseCap(old) === 0 && (fortLock(old, 0) ?? '').includes('off'))
  const brains = [newBrain(0, 'hard', 'defensive'), newBrain(1, 'hard', 'defensive')]
  for (let t = 0; t < (300 / STEP) && old.winner === -1; t++) {
    for (const b of brains) think(old, b, STEP)
    tick(old)
    old.events.length = 0
  }
  check('and plays on without them', old.units.every((u) => !u.t.orbital), `${(old.time / 60).toFixed(1)} min`)
  // Saved with stations standing and work under way: carries on in step.
  const a = fresh()
  const u = armed(a, ['battery', 'flak'])
  cmdFortFit(a, 0, u.id, 2, 'hangar')
  cmdFortFit(a, 0, u.id, 3, 'shield')
  run(a, 3)
  const b = restoreWorld(snapshotWorld(a))!
  const bu = b.byId.get(u.id)!
  check('a saved station keeps its level, modules and work', bu.t.orbital?.level === 3 && bu.t.orbital.slots.slice(0, 2).join() === 'battery,flak' && bu.dq?.length === 2)
  spawn(a, 'd-frigate', 1, u.x + 600, u.y, 0)
  spawn(b, 'd-frigate', 1, u.x + 600, u.y, 0)
  let same = true
  for (let t = 0; t < 60 / STEP; t++) {
    for (const w2 of [a, b]) {
      tick(w2)
      w2.events.length = 0
    }
    if (t % 30 === 0 && stateHash(a) !== stateHash(b)) {
      same = false
      break
    }
  }
  check('and carries on in step after a restore', same && b.byId.get(u.id)?.t.orbital?.slots.join() === 'battery,flak,hangar,shield')
}

if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('all skirmish defense station checks passed')
