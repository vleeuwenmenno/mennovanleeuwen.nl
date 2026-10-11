import { ACTIVITY_KIND, activityWindowMs, allows, normalizePrefs, type SourceId } from '../src/data/notifySources.ts'
import { mergeActivity, normalizeGithubEvents, normalizeGithubReleases, type Activity } from '../src/data/normalize.ts'
import { forgejoActivity } from './activity.ts'
import { accounts, type User } from './auth.ts'
import { listCaldav } from './caldav.ts'
import { allEvents } from './calendars.ts'
import { googleAccount } from './google.ts'
import { MC_HOST, onMinecraftStatus, type McStatus } from './minecraft.ts'
import { claimOnce, notify, registerWatcher, startWatchers, type Notice } from './notifier.ts'
import { onUserGone } from './db.ts'
import { readState } from './state.ts'

// The notification hub's watchers (server/notifier.ts): things the server looks at every so often,
// so their notifications reach the accounts that want them with no MvL OS page open. Each one hands
// what it finds to notify(), which applies the account's choices, keeps the list and pushes.
//
// - Minecraft: who joins and leaves, and the server going down or up, from the server's own
//   pinger (server/minecraft.ts), for the admins (it is Menno's server, part of his CV at /cv).
// - Activity: new pushes, releases and the like on Menno's GitHub and git.mvl.sh, for the admins,
//   each item once, back as far as the account's "how recent" setting.
// - Calendar: reminders before events, for each account with a calendar connected.

const prefsOf = (user: User) => normalizePrefs(readState(user).notify?.value)
/** Menno's own Minecraft server and activity: news for the admins only, not every account. */
const admins = () => accounts().filter((u) => u.admin)

// --- Minecraft -----------------------------------------------------------------------------------

/** The last ping: who was on, with how many pings in a row each has been missing from the sample. */
let lastMc: { online: boolean; count: number; misses: Map<string, number> } | null = null
const head = (name: string) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/32`

export function minecraft(st: McStatus) {
  const prev = lastMc
  const misses = new Map<string, number>()
  lastMc = { online: st.online, count: st.players.online, misses }
  for (const name of st.players.list) misses.set(name, 0)
  if (!prev) return // the first ping is where things stand, not news

  const tell = (source: SourceId, title: string, body: string, icon?: string) => {
    for (const u of admins()) notify(u, { source, title, body, icon, action: { app: 'mcserver' } })
  }
  if (prev.online !== st.online) {
    tell('minecraft.status', st.online ? "Menno's Minecraft server is back online" : "Menno's Minecraft server went offline", MC_HOST)
    if (!st.online) return
  }
  if (!st.online) return
  const joined = st.players.list.filter((p) => !prev.misses.has(p))
  const left: string[] = []
  // With fewer names than players (some hide theirs, and can switch between pings) a missing name
  // may still be on: only a complete list says who left.
  const complete = st.players.list.length >= st.players.online
  // A ping's player sample can leave someone out now and then: gone only after two misses in a row.
  for (const [name, n] of prev.misses) {
    if (misses.has(name)) continue
    if (!complete) misses.set(name, n)
    else if (n + 1 >= 2) left.push(name)
    else misses.set(name, n + 1)
  }
  const total = `${st.players.online} of ${st.players.max} players online · ${MC_HOST}`
  if (joined.length > 2) tell('minecraft.players', `${joined.length} players joined Menno's Minecraft server`, total)
  else joined.forEach((p) => tell('minecraft.players', `${p} joined Menno's Minecraft server`, total, head(p)))
  if (left.length > 2) tell('minecraft.players', `${left.length} players left Menno's Minecraft server`, total)
  else left.forEach((p) => tell('minecraft.players', `${p} left Menno's Minecraft server`, total, head(p)))
  // Servers that hide their player list still report a count.
  if (!st.players.list.length && !prev.misses.size && st.players.online !== prev.count) tell('minecraft.players', `Someone ${st.players.online > prev.count ? 'joined' : 'left'} Menno's Minecraft server`, total)
}

// --- Activity ------------------------------------------------------------------------------------

// The same feeds as the Activity app (src/data/recents.ts): Menno's public GitHub events, the
// releases of these repositories, and git.mvl.sh.
const GITHUB_USER = 'vleeuwenmenno'
const RELEASE_REPOS = ['vleeuwenmenno/boltwarden', 'vleeuwenmenno/omasoloist']

async function github(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'mvlos' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return res.json()
}

