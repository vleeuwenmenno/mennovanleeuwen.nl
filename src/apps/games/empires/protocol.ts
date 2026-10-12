import type { Difficulty } from './ai.ts'
import type { Cmd } from './commands.ts'
import type { FactionId } from './data.ts'
import type { MapRules } from './maps.ts'
import type { MatchInfo, Turn } from './match.ts'
import type { BattleSnap } from './snapshot.ts'

// What the Empires At War multiplayer client and server say to each other over the WebSocket at
// MP_PATH, as JSON text. Shared by both sides (types only, nothing to run).

export const MP_PATH = '/api/empires/ws'
export const CHAT_MAX = 240
/** Every this many ticks, players send the server a fingerprint of their battle to compare. */
export const HASH_EVERY = 30
/** How long a battle waits for a player who stepped away (closed the tab or the game, lost the
 * connection) before an AI admiral takes their fleet. Long enough to find the way back after
 * closing the wrong window, reopening the browser or switching devices; the others needn't sit it
 * out, as they can vote to carry on sooner. */
export const REJOIN_MS = 3 * 60_000

/** One spawn in a lobby. `team` is absolute (side 0 or 1), not relative to whoever looks at it.
 * Human seats carry the player's id and name; `away` while their connection is down. */
export type MpSlot = {
  kind: 'open' | 'human' | 'ai' | 'closed'
  player: string
  name: string
  faction: FactionId
  team: 0 | 1
  difficulty: Difficulty
  ready: boolean
  away: boolean
}

/** A lobby as its members see it. `map` is a fixed map's id or GENERATED (built from `gen`). */
export type MpLobby = {
  id: string
  name: string
  /** The player who sets it up and starts the battle. */
  host: string
  map: string
  gen: MapRules
  credits: number
  slots: MpSlot[]
  state: 'open' | 'playing'
}

/** How a battle's seat is doing: its player is in, away (connection down, may come back), gave up
 * (`left`) or never came back (`dropped`; both handed their fleet to an AI), or it's an AI seat. */
export type SeatStatus = 'playing' | 'away' | 'left' | 'dropped' | 'ai'
/** One seat in the battle's player list, by seat index; `ping` in milliseconds (0 for AI). `to`:
 * the seat of the teammate who took over this (dropped) player's fleet. */
export type RosterSeat = { status: SeatStatus; ping: number; to?: number }

/** What a player still in the battle wants done about one who stepped away: wait for them (the
 * default), hand their fleet to an AI admiral, or to the teammate in that seat. */
export type AwayVote = 'wait' | 'ai' | number
/** A player who stepped away mid-battle (closed the tab, lost the connection): the battle waits
 * for them until `deadline` (the server's clock, epoch milliseconds; 0 while nobody is back yet
 * after a server restart, so nobody counts down), or until everyone still there votes the same
 * way to carry on. `votes`: [voter's seat, vote]. */
export type AwaySeat = { seat: number; deadline: number; votes: [number, AwayVote][] }

/** A lobby in the list. */
export type LobbyInfo = { id: string; name: string; host: string; map: string; players: number; seats: number; state: MpLobby['state'] }

/** What can change about a slot; who may change what is up to the server. */
export type SlotPatch = Partial<Pick<MpSlot, 'faction' | 'team' | 'difficulty'>> & { kind?: 'open' | 'ai' | 'closed' }

/** Client to server. */
export type ClientMsg =
  /** First message on every connection. `token` resumes an identity after a reload or a dropped
   * connection, or a server restart (it is kept for a short while). `stored`: the token is the
   * browser's last one rather than this tab's own (the tab was closed): it is only taken back if
   * nobody is connected with it right now. Without a token to resume, a signed-in player gets back
   * their own player who isn't connected (from another device or browser), if there is one. */
  | { t: 'hello'; token?: string; stored?: boolean }
  /** Take a name (also to change it later). */
  | { t: 'claim'; name: string }
  /** For the round trip time; answered with `pong` straight away. `rtt` is our last measure of
   * it, which the server shows the other players. */
  | { t: 'ping'; n: number; rtt?: number }
  /** Lobbies: make one (and host it), join one, leave the one you're in. */
  | { t: 'create' }
  | { t: 'join'; id: string }
  | { t: 'leave' }
  /** Move to another open spawn. */
  | { t: 'seat'; i: number }
  | { t: 'slot'; i: number; patch: SlotPatch }
  /** Host only: the map, the generator's rules, starting credits. */
  | { t: 'setup'; map?: string; gen?: MapRules; credits?: number }
  | { t: 'ready'; on: boolean }
  | { t: 'chat'; text: string }
  /** Host only: everyone's ready, go. */
  | { t: 'start' }
  /** The battle's art and sounds are loaded; the clock starts once everyone has said so. */
  | { t: 'loaded' }
  /** An order, for the server to clean and hand to everyone for the next tick. */
  | { t: 'cmd'; c: Cmd }
  /** Our battle's fingerprint after tick `n` (every HASH_EVERY ticks). */
  | { t: 'hash'; n: number; h: number }
  /** About the player in `seat`, who stepped away: what we want done (see AwayVote). */
  | { t: 'vote'; seat: number; v: AwayVote }

/** Server to client. */
export type ServerMsg =
  /** Answer to `hello` when there's no identity to resume: pick a name next. `login` is the
   * signed-in GitHub login, which only this player may use as a name. */
  | { t: 'ready'; suggestion: string; login: string | null }
  /** You're in, as `name`. Keep `token` (per tab) to come back as the same player. */
  | { t: 'welcome'; id: string; name: string; token: string; resumed: boolean }
  /** A claim that didn't go through, with a free name to offer instead. */
  | { t: 'refused'; why: string; suggestion: string }
  | { t: 'pong'; n: number; at: number }
  /** The open lobbies, sent to everyone not in one whenever the list changes. */
  | { t: 'lobbies'; list: LobbyInfo[] }
  /** The lobby you're in, after every change; null once you're out of it (`why`, when that
   * happened while you were away). */
  | { t: 'lobby'; lobby: MpLobby | null; why?: string }
  /** A lobby chat line; `from` is empty for the lobby's own notices ("Vex joined"). */
  | { t: 'chat'; from: string; text: string; at: number }
  /** Taken out of the lobby by its host. */
  | { t: 'kicked'; why: string }
  /** Something the client did wrong or can't do; the connection stays open. */
  | { t: 'error'; why: string }
  /** The battle starts: build the world from `match`; we play seat `me`. Turns follow. */
  | { t: 'match'; match: MatchInfo; me: number }
  /** One tick's orders. Turns come in order, one per tick, starting at 1. */
  | ({ t: 'turn' } & Turn)
  /** The server's own copy of the battle has ended: `winner` is the winning team. */
  | { t: 'over'; winner: number }
  /** Our fingerprint at tick `n` didn't match the server's: our battle has drifted. A `sync`
   * follows to put it right. */
  | { t: 'desync'; n: number }
  /** The battle's players: how each seat is doing, and its ping. Sent when that changes, and
   * every couple of seconds for the pings. `away`: players who stepped away; while there are
   * any, the battle waits for them (no turns). */
  | { t: 'roster'; seats: RosterSeat[]; away?: AwaySeat[] }
  /** The server's own battle as it stands after tick `n` (snapshot.ts format), to carry on from:
   * after drifting, or on coming back to a battle under way. Turns after `n` follow. */
  | { t: 'sync'; n: number; world: string; brains: BattleSnap['brains']; why: 'drift' | 'rejoin' }
