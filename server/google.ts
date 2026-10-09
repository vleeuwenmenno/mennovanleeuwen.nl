import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import type { EventInput } from './calendars.ts'
import { database, decrypt, encrypt } from './db.ts'
import { cookies, HttpError, publicOrigin, redirect, setCookie } from './http.ts'

// Google Calendar, attached to the signed-in (GitHub) owner: their calendars, shared ones
// included, for the Agenda widget, the clock and the Calendar app, which can also add, change and
// delete events (and invite people) where Google allows it. Not a way to sign in. Google's refresh
// token is stored encrypted and swapped for short-lived access tokens as needed.
//
// Accounts connected before editing existed only granted calendar.readonly: they keep working
// read-only until connected again (`canWrite` says which).
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud OAuth client (web
// application) whose redirect URI is <site>/api/google/callback, with the Calendar API enabled.

const STATE_COOKIE = 'mvlos_google'
const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const SCOPES = `openid email https://www.googleapis.com/auth/calendar.readonly ${WRITE_SCOPE}`

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)

type GoogleRow = { email: string; refresh_token: string; access_token: string | null; expires_at: number }

export function googleAccount(user: User): { email: string; canWrite: boolean } | null {
  if (!googleEnabled()) return null
  const row = database().prepare('SELECT email, scopes FROM google WHERE user_id = ?').get(user.id) as { email: string; scopes: string | null } | undefined
  return row ? { email: row.email, canWrite: !!row.scopes?.split(' ').includes(WRITE_SCOPE) } : null
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
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; id_token?: string; scope?: string; error?: string }
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
      `INSERT INTO google (user_id, email, refresh_token, access_token, expires_at, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at, scopes = excluded.scopes`,
    )
    .run(user.id, email, encrypt(tokens.refresh_token), encrypt(tokens.access_token!), Date.now() + (tokens.expires_in ?? 3600) * 1000, tokens.scope ?? '', Date.now())
  clearGoogleCache(user)
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

async function calendarApi<T>(user: User, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await accessToken(user)
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!res) throw new HttpError(502, 'Google Calendar did not answer')
  if (res.status === 401) throw new HttpError(409, 'Google access was revoked; connect again')
  if (res.status === 403 && init.method && init.method !== 'GET') {
    const reason = ((await res.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null)?.error?.errors?.[0]?.reason
    throw new HttpError(403, reason === 'insufficientPermissions' ? 'Google only allowed reading: connect Google Calendar again (Settings → Calendar) to edit' : 'Google refused: you cannot change this calendar')
  }
  if (res.status === 404 || res.status === 410) throw new HttpError(404, 'That event is gone from Google Calendar')
  if (!res.ok) throw new HttpError(502, `Google Calendar answered ${res.status}`)
  return (res.status === 204 ? null : await res.json()) as T
}

export type CalendarInfo = { id: string; name: string; color: string; primary: boolean; selected: boolean; writable: boolean }
export type Attendee = { email: string; name?: string; status?: 'accepted' | 'declined' | 'tentative' | 'needs-action'; organizer?: boolean; self?: boolean }
export type CalendarEvent = {
  id: string
  /** The calendar's id ("caldav:..." for CalDAV) and name. */
  calendarId: string
  calendar: string
  color: string
  title: string
  /** ISO times, or "YYYY-MM-DD" dates for all-day events (end exclusive). */
  start: string
  end: string
  allDay: boolean
  location?: string
  description?: string
  url?: string
  meet?: string
  attendees?: Attendee[]
  /** One occurrence of a repeating event. */
  recurring?: boolean
  /** Can be changed from here. */
  editable?: boolean
  /** What the server needs to change or delete it (opaque to the browser). */
  ref?: string
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>()
/** After a change: the next read asks Google again. */
export const clearGoogleCache = (user: User) => {
  for (const k of cache.keys()) if (k.startsWith(`${user.id}|`)) cache.delete(k)
}
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
    const d = await calendarApi<{ items: { id: string; summary: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; selected?: boolean; accessRole?: string }[] }>(user, '/users/me/calendarList?minAccessRole=reader')
    const canWrite = !!googleAccount(user)?.canWrite
    return d.items.map((c) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary,
      color: c.backgroundColor ?? '#7aa2f7',
      primary: !!c.primary,
      selected: c.selected !== false,
      writable: canWrite && (c.accessRole === 'owner' || c.accessRole === 'writer'),
    }))
  })
}

