import { DIFFICULTY, aidAllies, newBrain, profileOf, think, type Brain, type Difficulty, type Profile } from './ai.ts'
import { runCmd, type Cmd } from './commands.ts'
import { isShip, type FactionId } from './data.ts'
import { GENERATED, MAP, MAPS, defaultArea, generateMap, type MapDef, type MapRules, type Pt } from './maps.ts'
import { STEP, autoStart, newWorld, tick, type Owner, type World } from './sim.ts'

// A multiplayer battle, the same on the server and on every player's machine: how its world is
// built from the lobby, and how one turn (the orders given in one tick, then the AI, then the
// tick itself) moves it on. Both sides run exactly this, in this order, so they never drift.

/** `profile`: how an AI seat plays (ai.ts PROFILES); matches from before profiles have none, and
 * their AI seats play Balanced. Part of the match config, so every copy runs the same admirals. */
export type MatchSeat = { kind: 'human' | 'ai'; player: string; name: string; faction: FactionId; team: 0 | 1; spawn: number; difficulty: Difficulty; profile?: Profile }
export type MatchInfo = { id: string; seed: number; map: string; gen: MapRules; credits: number; seats: MatchSeat[] }
/** One tick's orders, by seat, in the order the server took them; `ai`: seats an AI admiral takes
 * over from this tick (their player left); `give`: [from, to] seats whose fleet goes to a teammate
 * from this tick (the player stepped away, and the others voted for that). */
export type Turn = { n: number; c: [Owner, Cmd][]; ai?: [Owner, Difficulty][]; give?: [Owner, Owner][] }

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

export const matchBrains = (m: MatchInfo): Brain[] => m.seats.flatMap((s, i) => (s.kind === 'ai' ? [newBrain(i, s.difficulty, profileOf(s.profile))] : []))

/** Hands every ship of seat `from` (not its station, mines or defenses) and its credits to seat
 * `to`, a teammate. The base stays with `from`, for an AI admiral to run. Fighters out of a hangar
 * that stays behind are cut loose from it. Pop and income follow by themselves (the sim counts
 * them from the units every tick). */
export function giveFleet(w: World, from: Owner, to: Owner) {
  const moved = new Set<number>()
  for (const u of w.units) {
    // The station's defense wing stays with the base.
    if (u.dead || u.owner !== from || !isShip(u.t) || u.t.kind === 'wing') continue
    u.owner = to
    moved.add(u.id)
  }
  for (const u of w.units) if (moved.has(u.id) && u.parent && !moved.has(u.parent)) u.parent = 0
  w.players[to].credits += w.players[from].credits
  w.players[from].credits = 0
}

/** Moves the battle one tick on: fleets handed to teammates, new AI admirals, the turn's orders,
 * then the AI (and its gifts to broke teammates), then the sim. `onRun` hears what each order answered (a player's own refusals
 * become toasts). */
export function stepTurn(w: World, brains: Brain[], turn: Pick<Turn, 'c' | 'ai' | 'give'>, onRun?: (seat: Owner, c: Cmd, result: unknown) => void) {
  for (const [from, to] of turn.give ?? []) giveFleet(w, from, to)
  for (const [seat, d] of turn.ai ?? []) if (!brains.some((b) => b.o === seat)) brains.push(newBrain(seat, d))
  for (const [seat, c] of turn.c) {
    const r = runCmd(w, seat, c)
    onRun?.(seat, c, r)
  }
  for (const b of brains) think(w, b, STEP)
  aidAllies(w, brains)
  tick(w)
}
