import { requirePrivateRequest } from './privateRequest.ts'
import { privateFetch as fetch } from './privateRequest.ts'
import type { User } from './auth.ts'
import { guardedFetch, readCapped, rethrowEgress } from './egress.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError } from './http.ts'

// Code hosts a signed-in user can search: their GitHub account, plus any Gitea or Forgejo
// instances they linked with a personal access token. Each becomes a `Source` with one `api()`
// function, so search code doesn't care which kind it talks to.

export type Source = {
  /** "github" or "forge:<id>" */
  id: string
  label: string
  kind: 'github' | 'gitea'
  /** Web origin, for building links */
  web: string
  login: string
  /** GET an API path ("/repos/a/b"); resolves null on 404, throws on other errors. */
  api: <T>(path: string) => Promise<T | null>
  /** The same, for an answer that is plain text (a .diff) */
  text: (path: string) => Promise<string | null>
  /**
   * A change (the Git app's comments and descriptions): `json` sent with POST or PATCH, the host's
   * JSON answer back. Refusals throw with a message saying what to fix (a token without write access).
   */
  send: <T>(method: 'POST' | 'PATCH', path: string, json: unknown) => Promise<T>
}

export type ForgeInfo = { id: number; label: string; baseUrl: string; username: string }

const TIMEOUT = 8000

/** Error texts for an organisation that blocks this OAuth app, or wants SAML sign-on first. */
export const ORG_RESTRICTED = 'the organisation restricts OAuth app access'
export const ORG_SSO = 'the organisation wants SAML single sign-on for this token'

// When a host says "rate limited", stop asking it until the limit resets instead of failing on
// every keystroke. GitHub limits its search API (30 a minute) apart from the rest, so search and
// other requests are tracked separately, per token.
const blockedUntil = new Map<string, number>()
const limitKey = (url: string, headers: Record<string, string>) => `${new URL(url).host}|${url.includes('/search/') ? 'search' : 'core'}|${headers.Authorization ?? ''}`

/** What a host said was wrong, from its JSON error answer ({ message }), or "". */
const hostMessage = async (res: Response) => String(((await res.json().catch(() => null)) as { message?: unknown } | null)?.message ?? '').slice(0, 300)

/** A change: how it goes out, and what to say when the host refuses it for want of access. */
type Write = { method: 'POST' | 'PATCH'; body: unknown; refused: string }

/** `user` is who chose the address (a linked instance: checked by guardedFetch), null for GitHub's own API. */
async function get<T>(user: User | null, url: string, headers: Record<string, string>, label: string, text = false, write?: Write): Promise<T | null> {
  const key = limitKey(url, headers)
  const until = blockedUntil.get(key) ?? 0
  if (until > Date.now()) throw new HttpError(429, `${label} rate limit, back in ${Math.ceil((until - Date.now()) / 1000)} s`)
  const init: RequestInit = {
    headers: { Accept: 'application/json', 'User-Agent': 'mvlos', ...(write ? { 'Content-Type': 'application/json' } : {}), ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
    ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
  }
  const res = await (user ? guardedFetch(user, url, init) : fetch(url, init)).catch((e) => {
    rethrowEgress(e)
    throw new HttpError(502, `${label} did not answer`)
  })
  if (res.status === 404 && !write) return null
  if (res.status === 401) throw new HttpError(502, `${label} rejected the token`)
  // A change the host turned down: no access (GitHub answers 404 for that too), or something
  // about the change itself (a locked conversation, a text it won't take).
  if (write && (res.status === 403 || res.status === 404) && res.headers.get('x-ratelimit-remaining') !== '0' && !res.headers.get('retry-after')) {
    const why = await hostMessage(res)
    if (/lock/i.test(why)) throw new HttpError(403, `${label} refused: ${why}`)
    throw new HttpError(403, write.refused)
  }
  if (write && (res.status === 400 || res.status === 409 || res.status === 422)) {
    const why = await hostMessage(res)
    throw new HttpError(400, `${label} refused this${why ? `: ${why}` : ''}`)
  }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
    const retry = Number(res.headers.get('retry-after')) * 1000
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || retry) {
      blockedUntil.set(key, retry ? Date.now() + retry : reset > Date.now() ? reset : Date.now() + 60_000)
      throw new HttpError(429, `${label} rate limit, back in ${Math.ceil(((blockedUntil.get(key) ?? 0) - Date.now()) / 1000)} s`)
    }
    // GitHub says why when an organisation keeps this OAuth app out (its third-party access policy)
    // or wants SAML single sign-on first; Settings → Code hosts tells those apart (search.ts).
    const why = String(((await res.json().catch(() => null)) as { message?: unknown } | null)?.message ?? '')
    if (/OAuth App access restrictions/i.test(why)) throw new HttpError(403, `${label}: ${ORG_RESTRICTED}`)
    if (/SAML/i.test(why)) throw new HttpError(403, `${label}: ${ORG_SSO}`)
    throw new HttpError(502, `${label} refused (no permission)`)
  }
  if (!res.ok) throw new HttpError(502, `${label} answered ${res.status}`)
  const body = (await readCapped(res, 16 * 1024 * 1024)).toString('utf8')
  if (!text && !body.trim()) return null
  return (text ? body : JSON.parse(body)) as T
}

