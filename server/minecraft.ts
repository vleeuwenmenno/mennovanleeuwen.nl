import { connect } from 'node:net'
import { database } from './db.ts'
import { HttpError } from './http.ts'

// Asks the Minecraft server directly with the Server List Ping protocol (the request the game's
// multiplayer menu sends), so the status is live instead of coming from a public API's cache.
// Only the one hard-coded server is ever contacted.
//
// The ping's player sample is not a reliable list of names: players who switch off "Allow Server
// Listings" come through as "Anonymous Player", and the same player can be named in one ping and
// anonymous in the next. With MC_RCON (host:port) and MC_RCON_PASSWORD set, the names come from
// RCON's `list` command instead, which always has everyone; the ping still gives the rest. The
// pinger's tick also asks RCON for the world's clock, each online player's dimension, level and
// health, and a few settings (the extras below), all read-only.

export const MC_HOST = 'cloud.mvl.sh'
export const MC_PORT = 25565
const CACHE_MS = 10_000
/** Players who switched off "Allow Server Listings" are sent with this id as "Anonymous Player". */
const ANONYMOUS = '00000000-0000-0000-0000-000000000000'

export type McStatus = {
  online: boolean
  version?: string
  motd?: string
  /** `list` is the named part of the sample; `hidden` counts those in it who hide their name. */
  players: { online: number; max: number; list: string[]; hidden?: number }
  icon?: string
  /** Milliseconds from opening the connection to the answer. */
  latency?: number
  checkedAt: number
  /** From RCON, when it is set up and has answered in the last few minutes (see the extras below). */
  world?: McWorld
  playerInfo?: Record<string, McPlayerInfo>
  settings?: McSettings
}

function varint(n: number): Buffer {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return Buffer.from(out)
}

/** Reads a VarInt at `offset`; null when the buffer does not hold all of it yet. */
function readVarint(buf: Buffer, offset: number): [number, number] | null {
  let n = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null
    const b = buf[offset + i]
    n |= (b & 0x7f) << (7 * i)
    if (!(b & 0x80)) return [n, offset + i + 1]
  }
  throw new Error('bad varint')
}

/** Flattens a chat component ({text, extra: [...]}) or a plain string to text. */
function chatText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!c || typeof c !== 'object') return ''
  const o = c as { text?: string; extra?: unknown[] }
  return (o.text ?? '') + (o.extra ?? []).map(chatText).join('')
}

function ping(host: string, port: number, timeoutMs = 4000): Promise<McStatus> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port })
    let buf = Buffer.alloc(0)
    const started = Date.now()
    const fail = (err: Error) => {
      sock.destroy()
      reject(err)
    }
    sock.setTimeout(timeoutMs, () => fail(new Error('timeout')))
    sock.on('error', fail)
    sock.on('connect', () => {
      const h = Buffer.from(host)
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(port)
      // Handshake (packet 0x00, protocol -1 = "just asking", next state 1 = status), then status request.
      const handshake = Buffer.concat([varint(0), varint(767), varint(h.length), h, portBuf, varint(1)])
      sock.write(Buffer.concat([varint(handshake.length), handshake, varint(1), varint(0)]))
    })
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const len = readVarint(buf, 0)
      if (!len || buf.length < len[1] + len[0]) return
      const id = readVarint(buf, len[1])!
      const strLen = readVarint(buf, id[1])!
      const json = JSON.parse(buf.subarray(strLen[1], strLen[1] + strLen[0]).toString('utf8'))
      sock.end()
      const sample: { id?: string; name?: string }[] = Array.isArray(json.players?.sample) ? json.players.sample : []
      const anonymous = (p: { id?: string }) => p.id === ANONYMOUS
      resolve({
        online: true,
        version: json.version?.name,
        motd: chatText(json.description).replace(/§./g, '').trim() || undefined,
        players: {
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
          list: sample.filter((p) => !anonymous(p)).map((p) => p.name ?? '').filter((n) => !!n && !n.includes('§')),
          hidden: sample.filter(anonymous).length,
        },
        icon: typeof json.favicon === 'string' ? json.favicon : undefined,
        latency: Date.now() - started,
        checkedAt: Date.now(),
      })
    })
  })
}

