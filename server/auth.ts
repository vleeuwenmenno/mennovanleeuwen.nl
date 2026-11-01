import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientIp } from './egress.ts'
import { appSetting, database, decrypt, encrypt, nextUserId, sha256 } from './db.ts'
import { cookies, guardBodies, HttpError, json, publicOrigin, redirect, setCookie } from './http.ts'
import { endSession, sessionStored, track, type SessionBinding } from './liveSessions.ts'

// "Sign in with GitHub" (OAuth web flow). Any GitHub account may sign up while registration is
// open and there is room (MAX_USERS, default 100; the admin can change both in Settings → Users).
// GitHub accounts whose numeric id is in ADMIN_GITHUB_IDS (default: 46482143) are admins: they always
// get in, may use the keys set on the server, and manage the other users (server/admin.ts). The id
// never changes, unlike a login, which can be renamed and later taken by someone else. The old
// ADMIN_USERS (logins) is retired and grants nothing.
//
// Needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from a GitHub OAuth app whose callback URL is
// <site>/api/auth/github/callback. "Sign in with Google" (server/googleSignIn.ts) is the other way
// in, when GOOGLE_SIGNIN is on. With neither, login is off and /api/me says so.
//
// An account can have one sign-in of each kind (the identities table, server/db.ts), keyed by the
// provider's stable id. A second one is only ever added from Settings → Account by the signed-in
// account itself (`link`); accounts are never joined because their email addresses match.

const SESSION_COOKIE = 'mvlos_sid'
/** The sealed GitHub round trip (`beginFlow`). */
const STATE_COOKIE = 'mvlos_oauth'
/**
 * One-time choice of GitHub scopes, set by the signed-in account from Settings (POST
 * /api/auth/github/scope) and used by the next login start. Sealed, HttpOnly, short-lived and tied to that account.
 */
const SCOPE_COOKIE = 'mvlos_gh_scope'
/** The old sticky cookie (`?repo=1`); only cleared now. */
const LEGACY_REPO_COOKIE = 'mvlos_gh_repo'
const SCOPE_MINUTES = 10
/** The signed-in login, readable by the page, so the desktop boots as that user before /api/me answers. */
const LOGIN_COOKIE = 'mvlos_login'
/**
 * The signed-in account's id, readable by the page: the same cookie jar as the session, so every tab
 * knows at once which account the browser is signed in as now (src/os/accountSpace.ts).
 */
const UID_COOKIE = 'mvlos_uid'
const SESSION_DAYS = 30
// Sign-in only needs the profile. `repo` (asked for when someone allows it in Settings → Code hosts)
// lets Spotlight find private repositories, issues and branches; GitHub has no read-only variant
// of it for OAuth apps. GITHUB_SCOPES changes what "allow private repositories" asks for.
const BASIC_SCOPES = 'read:user'
const REPO_SCOPES = process.env.GITHUB_SCOPES ?? 'read:user repo read:org'
/** last_seen_at is written at most this often per user. */
const SEEN_EVERY = 5 * 60_000

// Where GitHub is: GITHUB_WEB_URL and GITHUB_API_URL point them at a stand-in for the checks
// (scripts/auth-identities-check.ts); nothing else sets them.
const GITHUB_WEB = process.env.GITHUB_WEB_URL || 'https://github.com'
const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com'

export const githubEnabled = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
/** Google sign-in (not Google Calendar): GOOGLE_SIGNIN=on, with an OAuth client (GOOGLE_SIGNIN_CLIENT_ID/SECRET, else GOOGLE_CLIENT_ID/SECRET). */
export const googleSignInClient = (): { id: string; secret: string } | null => {
  if (!/^(1|on|true|yes)$/i.test(process.env.GOOGLE_SIGNIN ?? '')) return null
  const id = process.env.GOOGLE_SIGNIN_CLIENT_ID || process.env.GOOGLE_CLIENT_ID
  const secret = process.env.GOOGLE_SIGNIN_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
  return id && secret ? { id, secret } : null
}
/** Whether anyone can sign in here: GitHub or Google sign-in is set up. */
export const authEnabled = () => githubEnabled() || !!googleSignInClient()
/** Which sign-ins this server offers, for the sign-in buttons. */
export const signInProviders = () => ({ github: githubEnabled(), google: !!googleSignInClient() })
const admins = () => (process.env.ADMIN_GITHUB_IDS ?? '46482143').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number)
/** Admin by GitHub's immutable numeric id (users.github_id), never by login, and never by Google: an account without GitHub is not an admin. */
export const isAdmin = (githubId: number | null) => githubId !== null && admins().includes(githubId)