async function activityFeed(): Promise<Activity[]> {
  const [events, ...releases] = await Promise.all([
    github(`/users/${GITHUB_USER}/events/public?per_page=100`).catch(() => []),
    ...RELEASE_REPOS.map((r) => github(`/repos/${r}/releases?per_page=10`).catch(() => [])),
  ])
  const gh = mergeActivity(normalizeGithubEvents(events as never[]), ...releases.map((r, i) => normalizeGithubReleases(RELEASE_REPOS[i], r as never[])))
  return mergeActivity(gh, await forgejoActivity().catch(() => []))
}

export async function activity() {
  const users = admins()
  if (!users.length) return
  const items = await activityFeed()
  for (const u of users) {
    const prefs = prefsOf(u)
    if (prefs.off.includes('activity')) continue
    const cutoff = Date.now() - activityWindowMs(prefs.activityWindow)
    const source = (a: Activity) => `activity.${ACTIVITY_KIND[a.kind] ?? a.kind}` as SourceId
    // New to this account, oldest first; each one marked as told.
    const fresh = items
      .filter((a) => new Date(a.date).getTime() > cutoff && allows(prefs, source(a)))
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((a) => claimOnce(u, `activity:${a.id}`))
    if (!fresh.length) continue
    if (fresh.length > 3) {
      notify(u, { source: source(fresh[fresh.length - 1]), title: `Menno has been busy: ${fresh.length} new updates`, body: 'Open Activity to see them', brand: fresh.every((a) => a.source === fresh[0].source) ? fresh[0].source : undefined, action: { app: 'recents' } })
      continue
    }
    for (const a of fresh) notify(u, { source: source(a), title: `New on ${a.source === 'github' ? 'GitHub' : 'git.mvl.sh'}: ${a.title}`, body: [a.detail, a.repo].filter(Boolean).join(' · '), brand: a.source, action: { app: 'recents' } })
  }
}

// --- Calendar ------------------------------------------------------------------------------------

type CalEvent = Awaited<ReturnType<typeof allEvents>>['events'][number]
/** Each account's coming events, read again every five minutes (Google and CalDAV are not asked every minute). */
const upcoming = new Map<number, { at: number; events: CalEvent[] }>()
onUserGone((id) => upcoming.delete(id))
const REFRESH_MS = 5 * 60_000

async function calendar() {
  const now = Date.now()
  for (const u of accounts()) {
    if (!googleAccount(u) && !listCaldav(u).length) continue
    const prefs = prefsOf(u)
    if (!allows(prefs, 'calendar.reminder')) continue
    let cached = upcoming.get(u.id)
    if (!cached || now - cached.at > REFRESH_MS) {
      const { events } = await allEvents(u, null, { from: new Date(now - 10 * 60_000), to: new Date(now + 3 * 3600_000) }).catch(() => ({ events: cached?.events ?? [] }))
      cached = { at: now, events }
      upcoming.set(u.id, cached)
    }
    for (const n of reminders(cached.events, now, prefs.calendarLead)) notify(u, n)
  }
}

/**
 * The reminders due now: events with a start time from `lead` minutes before they start until a
 * few minutes after (a reminder that was due while the server restarted still comes, late, but
 * not once the event is well underway). Each event's reminder is sent once (its `once` key).
 */
export function reminders(events: Pick<CalEvent, 'id' | 'title' | 'start' | 'allDay' | 'location' | 'calendar'>[], now: number, lead: number): Notice[] {
  const out: Notice[] = []
  for (const ev of events) {
    if (ev.allDay) continue
    const start = new Date(ev.start).getTime()
    if (Number.isNaN(start) || now < start - lead * 60_000 || now > start + 5 * 60_000) continue
    const mins = Math.round((start - now) / 60_000)
    const when = mins > 0 ? `In ${mins} minute${mins === 1 ? '' : 's'}` : mins === 0 ? 'Starting now' : `Started ${-mins} minute${mins === -1 ? '' : 's'} ago`
    out.push({
      source: 'calendar.reminder',
      title: ev.title || 'An event',
      body: [when, ev.location, ev.calendar].filter(Boolean).join(' · '),
      action: { app: 'calendar' },
      once: `calendar:${ev.id}:${ev.start}:${lead}`,
      tag: `calendar-${ev.id}`,
    })
  }
  return out
}

// --- start ---------------------------------------------------------------------------------------

let started = false

/** Registers the watchers and starts them (server/index.ts, and Vite's servers in development). */
export function startNotifications() {
  if (started) return
  started = true
  onMinecraftStatus(minecraft)
  registerWatcher({ name: 'activity', every: 5 * 60_000, run: activity })
  registerWatcher({ name: 'calendar', every: 60_000, run: calendar })
  startWatchers()
}
