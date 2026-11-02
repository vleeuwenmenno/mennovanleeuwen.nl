import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { APP_CHALLENGE, APP_STATE, appRedirect, githubEnabled, githubRedirect, googleSignInClient, onRevocation, revocationGeneration, sessionCookies, sessionKey, takeAppCode } from './auth.ts'
import { clientIp } from './egress.ts'
import { verifyGoogleIdToken } from './oidc.ts'
import { endSession } from './liveSessions.ts'
import { database } from './db.ts'
import { HttpError, json, readJson, redirect } from './http.ts'
import { googleAccountFor, googleRedirect } from './googleSignIn.ts'

// Signing in from the Android app's cloud desktop (mobile/, CloudActivity). That desktop is the
// site in an app WebView, which must not show GitHub's or Google's sign-in pages itself (RFC 8252:
// native apps use an external user-agent). So:
//
//   1. The app keeps a random PKCE verifier and its own state, and opens the system browser at
//      /api/auth/app/start?provider=…&challenge=…&state=…, the challenge bound to this server's
//      origin (APP_LOGIN_VERSION below). Needs PUBLIC_URL (https) on the server.
//   2. The usual GitHub or Google round trip runs in that browser (server/auth.ts beginFlow, with
//      bans, registration limits and admin rules as for any sign-in), but ends with a one-time
//      code (two minutes) sent to the app's fixed redirect, nl.mvlos.experiment:/oauth, instead of
//      a session in the browser.
//   3. The browser shows a page naming the account and the server; tapping "Open the app" hands
//      the code to the app (nl.mvlos.experiment:/oauth?code=…&state=…).
//   4. The app itself (not its WebView) POSTs the code and the verifier as JSON, with the header
//      X-MvL-App-Redeem, to /api/auth/app/redeem on the same server, without following redirects.
//      The code is taken out first (it works once), the verifier has to match the challenge, and
//      the account and the sign-in that made the code must still be there and allowed in. The
//      answer carries the session cookies, which the app checks and puts into its cloud WebView.
//
// Another app catching the redirect gets a code it can't use without the verifier. A web page can't
// redeem: a form can't send JSON or custom headers, and a cross-site fetch with them needs a CORS
// preflight this server never allows, so nobody can be signed in to someone else's account
// // this way. GET /api/auth/app says whether the server supports this, so the app can tell older ones apart.

/**
 * The protocol version the app checks for. Version 2 binds the proof to the server: the app's
 * challenge is base64url(SHA-256(verifier + "\n" + origin)), with the origin it is connected to,
 * and the server checks it with its own canonical address (PUBLIC_URL), never one taken from the
 * request. A server the person connected to can't relay the code and verifier to another server,
 * because the other server's address doesn't match the challenge.
 */
const APP_LOGIN_VERSION = 2

/** The server's canonical origin for app sign-in: PUBLIC_URL, required (a Host header could be anyone's). */
export function appOrigin(): string | null {
  const raw = process.env.PUBLIC_URL?.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** The challenge the app makes for this verifier and server (see APP_LOGIN_VERSION). */
export const appChallenge = (verifier: string, origin: string) => createHash('sha256').update(`${verifier}\n${origin}`).digest('base64url')

/** GET /api/auth/app: whether this server signs in the Android app, and with what. Without an https PUBLIC_URL it doesn't. */
export function appLoginInfo(res: ServerResponse) {
  const origin = appOrigin()
  if (!origin) return json(res, 200, { app: 0, reason: 'PUBLIC_URL (https) is not set on this server' }, { 'Cache-Control': 'no-store' })
  const native = nativeGoogle()
  json(res, 200, { app: APP_LOGIN_VERSION, origin, providers: { github: githubEnabled(), google: !!googleSignInClient() }, ...(native ? { googleNative: { clientId: native.clientId } } : {}) }, { 'Cache-Control': 'no-store' })
}

/** GET /api/auth/app/start: in the system browser, off to the provider for the app. */
export function startAppLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const provider = url.searchParams.get('provider')
  const challenge = url.searchParams.get('challenge') ?? ''
  const state = url.searchParams.get('state') ?? ''
  // Without a valid state there is nowhere safe to report to: a plain error page.
  if (!APP_STATE.test(state)) throw new HttpError(400, 'Invalid app sign-in request')
  if (!APP_CHALLENGE.test(challenge)) return redirect(res, appRedirect(state, { error: 'error' }))
  if (!appOrigin()) return redirect(res, appRedirect(state, { error: 'off' }))
  const flow = { m: 'app' as const, b: '/', c: challenge, a: state }
  if (provider === 'github' && githubEnabled()) {
    const { url: to, set } = githubRedirect(req, flow)
    return redirect(res, to, { 'Set-Cookie': set })
  }
  const google = googleSignInClient()
  if (provider === 'google' && google) {
    const { url: to, cookie } = googleRedirect(req, flow, google.id)
    return redirect(res, to, { 'Set-Cookie': cookie })
  }
  redirect(res, appRedirect(state, { error: 'off' }))
}