/** A stored GitHub token, opened; empty for an account without GitHub, or one sealed with another SESSION_SECRET. */
export function githubTokenOf(sealed: string | null): string {
  if (!sealed) return ''
  try {
    return decrypt(sealed)
  } catch {
    return ''
  }
}

/** How many accounts may exist: the admin's choice, else MAX_USERS, else 100. */
export const maxUsers = () => Math.max(0, Math.floor(Number(appSetting('max_users') ?? process.env.MAX_USERS ?? 100))) || 0
export const registrationOpen = () => appSetting('registration') !== 'closed'
export const userCount = () => (database().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n

/** Whether a new GitHub account could sign up right now, for the sign-in button and the admin. */
export function registration() {
  const count = userCount()
  const max = maxUsers()
  return { open: registrationOpen(), full: count >= max, count, max }
}

const signInHandlers: ((userId: number) => void)[] = []
/** Runs after every sign-in, with its new token (maybe with other scopes, or let into more organisations): server/search.ts forgets that user's cached lists. */
export const onSignIn = (fn: (userId: number) => void) => void signInHandlers.push(fn)

/** `githubId` null (and `githubToken` empty): an account that signs in with Google only. */
export type User = { id: number; githubId: number | null; login: string; name: string | null; avatar: string | null; githubToken: string; githubScopes: string[]; admin: boolean }

type UserRow = { id: number; github_id: number | null; login: string; name: string | null; avatar: string | null; github_token: string; github_scopes: string | null; last_seen_at: number | null; banned_at: number | null }

/** The stored key of this request's session (what sessions.id holds), or null without one. */
export function sessionKey(req: IncomingMessage): string | null {
  const sid = cookies(req)[SESSION_COOKIE]
  return sid ? sha256(sid) : null
}

/**
 * The stored session this request is signed in with (and who it is for), or null: what a
 * long-lived connection is bound to, so that the session ending ends it (server/liveSessions.ts).
 */
export function sessionBinding(req: IncomingMessage): SessionBinding | null {
  if (!authEnabled()) return null
  const key = sessionKey(req)
  if (!key) return null
  const row = database()
    .prepare('SELECT s.user_id, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.banned_at IS NULL')
    .get(key, Date.now()) as { user_id: number; expires_at: number } | undefined
  return row ? { key, userId: row.user_id, expiresAt: row.expires_at } : null
}

/**
 * Binds a connection that stays open (a stream, a socket) to the session of the request that
 * opened it, for that account. `close` ends it when the session does: signing out, running out,
 * a ban (server/liveSessions.ts). Null when the request has no such session. The caller asks
 * `check()` before it sends something private or acts, and calls `stop()` when the connection
 * ends by itself.
 */
export function bindConnection(req: IncomingMessage, userId: number, close: (why: string) => void) {
  const binding = sessionBinding(req)
  return binding && binding.userId === userId ? track(binding, close) : null
}

/**
 * Ties a streamed response (NDJSON of an Agents turn, a joined turn, the Image Studio) to the
 * session that asked for it: when that session ends the response is cut. What runs on the server
 * (a turn) goes on, as when a window is closed; only what it would send to that session stops.
 */
export function bindResponse(res: ServerResponse, userId: number) {
  const live = res.req ? bindConnection(res.req, userId, () => res.destroy()) : null
  if (!live) return void res.destroy(), null
  res.once('close', () => live.stop())
  return live
}

/**
 * The session each request was signed in with when `currentUser` accepted it. A request keeps
 * its `User` for as long as the handler runs, which can be long: a client may send its body a few
 * bytes at a time. The session can end meanwhile (signing out, expiry, a ban, a deletion), so what
 * the request is allowed to do is decided again against this exact session (`stillSignedIn`).
 */
const authenticated = new WeakMap<IncomingMessage, SessionBinding>()

/**
 * Whether the session this request was authenticated with is still good: stored, unexpired, its
 * account not banned. Always a database lookup. A request that was never signed in has nothing to
 * lose, so it is true. Ask it at the commit point: after the slow part of a request (its body, a
 * planning step) and right before something that costs, is saved or sends something private.
 */
export function stillSignedIn(req: IncomingMessage): boolean {
  const was = authenticated.get(req)
  return !was || (Date.now() < was.expiresAt && sessionStored(was.key, was.userId))
}

/** `stillSignedIn`, as the generic 401 of a request that is not signed in. */
export function requireStillSignedIn(req: IncomingMessage) {
  if (!stillSignedIn(req)) throw new HttpError(401, 'Not signed in')
}

// Every JSON body (server/http.ts readJson) and upload is checked once it has been read: the
// handlers take their user before they await the body, so without this a slow body would carry a
// signed-out session's authority past its end.
guardBodies(requireStillSignedIn)

/** The signed-in user for this request, or null. */
export function currentUser(req: IncomingMessage): User | null {
  if (!authEnabled()) return null
  const sid = cookies(req)[SESSION_COOKIE]
  if (!sid) return null
  const row = database()
    .prepare('SELECT u.id, u.github_id, u.login, u.name, u.avatar, u.github_token, u.github_scopes, u.last_seen_at, u.banned_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
    .get(sha256(sid), Date.now()) as (UserRow & { expires_at: number }) | undefined
  if (!row) return null
  // Checked on every request, so a ban signs someone out at once (their sessions go too).
  if (row.banned_at) return null
  const now = Date.now()
  if (!row.last_seen_at || now - row.last_seen_at > SEEN_EVERY) database().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.id)
  authenticated.set(req, { key: sha256(sid), userId: row.id, expiresAt: row.expires_at })
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    name: row.name,
    avatar: row.avatar,
    githubToken: githubTokenOf(row.github_token),
    githubScopes: (row.github_scopes ?? '').split(/[\s,]+/).filter(Boolean),
    admin: isAdmin(row.github_id),
  }
}

