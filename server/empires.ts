import { randomBytes, randomInt } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { currentUser } from './auth.ts'
import { database } from './db.ts'
import { sameOrigin } from './http.ts'
import { acceptWebSocket, refuse, type WsConnection } from './ws.ts'
import { DIFFICULTY, type Brain } from '../src/apps/games/empires/ai.ts'
import { cleanCmd } from '../src/apps/games/empires/commands.ts'
import { CREDIT_STEPS, FACTIONS, START_CREDITS } from '../src/apps/games/empires/data.ts'
import { DEFAULT_RULES, GENERATED, MAP, MAPS, cleanRules, generateMap, type MapDef } from '../src/apps/games/empires/maps.ts'
import { matchBrains, matchWorld, stepTurn, type MatchInfo, type Turn } from '../src/apps/games/empires/match.ts'
import { nameKey, nameProblem, randomName, tidyName } from '../src/apps/games/empires/names.ts'
import { CHAT_MAX, HASH_EVERY, MP_PATH, type ClientMsg, type LobbyInfo, type MpLobby, type MpSlot, type ServerMsg, type SlotPatch } from '../src/apps/games/empires/protocol.ts'
import { STEP, stateHash, type World } from '../src/apps/games/empires/sim.ts'

// Empires At War multiplayer: the players online, their names, the lobbies they gather in, and
// the battles. Anyone may play, signed in or not. Names are unique among everyone online; a
// signed-in user's GitHub login is theirs alone. Everything lives in memory: a restart ends every
// lobby and game.
//
// A battle runs in lockstep: every player's machine runs the whole battle itself, and only orders
// cross the network. The server keeps the clock: each tick it hands everyone that tick's orders
// (cleaned, and stamped with the sender's own seat), and nobody's battle moves on without them.
// It also runs its own copy, to check the fingerprints players send now and then and to call the
// winner, so a tampered client can't order other players' ships, play faster, or claim a win.

/** A dropped player keeps their name and seat this long, for a reload or a blip. */
const GRACE_MS = 30_000
const MAX_PLAYERS = 400
const MAX_PER_IP = 16
const MAX_MESSAGE = 16 * 1024
const MAX_LOBBIES = 100
/** How long the clock waits for everyone's game to load before starting anyway. */
const LOAD_WAIT_MS = 20_000
/** Orders one player may give in a single tick (a drag-select order is one). */
const MAX_CMDS_PER_TICK = 12
/** Fingerprints the server keeps, to compare late ones against. */
const KEEP_HASHES = 40
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
  /** When the connection dropped; the player is forgotten GRACE_MS later. */
  leftAt: number
  allowance: number
  allowanceAt: number
  /** The lobby they're in. */
  lobby: string | null
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
  /** Orders taken since the last tick, for the next one. */
  pending: Turn['c']
  loaded: Set<string>
  timer: NodeJS.Timeout | null
  hashes: Map<number, number>
  /** Players already told they drifted, so it's said once. */
  drifted: Set<string>
}

const send = (p: Player, m: ServerMsg) => p.ws?.send(JSON.stringify(m))
const newId = () => randomBytes(9).toString('base64url')

/** The address the request came from: the last X-Forwarded-For entry is the one our own reverse
 * proxy added (earlier ones are whatever the client claimed). */
function clientIp(req: IncomingMessage) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return fwd.at(-1) ?? req.socket.remoteAddress ?? '?'
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
const mapOf = (l: MpLobby): MapDef => (l.map === GENERATED ? generateMap(l.gen) : (MAP[l.map] ?? MAPS[0]))
const humans = (l: MpLobby) => l.slots.filter((s) => s.kind === 'human')
const seatOf = (l: MpLobby, p: Player) => l.slots.findIndex((s) => s.kind === 'human' && s.player === p.id)

