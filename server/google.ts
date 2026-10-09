import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { cookies, HttpError, publicOrigin, redirect, setCookie } from './http.ts'

// Google Calendar, attached to the signed-in (GitHub) owner: read-only access to their calendars,
// shared ones included, for the Agenda widget. Not a way to sign in. Google's refresh token is
// stored encrypted and swapped for short-lived access tokens as needed.
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud OAuth client (web
// application) whose redirect URI is <site>/api/google/callback, with the Calendar API enabled.

const STATE_COOKIE = 'mvlos_google'
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.readonly'

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)

type GoogleRow = { email: string; refresh_token: string; access_token: string | null; expires_at: number }

export function googleAccount(user: User): { email: string } | null {
  if (!googleEnabled()) return null
  const row = database().prepare('SELECT email FROM google WHERE user_id = ?').get(user.id) as { email: string } | undefined
  return row ? { email: row.email } : null
}

const callbackUrl = (req: IncomingMessage) => `${publicOrigin(req)}/api/google/callback`

export function startGoogle(req: IncomingMessage, res: ServerResponse) {
  if (!googleEnabled()) return redirect(res, '/?google=off')
  const state = randomBytes(16).toString('base64url')
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    scope: SCOPES,
    // A refresh token, every time (Google only hands one out on consent).
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, { 'Set-Cookie': setCookie(req, STATE_COOKIE, state, { maxAge: 600, path: '/api/google' }) })
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...body }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!res) throw new HttpError(502, 'Google did not answer')
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; id_token?: string; error?: string }
  if (!res.ok || !data.access_token) throw new HttpError(502, data.error === 'invalid_grant' ? 'Google access was revoked; connect again' : 'Google refused the token request')
  return data
}

export async function finishGoogle(req: IncomingMessage, res: ServerResponse, url: URL, user: User | null) {
  const clear = setCookie(req, STATE_COOKIE, '', { maxAge: 0, path: '/api/google' })
  const fail = (reason: string) => redirect(res, `/?google=${reason}`, { 'Set-Cookie': clear })
  if (!user) return fail('signin')
  if (!googleEnabled()) return fail('off')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (url.searchParams.get('error')) return fail('denied')
  if (!code || !state || state !== cookies(req)[STATE_COOKIE]) return fail('error')
  let tokens
  try {
    tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: callbackUrl(req) })
  } catch {
    return fail('error')
  }
  if (!tokens.refresh_token) return fail('error')
  // The ID token came straight from Google over TLS in this exchange; only its email is used.
  let email = 'Google account'
  try {
    email = JSON.parse(Buffer.from(tokens.id_token!.split('.')[1], 'base64url').toString('utf8')).email ?? email
  } catch {
    /* keep the placeholder */
  }
  database()
    .prepare(
      `INSERT INTO google (user_id, email, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at`,
    )
    .run(user.id, email, encrypt(tokens.refresh_token), encrypt(tokens.access_token!), Date.now() + (tokens.expires_in ?? 3600) * 1000, Date.now())
  redirect(res, '/?google=ok', { 'Set-Cookie': clear })
}

export async function disconnectGoogle(user: User) {
  const row = database().prepare('SELECT refresh_token FROM google WHERE user_id = ?').get(user.id) as { refresh_token: string } | undefined
  database().prepare('DELETE FROM google WHERE user_id = ?').run(user.id)
  if (row)
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(row.refresh_token))}`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {})
}

/** A valid access token, refreshed when it is about to expire. */
const refreshing = new Map<number, Promise<string>>()
async function accessToken(user: User): Promise<string> {
  const row = database().prepare('SELECT email, refresh_token, access_token, expires_at FROM google WHERE user_id = ?').get(user.id) as GoogleRow | undefined
  if (!row) throw new HttpError(409, 'Google Calendar is not connected')
  if (row.access_token && row.expires_at > Date.now() + 60_000) return decrypt(row.access_token)
  // One refresh at a time per user, however many requests ask at once.
  const pending = refreshing.get(user.id)
  if (pending) return pending
  const p = tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token) })
    .then((t) => {
      database().prepare('UPDATE google SET access_token = ?, expires_at = ? WHERE user_id = ?').run(encrypt(t.access_token!), Date.now() + (t.expires_in ?? 3600) * 1000, user.id)
      return t.access_token!
    })
    .finally(() => refreshing.delete(user.id))
  refreshing.set(user.id, p)
  return p
}

async function calendarApi<T>(user: User, path: string): Promise<T> {
  const token = await accessToken(user)
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!res) throw new HttpError(502, 'Google Calendar did not answer')
  if (res.status === 401) throw new HttpError(409, 'Google access was revoked; connect again')
  if (!res.ok) throw new HttpError(502, `Google Calendar answered ${res.status}`)
  return (await res.json()) as T
}

export type CalendarInfo = { id: string; name: string; color: string; primary: boolean; selected: boolean }
export type CalendarEvent = { id: string; calendar: string; color: string; title: string; start: string; end: string; allDay: boolean; location?: string; url?: string; meet?: string }

const cache = new Map<string, { at: number; value: Promise<unknown> }>()
function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as Promise<T>
  const value = load()
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}

/** The calendars in the account's list, shared ones included. */
export function listCalendars(user: User): Promise<CalendarInfo[]> {
  return cached(`${user.id}|calendars`, 5 * 60_000, async () => {
    const d = await calendarApi<{ items: { id: string; summary: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; selected?: boolean }[] }>(user, '/users/me/calendarList?minAccessRole=reader')
    return d.items.map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary, color: c.backgroundColor ?? '#7aa2f7', primary: !!c.primary, selected: c.selected !== false }))
  })
}

/**
 * Events between `range.from` and `range.to` (at most 45 days apart), from the given calendars
 * (default: the ones shown in Google Calendar).
 */
export async function listEvents(user: User, ids: string[] | null, range: { from: Date; to: Date }): Promise<CalendarEvent[]> {
  const calendars = await listCalendars(user)
  const pick = ids?.length ? calendars.filter((c) => ids.includes(c.id)) : calendars.filter((c) => c.selected)
  const from = range.from
  const to = new Date(Math.min(range.to.getTime(), from.getTime() + 45 * 864e5))
  if (!(to > from)) throw new HttpError(400, 'Bad date range')
  const lists = await Promise.all(
    pick.map((cal) =>
      cached(`${user.id}|events|${cal.id}|${from.toISOString()}|${to.toISOString()}`, 2 * 60_000, async () => {
        const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' })
        type Item = { id: string; status?: string; summary?: string; start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string }; location?: string; htmlLink?: string; hangoutLink?: string }
        const d = await calendarApi<{ items: Item[] }>(user, `/calendars/${encodeURIComponent(cal.id)}/events?${params}`)
        return d.items
          .filter((e) => e.status !== 'cancelled')
          .map<CalendarEvent>((e) => ({
            id: `${cal.id}|${e.id}`,
            calendar: cal.name,
            color: cal.color,
            title: e.summary || '(No title)',
            start: e.start.dateTime ?? e.start.date ?? '',
            end: e.end.dateTime ?? e.end.date ?? '',
            allDay: !e.start.dateTime,
            location: e.location,
            url: e.htmlLink,
            meet: e.hangoutLink,
          }))
      }).catch(() => [] as CalendarEvent[]),
    ),
  )
  return lists.flat().sort((a, b) => a.start.localeCompare(b.start) || Number(b.allDay) - Number(a.allDay))
}
