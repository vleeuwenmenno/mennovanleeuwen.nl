import { randomUUID } from 'node:crypto'
import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError } from './http.ts'

// Seafile, for the Files app: one account, linked in Settings → Integrations. Signing in once
// with the username and password (and a 2FA code when the account has one) gets an API token,
// made as a device ("mennovanleeuwen.nl") so it shows up in Seafile's Devices and can be revoked
// there. Only the token is kept, encrypted like the other secrets; the password never is.
//
// Seahub's API sends no CORS headers, so the browser talks to it through here. Uploads and
// downloads go straight to Seafile's file server (it does send CORS headers): this side only
// hands out the short-lived links.
//
// The OnlyOffice document server Seafile uses can be added too (its URL and JWT secret), for
// editing Office files in a window.

const NAME = 'seafile'
const OFFICE = 'onlyoffice'
const DEVICE_NAME = 'mennovanleeuwen.nl'

type Link = { url: string; username: string; token: string; name: string | null; version: string | null }
type Office = { url: string; secret: string }

/** What Settings (and /api/me) shows: never the token or the secret. */
export type SeafileInfo = { url: string; username: string; name: string | null; version: string | null; office: { url: string } | null }

function read<T>(user: User, name: string): T | null {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, name) as { secret: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(decrypt(row.secret)) as T
  } catch {
    return null
  }
}

function write(user: User, name: string, value: unknown) {
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user.id, name, encrypt(JSON.stringify(value)), Date.now())
}

const remove = (user: User, name: string) => database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, name)

export function seafileInfo(user: User): SeafileInfo | null {
  const link = read<Link>(user, NAME)
  if (!link) return null
  const office = read<Office>(user, OFFICE)
  return { url: link.url, username: link.username, name: link.name, version: link.version, office: office ? { url: office.url } : null }
}