/** Every account that may sign in (not banned), for the notification hub's watchers (server/watchers.ts). */
export function accounts(): User[] {
  const rows = database().prepare('SELECT id, github_id, login, name, avatar, github_token, github_scopes FROM users WHERE banned_at IS NULL').all() as UserRow[]
  return rows.map((r) => {
    return { id: r.id, githubId: r.github_id, login: r.login, name: r.name, avatar: r.avatar, githubToken: githubTokenOf(r.github_token), githubScopes: (r.github_scopes ?? '').split(/[\s,]+/).filter(Boolean), admin: isAdmin(r.github_id) }
  })
}

export function requireUser(req: IncomingMessage): User {
  const user = currentUser(req)
  if (!user) throw new HttpError(401, 'Not signed in')
  return user
}

/** A key set in the server's environment (OLLAMA_API_KEY, UPDOWN_API_KEY): the admin's own account,
 * so only admins fall back on it; everyone else saves their own in Settings. */
export const serverKey = (user: User, env: string): string | null => (user.admin && process.env[env]?.trim()) || null

export function requireAdmin(req: IncomingMessage): User {
  const user = requireUser(req)
  if (!user.admin) throw new HttpError(403, 'Only for admins')
  return user
}

/** The pages sign-in may come back to: the desktop, the CV page, and a game by its direct link (/play/<game>). Nothing else, so the link can't send anyone elsewhere. */
export const backTo = (path: string | null) => (path === '/cv' || (path && /^\/play(\/[a-z0-9-]{1,40})?$/.test(path)) ? path : '/')

