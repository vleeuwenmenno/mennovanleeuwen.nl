import type { User } from './auth.ts'
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
}

export type ForgeInfo = { id: number; label: string; baseUrl: string; username: string }

const TIMEOUT = 8000

async function get<T>(url: string, headers: Record<string, string>, label: string): Promise<T | null> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'mvlos', ...headers }, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => {
    throw new HttpError(502, `${label} did not answer`)
  })
  if (res.status === 404) return null
  if (res.status === 401) throw new HttpError(502, `${label} rejected the token`)
  if (res.status === 403 || res.status === 429) throw new HttpError(502, `${label} rate limit or permission error`)
  if (!res.ok) throw new HttpError(502, `${label} answered ${res.status}`)
  return (await res.json()) as T
}

export function githubSource(user: User): Source {
  return {
    id: 'github',
    label: 'GitHub',
    kind: 'github',
    web: 'https://github.com',
    login: user.login,
    api: (path) => get(`https://api.github.com${path}`, { Authorization: `Bearer ${user.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, 'GitHub'),
  }
}

function giteaSource(id: number, label: string, base: string, username: string, token: string): Source {
  return { id: `forge:${id}`, label, kind: 'gitea', web: base, login: username, api: (path) => get(`${base}/api/v1${path}`, { Authorization: `token ${token}` }, label) }
}

type ForgeRow = { id: number; label: string; base_url: string; username: string; token: string }

export function listForges(user: User): ForgeInfo[] {
  const rows = database().prepare('SELECT id, label, base_url, username FROM forges WHERE user_id = ? ORDER BY id').all(user.id) as unknown as ForgeRow[]
  return rows.map((r) => ({ id: r.id, label: r.label, baseUrl: r.base_url, username: r.username }))
}

export function sources(user: User): Source[] {
  const rows = database().prepare('SELECT id, label, base_url, username, token FROM forges WHERE user_id = ? ORDER BY id').all(user.id) as unknown as ForgeRow[]
  return [githubSource(user), ...rows.map((r) => giteaSource(r.id, r.label, r.base_url, r.username, decrypt(r.token)))]
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
  const me = await get<{ login?: string; username?: string }>(`${base}/api/v1/user`, { Authorization: `token ${token}` }, label).catch((e: Error) => {
    throw new HttpError(400, e.message)
  })
  const username = me?.login ?? me?.username
  if (!username) throw new HttpError(400, `${base} does not look like a Gitea or Forgejo instance`)
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