type GoogleTime = { date?: string; dateTime?: string; timeZone?: string }
type GooglePerson = { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean; self?: boolean }
type GoogleEvent = {
  id: string
  status?: string
  summary?: string
  description?: string
  start: GoogleTime
  end: GoogleTime
  originalStartTime?: GoogleTime
  recurringEventId?: string
  location?: string
  htmlLink?: string
  hangoutLink?: string
  attendees?: GooglePerson[]
}

const STATUS: Record<string, Attendee['status']> = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', needsAction: 'needs-action' }

/** What the server needs to find a Google event again: its calendar, the event (or occurrence) and its series. */
export type GoogleRef = { k: 'g'; c: string; e: string; m?: string }

/** Up to this many days of events in one go (the Calendar app's year view). */
export const MAX_RANGE_DAYS = 400

/**
 * Events between `range.from` and `range.to` (at most MAX_RANGE_DAYS apart), from the given
 * calendars (default: the ones shown in Google Calendar).
 */
export async function listEvents(user: User, ids: string[] | null, range: { from: Date; to: Date }, ref: (r: GoogleRef) => string): Promise<CalendarEvent[]> {
  const calendars = await listCalendars(user)
  const pick = ids?.length ? calendars.filter((c) => ids.includes(c.id)) : calendars.filter((c) => c.selected)
  const from = range.from
  const to = new Date(Math.min(range.to.getTime(), from.getTime() + MAX_RANGE_DAYS * 864e5))
  if (!(to > from)) throw new HttpError(400, 'Bad date range')
  const lists = await Promise.all(
    pick.map((cal) =>
      cached(`${user.id}|events|${cal.id}|${from.toISOString()}|${to.toISOString()}`, 2 * 60_000, async () => {
        const items: GoogleEvent[] = []
        let page: string | undefined
        // A page holds up to 2500; a busy calendar over a year can need a few.
        for (let i = 0; i < 4; i++) {
          const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' })
          if (page) params.set('pageToken', page)
          const d = await calendarApi<{ items: GoogleEvent[]; nextPageToken?: string }>(user, `/calendars/${encodeURIComponent(cal.id)}/events?${params}`)
          items.push(...d.items)
          page = d.nextPageToken
          if (!page) break
        }
        return items
          .filter((e) => e.status !== 'cancelled')
          .map<CalendarEvent>((e) => ({
            id: `${cal.id}|${e.id}`,
            calendarId: cal.id,
            calendar: cal.name,
            color: cal.color,
            title: e.summary || '(No title)',
            start: e.start.dateTime ?? e.start.date ?? '',
            end: e.end.dateTime ?? e.end.date ?? '',
            allDay: !e.start.dateTime,
            location: e.location,
            description: e.description,
            url: e.htmlLink,
            meet: e.hangoutLink,
            attendees: e.attendees
              ?.filter((a) => a.email)
              .map((a) => ({ email: a.email!, name: a.displayName, status: STATUS[a.responseStatus ?? ''], organizer: a.organizer || undefined, self: a.self || undefined })),
            recurring: !!e.recurringEventId || undefined,
            editable: cal.writable,
            ref: ref({ k: 'g', c: cal.id, e: e.id, m: e.recurringEventId }),
          }))
      }).catch(() => [] as CalendarEvent[]),
    ),
  )
  return lists.flat().sort((a, b) => a.start.localeCompare(b.start) || Number(b.allDay) - Number(a.allDay))
}

// ---------------------------------------------------------------------------------------------
// Changes. Invitations go out by email (sendUpdates=all) whenever there are other people on it.

const time = (value: string, allDay: boolean, timeZone?: string): GoogleTime => (allDay ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) })

