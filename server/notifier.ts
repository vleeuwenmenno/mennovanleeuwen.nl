import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { actionUrl, allows, brandBadge, brandIcon, keepMs, normalizePrefs, NOTIFY_SOURCES, sourceOf, type Brand, type Entry, type NoticeAction, type NotifyPrefs, type SourceId } from '../src/data/notifySources.ts'
import type { User } from './auth.ts'
import { database, onUserGone } from './db.ts'
import { HttpError, SECURITY } from './http.ts'
import { readState } from './state.ts'
import { pushToUser } from './webpush.ts'

// The notification hub: one place every app tells about something worth knowing, so all of them
// follow the same rules. A notification for an account
//
// 1. is dropped when its source is switched off in Settings → Notifications (synced state
//    "notify", read here), or when it was sent before (`once`, remembered per account);
// 2. is kept in the account's notification list (the bell, the same on every device);
// 3. goes live to the account's open pages, which show it as a pop-up when one is in view;
// 4. is sent as Web Push when no page is in view, unless do not disturb is on.
//
// Apps hand notifications in two ways: when something happens (notify(), e.g. an Agents answer or
// a finished unpack), or from a watcher that looks every so often (registerWatcher(), e.g. the
// Minecraft server, activity feeds, calendar reminders; see server/watchers.ts).

export type Notice = {
  source: SourceId
  title: string
  body?: string
  icon?: string
  /** Whose logo it carries (GitHub, Minecraft…), when not its source's own: the icon on devices, and in the list when there is no `icon` */
  brand?: Brand
  action?: NoticeAction
  /** A key: sent the first time only, ever, for this account */
  once?: string
  /** Push messages with the same tag replace each other on the device */
  tag?: string
}

type AccountRef = Pick<User, 'id'>

const prefsOf = (user: AccountRef): NotifyPrefs => normalizePrefs(readState(user as User).notify?.value)
const MAX_KEPT = 200
/** Remembered "once" keys per account. */
const MAX_ONCE = 5000
/** Notifications a page may send per minute (feedback for its own account). */
const PAGE_PER_MINUTE = 30
const pageSent = new Map<number, { at: number; n: number }>()
onUserGone((id) => pageSent.delete(id))

// --- open pages ----------------------------------------------------------------------------------

/** A page with the live stream open: whether it is in view, as it last said (a heartbeat). */
type Page = { res: ServerResponse; visible: boolean; seen: number }
const pages = new Map<number, Map<string, Page>>() // account → page id → page
/** Live streams one account may have open at once (tabs, devices). */
const MAX_PAGES = 8
/** A page that said it was in view longer ago than this is taken to be asleep (a phone in a pocket). */
const VISIBLE_FOR = 75_000

/** Ends an account's live streams (signed out everywhere, banned or deleted, server/users.ts). */
export function closeStreams(userId: number) {
  for (const p of pages.get(userId)?.values() ?? []) p.res.end()
  pages.delete(userId)
}
onUserGone(closeStreams)

const inView = (userId: number) => [...(pages.get(userId)?.values() ?? [])].some((p) => p.visible && Date.now() - p.seen < VISIBLE_FOR)

function broadcast(userId: number, event: string, data: unknown) {
  for (const p of pages.get(userId)?.values() ?? []) if (!p.res.writableEnded) p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Tells the account's open pages that something they show changed (`calendar`: events; `mail`: an account's mail, `{ account }`), over the same live stream. */
export const tellPages = (userId: number, event: 'calendar' | 'mail', data: unknown = {}) => broadcast(userId, event, data)

/** GET /api/notifications/stream?page=<id>: the page's live stream (Server-Sent Events). */
export function openStream(req: IncomingMessage, res: ServerResponse, user: User, pageId: string | null) {
  const id = pageId && /^[\w-]{8,64}$/.test(pageId) ? pageId : randomUUID()
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive', ...SECURITY })
  const list = pages.get(user.id) ?? new Map<string, Page>()
  pages.set(user.id, list)
  // Anyone can sign up: a few open pages each, the oldest let go past that.
  while (list.size >= MAX_PAGES) {
    const [oldest, page] = list.entries().next().value!
    list.delete(oldest)
    page.res.end()
  }
  list.set(id, { res, visible: true, seen: Date.now() })
  res.write(`event: hello\ndata: ${JSON.stringify({ page: id })}\n\n`)
  // A comment now and then keeps proxies from closing a quiet stream.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
  const done = () => {
    clearInterval(keepAlive)
    if (list.get(id)?.res === res) list.delete(id)
    if (!list.size) pages.delete(user.id)
  }
  req.on('close', done)
  res.on('close', done)
}