/**
 * The scope choice made by this request's signed-in account, if any and still valid. The cookie is
 * one-time: whatever it holds, the caller clears it.
 */
function chosenRepoScope(req: IncomingMessage): boolean {
  const sealed = cookies(req)[SCOPE_COOKIE]
  if (!sealed) return false
  try {
    const { u, repo, exp } = JSON.parse(decrypt(sealed)) as { u: number; repo: boolean; exp: number }
    const user = currentUser(req)
    return !!user && user.id === u && Date.now() < exp && repo === true
  } catch {
    return false
  }
}

/** Remembers, for the next sign-in of this account only, whether to ask GitHub for private repositories (Settings → Code hosts). */
export function chooseRepoScope(req: IncomingMessage, res: ServerResponse, body: { repo?: unknown }) {
  const user = requireUser(req)
  if (typeof body.repo !== 'boolean') throw new HttpError(400, 'repo is true or false')
  const sealed = encrypt(JSON.stringify({ u: user.id, repo: body.repo, exp: Date.now() + SCOPE_MINUTES * 60_000 }))
  json(res, 200, { ok: true }, { 'Set-Cookie': [setCookie(req, SCOPE_COOKIE, sealed, { maxAge: SCOPE_MINUTES * 60, path: '/api/auth' })] })
}

// ---- Sign-in flows (GitHub here, Google in server/googleSignIn.ts) ----
//
// Every sign-in or link round trip carries a random `state`, sealed (AES-GCM) into an HttpOnly
// cookie with what it is for: signing in, or linking another sign-in to the account and session
// that asked (linking never happens by matching email addresses). A state is registered in memory
// and taken out at the callback before anything else, so it works once; a restart forgets them
// (the person starts again). PKCE and the OpenID nonce for Google ride in the same sealed cookie.

/** How long the provider's page may take before the state is refused. */
const FLOW_TTL = Number(process.env.AUTH_STATE_TTL_MS) || 10 * 60_000
/**
 * At most this many round trips wait at once (one process), and at most PER_CLIENT from one
 * address (server/egress.ts clientIp): a client starting more gives up its own oldest, never
 * someone else's. Once every slot holds a live round trip, new starts are refused until some lapse.
 */
const MAX_FLOWS = 10_000
const PER_CLIENT = Number(process.env.AUTH_FLOWS_PER_CLIENT) || 20
const flows = new Map<string, { until: number; client: string }>()

export type FlowMode = 'signin' | 'link'
/** A sealed round trip. `u`/`s`: the account and stored session that asked to link. */
export type Flow = { p: 'github' | 'google'; n: string; m: FlowMode; b: string; e: number; u?: number; s?: string; v?: string; o?: string; repo?: boolean }

/** Registers a new round trip for this request's address and returns its sealed cookie value. */
export function beginFlow(req: IncomingMessage, flow: Omit<Flow, 'e'>): string {
  const now = Date.now()
  const client = clientIp(req)
  const mine: string[] = []
  for (const [k, f] of flows) {
    if (f.until <= now) flows.delete(k)
    else if (f.client === client) mine.push(k)
  }
  // Oldest first (a Map keeps insertion order).
  while (mine.length >= PER_CLIENT) flows.delete(mine.shift()!)
  if (flows.size >= MAX_FLOWS) throw new HttpError(503, 'Too many sign-ins at once. Try again in a few minutes.')
  flows.set(flow.n, { until: now + FLOW_TTL, client })
  return encrypt(JSON.stringify({ ...flow, e: now + FLOW_TTL }))
}

/**
 * The round trip this callback finishes, or null. The state is used up whatever the outcome. A
 * link is only honoured for the same account and the same stored session that started it, still
 * signed in; anything else (another account signed in meanwhile, signed out, another device) is refused.
 */