// --- RCON ------------------------------------------------------------------------------------
// Packets are: length, request id, type (int32 little-endian each), an ASCII body and two zero bytes.

const RCON_AUTH = 3
const RCON_COMMAND = 2
const RCON_TIMEOUT_MS = 3000
/** However many commands one connection runs, it is closed after this long. */
const RCON_SESSION_MS = 10_000
/** The server splits longer answers into packets of this many bytes. */
const RCON_CHUNK = 4096

function rconTarget(): { host: string; port: number; password: string } | null {
  const addr = process.env.MC_RCON?.trim()
  const password = process.env.MC_RCON_PASSWORD
  if (!addr || !password) return null
  const i = addr.lastIndexOf(':')
  const port = i > 0 ? Number(addr.slice(i + 1)) : 25575
  return { host: i > 0 ? addr.slice(0, i) : addr, port: Number.isInteger(port) && port > 0 ? port : 25575, password }
}

export const rconConfigured = () => rconTarget() !== null

function rconPacket(id: number, type: number, body: string) {
  const b = Buffer.from(body, 'utf8')
  const out = Buffer.alloc(14 + b.length)
  out.writeInt32LE(10 + b.length, 0)
  out.writeInt32LE(id, 4)
  out.writeInt32LE(type, 8)
  b.copy(out, 12)
  return out
}

/**
 * Logs in once and hands `use` a function that runs one command at a time on that connection, so
 * a tick's several commands cost one login. The connection closes when `use` is done, and fails as
 * a whole when the server stops answering for RCON_TIMEOUT_MS (or after RCON_SESSION_MS in all).
 */
export function rconSession<T>(host: string, port: number, password: string, use: (run: (command: string) => Promise<string>) => Promise<T>): Promise<T> {
  // Vanilla Minecraft gathers every RCON connection's command output in one shared buffer, so two
  // sessions at once (the pinger's tick, a visitor's status, the admin console) can get each
  // other's answers glued onto their own: "There are 0 of a max of 20 players online: There are 0
  // …", read as a player called "There are 0 of a max…". One session at a time, in turn.
  const turn = rconQueue.then(() => openRconSession(host, port, password, use))
  rconQueue = turn.then(
    () => {},
    () => {},
  )
  return turn
}
let rconQueue: Promise<void> = Promise.resolve()

function openRconSession<T>(host: string, port: number, password: string, use: (run: (command: string) => Promise<string>) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port })
    let buf = Buffer.alloc(0)
    let nextId = 2
    let done = false
    let authed = false
    /** The command waiting for its answer: the answer so far, and the id of the marker sent after a full chunk. */
    let waiting: { id: number; parts: string[]; marker?: number; resolve: (out: string) => void; reject: (err: Error) => void } | null = null
    const fail = (err: Error) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      sock.destroy()
      waiting?.reject(err)
      reject(err)
    }
    const deadline = setTimeout(() => fail(new Error('timeout')), RCON_SESSION_MS)
    sock.setTimeout(RCON_TIMEOUT_MS, () => fail(new Error('timeout')))
    sock.on('error', fail)
    sock.on('close', () => fail(new Error('connection closed')))
    sock.on('connect', () => sock.write(rconPacket(1, RCON_AUTH, password)))
    const run = (command: string) =>
      new Promise<string>((res, rej) => {
        if (done) return rej(new Error('connection closed'))
        const id = nextId++
        waiting = { id, parts: [], resolve: res, reject: rej }
        sock.write(rconPacket(id, RCON_COMMAND, command))
      })
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0)
        const id = buf.readInt32LE(4)
        const type = buf.readInt32LE(8)
        const body = buf.subarray(12, 4 + len - 2)
        buf = buf.subarray(4 + len)
        if (!authed) {
          // Some servers send an empty response before the auth answer (type 2): skip it.
          if (type !== RCON_COMMAND) continue
          if (id === -1) return fail(new Error('wrong RCON password'))
          authed = true
          use(run).then((value) => {
            if (done) return
            done = true
            clearTimeout(deadline)
            sock.end()
            resolve(value)
          }, fail)
          continue
        }
        const w = waiting
        if (!w) continue
        if (id === w.id) {
          w.parts.push(body.toString('utf8'))
          // A full chunk may have more after it. The server answers in order, so a request sent now
          // (an unknown packet type, which it answers with an error) comes back after the rest.
          if (body.length >= RCON_CHUNK && w.marker === undefined) {
            w.marker = nextId++
            sock.write(rconPacket(w.marker, 0, ''))
          }
          if (w.marker === undefined) {
            waiting = null
            w.resolve(w.parts.join(''))
          }
        } else if (id === w.marker) {
          waiting = null
          w.resolve(w.parts.join(''))
        }
      }
    })
  })
}

