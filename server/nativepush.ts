import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { clientIp } from './egress.ts'
import { fcmProject, sendData } from './fcm.ts'
import { HttpError, readJson } from './http.ts'

// Push notifications for the Android app (mobile/), over Firebase Cloud Messaging. The cloud
// desktop runs in a WebView that has no Push API, so the app's own native side registers here.
// Design (reviewed twice, README "Native push"):
//
// - A registration belongs to ONE session of ONE account and is a row in native_push_regs with a
//   foreign key to that session: signing out, a replaced session, sign-out-everywhere, a ban, an
//   account deletion and an expired session all end it (ON DELETE CASCADE), and every use checks
//   again that the session is alive and the account not banned.
// - It is made in two steps so that opening the opt-in screen changes nothing: `prepare` (cookie
//   session; inert, 10 minutes) and `activate` after the user confirmed in the app (compare-and-swap
//   against the registration it replaces; one that changed meanwhile is refused). Activation hands
//   out two secrets, shown once and kept only as hashes: a CAPABILITY (set the device token, fetch
//   this registration's notification content) and a REVOCATION key (delete this registration, nothing
//   else; the app keeps only that after Disconnect). Neither is a session or a cookie.
// - What is sent through Google is only ids: {rid, nid, k}. The title, line and the address to open
//   wait here under nid for 15 minutes and are handed out ONCE, to the registration's capability,
//   after the account's current notification settings (do not disturb, sources switched off) are
//   asked again. Anything else (unknown, used, expired, suppressed) is the same 404: the app shows
//   nothing.
// - The address is built here from a short list of apps and ids (nativePath), never taken from the
//   notification as it is.

const RID = /^[A-Za-z0-9_-]{22}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const INSTALL = /^[A-Za-z0-9_-]{22,64}$/
const TOKEN = /^[A-Za-z0-9_:-]{20,4096}$/
const PREPARED_FOR = 10 * 60_000
const CONTENT_FOR = 15 * 60_000
const MAX_REGS = 10
const MAX_PENDING_PER_REG = 30
const MAX_PENDING_TOTAL = 5000
const MAX_PREPARED = 5

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const rand = (bytes: number) => randomBytes(bytes).toString('base64url')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// --- small rate limiter ------------------------------------------------------------------------

const buckets = new Map<string, { at: number; n: number }>()
/** True while `key` has made at most `max` calls in the last `ms`. */
function allow(key: string, max: number, ms: number): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (b && now - b.at < ms) return ++b.n <= max
  buckets.set(key, { at: now, n: 1 })
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.at > 120_000) buckets.delete(k)
  return true
}

/** Bad credentials seen from one address in the last minute: they all wait once there are too many. */
const misses = new Map<string, { at: number; n: number }>()
const failures = (ip: string) => {
  const b = misses.get(ip)
  return b && Date.now() - b.at < 60_000 ? b.n : 0
}
const failed = (ip: string) => {
  const b = misses.get(ip)
  if (b && Date.now() - b.at < 60_000) b.n++
  else misses.set(ip, { at: Date.now(), n: 1 })
  if (misses.size > 5000) for (const [k, v] of misses) if (Date.now() - v.at > 120_000) misses.delete(k)
}

// --- the places a notification may send the app to -----------------------------------------------

const UUID = /^[0-9a-f-]{36}$/
/** Apps a native notification may open, and the ids they take: everything else opens the app's home. */
const OPENABLE: Record<string, Record<string, RegExp>> = {
  agents: { thread: UUID, task: UUID, run: UUID },
  tasks: { task: UUID },
  mail: {},
  calendar: {},
}

/** The address a native notification opens, from its action: `/` or `/?open=<app>` with ids, only from the list above. */
export function nativePath(action: { app?: unknown; props?: Record<string, unknown> } | undefined): string {
  const app = action && typeof action.app === 'string' ? action.app : ''
  const allowed = Object.hasOwn(OPENABLE, app) ? OPENABLE[app] : undefined
  if (!allowed) return '/'
  const query = [`open=${app}`]
  for (const [key, pattern] of Object.entries(allowed)) {
    const v = action?.props?.[key]
    if (typeof v === 'string' && pattern.test(v)) query.push(`${key}=${v}`)
  }
  return `/?${query.join('&')}`
}

/** The coarse kind the phone may show if it ever has to say something generic. */
export const kindOf = (source: string) => (['mail', 'agents', 'tasks', 'calendar'].includes(source.split('.')[0]) ? source.split('.')[0] : 'generic')