export function finishFlow(req: IncomingMessage, provider: Flow['p'], sealed: string | undefined, state: string | null): Flow | null {
  if (!state) return null
  const until = flows.get(state)?.until
  flows.delete(state)
  if (until === undefined || until <= Date.now() || !sealed) return null
  let flow: Flow
  try {
    flow = JSON.parse(decrypt(sealed)) as Flow
  } catch {
    return null
  }
  if (flow.p !== provider || flow.n !== state || typeof flow.e !== 'number' || flow.e <= Date.now()) return null
  if (flow.m === 'link') {
    const user = currentUser(req)
    if (!user || user.id !== flow.u || sessionKey(req) !== flow.s) return null
  } else if (flow.m !== 'signin') return null
  return flow
}

/** Where a round trip goes back to (a path from `backTo`), with ?auth=<result>. */
export const backWith = (back: string, result: string) => `${backTo(back)}?auth=${result}`

/** Whether a new account may be made now: registration open and room left. Admins are let in regardless (GitHub only). */
export function admission(): 'ok' | 'closed' | 'full' {
  if (!registrationOpen()) return 'closed'
  if (userCount() >= maxUsers()) return 'full'
  return 'ok'
}

/** The redirect for a banned account trying to sign in. */
export function bannedRedirect(res: ServerResponse, back: string, reason: string | null, set: string[]) {
  redirect(res, `${backWith(back, 'banned')}${reason ? `&reason=${encodeURIComponent(reason.slice(0, 200))}` : ''}`, { 'Set-Cookie': set })
}

/** Signs this browser in as `id`: a new session (never an old one reused), and the readable login and id cookies. */
export function issueSession(req: IncomingMessage, res: ServerResponse, id: number, location: string, set: string[]) {
  const row = database().prepare('SELECT login FROM users WHERE id = ?').get(id) as { login: string }
  for (const fn of signInHandlers) fn(id)
  const now = Date.now()
  const sid = randomBytes(32).toString('base64url')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + SESSION_DAYS * 864e5)
  redirect(res, location, {
    'Set-Cookie': [...set, setCookie(req, SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400 }), setCookie(req, LOGIN_COOKIE, row.login, { maxAge: SESSION_DAYS * 86400, readable: true }), setCookie(req, UID_COOKIE, String(id), { maxAge: SESSION_DAYS * 86400, readable: true })],
  })
}

/** The account a provider's identity signs in as, if any. */
export function identityOwner(provider: string, subject: string): { id: number; banned_at: number | null; ban_reason: string | null } | undefined {
  return database().prepare('SELECT u.id, u.banned_at, u.ban_reason FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?').get(provider, subject) as { id: number; banned_at: number | null; ban_reason: string | null } | undefined
}

export type Identity = { provider: 'github' | 'google'; label: string; linkedAt: number }

/** The sign-ins linked to an account, for Settings → Account. Email addresses only for display. */
export function identitiesOf(user: Pick<User, 'id' | 'login' | 'githubId'>): Identity[] {
  const rows = database().prepare('SELECT provider, email, created_at FROM identities WHERE user_id = ? ORDER BY created_at').all(user.id) as { provider: string; email: string | null; created_at: number }[]
  return rows
    .filter((r) => r.provider === 'github' || r.provider === 'google')
    .map((r) => ({ provider: r.provider as Identity['provider'], label: r.provider === 'github' ? `@${user.login}` : (r.email ?? 'Google account'), linkedAt: r.created_at }))
}

/** Asks GitHub to sign in, or (`link`) to link GitHub to the signed-in account. Asks for `read:user` only, unless the signed-in account just chose private repositories (chooseRepoScope); that choice is used once. */
function githubRedirect(req: IncomingMessage, flow: Omit<Flow, 'e' | 'n' | 'p'>): { url: string; set: string[] } {
  const state = randomBytes(16).toString('base64url')
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: `${publicOrigin(req)}/api/auth/github/callback`,
    scope: flow.repo ? REPO_SCOPES : BASIC_SCOPES,
    state,
    allow_signup: 'false',
  })
  const set = [setCookie(req, STATE_COOKIE, beginFlow(req, { ...flow, p: 'github', n: state }), { maxAge: FLOW_TTL / 1000, path: '/api/auth' }), setCookie(req, SCOPE_COOKIE, '', { maxAge: 0, path: '/api/auth' })]
  if (cookies(req)[LEGACY_REPO_COOKIE] !== undefined) set.push(setCookie(req, LEGACY_REPO_COOKIE, '', { maxAge: 0, path: '/api/auth' }))
  return { url: `${GITHUB_WEB}/login/oauth/authorize?${params}`, set }
}