/** Logs in, runs one command and answers its output. */
export function rcon(host: string, port: number, password: string, command: string): Promise<string> {
  return rconSession(host, port, password, (run) => run(command))
}

/** Minecraft's colour and format codes (§ and one character) taken out. */
const plain = (out: string) => out.replace(/§./gs, '').trim()

/** "There are 4 of a max of 20 players online: a, b, c, d" (vanilla, Paper and friends). */
export function parseList(out: string): string[] | null {
  const m = /players online:(.*)$/s.exec(out.replace(/§./g, ''))
  if (!m) return null
  // Only real usernames: an answer with something else glued on (see rconSession) must never
  // turn into a player.
  return m[1]
    .split(',')
    .map((n) => n.trim())
    .filter((n) => /^[A-Za-z0-9_]{3,16}$/.test(n))
}

// The extras RCON can tell besides who is on, asked on the pinger's tick (never by a visitor's
// request). Each answer is parsed strictly; one that doesn't fit leaves its field out. Nothing
// that would let a visitor find someone in the world (coordinates) or get in (the whitelist, the
// seed) is asked for here: this ends up in the public status.

/** In-game time: the day number, ticks into the day (0 = 06:00), that as a clock, and the light. */
export type McWorld = { day: number; ticks: number; clock: string; phase: 'day' | 'dusk' | 'night' | 'dawn' }
/** An online player's dimension (overworld, nether, end, or a datapack's own), XP level and health (0..20). */
export type McPlayerInfo = { dimension?: string; level?: number; health?: number }
/** `border` only when it is smaller than the default (the whole world); `software` is Vanilla, Paper and the like. */
export type McSettings = { difficulty?: string; border?: number; software?: string }

/** Player names as Minecraft allows them: the only thing ever put into a command. */
export const SAFE_NAME = /^[A-Za-z0-9_]{3,16}$/
const DETAILS_MAX = 12
/** Values older than this are dropped rather than shown as current. */
const EXTRAS_KEEP_MS = 5 * 60_000
const SETTINGS_EVERY_MS = 10 * 60_000
const SETTINGS_KEEP_MS = 30 * 60_000
const DEFAULT_BORDER = 59_999_968

/** "The time is 1234" (`time query daytime` and `time query day`). */
export function parseTime(out: string): number | null {
  const m = /^The time is (\d+)$/.exec(plain(out))
  return m ? Number(m[1]) : null
}

export function worldClock(daytime: number, day: number): McWorld {
  const ticks = daytime % 24000
  const h = (Math.floor(ticks / 1000) + 6) % 24
  const m = Math.floor(((ticks % 1000) * 60) / 1000)
  const phase = ticks < 12000 ? 'day' : ticks < 13000 ? 'dusk' : ticks < 23000 ? 'night' : 'dawn'
  return { day, ticks, clock: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, phase }
}

/** The value in "Steve has the following entity data: 30" (`data get entity <name> <path>`). */
export function parseEntityData(out: string): string | null {
  const m = /^[A-Za-z0-9_]{3,16} has the following entity data: (.+)$/s.exec(plain(out))
  return m ? m[1].trim() : null
}

/** "minecraft:the_nether" as overworld / nether / end, or a datapack dimension's own name. */
export function parseDimension(v: string | null): string | null {
  const m = v && /^"([a-z0-9_.-]+):([a-z0-9_./-]{1,40})"$/.exec(v)
  if (!m) return null
  if (m[1] === 'minecraft' && m[2] === 'the_nether') return 'nether'
  if (m[1] === 'minecraft' && m[2] === 'the_end') return 'end'
  return m[2]
}