// --- what the hub is asked at the moment the app fetches content -----------------------------------

let policy: (userId: number, source: string) => boolean = () => true
/** Set by the notification hub: whether the account's settings (do not disturb, sources off) allow this source now. */
export const setNativePolicy = (fn: (userId: number, source: string) => boolean) => void (policy = fn)

// --- registrations -------------------------------------------------------------------------------

type Reg = { id: number; rid: string; user_id: number; session_id: string; cap_hash: string; rev_hash: string; token_digest: string | null }

const pruneContent = () => {
  const db = database()
  db.prepare('DELETE FROM native_push_content WHERE expires_at < ?').run(Date.now())
  db.prepare('DELETE FROM native_push_regs WHERE state = ? AND expires_at < ?').run('prepared', Date.now())
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM native_push_content').get() as { n: number }
  if (n > MAX_PENDING_TOTAL) db.prepare('DELETE FROM native_push_content WHERE nid IN (SELECT nid FROM native_push_content ORDER BY created_at LIMIT ?)').run(n - MAX_PENDING_TOTAL)
}

const needHeader = (req: IncomingMessage) => {
  if (req.headers['x-mvl-app-push'] !== '1') throw new HttpError(400, 'Not an app request')
}

const cleanDevice = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '') || 'Android app'

/** GET /api/push/native: whether this server sends to the app, for which project, and the account's registered devices (Settings). */
export function nativeConfig(user: User) {
  return {
    enabled: fcmProject() !== null,
    projectId: fcmProject(),
    devices: (database().prepare("SELECT rid, device, created_at, last_seen FROM native_push_regs r WHERE user_id = ? AND state = 'active' AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = r.session_id AND s.expires_at > ?)").all(user.id, Date.now()) as { rid: string; device: string | null; created_at: number; last_seen: number | null }[]).map((d) => ({ rid: d.rid, name: d.device ?? 'Android app', createdAt: d.created_at, lastSeen: d.last_seen })),
  }
}

/**
 * Step one, from the app's cloud process with the signed-in session: an inert, short-lived
 * preparation that says which account the app is signed in as. Nothing existing is touched.
 */
export function prepare(req: IncomingMessage, user: User, session: string, body: { installId?: unknown; device?: unknown }) {
  needHeader(req)
  if (fcmProject() === null) throw new HttpError(503, 'This server does not send push notifications to the app')
  if (!allow(`np-prep:${user.id}`, 10, 60_000)) throw new HttpError(429, 'Too many tries: wait a minute')
  const installId = typeof body.installId === 'string' ? body.installId : ''
  if (!INSTALL.test(installId)) throw new HttpError(400, 'That is not an installation id')
  pruneContent()
  const db = database()
  const prepared = db.prepare("SELECT COUNT(*) AS n FROM native_push_regs WHERE user_id = ? AND state = 'prepared'").get(user.id) as { n: number }
  if (prepared.n >= MAX_PREPARED) db.prepare("DELETE FROM native_push_regs WHERE id IN (SELECT id FROM native_push_regs WHERE user_id = ? AND state = 'prepared' ORDER BY created_at LIMIT ?)").run(user.id, prepared.n - MAX_PREPARED + 1)
  const current = db.prepare("SELECT rid FROM native_push_regs WHERE user_id = ? AND install_id = ? AND state = 'active'").get(user.id, installId) as { rid: string } | undefined
  const prep = rand(16)
  db.prepare("INSERT INTO native_push_regs (rid, user_id, session_id, install_id, device, state, cap_hash, rev_hash, replaces_rid, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'prepared', '', '', ?, ?, ?)").run(prep, user.id, session, installId, cleanDevice(body.device), current?.rid ?? null, Date.now(), Date.now() + PREPARED_FOR)
  return { prep, login: user.login, projectId: fcmProject(), replaces: current?.rid ?? null, expiresIn: PREPARED_FOR / 1000 }
}

/**
 * Step two, after the user confirmed in the app: makes the registration real. It replaces this
 * account's registration of the same installation only if that is still the one that was current
 * when it was prepared; otherwise 409 (another preparation won).
 */
