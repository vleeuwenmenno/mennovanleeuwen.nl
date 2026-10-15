import { randomBytes, randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { dirname, join as joinPath, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { currentUser } from './auth.ts'
import { database } from './db.ts'
import { isPrivate } from './egress.ts'
import { sameOrigin } from './http.ts'
import { onShutdown } from './shutdown.ts'
import { acceptWebSocket, refuse, type WsConnection } from './ws.ts'
import { DIFFICULTY, PROFILES, profileOf, type Brain, type Difficulty } from '../src/apps/games/empires/ai.ts'
import { cleanCmd } from '../src/apps/games/empires/commands.ts'
import { CREDIT_STEPS, FACTIONS, START_CREDITS } from '../src/apps/games/empires/data.ts'
import { DEFAULT_RULES, GENERATED, MAP, MAPS, cleanRules, generateMap, type MapDef } from '../src/apps/games/empires/maps.ts'
import { matchBrains, matchWorld, stepTurn, type MatchInfo, type Turn } from '../src/apps/games/empires/match.ts'
import { nameKey, nameProblem, randomName, tidyName } from '../src/apps/games/empires/names.ts'
import { CHAT_MAX, HASH_EVERY, MP_PATH, OUTDATED_CODE, PROTOCOL, REJOIN_MS as REJOIN_DEFAULT_MS, type AwaySeat, type AwayVote, type ClientMsg, type LobbyInfo, type MpLobby, type MpSlot, type RosterSeat, type ServerMsg, type SlotPatch } from '../src/apps/games/empires/protocol.ts'
import { REINFORCE, STEP, cantGive, cantMendOn, cleanReinforce, stateHash, type Owner, type World } from '../src/apps/games/empires/sim.ts'
import { restoreBrain, restoreWorld, snapBrain, snapshotWorld, type BattleSnap } from '../src/apps/games/empires/snapshot.ts'

// Empires At War multiplayer: the players online, their names, the lobbies they gather in, and
// the battles. Anyone may play, signed in or not. Names are unique among everyone online; a
// signed-in user's GitHub login is theirs alone. Everything lives in memory, and a restart (a
// deploy) carries it over: on the way down it is written to DATA_DIR, and on the way up it comes
// back, with every battle on hold until its players have reconnected (see Restarts below).
//
// A battle runs in lockstep: every player's machine runs the whole battle itself, and only orders
// cross the network. The server keeps the clock: each tick it hands everyone that tick's orders
// (cleaned, and stamped with the sender's own seat), and nobody's battle moves on without them.
// It also runs its own copy, to check the fingerprints players send now and then and to call the
// winner, so a tampered client can't order other players' ships, play faster, or claim a win.

/** A dropped player keeps their name and seat this long, for a reload or a blip. */
const GRACE_MS = 30_000
/** A player who steps away mid-battle (closes the tab, loses the connection) has this long to come
 * back, while the battle waits for them; then an AI admiral takes their fleet (protocol.ts says
 * why it's three minutes). Tests shorten it. */
const REJOIN_MS = Number(process.env.EMPIRES_REJOIN_MS) || REJOIN_DEFAULT_MS
/** After a restart, for everyone at once: a deploy takes a while, and every player has to find the
 * way back. */
const RESTART_GRACE_MS = 3 * 60_000
/** State saved on the way down older than this is from another time (the server was down long, or
 * crashed and came back later): it is thrown away rather than resurrected. */
const STATE_MAX_AGE_MS = 10 * 60_000
const MAX_PLAYERS = 400
const MAX_PER_IP = 16
const MAX_MESSAGE = 16 * 1024
const MAX_LOBBIES = 100
/** Battles running at once: each one is simulated here too, on the event loop the site shares. */
const MAX_MATCHES = 12
/** Lobbies one address (or one signed-in account) may host. */
const LOBBIES_PER_HOST = 2
/** The longest a battle runs, and how long it goes on with nobody watching (AI against AI). */
const MAX_MATCH_MS = 2 * 3600_000
const UNWATCHED_MS = 60_000
/** Missed ticks run at once after a late wake-up, at most; past that the battle slows down instead. */
const MAX_CATCH_UP = 40
/** A connection that hasn't said hello by then is closed. */
const HELLO_MS = 10_000
/** How long the clock waits for everyone's game to load before starting anyway. */
const LOAD_WAIT_MS = 20_000
/** Orders one player may give in a single tick (a drag-select order is one). */
const MAX_CMDS_PER_TICK = 12
/** Fingerprints the server keeps, to compare late ones against. */
const KEEP_HASHES = 40
/** A drifting player gets the server's battle at most this often. */
const RESYNC_MS = 10_000
/** The AI that takes over a seat whose player left. */
const TAKEOVER: Difficulty = 'medium'
/** Ticks between player list updates (for the pings; changes go out at once). */
const ROSTER_EVERY = 60
const STEP_MS = STEP * 1000
/** Messages a second a connection may send on average, and in a burst. */
const RATE = 40
const BURST = 120

type Player = {
  id: string
  token: string
  /** Empty until a name is claimed. */
  name: string
  key: string
  /** The GitHub login of a signed-in player. */
  login: string | null
  ip: string
  ws: WsConnection | null
  /** When the connection dropped; the player is forgotten `grace` milliseconds later. */
  leftAt: number
  grace: number
  allowance: number
  allowanceAt: number
  /** The lobby they're in. */
  lobby: string | null
  /** Their round trip to the server, as their game last measured it, in milliseconds. */
  rtt: number
  /** Why they're out of their battle, when that happened while they were away (told on their return). */
  outWhy?: string
}

const players = new Map<string, Player>()
const byToken = new Map<string, Player>()
const byName = new Map<string, Player>()
const lobbies = new Map<string, MpLobby>()
/** Battles under way, by lobby id. */
const matches = new Map<string, Match>()

type Match = {
  info: MatchInfo
  lobby: string
  w: World
  brains: Brain[]
  /** The last tick run. */
  n: number
  /** When tick 0 was, by the server's clock; 0 while everyone's still loading. */
  t0: number
  /** Orders taken since the last tick, for the next one, and seats the AI takes over then (and
   * fleets handed to a teammate then). */
  pending: Turn['c']
  takeover: [Owner, Difficulty][]
  give: [Owner, Owner][]
  /** Seats whose players have left (gave up, or never came back): nobody can order them any more. */
  gone: Map<Owner, 'left' | 'dropped'>
  /** Who took over a dropped player's fleet, when it was a teammate. */
  heir: Map<Owner, Owner>
  /** Players who stepped away: while there are any, the battle waits (see Stepping away). */
  away: Map<Owner, { deadline: number; votes: Map<Owner, AwayVote> }>
  /** The clock has started (everyone loaded, or LOAD_WAIT_MS went by). */
  started: boolean
  loaded: Set<string>
  timer: NodeJS.Timeout | null
  hashes: Map<number, number>
  /** When each player last got the server's battle after drifting. */
  resynced: Map<string, number>
  /** When a player was last connected to it (an unwatched battle ends, see clock). */
  watchedAt?: number
}

const send = (p: Player, m: ServerMsg) => p.ws?.send(JSON.stringify(m))
const newId = () => randomBytes(9).toString('base64url')

/**
 * The address the request came from, as a key for the per-address limits. The last
 * X-Forwarded-For entry is the one our own reverse proxy added, but only when the request came
 * from that proxy (a private address): straight from the internet, the header is the client's to
 * make up. IPv6 by its /64, which is what one home or server gets.
 */
function clientIp(req: IncomingMessage) {
  const peer = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const ip = (fwd.length && isIP(peer) && isPrivate(peer) ? fwd.at(-1)! : peer).replace(/^::ffff:/, '')
  return isIP(ip) === 6 ? `${ip.split(':').slice(0, 4).join(':')}::/64` : ip
}

// --- Names ------------------------------------------------------------------------------------------

let loginsAt = 0
let logins = new Map<string, string>()
/** Name keys of every account's login, so a guest can't play as someone who has signed in here. */
function reservedLogins() {
  if (Date.now() - loginsAt > 60_000) {
    loginsAt = Date.now()
    try {
      const rows = database().prepare('SELECT login FROM users').all() as { login: string }[]
      logins = new Map(rows.map((r) => [nameKey(r.login), r.login]))
    } catch {
      logins = new Map()
    }
  }
  return logins
}

function nameTaken(name: string, by: Player | null) {
  const key = nameKey(name)
  const holder = byName.get(key)
  if (holder && holder !== by) return 'Someone online already has that name'
  const owner = reservedLogins().get(key)
  if (owner && owner.toLowerCase() !== by?.login?.toLowerCase()) return 'That name belongs to a signed-in player'
  return null
}

const suggest = (p: Player | null) => randomName((n) => !!nameTaken(n, p))

function claim(p: Player, raw: string) {
  const name = tidyName(String(raw ?? ''))
  const why = nameProblem(name) ?? nameTaken(name, p)
  if (why) return send(p, { t: 'refused', why, suggestion: suggest(p) })
  const first = !p.name
  if (p.key) byName.delete(p.key)
  const was = p.name
  p.name = name
  p.key = nameKey(name)
  byName.set(p.key, p)
  send(p, { t: 'welcome', id: p.id, name: p.name, token: p.token, resumed: false })
  const l = lobbyOf(p)
  if (l) {
    for (const s of l.slots) if (s.player === p.id) s.name = name
    if (was !== name) notice(l, `${was} is now ${name}`)
    pushLobby(l)
  } else if (first) send(p, { t: 'lobbies', list: lobbyList() })
}

// --- Lobbies ----------------------------------------------------------------------------------------

const lobbyOf = (p: Player) => (p.lobby ? lobbies.get(p.lobby) : undefined)
const mapOf = (l: MpLobby): MapDef => (l.map === GENERATED ? generateMap(l.gen) : Object.hasOwn(MAP, l.map) ? MAP[l.map] : MAPS[0])
const humans = (l: MpLobby) => l.slots.filter((s) => s.kind === 'human')
const seatOf = (l: MpLobby, p: Player) => l.slots.findIndex((s) => s.kind === 'human' && s.player === p.id)

const openSlot = (i: number): MpSlot => ({ kind: 'open', player: '', name: '', faction: i % 2 ? 'droid' : 'republic', team: (i % 2) as 0 | 1, difficulty: 'medium', profile: 'balanced', ready: false, away: false })
const seat = (s: MpSlot, p: Player): MpSlot => ({ ...s, kind: 'human', player: p.id, name: p.name, ready: false, away: !p.ws })

/** The slots for `map`, keeping what each spawn had where it still exists, and every human seated
 * (moved to a free spawn if theirs is gone); null when there aren't enough spawns for them. */
function slotsFor(map: MapDef, prev: MpSlot[]): MpSlot[] | null {
  const n = map.spawns.length
  const slots = Array.from({ length: n }, (_, i) => prev[i] ?? openSlot(i))
  for (const s of prev.slice(n)) {
    if (s.kind !== 'human') continue
    const free = slots.findIndex((x) => x.kind !== 'human')
    if (free < 0) return null
    slots[free] = { ...s, team: slots[free].team }
  }
  return slots
}

function lobbyList(): LobbyInfo[] {
  return [...lobbies.values()].map((l) => ({
    id: l.id,
    name: l.name,
    host: players.get(l.host)?.name ?? '',
    map: mapOf(l).name,
    players: humans(l).length,
    seats: l.slots.filter((s) => s.kind === 'human' || s.kind === 'open').length,
    state: l.state,
  }))
}

let listTimer: NodeJS.Timeout | null = null
/** Everyone looking at the list gets the new one (a few changes at once go out together). */
function pushList() {
  if (listTimer) return
  listTimer = setTimeout(() => {
    listTimer = null
    const msg = JSON.stringify({ t: 'lobbies', list: lobbyList() } satisfies ServerMsg)
    for (const p of players.values()) if (p.name && !p.lobby && p.ws) p.ws.send(msg)
  }, 150)
}

function pushLobby(l: MpLobby) {
  const msg = JSON.stringify({ t: 'lobby', lobby: l } satisfies ServerMsg)
  for (const s of humans(l)) players.get(s.player)?.ws?.send(msg)
  pushList()
}

function notice(l: MpLobby, text: string) {
  const msg = JSON.stringify({ t: 'chat', from: '', text, at: Date.now() } satisfies ServerMsg)
  for (const s of humans(l)) players.get(s.player)?.ws?.send(msg)
}

/** A change that matters to the battle: everyone has to say they're ready again. */
const unready = (l: MpLobby) => l.slots.forEach((s) => (s.ready = false))

function create(p: Player) {
  if (lobbies.size >= MAX_LOBBIES) return send(p, { t: 'error', why: 'There are too many battles being set up right now. Try again in a little while.' })
  // A few each, counted by address and by account, so nobody fills the list on their own.
  const mine = [...lobbies.values()].filter((l) => {
    const host = players.get(l.host)
    return host && host !== p && (host.ip === p.ip || (p.login && host.login === p.login))
  })
  if (mine.length >= LOBBIES_PER_HOST) return send(p, { t: 'error', why: 'You are already hosting battles elsewhere. Close one first.' })
  leave(p)
  const map = MAPS[0]
  const l: MpLobby = {
    id: newId(),
    name: `${p.name}'s battle`,
    host: p.id,
    map: map.id,
    gen: { ...DEFAULT_RULES },
    credits: START_CREDITS,
    reinforce: { ...REINFORCE },
    slots: slotsFor(map, [])!,
    state: 'open',
  }
  l.slots[0] = seat(l.slots[0], p)
  lobbies.set(l.id, l)
  p.lobby = l.id
  pushLobby(l)
}

function join(p: Player, id: string) {
  const l = lobbies.get(String(id))
  if (!l) return send(p, { t: 'error', why: 'That battle is gone.' })
  if (l.id === p.lobby) return pushLobby(l)
  if (l.state !== 'open') return send(p, { t: 'error', why: 'That battle has already started.' })
  const i = l.slots.findIndex((s) => s.kind === 'open')
  if (i < 0) return send(p, { t: 'error', why: 'That battle is full.' })
  leave(p)
  l.slots[i] = seat(l.slots[i], p)
  p.lobby = l.id
  notice(l, `${p.name} joined`)
  pushLobby(l)
}

/** Out of the lobby: the seat opens up, the host passes on, an empty lobby closes. */
function leave(p: Player, why = 'left', how: 'left' | 'dropped' = 'left') {
  const l = lobbyOf(p)
  p.lobby = null
  if (!l) return
  const game = matches.get(l.id)
  if (game) {
    if (abandon(p, game, how)) why = `${why}: the AI took over their fleet`
  }
  const i = seatOf(l, p)
  if (i >= 0) l.slots[i] = { ...openSlot(i), faction: l.slots[i].faction, team: l.slots[i].team }
  send(p, { t: 'lobby', lobby: null })
  send(p, { t: 'lobbies', list: lobbyList() })
  const left = humans(l)
  if (!left.length) {
    lobbies.delete(l.id)
    stopMatch(l.id)
    pushList()
    return
  }
  if (l.host === p.id) {
    l.host = left[0].player
    notice(l, `${p.name} ${why}; ${left[0].name} is the host now`)
  } else notice(l, `${p.name} ${why}`)
  pushLobby(l)
}

function moveSeat(p: Player, l: MpLobby, to: number) {
  const from = seatOf(l, p)
  const target = l.slots[to]
  if (from < 0 || !target || target.kind !== 'open') return send(p, { t: 'error', why: 'That spawn is taken.' })
  l.slots[to] = { ...l.slots[from], team: target.team, ready: false }
  l.slots[from] = { ...openSlot(from), faction: l.slots[from].faction, team: l.slots[from].team }
  pushLobby(l)
}

function changeSlot(p: Player, l: MpLobby, i: number, patch: SlotPatch) {
  const s = l.slots[i]
  if (!s || !patch || typeof patch !== 'object') return
  const host = l.host === p.id
  const own = s.kind === 'human' && s.player === p.id
  if (!host && !own) return send(p, { t: 'error', why: 'Only the host can change other spawns.' })
  const next = { ...s }
  if (patch.kind !== undefined) {
    if (!host || own || !['open', 'ai', 'closed'].includes(patch.kind)) return send(p, { t: 'error', why: "That can't be changed." })
    if (s.kind === 'human') {
      const them = players.get(s.player)
      if (them) {
        leave(them, 'was removed by the host')
        send(them, { t: 'kicked', why: 'The host took you out of the battle.' })
      }
      // leave() opened the slot; carry on from there.
      Object.assign(next, l.slots[i])
    }
    next.kind = patch.kind
  }
  // Own keys only: "toString" is in every object, and would take the server down.
  if (typeof patch.faction === 'string' && Object.hasOwn(FACTIONS, patch.faction)) next.faction = patch.faction
  if (patch.team === 0 || patch.team === 1) next.team = patch.team
  if (typeof patch.difficulty === 'string' && Object.hasOwn(DIFFICULTY, patch.difficulty) && (host || own)) next.difficulty = patch.difficulty
  if (typeof patch.profile === 'string' && Object.hasOwn(PROFILES, patch.profile) && (host || own)) next.profile = profileOf(patch.profile)
  l.slots[i] = next
  unready(l)
  pushLobby(l)
}

function changeSetup(p: Player, l: MpLobby, m: Extract<ClientMsg, { t: 'setup' }>) {
  if (l.host !== p.id) return send(p, { t: 'error', why: 'Only the host can change the map and rules.' })
  if (typeof m.credits === 'number' && CREDIT_STEPS.includes(m.credits)) l.credits = m.credits
  // Reinforcements: whatever is sent is cleaned (a surcharge onto its 5% steps from 0 to 50%, the
  // switches true or false), so a tampered client can't set a free or negative one.
  if (m.reinforce && typeof m.reinforce === 'object') l.reinforce = cleanReinforce({ ...cleanReinforce(l.reinforce), ...m.reinforce })
  if (m.map !== undefined || m.gen !== undefined) {
    const id = m.map === undefined ? l.map : m.map === GENERATED || (typeof m.map === 'string' && Object.hasOwn(MAP, m.map)) ? m.map : null
    if (!id) return send(p, { t: 'error', why: 'No such map.' })
    const gen = m.gen === undefined ? l.gen : cleanRules(m.gen)
    const map = id === GENERATED ? generateMap(gen) : MAP[id]
    const slots = slotsFor(map, l.slots)
    if (!slots) return send(p, { t: 'error', why: 'That map has fewer spawns than there are players here.' })
    l.map = id
    l.gen = gen
    l.slots = slots
  }
  unready(l)
  pushLobby(l)
}

function chat(p: Player, l: MpLobby, raw: string) {
  // No invisible characters (bidi overrides, zero-width): a line says what it looks like it says.
  const text = String(raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX)
  if (!text) return
  const msg = JSON.stringify({ t: 'chat', from: p.name, text, at: Date.now() } satisfies ServerMsg)
  for (const s of humans(l)) players.get(s.player)?.ws?.send(msg)
}

// --- Battles ----------------------------------------------------------------------------------------

/** Why the host can't start yet, or null. Mirrors what the lobby screen shows. */
function cantStart(l: MpLobby) {
  const filled = l.slots.filter((s) => s.kind === 'human' || s.kind === 'ai')
  if (!filled.some((s) => s.team === 0) || !filled.some((s) => s.team === 1)) return 'Both sides need someone on them.'
  const away = l.slots.find((s) => s.kind === 'human' && s.away)
  if (away) return `Waiting for ${away.name} to reconnect.`
  const waiting = l.slots.find((s) => s.kind === 'human' && s.player !== l.host && !s.ready)
  if (waiting) return `Waiting for ${waiting.name} to be ready.`
  return null
}

const seatIndex = (m: Match, p: Player) => m.info.seats.findIndex((s) => s.kind === 'human' && s.player === p.id)
/** Whether the player has a seat in a battle under way that's still theirs (not handed over). */
function battling(p: Player) {
  const game = p.lobby ? matches.get(p.lobby) : undefined
  const seat = game ? seatIndex(game, p) : -1
  return !!game && seat >= 0 && !game.gone.has(seat)
}

function start(p: Player, l: MpLobby) {
  if (l.host !== p.id) return send(p, { t: 'error', why: 'Only the host can start the battle.' })
  if (l.state !== 'open' || matches.has(l.id)) return
  const why = cantStart(l)
  if (why) return send(p, { t: 'error', why })
  if (matches.size >= MAX_MATCHES) return send(p, { t: 'error', why: 'Too many battles are running right now. Try again in a little while.' })
  const info: MatchInfo = {
    id: newId(),
    seed: randomInt(0, 2 ** 31),
    map: l.map,
    gen: l.gen,
    credits: l.credits,
    reinforce: cleanReinforce(l.reinforce),
    seats: l.slots.flatMap((s, spawn) =>
      s.kind === 'human' || s.kind === 'ai' ? [{ kind: s.kind, player: s.player, name: s.kind === 'ai' ? `${DIFFICULTY[s.difficulty].name} ${PROFILES[profileOf(s.profile)].name.toLowerCase()} AI` : s.name, faction: s.faction, team: s.team, spawn, difficulty: s.difficulty, ...(s.kind === 'ai' ? { profile: profileOf(s.profile) } : {}) }] : [],
    ),
  }
  const m: Match = {
    info, lobby: l.id, w: matchWorld(info), brains: matchBrains(info), n: 0, t0: 0, pending: [], takeover: [], give: [], gone: new Map(), heir: new Map(), away: new Map(), started: false, loaded: new Set(), timer: null, hashes: new Map(), resynced: new Map(),
  }
  matches.set(l.id, m)
  l.state = 'playing'
  info.seats.forEach((s, i) => {
    const them = s.kind === 'human' ? players.get(s.player) : undefined
    if (them) send(them, { t: 'match', match: info, me: i })
  })
  notice(l, 'The battle has begun')
  pushLobby(l)
  // Nobody waits forever for a player whose game won't load.
  m.timer = setTimeout(() => begin(m), LOAD_WAIT_MS)
}

function loaded(p: Player, m: Match) {
  m.loaded.add(p.id)
  const humans = m.info.seats.filter((s) => s.kind === 'human' && players.get(s.player)?.ws)
  if (humans.every((s) => m.loaded.has(s.player))) begin(m)
}

function begin(m: Match) {
  if (m.started || matches.get(m.lobby) !== m) return
  if (m.timer) clearTimeout(m.timer)
  m.started = true
  // Whoever isn't connected by now has stepped away: the battle waits for them from the start.
  m.info.seats.forEach((s, i) => {
    if (s.kind === 'human' && !m.gone.has(i) && !players.get(s.player)?.ws) stepAway(m, i)
  })
  pushRoster(m)
  run(m)
}

/** (Re)starts the clock from the battle's current tick, unless someone is away. The time it
 * stood still (waiting for a player, or the server restarting) doesn't count: nothing runs to
 * catch up with it. */
function run(m: Match) {
  if (!m.started || m.away.size || matches.get(m.lobby) !== m) return
  if (m.timer) clearTimeout(m.timer)
  m.t0 = performance.now() - m.n * STEP_MS
  m.watchedAt = performance.now()
  clock(m)
}

function pushRoster(m: Match) {
  const seats: RosterSeat[] = m.info.seats.map((s, i) => {
    if (s.kind === 'ai') return { status: 'ai', ping: 0 }
    const gone = m.gone.get(i)
    const p = players.get(s.player)
    const heir = m.heir.get(i)
    if (gone) return { status: gone, ping: 0, ...(heir !== undefined ? { to: heir } : {}) }
    return { status: p?.ws ? 'playing' : 'away', ping: p?.ws ? Math.round(p.rtt) : 0 }
  })
  const away: AwaySeat[] = [...m.away].map(([seat, a]) => ({ seat, deadline: a.deadline, votes: [...a.votes] }))
  toPlayers(m, JSON.stringify({ t: 'roster', seats, ...(away.length ? { away } : {}) } satisfies ServerMsg))
}

/** Runs every tick that's due by now, then sleeps until the next. A late wake-up (a busy
 * moment) just runs the missed ticks at once; players' games catch up the same way. */
function clock(m: Match) {
  // Someone stepped away: the battle waits (run starts it again).
  if (m.away.size) {
    m.timer = null
    return
  }
  let due = Math.floor((performance.now() - m.t0) / STEP_MS)
  // Far behind (the server was busy): run a bounded number now and let the battle fall back in
  // time, rather than blocking everything else to catch up.
  if (due - m.n > MAX_CATCH_UP) {
    m.t0 += (due - m.n - MAX_CATCH_UP) * STEP_MS
    due = m.n + MAX_CATCH_UP
  }
  while (m.n < due && matches.get(m.lobby) === m) {
    try {
      runTick(m)
    } catch (e) {
      // A battle that breaks ends; the server and the other battles go on.
      console.error('empires: battle stopped:', (e as Error).message)
      return halt(m, 'The battle stopped because of an error on the server')
    }
    if (m.w.winner !== -1) return finish(m)
  }
  if (matches.get(m.lobby) !== m) return
  // No battle runs forever, or on with nobody there to watch it.
  if (m.n * STEP_MS > MAX_MATCH_MS) return halt(m, 'The battle reached its time limit')
  const watched = m.info.seats.some((s) => s.kind === 'human' && !m.gone.has(m.info.seats.indexOf(s)) && players.get(s.player)?.ws)
  if (watched) m.watchedAt = performance.now()
  else if (performance.now() - (m.watchedAt ?? m.t0) > UNWATCHED_MS) return halt(m, 'The battle ended: nobody was left watching')
  m.timer = setTimeout(() => clock(m), Math.max(1, m.t0 + (m.n + 1) * STEP_MS - performance.now()))
}

function runTick(m: Match) {
  const n = ++m.n
  const turn: Turn = { n, c: m.pending, ...(m.takeover.length ? { ai: m.takeover } : {}), ...(m.give.length ? { give: m.give } : {}) }
  m.pending = []
  m.takeover = []
  m.give = []
  stepTurn(m.w, m.brains, turn)
  m.w.events.length = 0
  if (n % HASH_EVERY === 0) {
    m.hashes.set(n, stateHash(m.w))
    m.hashes.delete(n - HASH_EVERY * KEEP_HASHES)
  }
  const msg = JSON.stringify({ t: 'turn', ...turn } satisfies ServerMsg)
  toPlayers(m, msg)
  if (n % ROSTER_EVERY === 0) pushRoster(m)
}

/** Sends to every player still in the battle (not those who left it). */
function toPlayers(m: Match, msg: string) {
  m.info.seats.forEach((s, i) => {
    if (s.kind === 'human' && !m.gone.has(i)) players.get(s.player)?.ws?.send(msg)
  })
}

/** The server's battle as it stands, for a player to carry on from. */
function sync(p: Player, m: Match, why: 'drift' | 'rejoin') {
  send(p, { t: 'sync', n: m.n, world: snapshotWorld(m.w), brains: m.brains.map(snapBrain).map((b) => ({ ...b, scouts: [...b.scouts] })), why })
}

/** A player is out of the battle for good (left, or gone too long): an AI admiral takes their
 * fleet from the next tick, on everyone's machine at once. False if they were out already. */
function abandon(p: Player, m: Match, how: 'left' | 'dropped') {
  const seat = seatIndex(m, p)
  if (seat < 0 || m.gone.has(seat)) return false
  m.gone.set(seat, how)
  m.takeover.push([seat, TAKEOVER])
  // Nobody waits for them any more, and they have no say about anyone else.
  m.away.delete(seat)
  for (const a of m.away.values()) a.votes.delete(seat)
  decideAll(m)
  pushRoster(m)
  run(m)
  return true
}

// --- Stepping away ----------------------------------------------------------------------------------
//
// Quitting a battle (its menu's Leave) hands the fleet to an AI at once. Anything else that takes a
// player away (closing the tab or the game's window, a dropped connection, a server restart) only
// steps them away: the battle waits for everyone (no ticks) up to REJOIN_MS for them to come back,
// and they pick up the server's battle when they do. Meanwhile everyone still there votes: wait
// (the default), an AI admiral takes over, or a teammate takes over their fleet. The battle goes
// on as soon as all of them pick the same way to carry on; when time runs out, the AI takes over.

/** Seats whose players are in the battle right now: connected, and not away or out. */
const present = (m: Match) => m.info.seats.flatMap((s, i) => (s.kind === 'human' && !m.gone.has(i) && !m.away.has(i) && players.get(s.player)?.ws ? [i] : []))

function stepAway(m: Match, seat: number) {
  if (m.away.has(seat) || m.gone.has(seat)) return
  // After a restart nobody is back yet: nobody counts down until someone is (stepBack).
  m.away.set(seat, { deadline: present(m).length ? Date.now() + REJOIN_MS : 0, votes: new Map() })
  for (const a of m.away.values()) a.votes.delete(seat)
  if (m.timer) clearTimeout(m.timer)
  m.timer = null
  decideAll(m)
}

function stepBack(m: Match, seat: number) {
  if (!m.away.delete(seat)) return
  // The first one back after a restart: the others' time to come back starts now.
  for (const a of m.away.values()) if (!a.deadline) a.deadline = Date.now() + REJOIN_MS
  run(m)
}

function vote(p: Player, m: Match, seat: unknown, v: unknown) {
  const voter = seatIndex(m, p)
  const a = typeof seat === 'number' ? m.away.get(seat) : undefined
  if (!a || !present(m).includes(voter)) return
  const mates = present(m).filter((i) => m.info.seats[i].team === m.info.seats[seat as number].team)
  if (v !== 'wait' && v !== 'ai' && !(typeof v === 'number' && mates.includes(v))) return send(p, { t: 'error', why: "That player can't take over." })
  a.votes.set(voter, v)
  decide(m, seat as number)
  pushRoster(m)
}

/** Carries on without the player in `seat` if everyone still there picked the same way to. */
function decide(m: Match, seat: number) {
  const a = m.away.get(seat)
  const voters = present(m)
  if (!a || !voters.length) return
  const picks = voters.map((i) => a.votes.get(i) ?? 'wait')
  const pick = picks[0]
  if (pick === 'wait' || picks.some((x) => x !== pick)) return
  // A teammate picked to take over must still be there to.
  if (typeof pick === 'number' && !voters.includes(pick)) return
  takeSeat(m, seat, pick === 'ai' ? null : pick, 'vote')
}

/** Who's left to vote changed (someone stepped away, came back or left): votes may agree now. */
function decideAll(m: Match) {
  for (const seat of [...m.away.keys()]) decide(m, seat)
}

/** The player in `seat` is out (the others voted so, or their time ran out): an AI admiral takes
 * their fleet, or teammate `to` takes the ships and credits (and the AI the base) from the next
 * tick. They're out of the lobby too, and told why if they come back. */
function takeSeat(m: Match, seat: number, to: number | null, how: 'vote' | 'time') {
  if (!m.away.delete(seat) || m.gone.has(seat)) return
  m.gone.set(seat, 'dropped')
  m.takeover.push([seat, TAKEOVER])
  const heir = to === null ? null : m.info.seats[to].name
  if (to !== null) {
    m.give.push([seat, to])
    m.heir.set(seat, to)
  }
  const p = players.get(m.info.seats[seat].player)
  if (p && p.lobby === m.lobby) {
    const by = heir ? `${heir} took over your fleet` : 'an AI admiral took over your fleet'
    p.outWhy = how === 'vote' ? `While you were away, the others carried on: ${by}.` : `You were away too long: ${by}.`
    leave(p, heir ? `was away: ${heir} took over their fleet` : 'was away: the AI took over their fleet', 'dropped')
  }
  decideAll(m)
  pushRoster(m)
  run(m)
}

// Time's up for a player who stepped away: the AI takes over.
setInterval(() => {
  const now = Date.now()
  for (const m of [...matches.values()]) for (const [seat, a] of [...m.away]) if (a.deadline && now > a.deadline) takeSeat(m, seat, null, 'time')
}, 1000).unref()

function finish(m: Match) {
  const l = lobbies.get(m.lobby)
  stopMatch(m.lobby)
  const msg = JSON.stringify({ t: 'over', winner: m.w.winner } satisfies ServerMsg)
  toPlayers(m, msg)
  if (!l) return
  const won = m.info.seats.filter((s) => s.team === m.w.winner).map((s) => s.name)
  notice(l, `${won.join(' and ')} won the battle`)
  pushLobby(l)
}

/** Ends a battle without a winner, saying why in the lobby. */
function halt(m: Match, why: string) {
  const l = lobbies.get(m.lobby)
  stopMatch(m.lobby)
  if (!l) return
  notice(l, why)
  pushLobby(l)
}

/** Ends the battle in this lobby (if any) and opens the lobby again. */
function stopMatch(lobby: string) {
  const m = matches.get(lobby)
  if (!m) return
  if (m.timer) clearTimeout(m.timer)
  matches.delete(lobby)
  const l = lobbies.get(lobby)
  if (l) {
    l.state = 'open'
    unready(l)
  }
}

function order(p: Player, m: Match, raw: unknown) {
  const seat = seatIndex(m, p)
  if (seat < 0 || !m.started || m.gone.has(seat)) return
  if (m.pending.filter(([s]) => s === seat).length >= MAX_CMDS_PER_TICK) return
  const c = cleanCmd(raw, m.w)
  if (!c) return send(p, { t: 'error', why: "That order didn't make sense to the server." })
  // Credits for an ally: refused here already when they can't go (an enemy, more than we have, too
  // soon after the last), and one a tick at most, so nobody floods the turns with them. The sim
  // checks again when it runs, deterministically, on every copy.
  if (c.f === 'give') {
    const why = m.pending.some(([s, x]) => s === seat && x.f === 'give') ? 'Wait a moment before sending more credits' : cantGive(m.w, seat, c.a[0] as number, c.a[1] as number)
    if (why) return send(p, { t: 'error', why })
  }
  // A repair order on an enemy's ship or structure is refused here already; the sim refuses it too.
  if (c.f === 'mend') {
    const why = cantMendOn(m.w, seat, c.a[1] as number)
    if (why) return send(p, { t: 'error', why })
  }
  m.pending.push([seat, c])
}

function checkHash(p: Player, m: Match, n: unknown, h: unknown) {
  const ours = typeof n === 'number' ? m.hashes.get(n) : undefined
  if (ours === undefined || ours === h) return
  // Fingerprints already on their way when the sync went out still show the drift: one sync
  // per drift is enough.
  const last = m.resynced.get(p.id) ?? 0
  if (Date.now() - last < RESYNC_MS) return
  m.resynced.set(p.id, Date.now())
  console.warn(`[empires] ${p.name} drifted from the server's battle at tick ${n} (match ${m.info.id}): sent the server's copy`)
  send(p, { t: 'desync', n: n as number })
  sync(p, m, 'drift')
}

// --- Connections ------------------------------------------------------------------------------------

function forget(p: Player) {
  leave(p, 'lost the connection', 'dropped')
  players.delete(p.id)
  byToken.delete(p.token)
  if (p.key && byName.get(p.key) === p) byName.delete(p.key)
}

/** Takes a message off the player's allowance; false when they're sending too fast. */
function allowed(p: Player) {
  const now = Date.now()
  p.allowance = Math.min(BURST, p.allowance + ((now - p.allowanceAt) / 1000) * RATE)
  p.allowanceAt = now
  if (p.allowance < 1) return false
  p.allowance--
  return true
}

/** Seated players show as away while their connection is down; in a battle under way, they've
 * stepped away (and the battle waits for them), or are back. */
function setAway(p: Player, away: boolean) {
  const l = lobbyOf(p)
  const i = l ? seatOf(l, p) : -1
  if (!l || i < 0) return
  if (l.slots[i].away !== away) {
    l.slots[i] = { ...l.slots[i], away }
    pushLobby(l)
  }
  const game = matches.get(l.id)
  if (!game?.started) return
  const seat = seatIndex(game, p)
  if (seat >= 0 && !game.gone.has(seat)) {
    if (away) stepAway(game, seat)
    else stepBack(game, seat)
  }
  pushRoster(game)
}

/** A signed-in player's own player that isn't connected right now, for them coming back from
 * another device or browser (without its token): the one a battle is waiting for first, else the
 * one that left last. Never a connected one: that's them playing elsewhere, or in a second tab on
 * purpose. */
function awayByLogin(login: string) {
  const key = login.toLowerCase()
  let best: Player | undefined
  for (const p of players.values()) {
    if (p.ws || !p.name || p.login?.toLowerCase() !== key) continue
    if (!best || (battling(p) !== battling(best) ? battling(p) : p.leftAt > best.leftAt)) best = p
  }
  return best
}

function hello(ws: WsConnection, conn: { p: Player | null; login: string | null; ip: string }, token: unknown, stored: boolean) {
  const firstName = (p: Player) => (conn.login && !nameTaken(conn.login, p) ? conn.login : suggest(p))
  // Coming back within the grace period: the same player, name, lobby and seat, on this connection.
  // The browser's last token (from a closed tab) doesn't take over a tab still playing with it.
  // Signed in, the account finds its player too, from a browser that never had its token.
  const known = typeof token === 'string' ? byToken.get(token) : undefined
  const back = (known && !(stored && known.ws) ? known : undefined) ?? (conn.login ? awayByLogin(conn.login) : undefined)
  if (back) {
    back.ws?.close(4000, 'replaced')
    back.ws = ws
    back.leftAt = 0
    back.grace = GRACE_MS
    conn.p = back
    if (!back.name) return send(back, { t: 'ready', suggestion: firstName(back), login: conn.login })
    send(back, { t: 'welcome', id: back.id, name: back.name, token: back.token, resumed: true })
    const l = lobbyOf(back)
    if (l) {
      send(back, { t: 'lobby', lobby: l })
      const game = matches.get(l.id)
      const seat = game ? seatIndex(game, back) : -1
      if (game && seat >= 0 && !game.gone.has(seat)) {
        send(back, { t: 'match', match: game.info, me: seat })
        sync(back, game, 'rejoin')
      }
      // Back in the lobby, and in the battle: it carries on once nobody else is away.
      setAway(back, false)
    } else {
      // Out of the battle while away (an AI or a teammate took over): say so.
      send(back, { t: 'lobby', lobby: null, ...(back.outWhy ? { why: back.outWhy } : {}) })
      back.outWhy = undefined
      send(back, { t: 'lobbies', list: lobbyList() })
    }
    return
  }
  const p: Player = {
    id: newId(), token: randomBytes(18).toString('base64url'), name: '', key: '', login: conn.login, ip: conn.ip, ws, leftAt: 0, grace: GRACE_MS, allowance: BURST, allowanceAt: Date.now(), lobby: null, rtt: 0,
  }
  players.set(p.id, p)
  byToken.set(p.token, p)
  conn.p = p
  send(p, { t: 'ready', suggestion: firstName(p), login: conn.login })
}

function onMessage(ws: WsConnection, conn: { p: Player | null; login: string | null; ip: string }, text: string) {
  let m: ClientMsg
  try {
    m = JSON.parse(text)
  } catch {
    return ws.close(1003, 'not json')
  }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return ws.close(1003, 'bad message')

  if (!conn.p) {
    if (m.t !== 'hello') return ws.close(1008, 'hello first')
    // Another version of the game would play another battle: it has to reload first.
    if ((m.v ?? 1) !== PROTOCOL) return ws.close(OUTDATED_CODE, 'outdated')
    hello(ws, conn, m.token, m.stored === true)
    return
  }

  const p = conn.p
  if (!allowed(p)) return ws.close(1008, 'too fast')
  if (m.t === 'ping') {
    const rtt = Number(m.rtt)
    if (Number.isFinite(rtt)) p.rtt = Math.min(9999, Math.max(0, rtt))
    return send(p, { t: 'pong', n: Number(m.n) || 0, at: Date.now() })
  }
  if (m.t === 'claim') return claim(p, m.name)
  if (!p.name) return send(p, { t: 'error', why: 'Pick a name first.' })
  if (m.t === 'create') return create(p)
  if (m.t === 'join') return join(p, m.id)
  const l = lobbyOf(p)
  // Battle traffic still on its way after leaving is just dropped.
  if (!l && (m.t === 'cmd' || m.t === 'hash' || m.t === 'loaded' || m.t === 'vote')) return
  if (!l) return send(p, { t: 'error', why: "You're not in a battle." })
  if (l.state === 'playing' && (m.t === 'seat' || m.t === 'slot' || m.t === 'setup' || m.t === 'ready' || m.t === 'start')) return send(p, { t: 'error', why: 'The battle is on: the lobby opens again when it ends.' })
  switch (m.t) {
    case 'leave':
      return leave(p)
    case 'seat':
      return moveSeat(p, l, Number(m.i))
    case 'slot':
      return changeSlot(p, l, Number(m.i), m.patch)
    case 'setup':
      return changeSetup(p, l, m)
    case 'ready': {
      const i = seatOf(l, p)
      if (i >= 0) l.slots[i] = { ...l.slots[i], ready: !!m.on }
      return pushLobby(l)
    }
    case 'chat':
      return chat(p, l, m.text)
    case 'start':
      return start(p, l)
    case 'loaded':
    case 'cmd':
    case 'hash':
    case 'vote': {
      const game = matches.get(l.id)
      if (!game) return
      if (m.t === 'loaded') return loaded(p, game)
      if (m.t === 'cmd') return order(p, game, m.c)
      if (m.t === 'vote') return vote(p, game, m.seat, m.v)
      return checkHash(p, game, m.n, m.h)
    }
    default:
      return send(p, { t: 'error', why: `Unknown message ${String((m as { t: string }).t).slice(0, 20)}` })
  }
}

const perIp = new Map<string, number>()
/** Open WebSockets, said hello or not. */
let sockets = 0

/** Closes a signed-in account's game connections (signed out everywhere, banned or deleted). */
export function closeGameSessions(login: string) {
  const key = login.toLowerCase()
  for (const p of players.values()) if (p.login?.toLowerCase() === key) p.ws?.close(1008, 'signed out')
}

/** Takes the WebSocket upgrade for MP_PATH; false for any other path (left for others, such as
 * Vite's hot reload in development). */
export function empiresUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  let path: string
  try {
    path = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    return false // not a path at all: server/index.ts refuses it
  }
  if (path !== MP_PATH) return false
  socket.on('error', () => socket.destroy())
  // On the way down: the state is already saved, so a player can only come back after the restart.
  if (closing) {
    refuse(socket, 503, 'Service Unavailable')
    return true
  }
  // Only this site's pages may connect: a sign-in cookie rides along with the upgrade.
  if (!sameOrigin(req) || !req.headers.origin) {
    refuse(socket, 403, 'Forbidden')
    return true
  }
  const ip = clientIp(req)
  // Every accepted socket counts, also before it says hello.
  if (sockets >= MAX_PLAYERS || (perIp.get(ip) ?? 0) >= MAX_PER_IP) {
    refuse(socket, 503, 'Service Unavailable')
    return true
  }
  const ws = acceptWebSocket(req, socket, head, { maxMessage: MAX_MESSAGE })
  if (!ws) return true
  sockets++
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
  // Counted down when the socket itself closes, however the connection ends.
  socket.once('close', () => {
    sockets--
    const n = (perIp.get(ip) ?? 1) - 1
    if (n > 0) perIp.set(ip, n)
    else perIp.delete(ip)
  })
  let login: string | null = null
  try {
    login = currentUser(req)?.login ?? null
  } catch {
    // No database or sign-in configured: everyone is a guest.
  }
  const conn = { p: null as Player | null, login, ip }
  const hello = setTimeout(() => !conn.p && ws.close(1008, 'hello first'), HELLO_MS)
  ws.onMessage = (text) => {
    // A message that breaks something closes this connection, not the server.
    try {
      onMessage(ws, conn, text)
    } catch (e) {
      console.error('empires: message failed:', (e as Error).message)
      ws.close(1011, 'server error')
    }
  }
  ws.onClose = () => {
    clearTimeout(hello)
    const p = conn.p
    if (p && p.ws === ws) {
      p.ws = null
      p.leftAt = Date.now()
      // In a battle, kept long enough to rejoin it (and then to hear what happened, if too late).
      p.grace = battling(p) ? REJOIN_MS + GRACE_MS : GRACE_MS
      setAway(p, true)
    }
  }
  return true
}

// Players who didn't come back in time are let go: their seats open and their names are freed.
setInterval(() => {
  const now = Date.now()
  for (const p of players.values()) if (!p.ws && p.leftAt && now - p.leftAt > p.grace) forget(p)
}, 5_000).unref()

/** Whether a battle is waiting for this browser's player (its last token) or this signed-in
 * account's, which stepped away from it: the menus offer to rejoin it. */
export function empiresAway(token: unknown, login: string | null): { battle: boolean } {
  const known = typeof token === 'string' ? byToken.get(token) : undefined
  const mine = (p: Player | undefined) => !!p && !p.ws && battling(p)
  return { battle: mine(known) || (!!login && mine(awayByLogin(login))) }
}

/** For tests and a status line: how many are online, with names, and in lobbies. */
export const empiresOnline = () => ({ players: players.size, named: byName.size, lobbies: lobbies.size, battles: matches.size })

// --- Restarts ---------------------------------------------------------------------------------------
//
// A deploy restarts the site (Docker sends SIGTERM and waits ~10 s). On the way down the players,
// lobbies and battles are written to one small file; on the way up they're read back and the file
// is deleted (so a crash loop can't bring stale state back again and again). Players come back as
// dropped, with RESTART_GRACE_MS to reconnect with their token. In a battle they have all stepped
// away, so it waits at its last tick; nobody counts down until the first player is back, and then
// the others get REJOIN_MS like anyone who stepped away (see Stepping away). The server's copy of
// each battle is the one everyone carries on from: a returning player gets it as a `rejoin` sync.

/** Where the multiplayer state waits out a restart. */
const STATE_FILE = joinPath(resolve(process.env.DATA_DIR ?? 'data'), 'empires-state.json')
const STATE_VERSION = 1

type SavedPlayer = Pick<Player, 'id' | 'token' | 'name' | 'login' | 'ip' | 'lobby'>
type SavedMatch = {
  info: MatchInfo
  lobby: string
  n: number
  world: string
  brains: BattleSnap['brains']
  pending: Turn['c']
  takeover: Match['takeover']
  give: Match['give']
  gone: [Owner, 'left' | 'dropped'][]
  heir: [Owner, Owner][]
}
type SavedState = { v: number; at: number; players: SavedPlayer[]; lobbies: MpLobby[]; matches: SavedMatch[] }

/** Writes everyone with a name, their lobbies and the battles to STATE_FILE (tmp + rename, so a
 * half-written file is never read). Returns how many players it kept. */
export function saveEmpires(): number {
  const named = [...players.values()].filter((p) => p.name)
  if (!named.length) {
    rmSync(STATE_FILE, { force: true })
    return 0
  }
  const state: SavedState = {
    v: STATE_VERSION,
    at: Date.now(),
    players: named.map((p) => ({ id: p.id, token: p.token, name: p.name, login: p.login, ip: p.ip, lobby: p.lobby })),
    lobbies: [...lobbies.values()],
    matches: [...matches.values()].map((m) => ({
      info: m.info,
      lobby: m.lobby,
      n: m.n,
      world: snapshotWorld(m.w),
      brains: m.brains.map(snapBrain),
      // Orders taken for the next tick haven't reached anyone yet: they go out with it after the restart.
      pending: m.pending,
      takeover: m.takeover,
      give: m.give,
      gone: [...m.gone],
      heir: [...m.heir],
    })),
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, STATE_FILE)
  return named.length
}

/** Reads STATE_FILE back (and deletes it). Anything wrong with it (too old, another version,
 * garbled) and the server starts empty, as it did before restarts carried anything over. */
function restoreEmpires() {
  let raw: string
  try {
    raw = readFileSync(STATE_FILE, 'utf8')
  } catch {
    return // nothing saved: a first start, or nobody was playing
  }
  rmSync(STATE_FILE, { force: true })
  try {
    const s = JSON.parse(raw) as SavedState
    if (s?.v !== STATE_VERSION) throw new Error(`version ${String(s?.v)}`)
    const age = Date.now() - Number(s.at)
    if (!(age >= 0 && age <= STATE_MAX_AGE_MS)) throw new Error(`saved ${Math.round(age / 1000)} s ago`)
    const now = Date.now()
    for (const sp of s.players) {
      if (typeof sp.id !== 'string' || typeof sp.token !== 'string' || typeof sp.name !== 'string' || !sp.name) continue
      const p: Player = {
        id: sp.id, token: sp.token, name: sp.name, key: nameKey(sp.name), login: sp.login ?? null, ip: String(sp.ip), ws: null, leftAt: now, grace: RESTART_GRACE_MS, allowance: BURST, allowanceAt: now, lobby: sp.lobby ?? null, rtt: 0,
      }
      players.set(p.id, p)
      byToken.set(p.token, p)
      byName.set(p.key, p)
    }
    for (const l of s.lobbies) {
      // Everyone is away until they reconnect; a seat whose player wasn't kept opens up.
      l.slots = l.slots.map((x, i) => (x.kind !== 'human' ? x : players.get(x.player)?.lobby === l.id ? { ...x, away: true } : { ...openSlot(i), faction: x.faction, team: x.team }))
      const left = humans(l)
      if (!left.length) continue
      if (!left.some((x) => x.player === l.host)) l.host = left[0].player
      l.state = 'open'
      lobbies.set(l.id, l)
    }
    for (const sm of s.matches) {
      const l = lobbies.get(sm.lobby)
      const w = restoreWorld(sm.world)
      if (!l || !w || !Array.isArray(sm.brains)) continue
      const m: Match = {
        info: sm.info, lobby: sm.lobby, w, brains: sm.brains.map(restoreBrain), n: sm.n, t0: 0, pending: sm.pending ?? [], takeover: sm.takeover ?? [], give: sm.give ?? [],
        gone: new Map(sm.gone ?? []), heir: new Map(sm.heir ?? []), away: new Map(), started: true, loaded: new Set(), timer: null, hashes: new Map(), resynced: new Map(),
      }
      // A player who wasn't kept can't come back: their fleet goes to an AI on the first tick.
      // Everyone else has stepped away, with nobody counting down yet.
      m.info.seats.forEach((x, i) => {
        if (x.kind !== 'human' || m.gone.has(i)) return
        if (players.get(x.player)?.lobby === l.id) m.away.set(i, { deadline: 0, votes: new Map() })
        else {
          m.gone.set(i, 'dropped')
          m.takeover.push([i, TAKEOVER])
        }
      })
      matches.set(l.id, m)
      l.state = 'playing'
    }
    for (const p of players.values()) if (p.lobby && !lobbies.has(p.lobby)) p.lobby = null
    for (const l of lobbies.values()) if (l.state === 'open') unready(l)
    console.log(`[empires] carried over a restart: ${players.size} players, ${lobbies.size} lobbies, ${matches.size} battles (saved ${Math.round(age / 1000)} s ago)`)
  } catch (e) {
    console.warn(`[empires] ignored the state saved before the restart: ${(e as Error).message}`)
    players.clear()
    byToken.clear()
    byName.clear()
    lobbies.clear()
    matches.clear()
  }
}

let closing = false
/** On the way down: the state goes to disk, and every player is told the server is restarting
 * (WebSocket close code 1012, "service restart"), so their game can say so while it waits. */
function shutdown() {
  if (closing) return
  closing = true
  for (const m of matches.values()) if (m.timer) clearTimeout(m.timer)
  try {
    const kept = saveEmpires()
    if (kept) console.log(`[empires] saved ${kept} players, ${lobbies.size} lobbies and ${matches.size} battles for after the restart`)
  } catch (e) {
    console.error('[empires] could not save the state for after the restart:', (e as Error).message)
  }
  for (const p of players.values()) p.ws?.close(1012, 'server restarting')
}

let started = false
/** Brings back what was saved before a restart, and saves it again on the next SIGTERM or SIGINT.
 * Called once the server (or Vite's dev server) starts, not on import: `vite build` loads this
 * file too, and mustn't eat the state. */
export function startEmpires() {
  if (started) return
  started = true
  restoreEmpires()
  // server/shutdown.ts runs it with the other parts' hooks, then exits.
  onShutdown('empires', shutdown)
}
