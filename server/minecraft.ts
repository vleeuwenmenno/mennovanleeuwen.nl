import { connect } from 'node:net'
import { database } from './db.ts'

// Asks the Minecraft server directly with the Server List Ping protocol (the request the game's
// multiplayer menu sends), so the status is live instead of coming from a public API's cache.
// Only the one hard-coded server is ever contacted.

export const MC_HOST = 'cloud.mvl.sh'
export const MC_PORT = 25565
const CACHE_MS = 10_000

export type McStatus = {
  online: boolean
  version?: string
  motd?: string
  players: { online: number; max: number; list: string[] }
  icon?: string
  /** Milliseconds from opening the connection to the answer. */
  latency?: number
  checkedAt: number
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
      resolve({
        online: true,
        version: json.version?.name,
        motd: chatText(json.description).replace(/§./g, '').trim() || undefined,
        players: {
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
          list: (json.players?.sample ?? []).map((p: { name: string }) => p.name).filter((n: string) => !!n && !n.includes('§')),
        },
        icon: typeof json.favicon === 'string' ? json.favicon : undefined,
        latency: Date.now() - started,
        checkedAt: Date.now(),
      })
    })
  })
}

let cached: { at: number; value: Promise<McStatus> } | null = null

const pingNow = () => ping(MC_HOST, MC_PORT).catch((): McStatus => ({ online: false, players: { online: 0, max: 0, list: [] }, checkedAt: Date.now() }))

/** The server's status, cached for 10 seconds however many visitors ask. Offline when it does not answer. */
export function minecraftStatus(): Promise<McStatus> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = pingNow()
  cached = { at: Date.now(), value }
  return value
}

// ---------------------------------------------------------------------------------------------
// History: a ping every 30 seconds while the site's server runs, kept for 30 days. Who was on
// comes from the ping's player sample, so it is as good as that sample (vanilla lists up to 12).

const WATCH_MS = 30_000
const KEEP_MS = 30 * 864e5
/** Longer than this without a ping (the site was down) and nobody is assumed to have stayed on. */
const GAP_MS = 5 * 60_000

let watching = false

/** Starts the pinger; MC_WATCH=off leaves it off (and the overview without history). */
export function startMinecraftWatch() {
  if (watching || process.env.MC_WATCH === 'off') return
  watching = true
  let lastPrune = 0
  const tick = async () => {
    const value = pingNow()
    cached = { at: Date.now(), value }
    const st = await value
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
  buckets: { from: number; to: number; peak: number | null; avg: number | null; uptime: number | null }[]
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
  const buckets = Array.from({ length: n }, (_, i) => {
    const x = byBucket.get(i)
    return { from: Math.round(start + i * size), to: Math.round(start + (i + 1) * size), peak: x?.peak ?? null, avg: x ? Math.round(x.avg * 10) / 10 : null, uptime: x?.up ?? null }
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
