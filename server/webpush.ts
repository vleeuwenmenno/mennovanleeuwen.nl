import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError } from './http.ts'

// Web Push, so an Agents answer reaches the user's phone or computer when MvL OS is not open:
// the browser (or the installed app, also on iOS from 16.4 once added to the Home Screen) gives
// the page a subscription with an endpoint at its push service, and this server sends messages
// there. No dependencies, just Node's crypto:
//
// - VAPID (RFC 8292): each request carries a JWT signed with this server's P-256 key, which the
//   push service checks against the public key the subscription was made with. The keys come
//   from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are generated once into DATA_DIR/vapid.json.
// - Message encryption (RFC 8291, aes128gcm per RFC 8188): only the browser that subscribed can
//   read a message; the push service sees ciphertext. encryptPayload is checked against the
//   example in RFC 8291 (scripts/webpush-check.ts).

const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
const b64u = (b: Buffer) => b.toString('base64url')
const fromB64u = (s: string) => Buffer.from(s, 'base64url')

// --- the server's keys -------------------------------------------------------------------------

type Vapid = { publicKey: string; privateKey: string }
let vapid: (Vapid & { key: KeyObject }) | null = null

function keys() {
  if (vapid) return vapid
  let pair: Vapid
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) pair = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() }
  else {
    const file = join(DATA_DIR, 'vapid.json')
    if (existsSync(file)) pair = JSON.parse(readFileSync(file, 'utf8')) as Vapid
    else {
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      pair = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) }
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(file, JSON.stringify(pair), { mode: 0o600 })
    }
  }
  const pub = fromB64u(pair.publicKey)
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: pair.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' })
  vapid = { ...pair, key }
  return vapid
}

/** The public key browsers subscribe with (applicationServerKey). */
export const pushPublicKey = () => ({ publicKey: keys().publicKey })

/** Who sends: a mailto: or https: address the push services can reach the sender at (Apple requires one). */
const subject = () => process.env.VAPID_SUBJECT || process.env.PUBLIC_URL?.replace(/\/+$/, '') || 'mailto:webpush@mvlos.invalid'

/** The VAPID Authorization header for a push service (its origin is the JWT's audience). */
export function vapidHeader(endpoint: string, now = Date.now()): string {
  const { publicKey, key } = keys()
  const part = (o: object) => b64u(Buffer.from(JSON.stringify(o)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject() })}`
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64u(signature)}, k=${publicKey}`
}

// --- encryption (RFC 8291) ---------------------------------------------------------------------

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest()

/**
 * The body of a push message for one subscription: salt, record size and this message's public
 * key, then the AES-128-GCM ciphertext. `salt` and `senderPrivate` are only given by the check
 * against the RFC's example; otherwise both are fresh for every message.
 */
export function encryptPayload(payload: Buffer, uaPublic: Buffer, authSecret: Buffer, fixed: { salt?: Buffer; senderPrivate?: Buffer } = {}): Buffer {
  const ecdh = createECDH('prime256v1')
  if (fixed.senderPrivate) ecdh.setPrivateKey(fixed.senderPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const salt = fixed.salt ?? randomBytes(16)
  const prkKey = hmac(authSecret, ecdh.computeSecret(uaPublic))
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // One record, ended by the 0x02 delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

// --- subscriptions -----------------------------------------------------------------------------

export type PushSubscriptionJson = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }

/** Push services browsers use: Google (Chrome, Edge on Android), Mozilla, Apple, Microsoft. */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/]

function checkSubscription(body: PushSubscriptionJson) {
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new HttpError(400, 'That is not a push subscription')
  }
  // Only real push services: the server sends to this address, so it must not be just anywhere.
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((h) => h.test(url.hostname))) throw new HttpError(400, `${url.hostname} is not a push service this server sends to`)
  const p256dh = typeof body.keys?.p256dh === 'string' ? fromB64u(body.keys.p256dh) : Buffer.alloc(0)
  const auth = typeof body.keys?.auth === 'string' ? fromB64u(body.keys.auth) : Buffer.alloc(0)
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new HttpError(400, 'The subscription keys are not right')
  return { endpoint, p256dh: b64u(p256dh), auth: b64u(auth) }
}