const openSlot = (i: number): MpSlot => ({ kind: 'open', player: '', name: '', faction: i % 2 ? 'droid' : 'republic', team: (i % 2) as 0 | 1, difficulty: 'medium', ready: false, away: false })
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
  leave(p)
  const map = MAPS[0]
  const l: MpLobby = {
    id: newId(),
    name: `${p.name}'s battle`,
    host: p.id,
    map: map.id,
    gen: { ...DEFAULT_RULES },
    credits: START_CREDITS,
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
function leave(p: Player, why = 'left') {
  const l = lobbyOf(p)
  p.lobby = null
  if (!l) return
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
  if (patch.faction !== undefined && patch.faction in FACTIONS) next.faction = patch.faction
  if (patch.team === 0 || patch.team === 1) next.team = patch.team
  if (patch.difficulty !== undefined && patch.difficulty in DIFFICULTY && (host || own)) next.difficulty = patch.difficulty
  l.slots[i] = next
  unready(l)
  pushLobby(l)
}

function changeSetup(p: Player, l: MpLobby, m: Extract<ClientMsg, { t: 'setup' }>) {
  if (l.host !== p.id) return send(p, { t: 'error', why: 'Only the host can change the map and rules.' })
  if (typeof m.credits === 'number' && CREDIT_STEPS.includes(m.credits)) l.credits = m.credits
  if (m.map !== undefined || m.gen !== undefined) {
    const id = m.map === undefined ? l.map : m.map === GENERATED || MAP[m.map] ? m.map : null
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
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX)
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

function start(p: Player, l: MpLobby) {
  if (l.host !== p.id) return send(p, { t: 'error', why: 'Only the host can start the battle.' })
  if (l.state !== 'open' || matches.has(l.id)) return
  const why = cantStart(l)
  if (why) return send(p, { t: 'error', why })
  const info: MatchInfo = {
    id: newId(),
    seed: randomInt(0, 2 ** 31),
    map: l.map,
    gen: l.gen,
    credits: l.credits,
    seats: l.slots.flatMap((s, spawn) =>
      s.kind === 'human' || s.kind === 'ai' ? [{ kind: s.kind, player: s.player, name: s.kind === 'ai' ? `${DIFFICULTY[s.difficulty].name} AI` : s.name, faction: s.faction, team: s.team, spawn, difficulty: s.difficulty }] : [],
    ),
  }
  const m: Match = { info, lobby: l.id, w: matchWorld(info), brains: matchBrains(info), n: 0, t0: 0, pending: [], loaded: new Set(), timer: null, hashes: new Map(), drifted: new Set() }
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
  if (m.t0 || matches.get(m.lobby) !== m) return
  if (m.timer) clearTimeout(m.timer)
  m.t0 = performance.now()
  clock(m)
}

/** Runs every tick that's due by now, then sleeps until the next. A late wake-up (a busy
 * moment) just runs the missed ticks at once; players' games catch up the same way. */
function clock(m: Match) {
  const due = Math.floor((performance.now() - m.t0) / STEP_MS)
  while (m.n < due && matches.get(m.lobby) === m) {
    runTick(m)
    if (m.w.winner !== -1) return finish(m)
  }
  if (matches.get(m.lobby) !== m) return
  m.timer = setTimeout(() => clock(m), Math.max(1, m.t0 + (m.n + 1) * STEP_MS - performance.now()))
}

function runTick(m: Match) {
  const n = ++m.n
  const c = m.pending
  m.pending = []
  stepTurn(m.w, m.brains, c)
  m.w.events.length = 0
  if (n % HASH_EVERY === 0) {
    m.hashes.set(n, stateHash(m.w))
    m.hashes.delete(n - HASH_EVERY * KEEP_HASHES)
  }
  const msg = JSON.stringify({ t: 'turn', n, c } satisfies ServerMsg)
  for (const s of m.info.seats) if (s.kind === 'human') players.get(s.player)?.ws?.send(msg)
}

function finish(m: Match) {
  const l = lobbies.get(m.lobby)
  stopMatch(m.lobby)
  const msg = JSON.stringify({ t: 'over', winner: m.w.winner } satisfies ServerMsg)
  for (const s of m.info.seats) if (s.kind === 'human') players.get(s.player)?.ws?.send(msg)
  if (!l) return
  const won = m.info.seats.filter((s) => s.team === m.w.winner).map((s) => s.name)
  notice(l, `${won.join(' and ')} won the battle`)
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
  if (seat < 0 || !m.t0) return
  if (m.pending.filter(([s]) => s === seat).length >= MAX_CMDS_PER_TICK) return
  const c = cleanCmd(raw, m.w)
  if (!c) return send(p, { t: 'error', why: "That order didn't make sense to the server." })
  m.pending.push([seat, c])
}

function checkHash(p: Player, m: Match, n: unknown, h: unknown) {
  const ours = typeof n === 'number' ? m.hashes.get(n) : undefined
  if (ours === undefined || ours === h || m.drifted.has(p.id)) return
  m.drifted.add(p.id)
  console.warn(`[empires] ${p.name} drifted from the server's battle at tick ${n} (match ${m.info.id})`)
  send(p, { t: 'desync', n: n as number })
}

// --- Connections ------------------------------------------------------------------------------------

function forget(p: Player) {
  leave(p, 'left')
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

/** Seated players show as away while their connection is down. */
function setAway(p: Player, away: boolean) {
  const l = lobbyOf(p)
  const i = l ? seatOf(l, p) : -1
  if (!l || i < 0 || l.slots[i].away === away) return
  l.slots[i] = { ...l.slots[i], away }
  pushLobby(l)
}

function hello(ws: WsConnection, conn: { p: Player | null; login: string | null; ip: string }, token: unknown) {
  const firstName = (p: Player) => (conn.login && !nameTaken(conn.login, p) ? conn.login : suggest(p))
  // Coming back within the grace period: the same player, name, lobby and seat, on this connection.
  const back = typeof token === 'string' ? byToken.get(token) : undefined
  if (back) {
    back.ws?.close(4000, 'replaced')
    back.ws = ws
    back.leftAt = 0
    conn.p = back
    if (!back.name) return send(back, { t: 'ready', suggestion: firstName(back), login: conn.login })
    send(back, { t: 'welcome', id: back.id, name: back.name, token: back.token, resumed: true })
    const l = lobbyOf(back)
    if (l) {
      setAway(back, false)
      send(back, { t: 'lobby', lobby: l })
    } else send(back, { t: 'lobbies', list: lobbyList() })
    return
  }
  const p: Player = {
    id: newId(), token: randomBytes(18).toString('base64url'), name: '', key: '', login: conn.login, ip: conn.ip, ws, leftAt: 0, allowance: BURST, allowanceAt: Date.now(), lobby: null,
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
    hello(ws, conn, m.token)
    return
  }

  const p = conn.p
  if (!allowed(p)) return ws.close(1008, 'too fast')
  if (m.t === 'ping') return send(p, { t: 'pong', n: Number(m.n) || 0, at: Date.now() })
  if (m.t === 'claim') return claim(p, m.name)
  if (!p.name) return send(p, { t: 'error', why: 'Pick a name first.' })
  if (m.t === 'create') return create(p)
  if (m.t === 'join') return join(p, m.id)
  const l = lobbyOf(p)
  // Battle traffic still on its way after leaving is just dropped.
  if (!l && (m.t === 'cmd' || m.t === 'hash' || m.t === 'loaded')) return
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
    case 'hash': {
      const game = matches.get(l.id)
      if (!game) return
      if (m.t === 'loaded') return loaded(p, game)
      if (m.t === 'cmd') return order(p, game, m.c)
      return checkHash(p, game, m.n, m.h)
    }
    default:
      return send(p, { t: 'error', why: `Unknown message ${String((m as { t: string }).t).slice(0, 20)}` })
  }
}

const perIp = new Map<string, number>()

/** Takes the WebSocket upgrade for MP_PATH; false for any other path (left for others, such as
 * Vite's hot reload in development). */
export function empiresUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== MP_PATH) return false
  socket.on('error', () => socket.destroy())
  // Only this site's pages may connect: a sign-in cookie rides along with the upgrade.
  if (!sameOrigin(req) || !req.headers.origin) {
    refuse(socket, 403, 'Forbidden')
    return true
  }
  const ip = clientIp(req)
  const open = [...players.values()].filter((p) => p.ws).length
  if (open >= MAX_PLAYERS || (perIp.get(ip) ?? 0) >= MAX_PER_IP) {
    refuse(socket, 503, 'Service Unavailable')
    return true
  }
  const ws = acceptWebSocket(req, socket, head, { maxMessage: MAX_MESSAGE })
  if (!ws) return true
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
  let login: string | null = null
  try {
    login = currentUser(req)?.login ?? null
  } catch {
    // No database or sign-in configured: everyone is a guest.
  }
  const conn = { p: null as Player | null, login, ip }
  ws.onMessage = (text) => onMessage(ws, conn, text)
  ws.onClose = () => {
    const n = (perIp.get(ip) ?? 1) - 1
    if (n > 0) perIp.set(ip, n)
    else perIp.delete(ip)
    const p = conn.p
    if (p && p.ws === ws) {
      p.ws = null
      p.leftAt = Date.now()
      setAway(p, true)
    }
  }
  return true
}

// Players who didn't come back in time are let go: their seats open and their names are freed.
setInterval(() => {
  const now = Date.now()
  for (const p of players.values()) if (!p.ws && p.leftAt && now - p.leftAt > GRACE_MS) forget(p)
}, 5_000).unref()

/** For tests and a status line: how many are online, with names, and in lobbies. */
export const empiresOnline = () => ({ players: players.size, named: byName.size, lobbies: lobbies.size, battles: matches.size })