/** Google's body for the fields given; attendees keep the answers they already gave. */
function googleBody(input: Partial<EventInput>, existing?: GoogleEvent) {
  const body: Record<string, unknown> = {}
  if (input.title !== undefined) body.summary = input.title
  if (input.location !== undefined) body.location = input.location
  if (input.description !== undefined) body.description = input.description
  if (input.start !== undefined && input.end !== undefined && input.allDay !== undefined) {
    body.start = time(input.start, input.allDay, input.timeZone)
    body.end = time(input.end, input.allDay, input.timeZone)
  }
  if (input.attendees !== undefined) {
    const known = new Map((existing?.attendees ?? []).filter((a) => a.email).map((a) => [a.email!.toLowerCase(), a]))
    // Yourself (the organizer) stays on the list; Google adds you back anyway.
    const self = (existing?.attendees ?? []).filter((a) => a.self || a.organizer)
    const listed = input.attendees.map((email) => known.get(email.toLowerCase()) ?? { email })
    body.attendees = [...self.filter((a) => !listed.some((l) => l.email?.toLowerCase() === a.email?.toLowerCase())), ...listed]
  }
  return body
}

const eventPath = (calendar: string, event: string) => `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(event)}`

export async function createGoogleEvent(user: User, calendar: string, input: EventInput) {
  await calendarApi(user, `/calendars/${encodeURIComponent(calendar)}/events?sendUpdates=all`, { method: 'POST', body: googleBody(input) })
  clearGoogleCache(user)
}

/** Shifts a Google start or end by `ms`, keeping its kind (date or date-time) and time zone. */
function shift(t: GoogleTime, ms: number): GoogleTime {
  if (t.date) return { date: new Date(Date.parse(`${t.date}T00:00:00Z`) + Math.round(ms / 864e5) * 864e5).toISOString().slice(0, 10) }
  return { dateTime: new Date(Date.parse(t.dateTime!) + ms).toISOString(), ...(t.timeZone ? { timeZone: t.timeZone } : {}) }
}

/**
 * Changes an event. For one occurrence of a repeating event, `all` changes the whole series:
 * a new time moves every occurrence by as much as this one moved.
 */
export async function updateGoogleEvent(user: User, ref: GoogleRef, input: Partial<EventInput>, all: boolean) {
  const series = all && ref.m
  const id = series ? ref.m! : ref.e
  const existing = await calendarApi<GoogleEvent>(user, eventPath(ref.c, id))
  const body = googleBody(input, existing)
  if (series && body.start) {
    const occurrence = await calendarApi<GoogleEvent>(user, eventPath(ref.c, ref.e))
    if (!!input.allDay !== !existing.start.dateTime) throw new HttpError(400, 'Switch all day for one occurrence at a time, or for the series in Google Calendar')
    const was = Date.parse(occurrence.originalStartTime?.dateTime ?? occurrence.originalStartTime?.date ?? occurrence.start.dateTime ?? occurrence.start.date ?? '')
    const moved = Date.parse(input.start!) - was
    const length = Date.parse(input.end!) - Date.parse(input.start!)
    const start = shift(existing.start, moved)
    body.start = start
    body.end = shift(start, length)
  }
  await calendarApi(user, `${eventPath(ref.c, id)}?sendUpdates=all`, { method: 'PATCH', body })
  clearGoogleCache(user)
}

export async function moveGoogleEvent(user: User, ref: GoogleRef, destination: string) {
  await calendarApi(user, `${eventPath(ref.c, ref.e)}/move?destination=${encodeURIComponent(destination)}&sendUpdates=all`, { method: 'POST' })
  clearGoogleCache(user)
}

/** Deletes an event, one occurrence of a series, or (`all`) the whole series. */
export async function deleteGoogleEvent(user: User, ref: GoogleRef, all: boolean) {
  await calendarApi(user, `${eventPath(ref.c, all && ref.m ? ref.m : ref.e)}?sendUpdates=all`, { method: 'DELETE' })
  clearGoogleCache(user)
}
