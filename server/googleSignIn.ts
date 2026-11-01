import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { admission, backTo, backWith, beginFlow, completeSignIn, failSignIn, currentUser, finishFlow, googleSignInClient, identityOwner, requireUser, sessionKey, type Flow } from './auth.ts'
import { database, nextUserId } from './db.ts'
import { cookies, HttpError, json, publicOrigin, redirect, setCookie } from './http.ts'
import { verifyGoogleIdToken } from './oidc.ts'

// "Sign in with Google": OpenID Connect's authorization code flow with PKCE (S256), a one-time
// state and a nonce, asking for `openid email profile` only. It is a way in, nothing more: no
// Google token is kept, and it is separate from connecting Google Calendar (server/google.ts),
// which asks for its own consent and never signs anyone in.
//
// The account is found by Google's `sub`, never by email: a Google address that matches a GitHub
// account's, or a connected calendar's, links nothing. A Google account that has no account here
// signs up as a new one, within the registration limits, and is never an admin (admins are GitHub
// ids). Linking Google to an existing account is done from Settings → Account while signed in.
//
// Needs GOOGLE_SIGNIN=on and an OAuth client (web application) whose redirect URIs include
// <site>/api/auth/google/callback. GOOGLE_AUTH_URL and GOOGLE_TOKEN_URL point at a stand-in for
// the checks (scripts/auth-identities-check.ts); nothing else sets them.

const STATE_COOKIE = 'mvlos_oidc'
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'
const SCOPES = 'openid email profile'

const callbackUrl = (req: IncomingMessage) => `${publicOrigin(req)}/api/auth/google/callback`
const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

export function googleRedirect(req: IncomingMessage, flow: Omit<Flow, 'e' | 'n' | 'p' | 'v' | 'o'>, clientId: string) {
  const state = randomBytes(16).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  const nonce = randomBytes(16).toString('base64url')
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    scope: SCOPES,
    state,
    nonce,
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  const cookie = setCookie(req, STATE_COOKIE, beginFlow(req, { ...flow, p: 'google', n: state, v: verifier, o: nonce }), { maxAge: 600, path: '/api/auth' })
  return { url: `${AUTH_URL}?${params}`, cookie }
}

/** Off to Google to sign in (GET, a link the page follows), back to `back` (see server/auth.ts backTo). */
export function startGoogleSignIn(req: IncomingMessage, res: ServerResponse, url: URL) {
  const client = googleSignInClient()
  if (!client) return redirect(res, '/?auth=off')
  const { url: to, cookie } = googleRedirect(req, { m: 'signin', b: backTo(url.searchParams.get('back')) }, client.id)
  redirect(res, to, { 'Set-Cookie': cookie })
}

/** Settings → Account: link Google to the signed-in account. A POST from the page, answered with where to go. */
export function startGoogleLink(req: IncomingMessage, res: ServerResponse) {
  const user = requireUser(req)
  const client = googleSignInClient()
  if (!client) throw new HttpError(400, 'Google sign-in is not set up on this server')
  const linked = database().prepare("SELECT 1 FROM identities WHERE user_id = ? AND provider = 'google'").get(user.id)
  if (linked) throw new HttpError(409, 'A Google account is already linked')
  const { url, cookie } = googleRedirect(req, { m: 'link', b: '/', u: user.id, s: sessionKey(req)! }, client.id)
  json(res, 200, { url }, { 'Set-Cookie': cookie })
}

/** A login name for a new account made with Google: from the address or name, with an underscore (GitHub logins have none), unique here. */
function newLogin(email: string | null, name: string | null): string {
  const raw = (email?.split('@')[0] ?? name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'user'
  const taken = (l: string) => !!database().prepare('SELECT 1 FROM users WHERE lower(login) = ?').get(l)
  for (let i = 0; i < 1000; i++) {
    const login = `${raw}_g${i ? i + 1 : ''}`
    if (!taken(login)) return login
  }
  return `user_${randomBytes(4).toString('hex')}`
}

export async function finishGoogleSignIn(req: IncomingMessage, res: ServerResponse, url: URL) {
  const clear = setCookie(req, STATE_COOKIE, '', { maxAge: 0, path: '/api/auth' })
  const flow = finishFlow(req, 'google', cookies(req)[STATE_COOKIE], url.searchParams.get('state'))
  const home = flow?.b ?? '/'
  const failed = flow?.m === 'link' ? 'link-error' : 'error'
  const fail = (reason: string) => failSignIn(res, flow, home, reason, [clear])
  const client = googleSignInClient()
  if (!client) return fail('off')
  if (!flow || !flow.v || !flow.o) return fail('error')
  if (url.searchParams.get('error')) return fail(flow.m === 'link' ? 'link-error' : 'denied')
  const code = url.searchParams.get('code')
  if (!code) return fail(failed)

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: callbackUrl(req), grant_type: 'authorization_code', code_verifier: flow.v }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  const tokens = tokenRes?.ok ? ((await tokenRes.json().catch(() => ({}))) as { id_token?: string }) : {}
  if (typeof tokens.id_token !== 'string') return fail(failed)
  let who
  try {
    who = await verifyGoogleIdToken(tokens.id_token, { clientId: client.id, nonce: flow.o })
  } catch {
    return fail(failed)
  }

  const db = database()
  const now = Date.now()
  const owner = identityOwner('google', who.sub)

  if (flow.m === 'link') {
    const user = currentUser(req)
    if (!user || user.id !== flow.u) return fail('link-error')
    if (owner && owner.id !== user.id) return fail('link-taken')
    const mine = db.prepare("SELECT subject FROM identities WHERE user_id = ? AND provider = 'google'").get(user.id) as { subject: string } | undefined
    if (mine && mine.subject !== who.sub) return fail('link-exists')
    try {
      db.prepare("INSERT INTO identities (provider, subject, user_id, email, created_at, last_used_at) VALUES ('google', ?, ?, ?, ?, ?) ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, last_used_at = excluded.last_used_at WHERE identities.user_id = excluded.user_id").run(who.sub, user.id, who.email, now, now)
    } catch {
      return fail('link-error')
    }
    return redirect(res, backWith('/', 'linked-google'), { 'Set-Cookie': clear })
  }

  if (owner?.banned_at) return failSignIn(res, flow, home, 'banned', [clear], owner.ban_reason)
  let id: number
  if (owner) {
    id = owner.id
    db.prepare("UPDATE identities SET email = ?, last_used_at = ? WHERE provider = 'google' AND subject = ?").run(who.email, now, who.sub)
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, id)
  } else {
    const admit = admission()
    if (admit !== 'ok') return fail(admit)
    id = nextUserId()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO users (id, github_id, login, name, avatar, github_token, github_scopes, created_at, updated_at, last_seen_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, newLogin(who.email, who.name), who.name, who.picture, '', '', now, now, now)
      db.prepare("INSERT INTO identities (provider, subject, user_id, email, created_at, last_used_at) VALUES ('google', ?, ?, ?, ?, ?)").run(who.sub, id, who.email, now, now)
      db.exec('COMMIT')
    } catch {
      db.exec('ROLLBACK')
      return fail('error')
    }
  }
  completeSignIn(req, res, flow, id, [clear], { provider: 'google', subject: who.sub })
}