/**
 * Saves this browser's subscription for the user (again, when it is already known), tied to the
 * session that sent it: it gets messages only while that session is valid (liveSubscriptions), and
 * signing out removes it (server/auth.ts). A browser has one subscription: another account signing
 * in there and sending it takes it over.
 */
export function subscribe(user: User, session: string, body: { subscription?: PushSubscriptionJson; device?: unknown }) {
  const sub = checkSubscription(body.subscription ?? {})
  const device = typeof body.device === 'string' ? body.device.slice(0, 120) : null
  database()
    .prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, device, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, device = excluded.device, session_id = excluded.session_id`,
    )
    .run(user.id, sub.endpoint, encrypt(JSON.stringify({ p256dh: sub.p256dh, auth: sub.auth })), device, Date.now(), session)
  return { ok: true, devices: devices(user) }
}

export function unsubscribe(user: User, body: { endpoint?: unknown }) {
  if (typeof body.endpoint === 'string') database().prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(user.id, body.endpoint)
  return { ok: true, devices: devices(user) }
}

/**
 * The user's subscriptions that may get messages: made by a session that is still valid. Those of
 * sessions that ended (ran out, signed out elsewhere, from before subscriptions were tied to one)
 * are removed on the way; a device signed in again sends its subscription on its next visit.
 */
export function liveSubscriptions(userId: number): Row[] {
  database().prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE expires_at > ?))').run(userId, Date.now())
  return database().prepare('SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ?').all(userId) as Row[]
}

/** How many devices get the user's push messages. */
export const devices = (user: User) => liveSubscriptions(user.id).length

// --- sending -----------------------------------------------------------------------------------

/**
 * What the service worker shows (pwa/sw.js): a title and line, and the thread or page it opens.
 * `icon` and `badge`: this site's own paths (a push message holds about 4 KB, so no pictures in it).
 */
export type PushMessage = { title: string; body?: string; icon?: string; badge?: string; tag?: string; url?: string; thread?: string }

type Row = { id: number; endpoint: string; keys: string }

async function sendOne(row: Row, message: PushMessage): Promise<'sent' | 'gone' | 'failed'> {
  let k: { p256dh: string; auth: string }
  try {
    k = JSON.parse(decrypt(row.keys)) as { p256dh: string; auth: string }
  } catch {
    return 'gone' // sealed with another SESSION_SECRET: unusable
  }
  // A push message holds at most about 4 KB: the line is short anyway.
  const payload = Buffer.from(JSON.stringify({ ...message, body: message.body?.slice(0, 300) }))
  const res = await fetch(row.endpoint, {
    method: 'POST',
    headers: { TTL: String(24 * 3600), Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidHeader(row.endpoint) },
    body: new Uint8Array(encryptPayload(payload, fromB64u(k.p256dh), fromB64u(k.auth))),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!res) return 'failed'
  await res.body?.cancel().catch(() => {})
  // 404 and 410: the browser dropped the subscription (signed out, notifications turned off, app removed).
  if (res.status === 404 || res.status === 410) return 'gone'
  if (!res.ok) console.warn(`web push: ${new URL(row.endpoint).hostname} answered ${res.status}`)
  return res.ok ? 'sent' : 'failed'
}

/** Sends a message to every device the user turned push on for; forgets the ones that are gone. */
export async function pushToUser(user: User, message: PushMessage): Promise<{ sent: number; failed: number }> {
  const rows = liveSubscriptions(user.id)
  const results = await Promise.all(rows.map((r) => sendOne(r, message).catch(() => 'failed' as const)))
  results.forEach((r, i) => r === 'gone' && database().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(rows[i].id))
  return { sent: results.filter((r) => r === 'sent').length, failed: results.filter((r) => r === 'failed').length }
}
