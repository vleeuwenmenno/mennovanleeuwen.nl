import { sharedProviderJob } from './privateRequest.ts'
import { privateFetch as fetch } from './privateRequest.ts'
import { requirePrivateRequest, privateRequestAuthority, withoutPrivateRequest, privateSignal, bindPrivateAccess } from './privateRequest.ts'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { currentUser, sessionBinding, sessionKey, type User } from './auth.ts'
import type { EventInput } from './calendars.ts'
import { database, decrypt, encrypt, onUserGone } from './db.ts'
import { cookies, HttpError, publicOrigin, redirect, setCookie } from './http.ts'

// Google Calendar, attached to the signed-in (GitHub) user: their calendars, shared ones
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

// Where Google's APIs are: GOOGLE_API_URL, GOOGLE_TOKEN_URL and GOOGLE_STATE_TTL_MS point them at a stand-in for
// the checks (scripts/pim-check.ts); nothing else sets them.
const CALENDAR_API = process.env.GOOGLE_API_URL || 'https://www.googleapis.com/calendar/v3'
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)

type GoogleRow = { email: string; refresh_token: string; access_token: string | null; expires_at: number }

export function googleAccount(user: User): { email: string; canWrite: boolean } | null {
  if (!googleEnabled()) return null
  const row = database().prepare('SELECT email, scopes FROM google WHERE user_id = ?').get(user.id) as { email: string; scopes: string | null } | undefined
  return row ? { email: row.email, canWrite: !!row.scopes?.split(' ').includes(WRITE_SCOPE) } : null
}

/** How long the consent screen may take before the sealed state is refused. */
const STATE_TTL = Number(process.env.GOOGLE_STATE_TTL_MS) || 10 * 60_000
/** At most this many consents wait at once; the oldest give way (this service runs as one process). */
const MAX_PENDING = 1000

/**
 * Consents started and not yet finished, by their random state, with when each lapses. The callback
 * takes its state out of here before anything else, so a state works once: a copied sealed cookie
 * replayed afterwards, or after a refused attempt, finds nothing. A restart forgets them (the user
 * connects again).
 */
const pending = new Map<string, number>()

function registerPending(state: string) {
  const now = Date.now()
  for (const [k, e] of pending) {
    if (e > now && pending.size < MAX_PENDING) break
    pending.delete(k)
  }
  pending.set(state, now + STATE_TTL)
}

/** Takes the state out of the registry; whether it was there and still valid. */
function consumePending(state: string): boolean {
  const expires = pending.get(state)
  pending.delete(state)
  return expires !== undefined && expires > Date.now()
}

/**
 * The pending consent, sealed (AES-GCM, so it cannot be read or altered) into the state cookie: its
 * random state, the account and the session that started it, and when it lapses. The callback only
 * honours it for that same account and session, so consent started as one account can never be
 * stored under another one signed in meanwhile (or after a sign-out and sign-in).
 */
function sealState(state: string, user: User, session: string): string {
  return encrypt(JSON.stringify({ n: state, u: user.id, s: session, e: Date.now() + STATE_TTL }))
}

function openState(sealed: string | undefined, state: string, user: User, session: string | null): boolean {
  if (!sealed || !session) return false
  try {
    const p = JSON.parse(decrypt(sealed)) as { n?: unknown; u?: unknown; s?: unknown; e?: unknown }
    return p.n === state && p.u === user.id && p.s === session && typeof p.e === 'number' && p.e > Date.now()
  } catch {
    return false
  }
}

const callbackUrl = (req: IncomingMessage) => `${publicOrigin(req)}/api/google/callback`

export function startGoogle(req: IncomingMessage, res: ServerResponse) {
  if (!googleEnabled()) return redirect(res, '/?google=off')
  const user = currentUser(req)
  const session = sessionKey(req)
  if (!user || !session) return redirect(res, '/?google=signin')
  const state = randomBytes(16).toString('base64url')
  registerPending(state)
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
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, { 'Set-Cookie': setCookie(req, STATE_COOKIE, sealState(state, user, session), { maxAge: 600, path: '/api/google' }) })
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...body }),
    signal: privateSignal(AbortSignal.timeout(10_000)),
  }).catch(() => null)
  if (!res) throw new HttpError(502, 'Google did not answer')
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; id_token?: string; scope?: string; error?: string }
  if (!res.ok || !data.access_token) throw new HttpError(502, data.error === 'invalid_grant' ? 'Google access was revoked; connect again' : 'Google refused the token request')
  return data
}

