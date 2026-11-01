import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { APP_CHALLENGE, APP_STATE, appRedirect, githubEnabled, githubRedirect, googleSignInClient, sessionCookies, sessionKey, takeAppCode } from './auth.ts'
import { endSession } from './liveSessions.ts'
import { database } from './db.ts'
import { HttpError, json, readJson, redirect } from './http.ts'
import { googleRedirect } from './googleSignIn.ts'

// Signing in from the Android app's cloud desktop (mobile/, CloudActivity). That desktop is the
// site in an app WebView, which must not show GitHub's or Google's sign-in pages itself (RFC 8252:
// native apps use an external user-agent). So:
//
//   1. The app keeps a random PKCE verifier and its own state, and opens the system browser at
//      /api/auth/app/start?provider=…&challenge=S256(verifier)&state=….
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

/** The protocol version the app checks for. */
const APP_LOGIN_VERSION = 1

/** GET /api/auth/app: whether this server signs in the Android app, and with what. */
export function appLoginInfo(res: ServerResponse) {
  json(res, 200, { app: APP_LOGIN_VERSION, providers: { github: githubEnabled(), google: !!googleSignInClient() } }, { 'Cache-Control': 'no-store' })
}

/** GET /api/auth/app/start: in the system browser, off to the provider for the app. */
export function startAppLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const provider = url.searchParams.get('provider')
  const challenge = url.searchParams.get('challenge') ?? ''
  const state = url.searchParams.get('state') ?? ''
  // Without a valid state there is nowhere safe to report to: a plain error page.
  if (!APP_STATE.test(state)) throw new HttpError(400, 'Invalid app sign-in request')
  if (!APP_CHALLENGE.test(challenge)) return redirect(res, appRedirect(state, { error: 'error' }))
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
  // Only the app: a web page can send neither this header nor a JSON body without a preflight.
  if (req.headers['x-mvl-app-redeem'] !== '1' || !/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(400, 'Not an app sign-in')
  const body = (await readJson(req, 1024)) as { code?: unknown; verifier?: unknown }
  const code = typeof body.code === 'string' ? body.code : ''
  const verifier = typeof body.verifier === 'string' ? body.verifier : ''
  const fail = () => json(res, 400, { error: 'This sign-in expired or was already used. Sign in again.' }, { 'Cache-Control': 'no-store' })
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return fail()
  // Taken out before anything else: any attempt uses it up, a wrong or missing verifier too.
  const entry = takeAppCode(code)
  if (!entry || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return fail()
  const expected = Buffer.from(entry.challenge)
  const given = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return fail()
  // Still allowed in now: not banned or deleted, and the sign-in that made the code still belongs to the account.
  const db = database()
  const row = db.prepare('SELECT u.banned_at FROM users u JOIN identities i ON i.user_id = u.id WHERE u.id = ? AND i.provider = ? AND i.subject = ?').get(entry.userId, entry.provider, entry.subject) as { banned_at: number | null } | undefined
  if (!row || row.banned_at) return fail()
  // A session the app's WebView still had (it sends that cookie along) ends: the new one replaces it.
  const old = sessionKey(req)
  if (old) {
    db.prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(old)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(old)
    endSession(old)
  }
  json(res, 200, { ok: true }, { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookies(req, entry.userId) })
}