export function activate(req: IncomingMessage, user: User, session: string, body: { prep?: unknown }) {
  needHeader(req)
  const prep = typeof body.prep === 'string' && RID.test(body.prep) ? body.prep : ''
  if (!prep) throw new HttpError(400, 'That is not a preparation')
  const db = database()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare("SELECT id, install_id, replaces_rid FROM native_push_regs WHERE rid = ? AND user_id = ? AND session_id = ? AND state = 'prepared' AND expires_at > ?").get(prep, user.id, session, Date.now()) as { id: number; install_id: string; replaces_rid: string | null } | undefined
    if (!row) throw new HttpError(410, 'That preparation is over: start again')
    const current = db.prepare("SELECT id, rid FROM native_push_regs WHERE user_id = ? AND install_id = ? AND state = 'active'").get(user.id, row.install_id) as { id: number; rid: string } | undefined
    if ((current?.rid ?? null) !== row.replaces_rid) throw new HttpError(409, 'This installation changed meanwhile: start again')
    if (current) db.prepare('DELETE FROM native_push_regs WHERE id = ?').run(current.id)
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM native_push_regs WHERE user_id = ? AND state = 'active'").get(user.id) as { n: number }
    if (n >= MAX_REGS) throw new HttpError(409, 'Too many devices: remove one in Settings first')
    const cap = rand(32)
    const rev = rand(32)
    db.prepare("UPDATE native_push_regs SET state = 'active', cap_hash = ?, rev_hash = ?, last_seen = ?, expires_at = NULL WHERE id = ?").run(sha(cap), sha(rev), Date.now(), row.id)
    db.exec('COMMIT')
    return { rid: prep, cap: `${prep}.${cap}`, rev: `${prep}.${rev}` }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Settings: the signed-in owner removes one of the account's devices. */
export function removeOwned(user: User, rid: unknown) {
  if (typeof rid === 'string' && RID.test(rid)) database().prepare('DELETE FROM native_push_regs WHERE user_id = ? AND rid = ?').run(user.id, rid)
  return nativeConfig(user)
}

// --- the app's own calls: the capability or the revocation key -----------------------------------

/** Which secret a call may use. */
type Use = 'cap' | 'rev'

/**
 * Who a bearer credential is, for what it may do: the registration, found live (its session not
 * over, the account not banned) and the secret checked in constant time. Checked again by every
 * handler after anything awaited. A registration whose session is gone is deleted on the way.
 */
function authenticate(req: IncomingMessage, uses: Use[]): Reg & { used: Use } {
  needHeader(req)
  const ip = clientIp(req)
  if (failures(ip) >= 30) throw new HttpError(429, 'Too many tries: wait a minute')
  const fail = (): never => {
    failed(ip)
    throw new HttpError(401, 'Not registered')
  }
  const m = /^Bearer ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''))
  if (!m || !RID.test(m[1]) || !SECRET.test(m[2])) return fail()
  const row = database().prepare("SELECT r.id, r.rid, r.user_id, r.session_id, r.cap_hash, r.rev_hash, r.token_digest, s.expires_at, u.banned_at FROM native_push_regs r JOIN sessions s ON s.id = r.session_id JOIN users u ON u.id = r.user_id WHERE r.rid = ? AND r.state = 'active'").get(m[1]) as (Reg & { expires_at: number; banned_at: number | null }) | undefined
  if (!row) return fail()
  if (row.expires_at <= Date.now() || row.banned_at) {
    database().prepare('DELETE FROM native_push_regs WHERE id = ?').run(row.id)
    return fail()
  }
  const h = sha(m[2])
  const used = uses.find((u) => same(h, u === 'cap' ? row.cap_hash : row.rev_hash))
  if (!used) return fail()
  return { ...row, used }
}

/** PUT /api/push/native/token: this device's FCM token (also on rotation). Cannot create a registration. */
export async function setToken(req: IncomingMessage, body: Promise<{ token?: unknown }> = readJson(req, 8 * 1024)) {
  authenticate(req, ['cap'])
  const data = await body
  // The registration may have ended while the body was on its way.
  const reg = authenticate(req, ['cap'])
  const token = typeof data.token === 'string' ? data.token : ''
  if (!TOKEN.test(token)) throw new HttpError(400, 'That is not a device token')
  const digest = sha(token)
  const db = database()
  const taken = db.prepare('SELECT id FROM native_push_regs WHERE token_digest = ? AND id <> ?').get(digest, reg.id)
  if (taken) throw new HttpError(409, 'That token belongs to another registration')
  db.prepare('UPDATE native_push_regs SET token_enc = ?, token_digest = ?, last_seen = ? WHERE id = ?').run(encrypt(token), digest, Date.now(), reg.id)
}

