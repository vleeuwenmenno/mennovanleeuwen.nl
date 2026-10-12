import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appSetting, database, decrypt, encrypt, nextUserId, sha256 } from './db.ts'
import { cookies, HttpError, json, publicOrigin, redirect, setCookie } from './http.ts'

// "Sign in with GitHub" (OAuth web flow). Any GitHub account may sign up while registration is
// open and there is room (MAX_USERS, default 100; the admin can change both in Settings → Users).
// Logins in ADMIN_USERS (default: vleeuwenmenno) are admins: they always get in, may use the keys
// set on the server, and manage the other users (server/admin.ts).
//
// Needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from a GitHub OAuth app whose callback URL is
// <site>/api/auth/github/callback. Without them, login is off and /api/me says so.

const SESSION_COOKIE = 'mvlos_sid'
const STATE_COOKIE = 'mvlos_oauth'
/** Set once someone allows private repositories, so later sign-ins ask GitHub for the same scopes. */
const REPO_COOKIE = 'mvlos_gh_repo'
/** The signed-in login, readable by the page, so the desktop boots as that user before /api/me answers. */
const LOGIN_COOKIE = 'mvlos_login'
const SESSION_DAYS = 30
// Sign-in only needs the profile. `repo` (asked for when someone allows it in Settings → Code hosts)
// lets Spotlight find private repositories, issues and branches; GitHub has no read-only variant
// of it for OAuth apps. GITHUB_SCOPES changes what "allow private repositories" asks for.
const BASIC_SCOPES = 'read:user'
const REPO_SCOPES = process.env.GITHUB_SCOPES ?? 'read:user repo read:org'
/** last_seen_at is written at most this often per user. */
const SEEN_EVERY = 5 * 60_000

export const authEnabled = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
const admins = () => (process.env.ADMIN_USERS ?? 'vleeuwenmenno').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
export const isAdmin = (login: string) => admins().includes(login.toLowerCase())

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

export type User = { id: number; login: string; name: string | null; avatar: string | null; githubToken: string; githubScopes: string[]; admin: boolean }

type UserRow = { id: number; login: string; name: string | null; avatar: string | null; github_token: string; github_scopes: string | null; last_seen_at: number | null; banned_at: number | null }

/** The signed-in user for this request, or null. */
export function currentUser(req: IncomingMessage): User | null {
  if (!authEnabled()) return null
  const sid = cookies(req)[SESSION_COOKIE]
  if (!sid) return null
  const row = database()
    .prepare('SELECT u.id, u.login, u.name, u.avatar, u.github_token, u.github_scopes, u.last_seen_at, u.banned_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
    .get(sha256(sid), Date.now()) as UserRow | undefined
  if (!row) return null
  // Checked on every request, so a ban signs someone out at once (their sessions go too).
  if (row.banned_at) return null
  const now = Date.now()
  if (!row.last_seen_at || now - row.last_seen_at > SEEN_EVERY) database().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.id)
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatar: row.avatar,
    githubToken: decrypt(row.github_token),
    githubScopes: (row.github_scopes ?? '').split(/[\s,]+/).filter(Boolean),
    admin: isAdmin(row.login),
  }
}

/** Every account that may sign in (not banned), for the notification hub's watchers (server/watchers.ts). */
export function accounts(): User[] {
  const rows = database().prepare('SELECT id, login, name, avatar, github_token, github_scopes FROM users WHERE banned_at IS NULL').all() as UserRow[]
  return rows.map((r) => {
    let githubToken = ''
    try {
      githubToken = decrypt(r.github_token)
    } catch {
      /* sealed with another SESSION_SECRET */
    }
    return { id: r.id, login: r.login, name: r.name, avatar: r.avatar, githubToken, githubScopes: (r.github_scopes ?? '').split(/[\s,]+/).filter(Boolean), admin: isAdmin(r.login) }
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

/** Off to GitHub. `?repo=1` also asks for private repositories (and remembers that), `?repo=0` stops asking. */
export function startLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!authEnabled()) return redirect(res, '/?auth=off')
  const asked = url.searchParams.get('repo')
  const repo = asked === null ? cookies(req)[REPO_COOKIE] === '1' : asked === '1'
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
  const set = [setCookie(req, STATE_COOKIE, `${state} ${back}`, { maxAge: 600, path: '/api/auth' })]
  if (asked !== null) set.push(setCookie(req, REPO_COOKIE, repo ? '1' : '', { maxAge: repo ? 365 * 86400 : 0, path: '/api/auth' }))
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
  if (!known && !isAdmin(me.login)) {
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

  const sid = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + SESSION_DAYS * 864e5)
  redirect(res, `${home}?auth=ok`, {
    'Set-Cookie': [clearState, setCookie(req, SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400 }), setCookie(req, LOGIN_COOKIE, me.login, { maxAge: SESSION_DAYS * 86400, readable: true })],
  })
}

export function logout(req: IncomingMessage, res: ServerResponse) {
  const sid = cookies(req)[SESSION_COOKIE]
  if (sid && authEnabled()) database().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid))
  json(res, 200, { ok: true }, { 'Set-Cookie': [setCookie(req, SESSION_COOKIE, '', { maxAge: 0 }), setCookie(req, LOGIN_COOKIE, '', { maxAge: 0, readable: true })] })
}
