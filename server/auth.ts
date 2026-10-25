import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appSetting, database, decrypt, encrypt, nextUserId, sha256 } from './db.ts'
import { cookies, HttpError, json, publicOrigin, redirect, setCookie } from './http.ts'

// "Sign in with GitHub" (OAuth web flow). Any GitHub account may sign up while registration is
// open and there is room (MAX_USERS, default 100; the admin can change both in Settings → Users).
// GitHub accounts whose numeric id is in ADMIN_GITHUB_IDS (default: 46482143) are admins: they always
// get in, may use the keys set on the server, and manage the other users (server/admin.ts). The id
// never changes, unlike a login, which can be renamed and later taken by someone else. The old
// ADMIN_USERS (logins) is retired and grants nothing.
//
// Needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from a GitHub OAuth app whose callback URL is
// <site>/api/auth/github/callback. Without them, login is off and /api/me says so.

const SESSION_COOKIE = 'mvlos_sid'
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

export const authEnabled = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
const admins = () => (process.env.ADMIN_GITHUB_IDS ?? '46482143').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number)
/** Admin by GitHub's immutable numeric id (users.github_id), never by login. */
export const isAdmin = (githubId: number) => admins().includes(githubId)

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

export type User = { id: number; githubId: number; login: string; name: string | null; avatar: string | null; githubToken: string; githubScopes: string[]; admin: boolean }

type UserRow = { id: number; github_id: number; login: string; name: string | null; avatar: string | null; github_token: string; github_scopes: string | null; last_seen_at: number | null; banned_at: number | null }

/** The stored key of this request's session (what sessions.id holds), or null without one. */
export function sessionKey(req: IncomingMessage): string | null {
  const sid = cookies(req)[SESSION_COOKIE]
  return sid ? sha256(sid) : null
}

/** The signed-in user for this request, or null. */
export function currentUser(req: IncomingMessage): User | null {
  if (!authEnabled()) return null
  const sid = cookies(req)[SESSION_COOKIE]
  if (!sid) return null
  const row = database()
    .prepare('SELECT u.id, u.github_id, u.login, u.name, u.avatar, u.github_token, u.github_scopes, u.last_seen_at, u.banned_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
    .get(sha256(sid), Date.now()) as UserRow | undefined
  if (!row) return null
  // Checked on every request, so a ban signs someone out at once (their sessions go too).
  if (row.banned_at) return null
  const now = Date.now()
  if (!row.last_seen_at || now - row.last_seen_at > SEEN_EVERY) database().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.id)
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    name: row.name,
    avatar: row.avatar,
    githubToken: decrypt(row.github_token),
    githubScopes: (row.github_scopes ?? '').split(/[\s,]+/).filter(Boolean),
    admin: isAdmin(row.github_id),
  }
}

/** Every account that may sign in (not banned), for the notification hub's watchers (server/watchers.ts). */
export function accounts(): User[] {
  const rows = database().prepare('SELECT id, github_id, login, name, avatar, github_token, github_scopes FROM users WHERE banned_at IS NULL').all() as UserRow[]
  return rows.map((r) => {
    let githubToken = ''
    try {
      githubToken = decrypt(r.github_token)
    } catch {
      /* sealed with another SESSION_SECRET */
    }
    return { id: r.id, githubId: r.github_id, login: r.login, name: r.name, avatar: r.avatar, githubToken, githubScopes: (r.github_scopes ?? '').split(/[\s,]+/).filter(Boolean), admin: isAdmin(r.github_id) }
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
const backTo = (path: string | null) => (path === '/cv' || (path && /^\/play(\/[a-z0-9-]{1,40})?$/.test(path)) ? path : '/')

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

/** Off to GitHub. Asks for `read:user` only, unless the signed-in account just chose private repositories (chooseRepoScope); that choice is used once. */
export function startLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!authEnabled()) return redirect(res, '/?auth=off')
  const repo = chosenRepoScope(req)
  const state = randomBytes(16).toString('base64url')
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: `${publicOrigin(req)}/api/auth/github/callback`,
    scope: repo ? REPO_SCOPES : BASIC_SCOPES,
    state,
    allow_signup: 'false',
  })
  // Where to come back to: the CV page or a game's direct link when signing in from there, else the desktop.
  const back = backTo(url.searchParams.get('back'))
  const set = [setCookie(req, STATE_COOKIE, `${state} ${back}`, { maxAge: 600, path: '/api/auth' }), setCookie(req, SCOPE_COOKIE, '', { maxAge: 0, path: '/api/auth' })]
  if (cookies(req)[LEGACY_REPO_COOKIE] !== undefined) set.push(setCookie(req, LEGACY_REPO_COOKIE, '', { maxAge: 0, path: '/api/auth' }))
  redirect(res, `https://github.com/login/oauth/authorize?${params}`, { 'Set-Cookie': set })
}