/** https://host or https://host/seafile (a sub-path install), without the trailing slash. */
function normalizeUrl(input: string | undefined, what: string): string {
  const raw = input?.trim() ?? ''
  if (!raw) throw new HttpError(400, `${what} URL is required`)
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new HttpError(400, `That ${what} URL does not look right`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, `${what} URL must be http(s)`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

async function call(base: string, path: string, init: RequestInit & { token?: string; timeout?: number } = {}): Promise<Response> {
  const { token, timeout = 15_000, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set('Accept', 'application/json')
  if (token) headers.set('Authorization', `Token ${token}`)
  const res = await fetch(`${base}${path}`, { ...rest, headers, redirect: 'manual', signal: AbortSignal.timeout(timeout) }).catch(() => null)
  if (!res) throw new HttpError(502, 'Seafile did not answer')
  return res
}

const errorOf = async (res: Response) => {
  const body = (await res.json().catch(() => null)) as { error_msg?: string; detail?: string; non_field_errors?: string[] } | null
  return body?.error_msg || body?.detail || body?.non_field_errors?.[0] || `Seafile answered ${res.status}`
}

/**
 * Signs in for a token. Answers { otp: true } when Seafile wants a 2FA code first: the form asks
 * for one and sends everything again with it.
 */
export async function linkSeafile(user: User, body: { url?: string; username?: string; password?: string; otp?: string }): Promise<SeafileInfo | { otp: true }> {
  const url = normalizeUrl(body.url, 'Seafile')
  const username = body.username?.trim()
  const password = body.password
  if (!username || !password) throw new HttpError(400, 'Username and password are required')

  const form = new URLSearchParams({ username, password, platform: 'web', device_id: randomUUID(), device_name: DEVICE_NAME, client_version: '', platform_version: '' })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (body.otp?.trim()) headers['X-SEAFILE-OTP'] = body.otp.trim()
  const res = await call(url, '/api2/auth-token/', { method: 'POST', headers, body: form })
  if (res.status >= 300 && res.status < 400) throw new HttpError(400, 'Seafile redirected: check the URL (https, and the sub-path if it has one)')
  if (res.headers.get('x-seafile-otp') === 'required') {
    if (body.otp?.trim()) throw new HttpError(400, 'That 2FA code did not work')
    return { otp: true }
  }
  if (!res.ok) {
    const message = await errorOf(res)
    throw new HttpError(400, res.status === 404 ? 'No Seafile there: check the URL' : res.status === 429 ? 'Seafile says too many tries: wait a minute' : message)
  }
  const token = ((await res.json().catch(() => null)) as { token?: string } | null)?.token
  if (!token) throw new HttpError(502, 'Seafile signed in but sent no token')

  const [account, server] = await Promise.all([
    call(url, '/api2/account-info/', { token }).then((r) => (r.ok ? (r.json() as Promise<{ name?: string; email?: string }>) : null)).catch(() => null),
    call(url, '/api2/server-info/').then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null)).catch(() => null),
  ])

  // Linking again (a new password, or another account): sign the old device out first.
  const old = read<Link>(user, NAME)
  if (old) await revoke(old)
  write(user, NAME, { url, username, token, name: account?.name || null, version: server?.version || null } satisfies Link)
  return seafileInfo(user)!
}

/** Signs this device out on Seafile (removing it from Devices), as far as Seafile lets it. */
async function revoke(link: Link) {
  await call(link.url, '/api2/logout-device/', { method: 'POST', token: link.token, timeout: 5000 }).catch(() => null)
}

export async function unlinkSeafile(user: User) {
  const link = read<Link>(user, NAME)
  if (link) await revoke(link)
  remove(user, NAME)
  remove(user, OFFICE)
}

/** The OnlyOffice document server Seafile uses: checked by loading its api.js, then stored. */
export async function setOffice(user: User, body: { url?: string; secret?: string }) {
  if (!read<Link>(user, NAME)) throw new HttpError(409, 'Link Seafile first')
  const url = normalizeUrl(body.url, 'OnlyOffice')
  const secret = body.secret?.trim()
  if (!secret) throw new HttpError(400, 'The JWT secret is required (Seafile has needed one since version 12)')
  const res = await fetch(`${url}/web-apps/apps/api/documents/api.js`, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!res) throw new HttpError(400, 'OnlyOffice did not answer at that URL')
  if (!res.ok) throw new HttpError(400, `No OnlyOffice there (api.js answered ${res.status})`)
  write(user, OFFICE, { url, secret } satisfies Office)
}

export const removeOffice = (user: User) => void remove(user, OFFICE)

// ---------------------------------------------------------------------------------------------
// The API, for the Files app

export type Library = { id: string; name: string; type: 'mine' | 'shared' | 'group' | 'public'; owner: string | null; encrypted: boolean; permission: 'r' | 'rw'; size: number; mtime: number }

function linked(user: User): Link {
  const link = read<Link>(user, NAME)
  if (!link) throw new HttpError(409, 'Seafile is not linked')
  return link
}

/** A JSON request to Seahub's API as the linked account. */
export async function seafile<T>(user: User, path: string, init: RequestInit = {}): Promise<T> {
  const link = linked(user)
  const res = await call(link.url, path, { ...init, token: link.token })
  if (res.status === 401 || res.status === 403) {
    const message = await errorOf(res)
    throw new HttpError(res.status === 401 ? 409 : 403, res.status === 401 ? 'Seafile no longer accepts the token: link it again in Settings' : message)
  }
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, await errorOf(res))
  return (await res.json()) as T
}

type ApiRepo = { repo_id: string; repo_name: string; type: string; owner_email?: string; owner_name?: string; encrypted: boolean; permission: string; size: number; last_modified: string }

export async function libraries(user: User): Promise<Library[]> {
  const { repos } = await seafile<{ repos: ApiRepo[] }>(user, '/api/v2.1/repos/?type=mine&type=shared&type=group&type=public')
  const seen = new Set<string>()
  return repos
    .filter((r) => !seen.has(r.repo_id) && seen.add(r.repo_id))
    .map((r) => ({
      id: r.repo_id,
      name: r.repo_name,
      type: (['mine', 'shared', 'group', 'public'].includes(r.type) ? r.type : 'shared') as Library['type'],
      owner: r.owner_name || r.owner_email || null,
      encrypted: !!r.encrypted,
      permission: r.permission === 'rw' ? 'rw' : 'r',
      size: r.size ?? 0,
      mtime: Date.parse(r.last_modified) || 0,
    }))
}