/** GET /api/push/native/notification/<nid>: what a notification says, once, to its own registration. */
export function takeContent(req: IncomingMessage, nid: string) {
  const reg = authenticate(req, ['cap'])
  const unavailable = () => new HttpError(404, 'Not available')
  if (!/^[A-Za-z0-9_-]{22}$/.test(nid) || !allow(`np-content:${reg.rid}`, 120, 60_000)) throw unavailable()
  const db = database()
  const row = db.prepare('DELETE FROM native_push_content WHERE nid = ? AND reg_id = ? AND expires_at > ? RETURNING source, title, body, path').get(nid, reg.id, Date.now()) as { source: string; title: string; body: string | null; path: string } | undefined
  if (!row || !policy(reg.user_id, row.source)) throw unavailable()
  db.prepare('UPDATE native_push_regs SET last_seen = ? WHERE id = ?').run(Date.now(), reg.id)
  return { title: row.title, body: row.body ?? '', path: row.path }
}

/** DELETE /api/push/native with the capability or the revocation key: this registration ends. Answers the same if it is already gone. */
export function revoke(req: IncomingMessage) {
  needHeader(req)
  const m = /^Bearer ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''))
  if (m) {
    const row = database().prepare("SELECT id, cap_hash, rev_hash FROM native_push_regs WHERE rid = ? AND state = 'active'").get(m[1]) as { id: number; cap_hash: string; rev_hash: string } | undefined
    const h = sha(m[2])
    // The session may be long over (offline Disconnect): the key still revokes what it made.
    if (row && (same(h, row.cap_hash) || same(h, row.rev_hash))) database().prepare('DELETE FROM native_push_regs WHERE id = ?').run(row.id)
    else if (row) failed(clientIp(req))
  }
}

// --- sending ---------------------------------------------------------------------------------------

export type NativeNotice = { source: string; title: string; body?: string; action?: { app?: unknown; props?: Record<string, unknown> } }

/** Sends a notification to the account's live registrations. Returns how many messages went. */
export async function pushNative(user: Pick<User, 'id'>, n: NativeNotice): Promise<{ sent: number; failed: number }> {
  if (fcmProject() === null) return { sent: 0, failed: 0 }
  pruneContent()
  const db = database()
  const regs = db.prepare("SELECT r.id, r.rid, r.token_enc, r.token_digest FROM native_push_regs r JOIN sessions s ON s.id = r.session_id WHERE r.user_id = ? AND r.state = 'active' AND r.token_digest IS NOT NULL AND s.expires_at > ? LIMIT ?").all(user.id, Date.now(), MAX_REGS) as { id: number; rid: string; token_enc: string; token_digest: string }[]
  let sent = 0
  let failed = 0
  await Promise.all(
    regs.map(async (r) => {
      let token: string
      try {
        token = decrypt(r.token_enc)
      } catch {
        return void failed++
      }
      const nid = rand(16)
      const at = Date.now()
      db.prepare('INSERT INTO native_push_content (nid, reg_id, source, title, body, path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(nid, r.id, n.source.slice(0, 60), n.title.slice(0, 200), n.body ? n.body.slice(0, 500) : null, nativePath(n.action), at, at + CONTENT_FOR)
      db.prepare('DELETE FROM native_push_content WHERE reg_id = ? AND nid NOT IN (SELECT nid FROM native_push_content WHERE reg_id = ? ORDER BY created_at DESC LIMIT ?)').run(r.id, r.id, MAX_PENDING_PER_REG)
      const result = await sendData(token, { v: '1', rid: r.rid, nid, k: kindOf(n.source) }).catch(() => 'failed' as const)
      if (result === 'sent') return void sent++
      failed++
      db.prepare('DELETE FROM native_push_content WHERE nid = ?').run(nid)
      // Dead only when FCM said so, and only the token that was sent (it may have rotated since).
      if (result === 'unregistered') db.prepare('UPDATE native_push_regs SET token_enc = NULL, token_digest = NULL WHERE id = ? AND token_digest = ?').run(r.id, r.token_digest)
    }),
  )
  return { sent, failed }
}

/** How many devices of the account the app registered (for the Settings test). */
export const nativeDevices = (userId: number) => (database().prepare("SELECT COUNT(*) AS n FROM native_push_regs r WHERE user_id = ? AND state = 'active' AND token_digest IS NOT NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = r.session_id AND s.expires_at > ?)").get(userId, Date.now()) as { n: number }).n