export async function finishGoogle(req: IncomingMessage, res: ServerResponse, url: URL, user: User | null) {
  const clear = setCookie(req, STATE_COOKIE, '', { maxAge: 0, path: '/api/google' })
  const fail = (reason: string) => redirect(res, `/?google=${reason}`, { 'Set-Cookie': clear })
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  // Consumed first, whatever the outcome below: a refused attempt cannot be retried later.
  const live = state ? consumePending(state) : false
  if (!user) return fail('signin')
  if (!googleEnabled()) return fail('off')
  if (url.searchParams.get('error')) return fail('denied')
  if (!code || !state || !live || !openState(cookies(req)[STATE_COOKIE], state, user, sessionKey(req))) return fail('error')
  const generation = generationOf(user.id)
  let tokens
  try {
    tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: callbackUrl(req) })
  } catch {
    return fail('error')
  }
  if (!tokens.refresh_token) return fail('error')
  // Google took a while to answer: the session that started this must still be this account's live one
  // (not signed out, expired or banned) and the account's Google link must not have changed meanwhile.
  // Otherwise nothing is stored.
  if (sessionBinding(req)?.userId !== user.id || generationOf(user.id) !== generation) return fail('signin')
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
  // A new link: refreshes of the previous one that are still waiting on Google are dropped.
  bump(user.id)
  clearGoogleCache(user)
  redirect(res, '/?google=ok', { 'Set-Cookie': clear })
}

export async function disconnectGoogle(user: User) {
  bump(user.id)
  const row = database().prepare('SELECT refresh_token FROM google WHERE user_id = ?').get(user.id) as { refresh_token: string } | undefined
  database().prepare('DELETE FROM google WHERE user_id = ?').run(user.id)
  if (row)
    await fetch(`${process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke'}?token=${encodeURIComponent(decrypt(row.refresh_token))}`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {})
}

/**
 * The generation of an account's Google link. It moves on every new link, disconnect and account
 * removal, so work that began under an older link (a refresh waiting on Google, a consent exchange)
 * can neither be stored nor handed to a caller. The row is also only updated where its refresh token
 * is still the one the refresh started from, so even a missed bump cannot let an old result land on
 * a newer link.
 */
const linkChanges = new Set<(id: number) => void>()
export function onGoogleLinkChanged(fn: (id: number) => void) {
  linkChanges.add(fn)
  return () => { linkChanges.delete(fn) }
}
export function bindGoogleRequest(user: User) {
  const generation = googleLinkGeneration(user)
  if (generation === null) return
  bindPrivateAccess(() => sameLink(user, generation), (end) => onGoogleLinkChanged((id) => { if (id === user.id) end() }))
}
const generations = new Map<number, number>()
const generationOf = (id: number) => generations.get(id) ?? 0
/** Includes disconnected links, for caches that must detect every link mutation. */
export const googleLinkVersion = (user: User): number => generationOf(user.id)
function bump(id: number) {
  generations.set(id, generationOf(id) + 1)
  for (const fn of linkChanges) fn(id)
  refreshing.delete(id)
  // Reads started under the old link are no longer shared with, or served to, anyone.
  clearGoogleCache({ id } as User)
}

/** Something that began under an earlier link of this account (before a relink, disconnect or removal). */
class StaleLink extends HttpError {
  constructor() {
    super(409, 'Google Calendar was reconnected or disconnected meanwhile: try again')
  }
}
/**
 * For a read that combines Google with other sources (server/calendars.ts, server/noteLinks.ts, the
 * Agents app's note tools): the Google snapshot, taken before the read's first await: the generation
 * of the account's Google link, or null when none is connected. The read uses the snapshot for all
 * of it. Null means Google takes no part, whatever is connected by the time a later step runs (a link
 * made meanwhile shows up in the next read); a number means every Google call is made under exactly
 * that generation and nothing of Google outlives a change of it. `assertGoogleLink` is called after every source has answered, just
 * before the combined result is returned, and throws if the link changed, was removed or the
 * account was deleted meanwhile, so the whole result is dropped, completed Google parts included.
 */