export async function finishLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const clearState = setCookie(req, STATE_COOKIE, '', { maxAge: 0, path: '/api/auth' })
  const [expected, back = '/'] = (cookies(req)[STATE_COOKIE] ?? '').split(' ')
  const home = backTo(back)
  const fail = (reason: string) => redirect(res, `${home}?auth=${reason}`, { 'Set-Cookie': clearState })
  if (!authEnabled()) return fail('off')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state || state !== expected) return fail('error')

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
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
  if (!token) return fail('error')

  const meRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mvlos' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!meRes?.ok) return fail('error')
  const me = (await meRes.json()) as { id: number; login: string; name: string | null; avatar_url: string | null }

  // Who gets in: existing accounts unless banned, admins always, newcomers while registration is
  // open and there is room. Banned accounts keep their row (and their spot), so they stay out.
  const db = database()
  const known = db.prepare('SELECT id, banned_at, ban_reason FROM users WHERE github_id = ?').get(me.id) as { id: number; banned_at: number | null; ban_reason: string | null } | undefined
  if (known?.banned_at) return redirect(res, `${home}?auth=banned${known.ban_reason ? `&reason=${encodeURIComponent(known.ban_reason.slice(0, 200))}` : ''}`, { 'Set-Cookie': clearState })
  if (!known && !isAdmin(me.id)) {
    if (!registrationOpen()) return fail('closed')
    if (userCount() >= maxUsers()) return fail('full')
  }

  const now = Date.now()
  let id: number
  if (known) {
    id = known.id
    db.prepare('UPDATE users SET login = ?, name = ?, avatar = ?, github_token = ?, github_scopes = ?, updated_at = ?, last_seen_at = ? WHERE id = ?').run(me.login, me.name, me.avatar_url, encrypt(token), granted.scope ?? '', now, now, id)
  } else {
    id = nextUserId()
    db.prepare('INSERT INTO users (id, github_id, login, name, avatar, github_token, github_scopes, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, me.id, me.login, me.name, me.avatar_url, encrypt(token), granted.scope ?? '', now, now, now)
  }

  for (const fn of signInHandlers) fn(id)

  const sid = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + SESSION_DAYS * 864e5)
  redirect(res, `${home}?auth=ok`, {
    'Set-Cookie': [clearState, setCookie(req, SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400 }), setCookie(req, LOGIN_COOKIE, me.login, { maxAge: SESSION_DAYS * 86400, readable: true }), setCookie(req, UID_COOKIE, String(id), { maxAge: SESSION_DAYS * 86400, readable: true })],
  })
}

export function logout(req: IncomingMessage, res: ServerResponse) {
  const sid = cookies(req)[SESSION_COOKIE]
  if (sid && authEnabled()) {
    // Its push subscriptions go with it: this device no longer gets the account's messages.
    database().prepare('DELETE FROM push_subscriptions WHERE session_id = ?').run(sha256(sid))
    database().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid))
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
