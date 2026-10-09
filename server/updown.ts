import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError } from './http.ts'

// updown.io, for the Status widget: the owner's uptime checks with their state, uptime, response
// time and certificate expiry. Uses updown's read-only API key (it can't change anything):
// UPDOWN_API_KEY from the server's environment, or one saved in Settings (stored encrypted like the
// other tokens, and used first). Answers are cached for a minute.

const API = 'https://updown.io/api'
const NAME = 'updown'

export type UpdownCheck = {
  token: string
  name: string
  url: string
  down: boolean
  enabled: boolean
  error: string | null
  downSince: string | null
  /** Percent, over updown's default window (the last 30 days) */
  uptime: number | null
  /** Milliseconds, the last 24 hours' average; null when updown has no metrics yet */
  responseTime: number | null
  lastCheckAt: string | null
  sslExpiresAt: string | null
  sslValid: boolean | null
}

type ApiCheck = {
  token: string
  url: string
  alias?: string | null
  down: boolean
  enabled: boolean
  error?: string | null
  down_since?: string | null
  uptime?: number | null
  last_check_at?: string | null
  ssl?: { expires_at?: string | null; valid?: boolean | null } | null
}
type ApiMetrics = { timings?: { total?: number } }

async function get<T>(path: string, key: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${API}${path}${sep}api-key=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }).catch(() => null)
  if (!res) throw new HttpError(502, 'updown.io did not answer')
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'updown.io refused that API key')
  if (!res.ok) throw new HttpError(502, `updown.io answered ${res.status}`)
  return (await res.json()) as T
}

function storedKey(user: User): string | null {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, NAME) as { secret: string } | undefined
  return row ? decrypt(row.secret) : process.env.UPDOWN_API_KEY?.trim() || null
}

/** Where the key comes from, for Settings: saved there, or the server's environment. */
export const updownSource = (user: User): 'settings' | 'server' | null =>
  database().prepare('SELECT 1 FROM integrations WHERE user_id = ? AND name = ?').get(user.id, NAME) ? 'settings' : process.env.UPDOWN_API_KEY?.trim() ? 'server' : null

/** Checks the key against updown.io, then stores it. */
export async function setUpdownKey(user: User, body: { key?: string }) {
  const key = body.key?.trim()
  if (!key) throw new HttpError(400, 'Paste your updown.io read-only API key')
  await get<ApiCheck[]>('/checks', key)
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user.id, NAME, encrypt(key), Date.now())
  cache.delete(user.id)
}

export function removeUpdownKey(user: User) {
  database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, NAME)
  cache.delete(user.id)
}

const cache = new Map<number, { at: number; value: Promise<UpdownCheck[]> }>()

export function updownChecks(user: User): Promise<UpdownCheck[]> {
  const hit = cache.get(user.id)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const key = storedKey(user)
  if (!key) return Promise.reject(new HttpError(409, 'No updown.io key yet'))
  const value = (async () => {
    const checks = await get<ApiCheck[]>('/checks', key)
    // Response times only come per check: the last 24 hours' average, fine for a handful of checks.
    const since = encodeURIComponent(new Date(Date.now() - 864e5).toISOString())
    const metrics = await Promise.all(checks.slice(0, 20).map((c) => get<ApiMetrics>(`/checks/${encodeURIComponent(c.token)}/metrics?from=${since}`, key).catch(() => null)))
    return checks.map<UpdownCheck>((c, i) => ({
      token: c.token,
      name: c.alias || c.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      url: c.url,
      down: c.down,
      enabled: c.enabled,
      error: c.error ?? null,
      downSince: c.down_since ?? null,
      uptime: c.uptime ?? null,
      responseTime: typeof metrics[i]?.timings?.total === 'number' ? Math.round(metrics[i]!.timings!.total!) : null,
      lastCheckAt: c.last_check_at ?? null,
      sslExpiresAt: c.ssl?.expires_at ?? null,
      sslValid: c.ssl?.valid ?? null,
    }))
  })()
  cache.set(user.id, { at: Date.now(), value })
  value.catch(() => cache.delete(user.id))
  return value
}
