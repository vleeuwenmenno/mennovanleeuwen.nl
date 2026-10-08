import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { database, decrypt, encrypt, sha256 } from './db.ts'
import { cookies, HttpError, json, publicOrigin, redirect, setCookie } from './http.ts'

// "Sign in with GitHub" (OAuth web flow) for the site's owner. Only logins in ALLOWED_USERS
// (default: vleeuwenmenno) get a session; everyone else keeps the plain CV desktop.
//
// Needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from a GitHub OAuth app whose callback URL is
// <site>/api/auth/github/callback. Without them, login is off and /api/me says so.

const SESSION_COOKIE = 'mvlos_sid'
const STATE_COOKIE = 'mvlos_oauth'
const SESSION_DAYS = 30
// `repo` lets Spotlight find private repositories, issues and branches; GitHub has no read-only
// variant of it for OAuth apps. GITHUB_SCOPES narrows it (e.g. "read:user public_repo").
const SCOPES = process.env.GITHUB_SCOPES ?? 'read:user repo read:org'

export const authEnabled = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
const allowed = () => (process.env.ALLOWED_USERS ?? 'vleeuwenmenno').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

export type User = { id: number; login: string; name: string | null; avatar: string | null; githubToken: string }

type UserRow = { id: number; login: string; name: string | null; avatar: string | null; github_token: string }

/** The signed-in user for this request, or null. */
export function currentUser(req: IncomingMessage): User | null {
  if (!authEnabled()) return null
  const sid = cookies(req)[SESSION_COOKIE]
  if (!sid) return null
  const row = database()
    .prepare('SELECT u.id, u.login, u.name, u.avatar, u.github_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
    .get(sha256(sid), Date.now()) as UserRow | undefined
  if (!row) return null
  // The allowlist is checked on every request, so removing someone from it signs them out.
  if (!allowed().includes(row.login.toLowerCase())) return null
  return { id: row.id, login: row.login, name: row.name, avatar: row.avatar, githubToken: decrypt(row.github_token) }
}

export function requireUser(req: IncomingMessage): User {
  const user = currentUser(req)
  if (!user) throw new HttpError(401, 'Not signed in')
  return user
}

export function startLogin(req: IncomingMessage, res: ServerResponse) {
  if (!authEnabled()) return redirect(res, '/?auth=off')
  const state = randomBytes(16).toString('base64url')
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: `${publicOrigin(req)}/api/auth/github/callback`,
    scope: SCOPES,
    state,
    allow_signup: 'false',
  })
  redirect(res, `https://github.com/login/oauth/authorize?${params}`, {
    'Set-Cookie': setCookie(req, STATE_COOKIE, state, { maxAge: 600, path: '/api/auth' }),
  })
}

export async function finishLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const clearState = setCookie(req, STATE_COOKIE, '', { maxAge: 0, path: '/api/auth' })
  const fail = (reason: string) => redirect(res, `/?auth=${reason}`, { 'Set-Cookie': clearState })
  if (!authEnabled()) return fail('off')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state || state !== cookies(req)[STATE_COOKIE]) return fail('error')

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
  const token = tokenRes?.ok ? ((await tokenRes.json()) as { access_token?: string }).access_token : undefined
  if (!token) return fail('error')

  const meRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mvlos' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!meRes?.ok) return fail('error')
  const me = (await meRes.json()) as { id: number; login: string; name: string | null; avatar_url: string | null }
  if (!allowed().includes(me.login.toLowerCase())) return fail('denied')

  const db = database()
  const now = Date.now()
  db.prepare(
    `INSERT INTO users (github_id, login, name, avatar, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar = excluded.avatar, github_token = excluded.github_token, updated_at = excluded.updated_at`,
  ).run(me.id, me.login, me.name, me.avatar_url, encrypt(token), now, now)
  const { id } = db.prepare('SELECT id FROM users WHERE github_id = ?').get(me.id) as { id: number }

  const sid = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + SESSION_DAYS * 864e5)
  redirect(res, '/?auth=ok', { 'Set-Cookie': [clearState, setCookie(req, SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400 })] })
}

export function logout(req: IncomingMessage, res: ServerResponse) {
  const sid = cookies(req)[SESSION_COOKIE]
  if (sid && authEnabled()) database().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid))
  json(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, SESSION_COOKIE, '', { maxAge: 0 }) })
}