/** POST /api/notifications/presence {page, visible}: a page's heartbeat, and when it goes out of view. */
export function presence(user: User, body: { page?: unknown; visible?: unknown }) {
  const page = typeof body.page === 'string' ? pages.get(user.id)?.get(body.page) : undefined
  if (page) {
    page.visible = body.visible === true
    page.seen = Date.now()
  }
  return { ok: true, known: !!page }
}

// --- the list (the bell) -------------------------------------------------------------------------

type Row = { id: string; source: string | null; title: string; body: string | null; icon: string | null; action: string | null; at: number; read: number }
const toEntry = (r: Row): Entry => ({
  id: r.id,
  title: r.title,
  ...(r.body ? { body: r.body } : {}),
  ...(r.icon ? { icon: r.icon } : {}),
  ...(r.action ? { action: JSON.parse(r.action) as NoticeAction } : {}),
  ...(r.source ? { source: r.source as SourceId } : {}),
  at: r.at,
  read: !!r.read,
})

/** Drops what is older than the account keeps notifications, and anything past the newest MAX_KEPT. */
function prune(userId: number, prefs: NotifyPrefs) {
  const db = database()
  const keep = keepMs(prefs.keep)
  if (Number.isFinite(keep)) db.prepare('DELETE FROM notifications WHERE user_id = ? AND at < ?').run(userId, Date.now() - keep)
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY at DESC LIMIT ?)').run(userId, userId, MAX_KEPT)
}

export function listEntries(user: User): Entry[] {
  prune(user.id, prefsOf(user))
  return (database().prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY at DESC').all(user.id) as Row[]).map(toEntry)
}

/** Marks some (or all) as read, or removes one or all; other pages follow. */
export function changeEntries(user: User, body: { read?: unknown; remove?: unknown; all?: unknown }) {
  const db = database()
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : [])
  if (body.all === true && body.remove === true) {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(user.id)
    broadcast(user.id, 'clear', {})
  } else if (body.all === true && body.read === true) {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id)
    broadcast(user.id, 'read', { all: true })
  } else {
    const read = ids(body.read)
    const remove = ids(body.remove)
    for (const id of read) db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?').run(user.id, id)
    for (const id of remove) db.prepare('DELETE FROM notifications WHERE user_id = ? AND id = ?').run(user.id, id)
    if (read.length) broadcast(user.id, 'read', { ids: read })
    if (remove.length) broadcast(user.id, 'remove', { ids: remove })
  }
  return { ok: true }
}

// --- sending -------------------------------------------------------------------------------------

/** True the first time this account sees `key` (and remembers it, 60 days). For a watcher that
 * sums up many new things in one notification and marks each of them seen. */
export const claimOnce = (user: AccountRef, key: string) => firstTime(user.id, key)

function firstTime(userId: number, key: string): boolean {
  const db = database()
  const r = db.prepare('INSERT OR IGNORE INTO notify_once (user_id, key, at) VALUES (?, ?, ?)').run(userId, key.slice(0, 300), Date.now())
  if (Math.random() < 0.02) db.prepare('DELETE FROM notify_once WHERE at < ?').run(Date.now() - 60 * 864e5)
  // Pages can name keys too (noticeFromPage): each account keeps its newest few thousand.
  if (r.changes && Math.random() < 0.05) db.prepare('DELETE FROM notify_once WHERE user_id = ? AND key NOT IN (SELECT key FROM notify_once WHERE user_id = ? ORDER BY at DESC LIMIT ?)').run(userId, userId, MAX_ONCE)
  return r.changes > 0
}

/**
 * Tells an account about something. `watched`: a page shows it already (an Agents thread on
 * screen), so it is neither kept nor pushed. Answers the kept entry, or null when nothing was sent.
 */