/** Off to GitHub to sign in. */
export function startLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!githubEnabled()) return redirect(res, '/?auth=off')
  // Where to come back to: the CV page or a game's direct link when signing in from there, else the desktop.
  const { url: to, set } = githubRedirect(req, { m: 'signin', b: backTo(url.searchParams.get('back')), repo: chosenRepoScope(req) })
  redirect(res, to, { 'Set-Cookie': set })
}

/** Settings → Account: link GitHub to the signed-in account. A POST from the page (same-origin, its account), answered with where to go. */
export function startGithubLink(req: IncomingMessage, res: ServerResponse) {
  const user = requireUser(req)
  if (!githubEnabled()) throw new HttpError(400, 'GitHub sign-in is not set up on this server')
  if (user.githubId !== null) throw new HttpError(409, 'GitHub is already linked to this account')
  const { url, set } = githubRedirect(req, { m: 'link', b: '/', u: user.id, s: sessionKey(req)! })
  json(res, 200, { url }, { 'Set-Cookie': set })
}

export async function finishLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const clearState = setCookie(req, STATE_COOKIE, '', { maxAge: 0, path: '/api/auth' })
  const flow = finishFlow(req, 'github', cookies(req)[STATE_COOKIE], url.searchParams.get('state'))
  const home = flow?.b ?? '/'
  const fail = (reason: string) => redirect(res, backWith(home, reason), { 'Set-Cookie': clearState })
  if (!githubEnabled()) return fail('off')
  const code = url.searchParams.get('code')
  if (!flow) return fail('error')
  if (!code) return fail(flow.m === 'link' ? 'link-error' : 'error')

  const tokenRes = await fetch(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${publicOrigin(req)}/api/auth/github/callback`,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  const granted = tokenRes?.ok ? ((await tokenRes.json()) as { access_token?: string; scope?: string }) : {}
  const token = granted.access_token
  if (!token) return fail(flow.m === 'link' ? 'link-error' : 'error')

  const meRes = await fetch(`${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mvlos' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!meRes?.ok) return fail(flow.m === 'link' ? 'link-error' : 'error')
  const me = (await meRes.json()) as { id: number; login: string; name: string | null; avatar_url: string | null }
  if (!Number.isSafeInteger(me.id) || me.id <= 0 || typeof me.login !== 'string') return fail('error')

  const db = database()
  const now = Date.now()
  const owner = identityOwner('github', String(me.id))

  if (flow.m === 'link') {
    // Linking GitHub to the account that asked, still signed in with the same session. A GitHub
    // account with an account of its own here stays separate: accounts are never merged.
    const user = currentUser(req)
    if (!user || user.id !== flow.u) return fail('link-error')
    if (owner && owner.id !== user.id) return fail('link-taken')
    if (user.githubId !== null && user.githubId !== me.id) return fail('link-exists')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE users SET github_id = ?, login = ?, name = COALESCE(name, ?), avatar = COALESCE(avatar, ?), github_token = ?, github_scopes = ?, updated_at = ? WHERE id = ?').run(me.id, me.login, me.name, me.avatar_url, encrypt(token), granted.scope ?? '', now, user.id)
      db.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)').run('github', String(me.id), user.id, now, now)
      db.exec('COMMIT')
    } catch {
      db.exec('ROLLBACK')
      return fail('link-error')
    }
    for (const fn of signInHandlers) fn(user.id)
    return redirect(res, backWith('/', 'linked-github'), { 'Set-Cookie': [clearState, setCookie(req, LOGIN_COOKIE, me.login, { maxAge: SESSION_DAYS * 86400, readable: true })] })
  }

  // Who gets in: existing accounts unless banned, admins always, newcomers while registration is
  // open and there is room. Banned accounts keep their row (and their spot), so they stay out.
  if (owner?.banned_at) return bannedRedirect(res, home, owner.ban_reason, [clearState])
  if (!owner && !isAdmin(me.id)) {
    const admit = admission()
    if (admit !== 'ok') return fail(admit)
  }

  let id: number
  if (owner) {
    id = owner.id
    db.prepare('UPDATE users SET login = ?, name = ?, avatar = ?, github_token = ?, github_scopes = ?, updated_at = ?, last_seen_at = ? WHERE id = ?').run(me.login, me.name, me.avatar_url, encrypt(token), granted.scope ?? '', now, now, id)
    db.prepare("UPDATE identities SET last_used_at = ? WHERE provider = 'github' AND subject = ?").run(now, String(me.id))
  } else {
    id = nextUserId()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO users (id, github_id, login, name, avatar, github_token, github_scopes, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, me.id, me.login, me.name, me.avatar_url, encrypt(token), granted.scope ?? '', now, now, now)
      db.prepare('INSERT INTO identities (provider, subject, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)').run('github', String(me.id), id, now, now)
      db.exec('COMMIT')
    } catch {
      db.exec('ROLLBACK')
      return fail('error')
    }
  }
  issueSession(req, res, id, backWith(home, 'ok'), [clearState])
}