/** POST /api/auth/app/redeem: from the app itself, the one-time code and its verifier into a session. */
export async function redeemAppLogin(req: IncomingMessage, res: ServerResponse) {
  requireAppRequest(req)
  const body = (await readJson(req, 1024)) as { code?: unknown; verifier?: unknown }
  const code = typeof body.code === 'string' ? body.code : ''
  const verifier = typeof body.verifier === 'string' ? body.verifier : ''
  const fail = () => json(res, 400, { error: 'This sign-in expired or was already used. Sign in again.' }, { 'Cache-Control': 'no-store' })
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return fail()
  // Taken out before anything else: any attempt uses it up, a wrong or missing verifier too.
  const entry = takeAppCode(code)
  if (!entry || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return fail()
  const origin = appOrigin()
  if (!origin) return fail()
  const expected = Buffer.from(entry.challenge)
  const given = Buffer.from(appChallenge(verifier, origin))
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return fail()
  // Still allowed in now: not banned or deleted, and the sign-in that made the code still belongs to the account.
  const db = database()
  const row = db.prepare('SELECT u.banned_at FROM users u JOIN identities i ON i.user_id = u.id WHERE u.id = ? AND i.provider = ? AND i.subject = ?').get(entry.userId, entry.provider, entry.subject) as { banned_at: number | null } | undefined
  if (!row || row.banned_at) return fail()
  appSession(req, res, entry.userId)
}

/** A fresh session for the app's WebView, as JSON with its cookies; a session that WebView still had (it sends that cookie along) ends. */
function appSession(req: IncomingMessage, res: ServerResponse, userId: number) {
  const db = database()
  const old = sessionKey(req)
  if (old) {
    db.prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(old)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(old)
    endSession(old)
  }
  json(res, 200, { ok: true }, { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookies(req, userId) })
}

/** Only the app: a web page can send neither this header nor a JSON body without a CORS preflight, which this server never grants. */
function requireAppRequest(req: IncomingMessage) {
  if (req.headers['x-mvl-app-redeem'] !== '1' || !/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(400, 'Not an app sign-in')
}

// ---- Native Google sign-in in the Android app ----
//
// The app's own Google account picker (Android Credential Manager) instead of the browser round
// trip, for servers the app was built to trust (mobile/: a list of origins) that announce it here.
// It needs an Android OAuth client (package and signing certificate) in the same Google Cloud
// project as this server's web client, listed in GOOGLE_SIGNIN_ANDROID_CLIENT_IDS. Then:
//
//   1. The app asks POST /api/auth/app/google/start for a challenge: 32 random bytes, one use,
//      five minutes.
//   2. It asks Google for an ID token for this server's web client with the nonce
//      base64url(SHA-256(challenge + "\n" + origin)), origin being the server it is connected to.
//   3. It POSTs { challenge, idToken } to /api/auth/app/google/redeem. The challenge is taken out
//      first; the token must be signed by Google for this web client (aud), issued to one of the
//      listed Android clients (azp), unexpired, with exactly that nonce computed with this server's
//      own PUBLIC_URL. Then the usual Google sign-in rules: the account by its `sub`, never by
//      email; bans and registration limits; and the app's WebView gets a session as above.
//
// A server the person connected to that relays another server's challenge gets a token whose nonce
// names itself, which the other server refuses; a token alone, without its live challenge, is worth
// nothing. Challenges belong to no account yet, so every revocation (sign out everywhere, a ban, a
// deletion, removing a sign-in) drops all of them, and a redeem whose token check spanned one is refused.

const NATIVE_TTL = Number(process.env.AUTH_NATIVE_TTL_MS) || 5 * 60_000
const NATIVE_PER_CLIENT = 10
const MAX_NATIVE = 5000
const nativeChallenges = new Map<string, { until: number; client: string }>()
onRevocation(() => nativeChallenges.clear())

/** Native Google sign-in, when Google sign-in is on, app sign-in is possible (PUBLIC_URL) and Android clients are listed. */
function nativeGoogle(): { clientId: string; androidClients: string[] } | null {
  const google = googleSignInClient()
  const androidClients = (process.env.GOOGLE_SIGNIN_ANDROID_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter((s) => /^[\w.-]{10,200}$/.test(s))
  return google && appOrigin() && androidClients.length ? { clientId: google.id, androidClients } : null
}

/** The nonce the app puts in its request to Google for this challenge and server. */
export const nativeNonce = (challenge: string, origin: string) => createHash('sha256').update(`${challenge}\n${origin}`).digest('base64url')

/** POST /api/auth/app/google/start: a one-time challenge for the app's native Google sign-in. */
export async function startNativeGoogle(req: IncomingMessage, res: ServerResponse) {
  requireAppRequest(req)
  await readJson(req, 256)
  if (!nativeGoogle()) throw new HttpError(404, 'Native Google sign-in is not set up on this server')
  const now = Date.now()
  const client = clientIp(req)
  const mine: string[] = []
  for (const [k, c] of nativeChallenges) {
    if (c.until <= now) nativeChallenges.delete(k)
    else if (c.client === client) mine.push(k)
  }
  while (mine.length >= NATIVE_PER_CLIENT) nativeChallenges.delete(mine.shift()!)
  if (nativeChallenges.size >= MAX_NATIVE) throw new HttpError(503, 'Too many sign-ins at once. Try again in a few minutes.')
  const challenge = randomBytes(32).toString('base64url')
  nativeChallenges.set(challenge, { until: now + NATIVE_TTL, client })
  json(res, 200, { challenge }, { 'Cache-Control': 'no-store' })
}

/** POST /api/auth/app/google/redeem: the challenge and Google's ID token into a session for the app's WebView. */
export async function redeemNativeGoogle(req: IncomingMessage, res: ServerResponse) {
  requireAppRequest(req)
  const body = (await readJson(req, 8 * 1024)) as { challenge?: unknown; idToken?: unknown }
  // Refusals are logged as one line with the failed check only (never the token or who it was for),
  // and the check is told to the app too (`detail`), so a failure on a phone can be explained.
  const refuse = (status: number, error: string, reason?: string, detail?: string) => {
    console.warn(`native Google sign-in refused: ${error}${detail ? ` (${detail})` : ''}`)
    json(res, status, { error, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) }, { 'Cache-Control': 'no-store' })
  }
  const native = nativeGoogle()
  const origin = appOrigin()
  if (!native || !origin) return refuse(404, 'off')
  const challenge = typeof body.challenge === 'string' ? body.challenge : ''
  const idToken = typeof body.idToken === 'string' ? body.idToken : ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return refuse(400, 'expired', undefined, 'no challenge')
  // Taken out before anything else: any attempt uses it up.
  const live = nativeChallenges.get(challenge)
  nativeChallenges.delete(challenge)
  if (!live || live.until <= Date.now()) return refuse(400, 'expired', undefined, 'challenge used or expired')
  if (!idToken || idToken.length > 6000) return refuse(400, 'error', undefined, 'no token')
  const generation = revocationGeneration()
  let who
  try {
    who = await verifyGoogleIdToken(idToken, { clientId: native.clientId, nonce: nativeNonce(challenge, origin), androidClients: native.androidClients })
  } catch (e) {
    // The verifier's messages name the check ("wrong authorized party", "wrong nonce", ...).
    const check = e instanceof Error && /^[a-z ]{1,40}$/.test(e.message) ? e.message : 'token check failed'
    return refuse(400, 'error', undefined, check)
  }
  // Something was revoked while the token was checked: start again.
  if (revocationGeneration() !== generation) return refuse(409, 'expired', undefined, 'revoked meanwhile')
  const outcome = googleAccountFor(who)
  if ('refused' in outcome) return refuse(403, outcome.refused, outcome.refused === 'banned' && outcome.reason ? outcome.reason.slice(0, 200) : undefined)
  appSession(req, res, outcome.id)
}