export function notify(user: AccountRef, n: Notice, { watched = false }: { watched?: boolean } = {}): Entry | null {
  if (watched) return null
  const prefs = prefsOf(user)
  if (!allows(prefs, n.source)) return null
  if (n.once && !firstTime(user.id, n.once)) return null
  const brand = n.brand ?? sourceOf(n.source)?.brand
  const icon = n.icon ?? (brand && brandIcon(brand))
  const entry: Entry = { id: randomUUID(), title: n.title.slice(0, 200), ...(n.body ? { body: n.body.slice(0, 500) } : {}), ...(icon ? { icon } : {}), ...(n.action ? { action: n.action } : {}), source: n.source, at: Date.now(), read: false }
  database()
    .prepare('INSERT INTO notifications (id, user_id, source, title, body, icon, action, at, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
    .run(entry.id, user.id, entry.source ?? null, entry.title, entry.body ?? null, entry.icon ?? null, entry.action ? JSON.stringify(entry.action) : null, entry.at)
  prune(user.id, prefs)
  // Pages show it (as a pop-up only when do not disturb is off and they are in view); a device
  // with none in view gets it as push.
  broadcast(user.id, 'notice', { entry, popup: prefs.popups })
  if (prefs.popups && !inView(user.id)) {
    // On devices the brand wins over a picture (a player's head): it says where the news is from.
    const logo = brand ? { icon: brandIcon(brand), badge: brandBadge(brand) } : {}
    void pushToUser(user as User, { title: entry.title, body: entry.body, ...logo, tag: n.tag ?? entry.id, url: actionUrl(n.action), thread: n.action?.app === 'agents' ? n.action.props?.thread : undefined }).catch(() => {})
  }
  return entry
}

/** POST /api/notifications: something a page noticed itself (an upload finishing), for the list and the account's other devices. */
export function noticeFromPage(user: User, body: { source?: unknown; title?: unknown; body?: unknown; action?: unknown; once?: unknown }) {
  const now = Date.now()
  const sent = pageSent.get(user.id)
  if (sent && now - sent.at < 60_000) {
    if (++sent.n > PAGE_PER_MINUTE) throw new HttpError(429, 'Too many notifications: slow down')
  } else pageSent.set(user.id, { at: now, n: 1 })
  const source = typeof body.source === 'string' ? body.source : ''
  const [app, kind] = source.split('.')
  if (!NOTIFY_SOURCES.some((s) => s.app === app && s.kinds.some((k) => k.id === kind))) throw new HttpError(400, 'Unknown notification source')
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) throw new HttpError(400, 'A notification needs a title')
  const a = body.action as { app?: unknown; props?: unknown } | undefined
  const action: NoticeAction | undefined =
    a && typeof a.app === 'string' && /^[a-z]{2,20}$/.test(a.app)
      ? { app: a.app, props: Object.fromEntries(Object.entries(a.props && typeof a.props === 'object' ? (a.props as Record<string, unknown>) : {}).filter(([k, v]) => typeof v === 'string' && k.length < 30).slice(0, 10).map(([k, v]) => [k, (v as string).slice(0, 500)])) }
      : undefined
  const entry = notify(user, { source: source as SourceId, title, body: typeof body.body === 'string' ? body.body : undefined, action, once: typeof body.once === 'string' ? `page:${body.once}` : undefined })
  return { entry }
}

// --- watchers ------------------------------------------------------------------------------------

/** Something that looks every so often and hands what it finds to notify(). */
export type Watcher = { name: string; every: number; run: () => Promise<void> }
const watchers: Watcher[] = []
let started = false

export function registerWatcher(w: Watcher) {
  watchers.push(w)
  if (started) start(w)
}

function start(w: Watcher) {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await w.run()
    } catch (e) {
      console.error(`notifications (${w.name}):`, (e as Error).message)
    } finally {
      busy = false
    }
  }
  setTimeout(tick, 5_000).unref()
  setInterval(tick, w.every).unref()
}

/** Starts the registered watchers (once; NOTIFY_WATCH=off leaves them off). */
export function startWatchers() {
  if (started || process.env.NOTIFY_WATCH === 'off') return
  started = true
  watchers.forEach(start)
}