/** For a change, which never answers null: a host that sent nothing back answers {}. */
const sent = <T>(p: Promise<T | null>) => p.then((v) => (v ?? {}) as T)

/** What GitHub's refusal of a change usually means: the token was granted without write access. */
const GITHUB_REFUSED = "GitHub didn't allow this — sign in again with private repositories allowed (Settings → Code hosts)"

export function githubSource(user: User): Source {
  return {
    id: 'github',
    label: 'GitHub',
    kind: 'github',
    web: 'https://github.com',
    login: user.login,
    api: (path) => get(null, `https://api.github.com${path}`, { Authorization: `Bearer ${user.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, 'GitHub'),
    text: (path) => get<string>(null, `https://api.github.com${path}`, { Authorization: `Bearer ${user.githubToken}`, Accept: 'application/vnd.github.diff', 'X-GitHub-Api-Version': '2022-11-28' }, 'GitHub', true),
    send: <T>(method: 'POST' | 'PATCH', path: string, json: unknown) =>
      sent<T>(get<T>(null, `https://api.github.com${path}`, { Authorization: `Bearer ${user.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, 'GitHub', false, { method, body: json, refused: GITHUB_REFUSED })),
  }
}

function giteaSource(user: User, id: number, label: string, base: string, username: string, token: string): Source {
  return {
    id: `forge:${id}`,
    label,
    kind: 'gitea',
    web: base,
    login: username,
    api: (path) => get(user, `${base}/api/v1${path}`, { Authorization: `token ${token}` }, label),
    text: (path) => get<string>(user, `${base}/api/v1${path}`, { Authorization: `token ${token}`, Accept: 'text/plain' }, label, true),
    send: <T>(method: 'POST' | 'PATCH', path: string, json: unknown) =>
      sent<T>(get<T>(user, `${base}/api/v1${path}`, { Authorization: `token ${token}` }, label, false, { method, body: json, refused: `${label} didn't allow this — the token needs the write:issue scope (Settings → Code hosts)` })),
  }
}

type ForgeRow = { id: number; label: string; base_url: string; username: string; token: string }

export function listForges(user: User): ForgeInfo[] {
  const rows = database().prepare('SELECT id, label, base_url, username FROM forges WHERE user_id = ? ORDER BY id').all(user.id) as unknown as ForgeRow[]
  return rows.map((r) => ({ id: r.id, label: r.label, baseUrl: r.base_url, username: r.username }))
}

export function sources(user: User): Source[] {
  const rows = database().prepare('SELECT id, label, base_url, username, token FROM forges WHERE user_id = ? ORDER BY id').all(user.id) as unknown as ForgeRow[]
  return [githubSource(user), ...rows.map((r) => giteaSource(user, r.id, r.label, r.base_url, r.username, decrypt(r.token)))]
}

/** "git.example.com", "https://git.example.com/", ".../api/v1" all become "https://git.example.com". */
export function normalizeBase(input: string): string {
  let raw = input.trim()
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'That is not a URL')
  }
  if (url.username || url.password) throw new HttpError(400, 'Leave credentials out of the URL; use the token field')
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/** Checks the token against the instance (GET /user) and stores it encrypted. */
export async function addForge(user: User, body: { baseUrl?: string; token?: string; label?: string }): Promise<ForgeInfo> {
  if (!body.baseUrl || !body.token) throw new HttpError(400, 'URL and token are required')
  const base = normalizeBase(body.baseUrl)
  const token = body.token.trim()
  const label = (body.label?.trim() || new URL(base).host).slice(0, 40)
  const me = await get<{ login?: string; username?: string }>(user, `${base}/api/v1/user`, { Authorization: `token ${token}` }, label).catch((e: Error) => {
    throw new HttpError(400, e.message)
  })
  const username = me?.login ?? me?.username
  if (!username) throw new HttpError(400, `${base} does not look like a Gitea or Forgejo instance`)
  requirePrivateRequest(user)
  const db = database()
  const existing = db.prepare('SELECT id FROM forges WHERE user_id = ? AND base_url = ?').get(user.id, base) as { id: number } | undefined
  if (existing) {
    db.prepare('UPDATE forges SET label = ?, username = ?, token = ? WHERE id = ?').run(label, username, encrypt(token), existing.id)
    return { id: existing.id, label, baseUrl: base, username }
  }
  const r = db.prepare('INSERT INTO forges (user_id, label, base_url, username, token, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, label, base, username, encrypt(token), Date.now())
  return { id: Number(r.lastInsertRowid), label, baseUrl: base, username }
}

export function removeForge(user: User, id: number) {
  database().prepare('DELETE FROM forges WHERE user_id = ? AND id = ?').run(user.id, id)
}
