import { DIFFICULTY, newBrain, think, type Brain, type Difficulty } from './ai.ts'
import { runCmd, type Cmd } from './commands.ts'
import type { FactionId } from './data.ts'
import { GENERATED, MAP, MAPS, defaultArea, generateMap, type MapDef, type MapRules, type Pt } from './maps.ts'
import { STEP, autoStart, newWorld, tick, type Owner, type World } from './sim.ts'

// A multiplayer battle, the same on the server and on every player's machine: how its world is
// built from the lobby, and how one turn (the orders given in one tick, then the AI, then the
// tick itself) moves it on. Both sides run exactly this, in this order, so they never drift.

export type MatchSeat = { kind: 'human' | 'ai'; player: string; name: string; faction: FactionId; team: 0 | 1; spawn: number; difficulty: Difficulty }
export type MatchInfo = { id: string; seed: number; map: string; gen: MapRules; credits: number; seats: MatchSeat[] }
/** One tick's orders, by seat, in the order the server took them. */
export type Turn = { n: number; c: [Owner, Cmd][] }

export const matchMap = (m: MatchInfo): MapDef => (m.map === GENERATED ? generateMap(m.gen) : (MAP[m.map] ?? MAPS[0]))

/** The world at tick 0. Stations start where the single-player lobby would put them by default. */
export function matchWorld(m: MatchInfo): World {
  const map = matchMap(m)
  const seat = (s: MatchSeat, at: Pt) => ({ faction: s.faction, team: s.team, spawn: s.spawn, at, incomeMul: s.kind === 'ai' ? DIFFICULTY[s.difficulty].income : 1 })
  const opts = { seed: m.seed, credits: m.credits }
  const base = newWorld(map, m.seats.map((s) => seat(s, map.spawns[s.spawn])), opts)
  const starts: Pt[] = []
  for (const s of m.seats) starts.push(autoStart(base, defaultArea(map, s.spawn), map.spawns[s.spawn], starts))
  return newWorld(map, m.seats.map((s, i) => seat(s, starts[i])), opts)
}

export const matchBrains = (m: MatchInfo): Brain[] => m.seats.flatMap((s, i) => (s.kind === 'ai' ? [newBrain(i, s.difficulty)] : []))

/** Moves the battle one tick on: the turn's orders, then the AI admirals, then the sim. `onRun`
 * hears what each order answered (a player's own refusals become toasts). */
export function stepTurn(w: World, brains: Brain[], cmds: Turn['c'], onRun?: (seat: Owner, c: Cmd, result: unknown) => void) {
  for (const [seat, c] of cmds) {
    const r = runCmd(w, seat, c)
    onRun?.(seat, c, r)
  }
  for (const b of brains) think(w, b, STEP)
  tick(w)
}
