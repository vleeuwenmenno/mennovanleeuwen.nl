import { useSyncExternalStore } from 'react'
import { api } from './account'
import { keepMs, notifyPrefs, sourceOn, type SourceId } from './notifyPrefs'
import type { Entry, NoticeAction } from '../data/notifySources'
import { accountStorage } from './accountSpace'

export type { Entry, NoticeAction } from '../data/notifySources'

// Desktop notifications, Omarchy (mako) style: a short stack in the top-right corner that fades
// out on its own. Anything can post one.
//
// A notification that names its source ("agents.answer", see src/data/notifySources.ts) follows
// Settings → Notifications and is kept in the notification center (the bell in the top bar).
// Signed in, that list is the account's, kept by the server's notification hub
// (server/notifier.ts) and the same on every device: notifications from the server arrive over
// the live stream (src/os/notifyStream.ts), and the ones this page notices itself are sent there
// too, so they reach the account's other devices. Signed out, the list is this browser's.
//
// Without a source, or `transient`, it is a pop-up only: feedback on what was just done, or an
// offer that would go stale. `once` shows it only the first time ever.

export type Notice = { id: number; title: string; body?: string; icon?: string; onClick?: () => void; action?: NoticeAction; source?: SourceId; at: number; /** Stays until dismissed. */ sticky?: boolean; /** Its entry in the center */ entry?: string }

export type NotifyInput = Omit<Notice, 'id' | 'at' | 'entry'> & {
  /** A key: shown the first time only, ever */
  once?: string
  /** A pop-up only, never kept in the notification center */
  transient?: boolean
}

const LIFETIME_MS = 7000
const MAX = 4
let notices: Notice[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Opens what a notification is about (Shell listens; works from outside React). */
export const runAction = (a: NoticeAction) => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: a.app, props: { ...a.props, t: String(Date.now()) } } }))

/** Shows a pop-up, unless do not disturb holds it back (feedback without a source always shows). */
function popUp(n: Omit<Notice, 'id' | 'at'>) {
  if (n.source && !notifyPrefs().popups) return
  const id = nextId++
  notices = [...notices, { ...n, id, at: Date.now() }].slice(-MAX)
  emit()
  if (!n.sticky) setTimeout(() => dismiss(id), LIFETIME_MS)
}

export function notify(n: NotifyInput) {
  if (n.source && !sourceOn(n.source)) return
  const { once, transient, ...rest } = n
  // Signed in: the hub keeps it (once included) and sends it back over the stream as a pop-up,
  // to this page and the account's others; without the server, it shows here all the same.
  if (accountList && n.source && !transient) {
    void api('/api/notifications', { method: 'POST', json: { source: n.source, title: n.title, body: n.body, action: n.action, once } }).catch(() => popUp(rest))
    return
  }
  if (once && !firstTime(once)) return
  const entry = n.source && !transient ? keep({ title: n.title, body: n.body, icon: n.icon, action: n.action, source: n.source }) : undefined
  popUp({ ...rest, entry })
}

export function dismiss(id: number) {
  if (!notices.some((n) => n.id === id)) return
  notices = notices.filter((n) => n.id !== id)
  emit()
}

/** A pop-up clicked: its own handler or its action, and its entry in the center counts as opened. */
export function openNotice(n: Notice) {
  if (n.onClick) n.onClick()
  else if (n.action) runAction(n.action)
  if (n.entry) opened(n.entry)
  dismiss(n.id)
}

export function useNotices() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => notices,
  )
}

// --- the notification center's list ----------------------------------------------------------

const HISTORY_KEY = 'mvlos.notify.history'
const SEEN_KEY = 'mvlos.notify.seen'
const MAX_KEPT = 100