/** An NBT number: "30", "20.0f", "7.5d". */
export function parseNumber(v: string | null): number | null {
  const m = v && /^(-?\d+(?:\.\d+)?)[bsfdlBSFDL]?$/.exec(v)
  return m ? Number(m[1]) : null
}

/** "The difficulty is Normal". */
export function parseDifficulty(out: string): string | null {
  const m = /^The difficulty is (Peaceful|Easy|Normal|Hard)$/i.exec(plain(out))
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null
}

/** "The world border is currently 59999968 block(s) wide". */
export function parseBorder(out: string): number | null {
  const m = /^The world border is currently ([\d,]+(?:\.\d+)?) block/.exec(plain(out))
  const n = m ? Number(m[1].replace(/,/g, '')) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

const FORKS = ['Paper', 'Purpur', 'Folia', 'Pufferfish', 'Spigot', 'CraftBukkit']
/** Paper and the other Bukkit servers answer `version` with their name; vanilla 1.20.1 doesn't know the command. */
export function parseSoftware(out: string): string | null {
  const text = plain(out)
  if (/running/i.test(text) || /version/i.test(text)) {
    const fork = FORKS.find((f) => new RegExp(`\\b${f}\\b`, 'i').test(text))
    if (fork) return fork
  }
  return /^Unknown (or incomplete )?command/i.test(text) ? 'Vanilla' : null
}

const extras: { world: { value: McWorld; at: number } | null; players: Map<string, { value: McPlayerInfo; at: number }>; settings: { value: McSettings; at: number } | null } = {
  world: null,
  players: new Map(),
  settings: null,
}

/** Asks for the extras on an open RCON connection, keeping each value as soon as it is in. */
async function collectExtras(run: (command: string) => Promise<string>, names: string[]) {
  const daytime = parseTime(await run('time query daytime'))
  const day = parseTime(await run('time query day'))
  if (daytime !== null && day !== null) extras.world = { value: worldClock(daytime, day), at: Date.now() }
  for (const name of names.filter((n) => SAFE_NAME.test(n)).slice(0, DETAILS_MAX)) {
    const info: McPlayerInfo = {}
    const dimension = parseDimension(parseEntityData(await run(`data get entity ${name} Dimension`)))
    const level = parseNumber(parseEntityData(await run(`data get entity ${name} XpLevel`)))
    const health = parseNumber(parseEntityData(await run(`data get entity ${name} Health`)))
    if (dimension !== null) info.dimension = dimension
    if (level !== null && Number.isInteger(level) && level >= 0) info.level = level
    if (health !== null && health >= 0 && health <= 1024) info.health = Math.round(health * 10) / 10
    if (Object.keys(info).length) extras.players.set(name, { value: info, at: Date.now() })
  }
  if (!extras.settings || Date.now() - extras.settings.at > SETTINGS_EVERY_MS) {
    const settings: McSettings = {}
    const difficulty = parseDifficulty(await run('difficulty'))
    const border = parseBorder(await run('worldborder get'))
    // Unknown on vanilla (that answer is what says it's vanilla), so a failure here is no error.
    const software = parseSoftware(await run('version').catch(() => ''))
    if (difficulty) settings.difficulty = difficulty
    if (border !== null && border < DEFAULT_BORDER) settings.border = border
    if (software) settings.software = software
    extras.settings = { value: settings, at: Date.now() }
  }
}

/** The status with whatever extras are recent enough, the player details only for those on now. */
function withExtras(st: McStatus): McStatus {
  if (!st.online) return st
  const now = Date.now()
  const out: McStatus = { ...st }
  if (extras.world && now - extras.world.at < EXTRAS_KEEP_MS) out.world = extras.world.value
  const info: Record<string, McPlayerInfo> = {}
  for (const [name, p] of extras.players) {
    if (now - p.at >= EXTRAS_KEEP_MS) extras.players.delete(name)
    else if (st.players.list.includes(name)) info[name] = p.value
  }
  if (Object.keys(info).length) out.playerInfo = info
  if (extras.settings && now - extras.settings.at < SETTINGS_KEEP_MS && Object.keys(extras.settings.value).length) out.settings = extras.settings.value
  return out
}

let rconWarned = false
let extrasRunning = false
/**
 * Everyone online by name over RCON, or null when it isn't set up or doesn't answer. With `extras`
 * (the pinger's tick) the same connection goes on to ask for the extras after `list`; the names are
 * answered as soon as they are in, so the ping never waits on the rest.
 */
function rconPlayers(withExtras: boolean): Promise<string[] | null> {
  const t = rconTarget()
  if (!t) return Promise.resolve(null)
  const asking = withExtras && !extrasRunning
  if (asking) extrasRunning = true
  let answer: (names: string[] | null) => void = () => {}
  const names = new Promise<string[] | null>((r) => (answer = r))
  rconSession(t.host, t.port, t.password, async (run) => {
    const list = parseList(await run('list'))
    if (!list) throw new Error('unexpected answer to list')
    answer(list)
    if (asking) await collectExtras(run, list)
  })
    .then(
      () => {
        rconWarned = false
      },
      (e: Error) => {
        answer(null)
        if (!rconWarned) console.error('minecraft rcon:', e.message)
        rconWarned = true
      },
    )
    .finally(() => {
      if (asking) extrasRunning = false
    })
  return names
}

// --- Admin console -----------------------------------------------------------------------------
// The Minecraft server window's RCON panel, for the site's admins only (POST /api/minecraft/rcon,
// checked in server/api.ts). Quick actions are built here from validated parts; the console runs
// what it is given, one line at a time. Every command is logged with who sent it.

const ADMIN_PER_MINUTE = 30
const COMMAND_MAX = 256
const adminSent = new Map<number, { at: number; n: number }>()

/** Chat text for `say`, `tell` and kick reasons: one line, no colour codes, not too long. */
function chatLine(v: unknown, max = COMMAND_MAX - 40): string {
  return typeof v === 'string'
    ? v
        .replace(/§/g, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .slice(0, max)
    : ''
}

function playerName(v: unknown): string {
  if (typeof v !== 'string' || !SAFE_NAME.test(v)) throw new HttpError(400, 'Not a valid player name')
  return v
}

/** "There are 2 whitelisted player(s): a, b", or "There are no whitelisted players". */
export function parseWhitelist(out: string): string[] | null {
  const text = plain(out)
  if (/no whitelisted players/i.test(text)) return []
  const m = /whitelisted player(?:s|\(s\))?:(.*)$/s.exec(text)
  return m
    ? m[1]
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    : null
}

export type McAdminRequest = { action?: unknown; command?: unknown; name?: unknown; text?: unknown; reason?: unknown; op?: unknown }

/** The one command a request asks for, or a 400 saying why not. */
export function adminCommand(body: McAdminRequest): string {
  switch (body.action) {
    case 'say': {
      const text = chatLine(body.text)
      if (!text) throw new HttpError(400, 'Nothing to say')
      return `say ${text}`
    }
    case 'tell': {
      const name = playerName(body.name)
      const text = chatLine(body.text)
      if (!text) throw new HttpError(400, 'Nothing to say')
      return `tell ${name} ${text}`
    }
    case 'kick': {
      const reason = chatLine(body.reason, 100)
      return `kick ${playerName(body.name)}${reason ? ` ${reason}` : ''}`
    }
    case 'whitelist':
      if (body.op === 'list') return 'whitelist list'
      if (body.op === 'add' || body.op === 'remove') return `whitelist ${body.op} ${playerName(body.name)}`
      throw new HttpError(400, 'Unknown whitelist action')
    case undefined:
    case 'command': {
      if (typeof body.command !== 'string') throw new HttpError(400, 'No command')
      if (/[\x00-\x1f\x7f]/.test(body.command)) throw new HttpError(400, 'One command at a time, on one line')
      const command = body.command.trim().replace(/^\//, '')
      if (!command) throw new HttpError(400, 'No command')
      if (command.length > COMMAND_MAX) throw new HttpError(400, `Commands are at most ${COMMAND_MAX} characters`)
      return command
    }
    default:
      throw new HttpError(400, 'Unknown action')
  }
}

/** Runs an admin's request over RCON: its command, the output, and the whitelist when that was listed. */
export async function minecraftAdmin(user: { id: number; login: string }, body: McAdminRequest): Promise<{ command: string; output: string; whitelist?: string[] }> {
  const t = rconTarget()
  if (!t) throw new HttpError(503, 'RCON is not set up on this server (MC_RCON and MC_RCON_PASSWORD)')
  const command = adminCommand(body)
  const now = Date.now()
  const sent = adminSent.get(user.id)
  if (sent && now - sent.at < 60_000) {
    if (++sent.n > ADMIN_PER_MINUTE) throw new HttpError(429, `At most ${ADMIN_PER_MINUTE} commands a minute: wait a little`)
  } else adminSent.set(user.id, { at: now, n: 1 })
  console.log(`${new Date(now).toISOString()} minecraft rcon: ${user.login} ran: ${command}`)
  let output: string
  try {
    output = plain(await rcon(t.host, t.port, t.password, command))
  } catch (e) {
    const msg = (e as Error).message
    throw new HttpError(502, msg === 'wrong RCON password' ? 'RCON refused the password (MC_RCON_PASSWORD)' : `Could not reach the Minecraft server's RCON (${msg})`)
  }
  if (command === 'whitelist list') {
    const whitelist = parseWhitelist(output)
    if (whitelist) return { command, output, whitelist }
  }
  return { command, output }
}

let cached: { at: number; value: Promise<McStatus> } | null = null

async function pingNow(extras = false): Promise<McStatus> {
  const st = await ping(MC_HOST, MC_PORT).catch((): McStatus => ({ online: false, players: { online: 0, max: 0, list: [] }, checkedAt: Date.now() }))
  if (!st.online) return st
  const names = await rconPlayers(extras)
  return names ? { ...st, players: { ...st.players, online: names.length, list: names, hidden: 0 } } : st
}

/** The server's status, cached for 10 seconds however many visitors ask. Offline when it does not answer. */
export function minecraftStatus(): Promise<McStatus> {
  if (!cached || Date.now() - cached.at >= CACHE_MS) cached = { at: Date.now(), value: pingNow() }
  return cached.value.then(withExtras)
}

// ---------------------------------------------------------------------------------------------
// History: a ping every 30 seconds while the site's server runs, kept for 30 days. Who was on
// comes from the ping's player sample, so it is as good as that sample (vanilla lists up to 12).

const WATCH_MS = 30_000
const KEEP_MS = 30 * 864e5
/** Longer than this without a ping (the site was down) and nobody is assumed to have stayed on. */
const GAP_MS = 5 * 60_000

let watching = false
/** Told every ping's result (the notification hub's Minecraft watcher, server/watchers.ts). */
const listeners = new Set<(st: McStatus) => void>()
export function onMinecraftStatus(l: (st: McStatus) => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Starts the pinger; MC_WATCH=off leaves it off (and the overview without history). */
export function startMinecraftWatch() {
  if (watching || process.env.MC_WATCH === 'off') return
  watching = true
  let lastPrune = 0
  const tick = async () => {
    const value = pingNow(true)
    cached = { at: Date.now(), value }
    const st = await value
    for (const l of listeners) {
      try {
        l(st)
      } catch (e) {
        console.error('minecraft listener:', (e as Error).message)
      }
    }
    try {
      record(st)
      if (st.checkedAt - lastPrune > 3600_000) {
        lastPrune = st.checkedAt
        prune(st.checkedAt)
      }
    } catch (e) {
      console.error('minecraft history:', (e as Error).message)
    }
  }
  void tick()
  setInterval(tick, WATCH_MS).unref()
}

function record(st: McStatus) {
  const db = database()
  const now = st.checkedAt
  const prev = (db.prepare('SELECT MAX(at) AS at FROM mc_samples').get() as { at: number | null }).at
  db.prepare('INSERT OR REPLACE INTO mc_samples (at, online, players, latency) VALUES (?, ?, ?, ?)').run(now, st.online ? 1 : 0, st.players.online, st.latency ?? null)

  // After a gap, whoever was on is taken to have left when the last ping saw them.
  if (prev !== null && now - prev > GAP_MS) db.prepare('UPDATE mc_sessions SET left_at = ? WHERE left_at IS NULL').run(prev)
  const open = db.prepare('SELECT id, name FROM mc_sessions WHERE left_at IS NULL').all() as { id: number; name: string }[]
  const here = new Set(st.online ? st.players.list : [])
  // A sample shorter than the count leaves people out at random: only trust it for who joined.
  // A player can be named in one ping and anonymous in the next, so the hidden ones count as unknown.
  const complete = !st.online || st.players.list.length >= st.players.online
  for (const s of open) if (!here.has(s.name) && complete) db.prepare('UPDATE mc_sessions SET left_at = ? WHERE id = ?').run(now, s.id)
  const known = new Set(open.map((s) => s.name))
  for (const name of here) if (!known.has(name)) db.prepare('INSERT INTO mc_sessions (name, joined_at) VALUES (?, ?)').run(name, now)
}

function prune(now: number) {
  const db = database()
  db.prepare('DELETE FROM mc_samples WHERE at < ?').run(now - KEEP_MS)
  db.prepare('DELETE FROM mc_sessions WHERE left_at IS NOT NULL AND left_at < ?').run(now - KEEP_MS)
}

export type McRange = '24h' | '7d' | '30d'
const RANGES: Record<McRange, { span: number; buckets: number }> = {
  '24h': { span: 864e5, buckets: 48 },
  '7d': { span: 7 * 864e5, buckets: 84 },
  '30d': { span: 30 * 864e5, buckets: 60 },
}

/** Who was on during a bucket, earliest first: `joined` and `left` when that happened inside it. */
export type McBucketPlayer = { name: string; joined?: number; left?: number }
export type McBucket = {
  from: number
  to: number
  peak: number | null
  avg: number | null
  uptime: number | null
  /** At most BUCKET_NAMES of them; `more` counts the rest, `joins` everyone who joined in it. */
  players: McBucketPlayer[]
  more: number
  joins: number
}
const BUCKET_NAMES = 12

/**
 * Who was on in each bucket, from the visits overlapping it. Several visits by one player in a
 * bucket are one entry: joined at their first join inside it, and left only if their last visit
 * ended inside it too.
 */
export function bucketPlayers(sessions: { name: string; joinedAt: number; leftAt: number | null }[], from: number, to: number, now: number) {
  const who = new Map<string, McBucketPlayer & { first: number }>()
  for (const s of [...sessions].sort((a, b) => a.joinedAt - b.joinedAt)) {
    const end = s.leftAt ?? now
    const inside = s.joinedAt >= from && s.joinedAt < to
    if (!inside && !(s.joinedAt < to && end > from)) continue
    let p = who.get(s.name)
    if (!p) who.set(s.name, (p = { name: s.name, first: Math.max(s.joinedAt, from) }))
    if (inside && p.joined === undefined) p.joined = s.joinedAt
    if (s.leftAt !== null && s.leftAt < to) p.left = s.leftAt
    else delete p.left
  }
  const all = [...who.values()].sort((a, b) => a.first - b.first)
  return {
    players: all.slice(0, BUCKET_NAMES).map(({ first: _, ...p }) => p),
    more: Math.max(0, all.length - BUCKET_NAMES),
    joins: all.filter((p) => p.joined !== undefined).length,
  }
}

export type McOverview = {
  status: McStatus
  /** False when nothing is recorded (MC_WATCH=off, or the pinger has only just started). */
  tracking: boolean
  trackedSince: number | null
  /** When the server last came up (or went down), if that happened since tracking began. */
  stateSince: number | null
  uptime: { day: number | null; week: number | null; month: number | null }
  latency: number | null
  peak: { players: number; at: number } | null
  range: McRange
  /** Oldest first. peak/avg are null where nothing was recorded; uptime is 0..1. */
  buckets: McBucket[]
  online: { name: string; since: number }[]
  recent: { name: string; joinedAt: number; leftAt: number | null }[]
  top: { name: string; ms: number; visits: number; lastSeen: number | null }[]
}

export async function minecraftOverview(range: string | null): Promise<McOverview> {
  const r: McRange = range && range in RANGES ? (range as McRange) : '24h'
  const status = await minecraftStatus()
  const now = Date.now()
  const db = database()
  const one = <T>(sql: string, ...args: (number | string)[]) => db.prepare(sql).get(...args) as T
  const all = <T>(sql: string, ...args: (number | string)[]) => db.prepare(sql).all(...args) as T[]

  const trackedSince = one<{ at: number | null }>('SELECT MIN(at) AS at FROM mc_samples').at
  const uptime = (since: number) => one<{ u: number | null }>('SELECT AVG(online) AS u FROM mc_samples WHERE at >= ?', now - since).u
  const flip = one<{ at: number | null }>('SELECT MAX(at) AS at FROM mc_samples WHERE online != ?', status.online ? 1 : 0).at
  const stateSince = flip === null ? null : one<{ at: number | null }>('SELECT MIN(at) AS at FROM mc_samples WHERE at > ?', flip).at
  const peak = one<{ players: number; at: number } | undefined>('SELECT players, at FROM mc_samples WHERE at >= ? AND players > 0 ORDER BY players DESC, at DESC LIMIT 1', now - KEEP_MS) ?? null

  const { span, buckets: n } = RANGES[r]
  const size = span / n
  const start = now - span
  const rows = all<{ b: number; peak: number; avg: number; up: number }>(
    'SELECT CAST((at - ?) / ? AS INTEGER) AS b, MAX(players) AS peak, AVG(players) AS avg, AVG(online) AS up FROM mc_samples WHERE at >= ? GROUP BY b',
    start,
    size,
    start,
  )
  const byBucket = new Map(rows.map((x) => [x.b, x]))
  const sessions = all<{ name: string; joinedAt: number; leftAt: number | null }>(
    'SELECT name, joined_at AS joinedAt, left_at AS leftAt FROM mc_sessions WHERE joined_at < ? AND COALESCE(left_at, ?) >= ?',
    now,
    now,
    start,
  )
  const buckets = Array.from({ length: n }, (_, i): McBucket => {
    const x = byBucket.get(i)
    const from = Math.round(start + i * size)
    const to = Math.round(start + (i + 1) * size)
    return { from, to, peak: x?.peak ?? null, avg: x ? Math.round(x.avg * 10) / 10 : null, uptime: x?.up ?? null, ...bucketPlayers(sessions, from, to, now) }
  })

  const online = all<{ name: string; since: number }>('SELECT name, MIN(joined_at) AS since FROM mc_sessions WHERE left_at IS NULL GROUP BY name ORDER BY since')
  const recent = all<{ name: string; joinedAt: number; leftAt: number | null }>(
    'SELECT name, joined_at AS joinedAt, left_at AS leftAt FROM mc_sessions WHERE left_at IS NOT NULL ORDER BY left_at DESC LIMIT 12',
  )
  const top = all<{ name: string; ms: number; visits: number; lastSeen: number | null }>(
    `SELECT name, SUM(COALESCE(left_at, ?) - MAX(joined_at, ?)) AS ms, COUNT(*) AS visits,
       CASE WHEN SUM(left_at IS NULL) > 0 THEN NULL ELSE MAX(left_at) END AS lastSeen
     FROM mc_sessions WHERE COALESCE(left_at, ?) >= ? GROUP BY name ORDER BY ms DESC LIMIT 10`,
    now,
    now - KEEP_MS,
    now,
    now - KEEP_MS,
  )

  const latency = one<{ l: number | null }>('SELECT AVG(latency) AS l FROM mc_samples WHERE at >= ? AND latency IS NOT NULL', now - 3600_000).l
  return {
    status,
    tracking: trackedSince !== null,
    trackedSince,
    stateSince,
    uptime: { day: uptime(864e5), week: uptime(7 * 864e5), month: uptime(KEEP_MS) },
    latency: latency === null ? null : Math.round(latency),
    peak,
    range: r,
    buckets,
    online,
    recent,
    top,
  }
}
