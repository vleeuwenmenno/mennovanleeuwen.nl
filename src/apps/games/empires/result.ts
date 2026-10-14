// What a galactic conquest battle leaves of each side, as the galaxy takes it back (see applyBattle).
// No DOM, so the check scripts can use it.

import { UNIT, isShip } from './data.ts'
import { rushFromBattle, type BattleResult, type Clash, type RushedShip } from './galaxy.ts'
import { baseLeft, type World } from './sim.ts'

/** The battle that's over: who won, what's left on each side, and who jumped out. */
export function resultOf(w: World, c: Clash, meSide: number, left: boolean): BattleResult {
  const owners = [c.holder, c.attacker]
  const winSide = left ? 1 - meSide : w.winner
  const survivors: Record<number, string[]> = { [c.holder]: [], [c.attacker]: [] }
  const escaped: Record<number, string[]> = { [c.holder]: [], [c.attacker]: [] }
  // Ships still unfinished (rush-launched in the galaxy and not finished during the battle), with how far along.
  const rushed: Record<number, RushedShip[]> = { [c.holder]: [], [c.attacker]: [] }
  owners.forEach((o, side) => {
    const won = side === winSide
    const p = w.players[side]
    // A fighter squadron is one fleet entry while any of it lives.
    const squads = new Set<number>()
    for (const u of w.units) {
      if (u.dead || u.owner !== side || !isShip(u.t) || u.parent) continue
      if (u.squad) {
        if (squads.has(u.squad)) continue
        squads.add(u.squad)
      }
      const jumped = u.retreat > 0 || (!won && left && side === meSide)
      if (jumped) escaped[o].push(u.t.id)
      else if (won) survivors[o].push(u.t.id)
      else continue
      if (u.rush) rushed[o].push(rushFromBattle(u.t.id, u.rush.left))
    }
    // Ships that never made it onto the field: still with the fleet, or gone with it.
    const waiting = [...p.reserve, ...w.arrivals.filter((a) => a.owner === side).map((a) => a.unit)]
    if (won) survivors[o].push(...waiting)
    else escaped[o].push(...waiting.filter((id) => UNIT[id].tier !== 'fighter'))
    escaped[o].push(...p.escaped)
    // Those among them still unfinished: in the reserve or on their way in (they never got to be finished), or jumped out.
    const wait = [...(p.rushRes ?? []).map((r) => rushFromBattle(r.unit, r.left)), ...w.arrivals.filter((a) => a.owner === side && a.rush).map((a) => rushFromBattle(a.unit, a.rush!.left))]
    rushed[o].push(...wait.filter((r) => won || UNIT[r.unit].tier !== 'fighter'), ...(p.escapedRush ?? []).map((r) => rushFromBattle(r.unit, r.left)))
  })
  const st = w.byId.get(w.players[0].station)
  // The holder's yards still standing, and the expansions not shot off (see applyBattle).
  return { winner: owners[winSide] ?? c.holder, survivors, escaped, stationLeft: !!st && !st.dead, rushed, ...(c.base ? { base: baseLeft(w, 0, c.base.mods) } : {}) }
}