export function logout(req: IncomingMessage, res: ServerResponse) {
  const sid = cookies(req)[SESSION_COOKIE]
  if (sid && authEnabled()) {
    // Its push subscriptions go with it: this device no longer gets the account's messages.
    database().prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(sha256(sid))
    database().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid))
    // Its open streams and sockets close now; the account's other sessions keep theirs.
    endSession(sha256(sid))
  }
  json(res, 200, { ok: true }, { 'Set-Cookie': [setCookie(req, SESSION_COOKIE, '', { maxAge: 0 }), setCookie(req, LOGIN_COOKIE, '', { maxAge: 0, readable: true }), setCookie(req, UID_COOKIE, '', { maxAge: 0, readable: true })] })
}

/**
 * The account id cookie put right for this request's session, if it isn't: set to the session's
 * account (a session from before the cookie existed), or cleared when there is no valid session
 * (it ran out, was signed out elsewhere, or the account is gone).
 */
export function uidCookieFix(req: IncomingMessage, user: User | null): string[] {
  const has = cookies(req)[UID_COOKIE]
  if (user && has !== String(user.id)) {
    const sid = cookies(req)[SESSION_COOKIE]
    const row = sid ? (database().prepare('SELECT expires_at FROM sessions WHERE id = ?').get(sha256(sid)) as { expires_at: number } | undefined) : undefined
    const maxAge = row ? Math.max(60, Math.floor((row.expires_at - Date.now()) / 1000)) : SESSION_DAYS * 86400
    return [setCookie(req, UID_COOKIE, String(user.id), { maxAge, readable: true })]
  }
  if (!user && has) return [setCookie(req, UID_COOKIE, '', { maxAge: 0, readable: true })]
  return []
}

/**
 * Whether a request from a page is for the account the page holds: the page says which in
 * X-MvL-Account (an account id, or `visitor`; the notification stream says it in ?holds=). A page of another
 * account than the session's now (another tab signed in as someone else) is refused, so its state
 * never reaches this account; where state is written, a page that doesn't say is refused too (a
 * tab from before this check: it has to reload).
 */
export function accountMismatch(req: IncomingMessage, held: string | null, required: boolean): string | null {
  if (held === null) return required ? 'Reload the page: it is from an older version' : null
  const user = currentUser(req)
  return held === (user ? String(user.id) : 'visitor') ? null : 'Signed in as another account'
}