const load = (): Entry[] => {
  try {
    const v = JSON.parse(accountStorage.get(HISTORY_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? (v as Entry[]).filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string' && typeof e.at === 'number') : []
  } catch {
    return []
  }
}
/** Whether the list is the signed-in account's (from the server) rather than this browser's. */
let accountList = false
let entries: Entry[] = load()
const historyListeners = new Set<() => void>()

function save(next: Entry[]) {
  entries = next
  if (!accountList) {
    try {
      accountStorage.set(HISTORY_KEY, JSON.stringify(next))
    } catch {
      /* kept for this page only */
    }
  }
  historyListeners.forEach((l) => l())
}

/** Changes the account's list on the server; the stream tells the account's other pages. */
const change = (body: { read?: string[] | true; remove?: string[] | true; all?: true }) => {
  if (accountList) void api('/api/notifications', { method: 'PATCH', json: body.read === true ? { read: true, all: true } : body.remove === true ? { remove: true, all: true } : body }).catch(() => {})
}

/** Signed in or out (src/os/notifyStream.ts): the list becomes the account's, read from the server, or this browser's again. */
export async function setAccountList(on: boolean) {
  accountList = on
  if (!on) return save(load())
  const { entries: list } = await api<{ entries: Entry[] }>('/api/notifications').catch(() => ({ entries: entries }))
  if (accountList) save(list)
}

/** From the server's stream: a new notification for the account (a pop-up when it says so and this page is in view). */
export function receive(entry: Entry, popup: boolean) {
  if (!accountList) return
  save([entry, ...entries.filter((e) => e.id !== entry.id)].slice(0, 200))
  if (popup && document.visibilityState === 'visible') popUp({ title: entry.title, body: entry.body, icon: entry.icon, action: entry.action, source: entry.source, entry: entry.id })
}
/** From the server's stream: another page read, removed or cleared some. */
export function applyChange(kind: 'read' | 'remove' | 'clear', data: { ids?: string[]; all?: boolean }) {
  if (!accountList) return
  if (kind === 'clear') return save([])
  const hit = (e: Entry) => data.all || data.ids?.includes(e.id)
  if (kind === 'remove') save(entries.filter((e) => !hit(e)))
  else save(entries.map((e) => (hit(e) ? { ...e, read: true } : e)))
}

/** Drops what is older than Settings keeps, and anything past the newest MAX_KEPT (this browser's list; the server prunes the account's). */
function pruned(list: Entry[]) {
  const cutoff = Date.now() - keepMs(notifyPrefs().keep)
  return list.filter((e) => e.at >= cutoff).slice(0, MAX_KEPT)
}

function keep(e: Omit<Entry, 'id' | 'at' | 'read'>): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  save(pruned([{ ...e, id, at: Date.now(), read: false }, ...entries]))
  return id
}

export const useEntries = () =>
  useSyncExternalStore(
    (l) => {
      historyListeners.add(l)
      return () => historyListeners.delete(l)
    },
    () => entries,
  )

export function removeEntry(id: string) {
  save(entries.filter((e) => e.id !== id))
  change({ remove: [id] })
}
export function clearEntries() {
  save([])
  change({ remove: true })
}
export function markAllRead() {
  if (!entries.some((e) => !e.read)) return
  save(entries.map((e) => (e.read ? e : { ...e, read: true })))
  change({ read: true })
}
// Signed out, or another account here: the list was that account's (src/os/account.ts clears it
// from storage too). Only here: the server keeps each account's own list.
if (typeof window !== 'undefined') window.addEventListener('mvlos:forget', () => save([]))
/** Opened from a pop-up or the center: gone when Settings says so, otherwise read. */
export function opened(id: string) {
  if (notifyPrefs().removeOnOpen) return removeEntry(id)
  if (!entries.some((e) => e.id === id && !e.read)) return
  save(entries.map((e) => (e.id === id ? { ...e, read: true } : e)))
  change({ read: [id] })
}
/** Opens an entry from the center. */
export function openEntry(e: Entry) {
  if (e.action) runAction(e.action)
  opened(e.id)
}
/** Applies a shorter "keep for" at once, and every few minutes while the page stays open. */
export const pruneEntries = () => {
  if (accountList) return void setAccountList(true)
  const next = pruned(entries)
  if (next.length !== entries.length) save(next)
}
setInterval(() => !accountList && pruneEntries(), 5 * 60_000)

/** True the first time a `once` key is seen on this device (signed out; the server remembers them for accounts). */
function firstTime(key: string): boolean {
  try {
    const seen = JSON.parse(accountStorage.get(SEEN_KEY) ?? '[]') as string[]
    if (seen.includes(key)) return false
    accountStorage.set(SEEN_KEY, JSON.stringify([...seen, key].slice(-500)))
  } catch {
    /* without storage: once per page load, as before */
  }
  return true
}