export type GoogleSnapshot = number | null
export const googleLinkGeneration = (user: User): GoogleSnapshot => (googleAccount(user) ? generationOf(user.id) : null)
export function assertGoogleLink(user: User, generation: number | null) {
  if (generation !== null) sameLink(user, generation)
}

/** For `.catch`: a failed call is treated as no answer, but a changed link still fails the whole read. */
const keepStale = (e: unknown) => {
  if (e instanceof StaleLink) throw e
  return null
}
/** Throws when the account's Google link is no longer the one `generation` was read from. */
function sameLink(user: User, generation: number) {
  if (generationOf(user.id) !== generation) throw new StaleLink()
}

/** A valid access token, refreshed when it is about to expire. */
const refreshing = new Map<number, { generation: number; job: ReturnType<typeof sharedProviderJob<string>> }>()
async function accessToken(user: User): Promise<string> {
  const row = database().prepare('SELECT email, refresh_token, access_token, expires_at FROM google WHERE user_id = ?').get(user.id) as GoogleRow | undefined
  if (!row) throw new HttpError(409, 'Google Calendar is not connected')
  if (row.access_token && row.expires_at > Date.now() + 60_000) return decrypt(row.access_token)
  // One refresh at a time per link of a user, however many requests ask at once.
  const generation = generationOf(user.id)
  const pending = refreshing.get(user.id)
  if (pending && pending.generation === generation && !pending.job.signal.aborted) return pending.job.join()
  const stale = () => new StaleLink()
  const check = () => {
    if (generationOf(user.id) !== generation || !database().prepare('SELECT 1 FROM users WHERE id=? AND banned_at IS NULL').get(user.id)) throw stale()
  }
  const job = sharedProviderJob(check, (end) => onGoogleLinkChanged((id) => { if (id === user.id) end() }), async () => {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token) })
    check()
    const done = database().prepare('UPDATE google SET access_token = ?, expires_at = ? WHERE user_id = ? AND refresh_token = ?').run(encrypt(t.access_token!), Date.now() + (t.expires_in ?? 3600) * 1000, user.id, row.refresh_token)
    if (!Number(done.changes)) throw stale()
    return t.access_token!
  })
  void job.value.finally(() => { if (refreshing.get(user.id)?.job === job) refreshing.delete(user.id) }).catch(() => {})
  refreshing.set(user.id, { generation, job })
  return job.join()
}

/**
 * One call to Google. `expected` is the link generation the caller's whole read started under; the
 * call is refused up front if it moved, and its answer is dropped, after every await (the headers,
 * the body), if it moves while Google is answering.
 */
