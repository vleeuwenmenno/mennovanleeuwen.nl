import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { currentUser } from './auth.ts'
import { database } from './db.ts'
import { sameOrigin } from './http.ts'
import { acceptWebSocket, refuse, type WsConnection } from './ws.ts'
import { nameKey, nameProblem, randomName, tidyName } from '../src/apps/games/empires/names.ts'
import { MP_PATH, type ClientMsg, type ServerMsg } from '../src/apps/games/empires/protocol.ts'

// Empires At War multiplayer: the players online, their names and (later) lobbies and matches.
// Anyone may play, signed in or not. Names are unique among everyone online; a signed-in user's
// GitHub login is theirs alone. Everything lives in memory: a restart ends every game.

/** A dropped player keeps their name (and later their seat) this long, for a reload or a blip. */
const GRACE_MS = 30_000
const MAX_PLAYERS = 400
const MAX_PER_IP = 16
const MAX_MESSAGE = 16 * 1024
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
}

const players = new Map<string, Player>()
const byToken = new Map<string, Player>()
const byName = new Map<string, Player>()

const send = (p: Player, m: ServerMsg) => p.ws?.send(JSON.stringify(m))
const newId = () => randomBytes(9).toString('base64url')

/** The address the request came from: the last X-Forwarded-For entry is the one our own reverse
 * proxy added (earlier ones are whatever the client claimed). */
function clientIp(req: IncomingMessage) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return fwd.at(-1) ?? req.socket.remoteAddress ?? '?'
}

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
  if (p.key) byName.delete(p.key)
  p.name = name
  p.key = nameKey(name)
  byName.set(p.key, p)
  send(p, { t: 'welcome', id: p.id, name: p.name, token: p.token, resumed: false })
}

function forget(p: Player) {
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
    // Coming back within the grace period: the same player, name and all, on this connection.
    const back = typeof m.token === 'string' ? byToken.get(m.token) : undefined
    if (back) {
      back.ws?.close(4000, 'replaced')
      back.ws = ws
      back.leftAt = 0
      conn.p = back
      if (back.name) return send(back, { t: 'welcome', id: back.id, name: back.name, token: back.token, resumed: true })
      return send(back, { t: 'ready', suggestion: conn.login && !nameTaken(conn.login, back) ? conn.login : suggest(back), login: conn.login })
    }
    const p: Player = { id: newId(), token: randomBytes(18).toString('base64url'), name: '', key: '', login: conn.login, ip: conn.ip, ws, leftAt: 0, allowance: BURST, allowanceAt: Date.now() }
    players.set(p.id, p)
    byToken.set(p.token, p)
    conn.p = p
    return send(p, { t: 'ready', suggestion: conn.login && !nameTaken(conn.login, p) ? conn.login : suggest(p), login: conn.login })
  }

  const p = conn.p
  if (!allowed(p)) return ws.close(1008, 'too fast')
  switch (m.t) {
    case 'ping':
      return send(p, { t: 'pong', n: Number(m.n) || 0, at: Date.now() })
    case 'claim':
      return claim(p, m.name)
    default:
      return send(p, { t: 'error', why: `Unknown message ${String(m.t).slice(0, 20)}` })
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
    }
  }
  return true
}

// Players who didn't come back in time are let go, and their names freed.
setInterval(() => {
  const now = Date.now()
  for (const p of players.values()) if (!p.ws && p.leftAt && now - p.leftAt > GRACE_MS) forget(p)
}, 5_000).unref()

/** For tests and a status line: how many are online, and with names. */
export const empiresOnline = () => ({ players: players.size, named: byName.size })
