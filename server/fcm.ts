import { createSign } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { privateFetch as fetch } from './privateRequest.ts'

// Firebase Cloud Messaging for the Android app (server/nativepush.ts), with no dependencies:
//
// - The sending identity is a service-account key kept in a FILE (FCM_SERVICE_ACCOUNT_FILE), never
//   in the environment, the database or a log. Without the file the feature is off.
// - An OAuth2 access token is made from it with a signed JWT (RS256) at Google's fixed token
//   address, cached until shortly before it runs out. Both Google addresses are fixed here, not
//   read from configuration (tests replace the whole transport, see setFcmTransport).
// - Messages are DATA ONLY (no `notification` block, so the app decides what to show), at most a
//   few hundred bytes, with a short time to live. Nothing the user reads goes through Google: the
//   data holds opaque ids (server/nativepush.ts).
// - Only the structured FCM error UNREGISTERED says a token is dead. Anything else (a wrong
//   project, bad request, quota, outage) keeps the registration and is reported as a failure.

export type FcmResult = 'sent' | 'unregistered' | 'failed'

export type FcmTransport = {
  /** Exchanges a signed JWT for an access token. */
  token(assertion: string): Promise<{ status: number; body: unknown }>
  /** Sends one message to the project. */
  send(project: string, accessToken: string, message: unknown): Promise<{ status: number; body: unknown; retryAfter?: number }>
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const TTL_SECONDS = 900
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
/** A message may hold at most this many bytes of data: it carries ids only. */
const MAX_DATA_BYTES = 1024

const realTransport: FcmTransport = {
  async token(assertion) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  },
  async send(project, accessToken, message) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(10_000),
    })
    const wait = Number(res.headers.get('retry-after'))
    return { status: res.status, body: await res.json().catch(() => null), retryAfter: Number.isFinite(wait) && wait > 0 ? Math.min(wait, 300) : undefined }
  },
}

let transport = realTransport
/** For the checks only: replaces Google's two addresses with a fake. */
export function setFcmTransport(t: FcmTransport | null) {
  transport = t ?? realTransport
  cached = null
  inflight = null
  pausedUntil = 0
}

type Account = { project: string; email: string; key: string }
let account: { path: string; mtime: number; value: Account | null } | null = null

/** The sending identity, or null (no file, not a service account, a bad project id). Never logged. */
function loadAccount(): Account | null {
  const path = process.env.FCM_SERVICE_ACCOUNT_FILE
  if (!path) return null
  try {
    const mtime = statSync(path).mtimeMs
    if (account && account.path === path && account.mtime === mtime) return account.value
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { type?: unknown; project_id?: unknown; client_email?: unknown; private_key?: unknown }
    const ok = raw.type === 'service_account' && typeof raw.project_id === 'string' && PROJECT.test(raw.project_id) && typeof raw.client_email === 'string' && /^[^\s@]+@[^\s@]+$/.test(raw.client_email) && typeof raw.private_key === 'string' && raw.private_key.includes('PRIVATE KEY')
    const value = ok ? { project: raw.project_id as string, email: raw.client_email as string, key: raw.private_key as string } : null
    account = { path, mtime, value }
    return value
  } catch {
    return null
  }
}

/** Whether the server can send, and for which Firebase project (not a secret: it is in the app's own config). */
export const fcmProject = (): string | null => loadAccount()?.project ?? null

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function assertion(a: Account, now: number) {
  const unsigned = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iss: a.email, scope: SCOPE, aud: TOKEN_URL, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 }))}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  return `${unsigned}.${b64u(signer.sign(a.key))}`
}

let cached: { token: string; until: number } | null = null
let inflight: Promise<string | null> | null = null
let pausedUntil = 0

async function accessToken(a: Account): Promise<string | null> {
  if (cached && Date.now() < cached.until) return cached.token
  inflight ??= (async () => {
    try {
      const res = await transport.token(assertion(a, Date.now()))
      const body = res.body as { access_token?: unknown; expires_in?: unknown } | null
      if (res.status !== 200 || typeof body?.access_token !== 'string') return null
      const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3000
      cached = { token: body.access_token, until: Date.now() + Math.max(60, seconds - 300) * 1000 }
      return cached.token
    } catch {
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

const dataSize = (data: Record<string, string>) => Buffer.byteLength(JSON.stringify(data))

/** Errors in FCM's structured form: google.firebase.fcm.v1.FcmError with errorCode. */
function errorCode(body: unknown): string | null {
  const details = (body as { error?: { details?: { errorCode?: unknown }[] } } | null)?.error?.details
  const code = details?.find((d) => typeof d?.errorCode === 'string')?.errorCode
  return typeof code === 'string' ? code : null
}

/**
 * Sends one data-only message to a device token. 'unregistered' only when FCM says UNREGISTERED
 * for it; everything else that goes wrong is 'failed' (and a rate limit pauses sending a while).
 */
export async function sendData(token: string, data: Record<string, string>): Promise<FcmResult> {
  const a = loadAccount()
  if (!a || Date.now() < pausedUntil) return 'failed'
  if (dataSize(data) > MAX_DATA_BYTES) return 'failed'
  const message = { token, data, android: { priority: 'HIGH', ttl: `${TTL_SECONDS}s` } }
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = await accessToken(a)
    if (!at) return 'failed'
    const res = await transport.send(a.project, at, message).catch(() => null)
    if (!res) return 'failed'
    if (res.status >= 200 && res.status < 300) return 'sent'
    if (res.status === 401 && attempt === 0) {
      cached = null
      continue
    }
    if (res.status === 429 || res.status >= 500) pausedUntil = Date.now() + (res.retryAfter ?? 30) * 1000
    if (res.status === 404 && errorCode(res.body) === 'UNREGISTERED') return 'unregistered'
    return 'failed'
  }
  return 'failed'
}