async function calendarApi<T>(user: User, path: string, init: { method?: string; body?: unknown } = {}, expected?: number): Promise<T> {
  requirePrivateRequest(user)
  const generation = expected ?? generationOf(user.id)
  sameLink(user, generation)
  const token = await accessToken(user)
  sameLink(user, generation)
  requirePrivateRequest(user)
  const res = await fetch(`${CALENDAR_API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: privateSignal(AbortSignal.timeout(10_000)),
  }).catch(() => null)
  requirePrivateRequest(user)
  if (!res) throw new HttpError(502, 'Google Calendar did not answer')
  // Asked with an earlier link's token: its answer (another Google account's calendar) is dropped.
  const drop = async (): Promise<never> => {
    await res.body?.cancel().catch(() => {})
    throw new StaleLink()
  }
  if (generationOf(user.id) !== generation) return drop()
  if (res.status === 401) throw new HttpError(409, 'Google access was revoked; connect again')
  if (res.status === 403 && init.method && init.method !== 'GET') {
    const reason = ((await res.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null)?.error?.errors?.[0]?.reason
    sameLink(user, generation)
    throw new HttpError(403, reason === 'insufficientPermissions' ? 'Google only allowed reading: connect Google Calendar again (Settings → Integrations → Calendars) to edit' : 'Google refused: you cannot change this calendar')
  }
  if (res.status === 404 || res.status === 410) throw new HttpError(404, 'That event is gone from Google Calendar')
  if (!res.ok) throw new HttpError(502, `Google Calendar answered ${res.status}`)
  if (res.status === 204) return null as T
  const data = (await res.json()) as T
  // The body may have taken a while: check again before any of it leaves this function.
  sameLink(user, generation)
  return data
}

/** `access` is Google's own role: owner (yours), writer (shared with you to edit), reader (shared to look at). */
export type CalendarInfo = { id: string; name: string; color: string; primary: boolean; selected: boolean; writable: boolean; access?: 'owner' | 'writer' | 'reader' }
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
  /** Its iCalendar UID, the same in every calendar it is in (an invitation in Mail finds it by this). */
  uid?: string
  /** One occurrence of a repeating event: when it was meant to start (ISO time, or "YYYY-MM-DD"). */
  occurrence?: string
  /** Notes linked to it in MvL OS (its private backlinks, server/noteLinks.ts): their ids. */
  notes?: string[]
}

const cache = new Map<string, { at: number; value: Promise<unknown>; authority: object | undefined; settled: boolean }>()
/** After a change: the next read asks Google again. */
export const clearGoogleCache = (user: User) => {
  for (const k of cache.keys()) if (k.startsWith(`${user.id}|`)) cache.delete(k)
}
onUserGone((id) => {
  clearGoogleCache({ id } as User)
  bump(id)
})
function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms && (hit.settled || !hit.authority || hit.authority === privateRequestAuthority())) return hit.value as Promise<T>
  const value = load()
  // Only this call's own entry goes on failure: a newer one under the same key stays.
  const entry = { at: Date.now(), value, authority: privateRequestAuthority(), settled: false }
  cache.set(key, entry)
  value.then((data) => { entry.settled = true; entry.authority = undefined; entry.value = withoutPrivateRequest(() => Promise.resolve(data)) }, () => {
    if (cache.get(key) === entry) cache.delete(key)
  })
  return value
}

/** The calendars in the account's list, shared ones included. */
export function listCalendars(user: User, expected?: number): Promise<CalendarInfo[]> {
  return calendarsAt(user, expected ?? generationOf(user.id))
}
function calendarsAt(user: User, generation: number): Promise<CalendarInfo[]> {
  return cached(`${user.id}|calendars`, 5 * 60_000, async () => {
    const d = await calendarApi<{ items: { id: string; summary: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; selected?: boolean; accessRole?: string }[] }>(user, '/users/me/calendarList?minAccessRole=reader', {}, generation)
    const canWrite = !!googleAccount(user)?.canWrite
    return d.items.map((c) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary,
      color: c.backgroundColor ?? '#7aa2f7',
      primary: !!c.primary,
      selected: c.selected !== false,
      writable: canWrite && (c.accessRole === 'owner' || c.accessRole === 'writer'),
      access: c.accessRole === 'owner' || c.accessRole === 'writer' ? c.accessRole : 'reader',
    }))
  })
}

type GoogleTime = { date?: string; dateTime?: string; timeZone?: string }
type GooglePerson = { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean; self?: boolean }
type GoogleEvent = {
  id: string
  iCalUID?: string
  status?: string
  summary?: string
  description?: string
  start: GoogleTime
  end: GoogleTime
  originalStartTime?: GoogleTime
  recurringEventId?: string
  recurrence?: string[]
  location?: string
  htmlLink?: string
  hangoutLink?: string
  attendees?: GooglePerson[]
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> }
}

/** The private extended property that holds the ids of the notes linked to an event. */
const NOTES_KEY = 'mvlosNotes'
const notesOf = (e: GoogleEvent) => [...new Set((e.extendedProperties?.private?.[NOTES_KEY] ?? '').split(',').map((x) => x.trim()).filter(Boolean))]
/** When an occurrence was meant to start, as an ISO time or a date. */
const occurrenceOf = (e: GoogleEvent) => (!e.recurringEventId ? undefined : e.originalStartTime?.dateTime ? new Date(e.originalStartTime.dateTime).toISOString() : e.originalStartTime?.date)

const STATUS: Record<string, Attendee['status']> = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', needsAction: 'needs-action' }

/** What the server needs to find a Google event again: its calendar, the event (or occurrence) and its series. */
export type GoogleRef = { k: 'g'; c: string; e: string; m?: string }

/** Up to this many days of events in one go (the Calendar app's year view). */
export const MAX_RANGE_DAYS = 400

/**
 * Events between `range.from` and `range.to` (at most MAX_RANGE_DAYS apart), from the given
 * calendars (default: the ones shown in Google Calendar).
 */
export async function listEvents(user: User, ids: string[] | null, range: { from: Date; to: Date }, ref: (r: GoogleRef) => string, expected?: number): Promise<CalendarEvent[]> {
  // One link generation for the whole read: every call below is made under it, and the result is
  // only handed out if it is still the account's link, so nothing of an earlier link is mixed in.
  requirePrivateRequest(user)
  const generation = expected ?? generationOf(user.id)
  const calendars = await calendarsAt(user, generation)
  sameLink(user, generation)
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
          const d = await calendarApi<{ items: GoogleEvent[]; nextPageToken?: string }>(user, `/calendars/${encodeURIComponent(cal.id)}/events?${params}`, {}, generation)
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
            uid: e.iCalUID,
            ...(occurrenceOf(e) ? { occurrence: occurrenceOf(e) } : {}),
            ...(notesOf(e).length ? { notes: notesOf(e) } : {}),
          }))
      }).catch((e) => {
        // A calendar that fails is left out, but a changed link fails the whole read.
        if (e instanceof StaleLink) throw e
        return [] as CalendarEvent[]
      }),
    ),
  )
  sameLink(user, generation)
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
  // Only for new events (calendars.ts refuses it in a change). Google wants the time zone with a
  // repeating timed event, to know what "every Monday at 09:00" means across daylight saving.
  if (input.recurrence) body.recurrence = [`RRULE:${input.recurrence}`]
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

/** Makes an event; answers where it now lives. */
export async function createGoogleEvent(user: User, calendar: string, input: EventInput): Promise<GoogleRef> {
  // An imported event keeps its UID, which only Google's import call takes (and it invites nobody).
  const made = input.uid
    ? await calendarApi<GoogleEvent>(user, `/calendars/${encodeURIComponent(calendar)}/events/import`, { method: 'POST', body: { ...googleBody(input), iCalUID: input.uid } })
    : await calendarApi<GoogleEvent>(user, `/calendars/${encodeURIComponent(calendar)}/events?sendUpdates=all`, { method: 'POST', body: googleBody(input) })
  clearGoogleCache(user)
  return { k: 'g', c: calendar, e: made.id }
}

/** Which of these iCalendar UIDs a calendar already has (Google answers one UID at a time). */
export async function googleKnownUids(user: User, calendar: string, uids: string[]): Promise<string[]> {
  const generation = generationOf(user.id)
  const known: string[] = []
  const queue = uids.slice(0, 500)
  const worker = async () => {
    for (let uid = queue.shift(); uid; uid = queue.shift()) {
      const d = await calendarApi<{ items?: GoogleEvent[] }>(user, `/calendars/${encodeURIComponent(calendar)}/events?${new URLSearchParams({ iCalUID: uid, maxResults: '1' })}`, {}, generation).catch(keepStale)
      if (d?.items?.some((e) => e.status !== 'cancelled')) known.push(uid)
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker))
  sameLink(user, generation)
  return known
}

/** One event (or one occurrence of a series) as it is now, for the Agents app's changes. */
export async function getGoogleEvent(user: User, ref: GoogleRef): Promise<{ title: string; start: string; end: string; allDay: boolean; location?: string; description?: string; recurring: boolean; guests: number }> {
  const e = await calendarApi<GoogleEvent>(user, eventPath(ref.c, ref.e))
  if (e.status === 'cancelled') throw new HttpError(404, 'That event is gone from Google Calendar')
  return {
    title: e.summary || '(No title)',
    start: e.start.dateTime ?? e.start.date ?? '',
    end: e.end.dateTime ?? e.end.date ?? '',
    allDay: !e.start.dateTime,
    location: e.location,
    description: e.description,
    recurring: !!e.recurringEventId || !!e.recurrence?.length,
    guests: (e.attendees ?? []).filter((a) => a.email && !a.self && !a.organizer).length,
  }
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

// ---------------------------------------------------------------------------------------------
// Notes linked to events (server/noteLinks.ts): the notes' ids in a private extended property,
// which only this account's copy of the event has, changed with sendUpdates=none and nothing else
// in the body (the guests and everything else stay as they are, and nobody is mailed). For one
// occurrence it goes on that occurrence; for the series, on the series.

/** What a link needs from an event, and what a meeting note shows. */
export async function googleEventInfo(user: User, ref: GoogleRef) {
  const e = await calendarApi<GoogleEvent>(user, eventPath(ref.c, ref.e))
  if (e.status === 'cancelled') throw new HttpError(404, 'That event is gone from Google Calendar')
  return {
    uid: e.iCalUID ?? '',
    occurrence: occurrenceOf(e),
    recurring: !!e.recurringEventId || !!e.recurrence?.length,
    title: e.summary || '(No title)',
    start: e.start.dateTime ?? e.start.date ?? '',
    end: e.end.dateTime ?? e.end.date ?? '',
    allDay: !e.start.dateTime,
    location: e.location,
    attendees: (e.attendees ?? []).filter((a) => a.email).map((a) => ({ email: a.email!.toLowerCase(), name: a.displayName, organizer: a.organizer || undefined, self: a.self || undefined })),
    notes: notesOf(e),
  }
}

/** Adds (or with `unlink` takes out) a note's id in the event's private property; `all`: on the series. */
export async function markGoogleNote(user: User, ref: GoogleRef, noteId: string, opts: { all: boolean; unlink: boolean }): Promise<{ mirrored: boolean; why?: string }> {
  const account = googleAccount(user)
  if (!account) throw new HttpError(409, 'Google Calendar is not connected')
  if (!account.canWrite) return { mirrored: false, why: 'Google Calendar is connected read-only' }
  const calendar = (await listCalendars(user)).find((c) => c.id === ref.c)
  if (!calendar) throw new HttpError(404, 'That calendar is not connected')
  if (!calendar.writable) return { mirrored: false, why: 'The calendar is read-only' }
  const id = opts.all && ref.m ? ref.m : ref.e
  const e = await calendarApi<GoogleEvent>(user, eventPath(ref.c, id))
  if (e.status === 'cancelled') throw new HttpError(404, 'That event is gone from Google Calendar')
  const ids = notesOf(e)
  const next = opts.unlink ? ids.filter((x) => x !== noteId) : ids.includes(noteId) ? ids : [...ids, noteId]
  if (next.length === ids.length && next.every((x, i) => x === ids[i])) return { mirrored: true }
  // The whole private map (and the shared one as it is) goes back, so a stand-in that replaces
  // objects keeps other apps' properties as Google's patch, which merges them, does.
  const extendedProperties = { private: { ...(e.extendedProperties?.private ?? {}), [NOTES_KEY]: next.join(',') }, ...(e.extendedProperties?.shared ? { shared: e.extendedProperties.shared } : {}) }
  await calendarApi(user, `${eventPath(ref.c, id)}?sendUpdates=none`, { method: 'PATCH', body: { extendedProperties } })
  clearGoogleCache(user)
  return { mirrored: true }
}

// ---------------------------------------------------------------------------------------------
// Invitations (server/pim.ts): an event found by its iCalendar UID (Google puts invitations sent
// to the account in its calendar by itself), your answer to it, a guest's answer on your own
// event, and an invitation from elsewhere imported as it is.

export type GoogleFound = { calendarId: string; calendar: string; id: string; title: string; start: string; end: string; allDay: boolean; cancelled: boolean; url?: string; attendees: Attendee[] }

/** The event with this UID in one of your calendars that you can change (the main one first), or null. */
export async function googleByUid(user: User, uid: string, expected?: number): Promise<GoogleFound | null> {
  if (!googleAccount(user) || !uid || uid.length > 1000) return null
  requirePrivateRequest(user)
  const generation = expected ?? generationOf(user.id)
  const calendars = (await calendarsAt(user, generation)).filter((c) => c.access === 'owner' || c.access === 'writer').sort((a, b) => Number(b.primary) - Number(a.primary)).slice(0, 10)
  for (const cal of calendars) {
    const d = await calendarApi<{ items?: GoogleEvent[] }>(user, `/calendars/${encodeURIComponent(cal.id)}/events?${new URLSearchParams({ iCalUID: uid, showDeleted: 'true', maxResults: '5' })}`, {}, generation).catch(keepStale)
    sameLink(user, generation)
    const e = d?.items?.find((x) => !x.recurringEventId) ?? d?.items?.[0]
    if (!e) continue
    return {
      calendarId: cal.id,
      calendar: cal.name,
      id: e.id,
      title: e.summary || '(No title)',
      start: e.start.dateTime ?? e.start.date ?? '',
      end: e.end.dateTime ?? e.end.date ?? '',
      allDay: !e.start.dateTime,
      cancelled: e.status === 'cancelled',
      url: e.htmlLink,
      attendees: (e.attendees ?? []).filter((a) => a.email).map((a) => ({ email: a.email!.toLowerCase(), name: a.displayName, status: STATUS[a.responseStatus ?? ''], organizer: a.organizer || undefined, self: a.self || undefined })),
    }
  }
  return null
}

const GOOGLE_STATUS: Record<string, string> = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', 'needs-action': 'needsAction' }

/**
 * Sets one person's answer on an event: yours (`self`, or one of `emails`) to an invitation, which
 * Google then sends to the organiser; or a guest's on your own event, from their reply by email
 * (`notify` false: nobody needs telling). Answers false when that person is not on it.
 */
export async function setGoogleAnswer(user: User, calendarId: string, eventId: string, who: { self?: boolean; emails: string[] }, status: 'accepted' | 'declined' | 'tentative' | 'needs-action', notify: boolean): Promise<boolean> {
  const path = eventPath(calendarId, eventId)
  const e = await calendarApi<GoogleEvent>(user, path)
  const wanted = new Set(who.emails.map((x) => x.toLowerCase()))
  const attendees = e.attendees ?? []
  const i = attendees.findIndex((a) => (who.self && a.self) || (a.email && wanted.has(a.email.toLowerCase())))
  if (i < 0) return false
  attendees[i] = { ...attendees[i], responseStatus: GOOGLE_STATUS[status] }
  await calendarApi(user, `${path}?sendUpdates=${notify ? 'all' : 'none'}`, { method: 'PATCH', body: { attendees } })
  clearGoogleCache(user)
  return true
}

/** An invitation from elsewhere, imported into a Google calendar with its own UID (no one is mailed). */
export async function importGoogleEvent(
  user: User,
  calendarId: string,
  e: { uid: string; title: string; start: string; end: string; allDay: boolean; location?: string | null; description?: string | null; organizer: { email: string; name?: string | null } | null; attendees: { email: string; name?: string | null; status: string }[] },
): Promise<string> {
  const body = {
    iCalUID: e.uid,
    summary: e.title,
    start: time(e.start, e.allDay),
    end: time(e.end, e.allDay),
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.organizer ? { organizer: { email: e.organizer.email, ...(e.organizer.name ? { displayName: e.organizer.name } : {}) } } : {}),
    attendees: e.attendees.map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}), responseStatus: GOOGLE_STATUS[a.status] ?? 'needsAction' })),
  }
  const made = await calendarApi<GoogleEvent>(user, `/calendars/${encodeURIComponent(calendarId)}/events/import`, { method: 'POST', body })
  clearGoogleCache(user)
  return made.id
}

/** For the refresh-race check (scripts/google-refresh-check.ts) only. */
export const googleForTest = { accessToken }
