import { useSyncExternalStore } from 'react'
import { keepMs, notifyPrefs, sourceOn, type SourceId } from './notifyPrefs'
import type { AppId } from './wm'

// Desktop notifications, Omarchy (mako) style: a short stack in the top-right corner that fades
// out on its own. Anything can post one.
//
// A notification that names its source ("agents.answer", see src/os/notifyPrefs.ts) follows
// Settings → Notifications: a switched-off source shows nothing, and the rest are also kept in
// the notification center (the bell in the top bar) on this device, for as long as Settings says.
// Without a source, or `transient`, it is a pop-up only: feedback on what was just done, or an
// offer that would go stale. `once` shows it only the first time ever, also after a reload.

/** What opening a notification does, kept with it in the center: an app, with props. */
export type NoticeAction = { app: AppId; props?: Record<string, string> }

export type Notice = { id: number; title: string; body?: string; icon?: string; onClick?: () => void; action?: NoticeAction; source?: SourceId; at: number; /** Stays until dismissed. */ sticky?: boolean; /** Its entry in the center */ entry?: string }

export type NotifyInput = Omit<Notice, 'id' | 'at' | 'entry'> & {
  /** A key: shown the first time only, ever (on this device) */
  once?: string
  /** A pop-up only, never kept in the notification center */
  transient?: boolean
}

/** One kept in the notification center. */
export type Entry = { id: string; title: string; body?: string; icon?: string; action?: NoticeAction; source?: SourceId; at: number; read: boolean }

const LIFETIME_MS = 7000
const MAX = 4
let notices: Notice[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Opens what a notification is about (Shell listens; works from outside React). */
export const runAction = (a: NoticeAction) => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: a.app, props: { ...a.props, t: String(Date.now()) } } }))

export function notify(n: NotifyInput) {
  if (n.source && !sourceOn(n.source)) return
  if (n.once && !firstTime(n.once)) return
  const { once: _once, transient, ...rest } = n
  const entry = n.source && !transient ? keep({ title: n.title, body: n.body, icon: n.icon, action: n.action, source: n.source }) : undefined
  // Do not disturb holds back the pop-ups of sources; feedback without one always shows.
  if (n.source && !notifyPrefs().popups) return
  const id = nextId++
  notices = [...notices, { ...rest, id, at: Date.now(), entry }].slice(-MAX)
  emit()
  if (!n.sticky) setTimeout(() => dismiss(id), LIFETIME_MS)
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
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? (v as Entry[]).filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string' && typeof e.at === 'number') : []
  } catch {
    return []
  }
}
let entries: Entry[] = load()
const historyListeners = new Set<() => void>()

function save(next: Entry[]) {
  entries = next
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* kept for this page only */
  }
  historyListeners.forEach((l) => l())
}

/** Drops what is older than Settings keeps, and anything past the newest MAX_KEPT. */
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

export const removeEntry = (id: string) => save(entries.filter((e) => e.id !== id))
export const clearEntries = () => save([])
// Signed out: the history was that account's (src/os/account.ts clears it from storage too).
if (typeof window !== 'undefined') window.addEventListener('mvlos:forget', clearEntries)
export const markAllRead = () => entries.some((e) => !e.read) && save(entries.map((e) => (e.read ? e : { ...e, read: true })))
/** Opened from a pop-up or the center: gone when Settings says so, otherwise read. */
export function opened(id: string) {
  if (notifyPrefs().removeOnOpen) removeEntry(id)
  else if (entries.some((e) => e.id === id && !e.read)) save(entries.map((e) => (e.id === id ? { ...e, read: true } : e)))
}
/** Opens an entry from the center. */
export function openEntry(e: Entry) {
  if (e.action) runAction(e.action)
  opened(e.id)
}
/** Applies a shorter "keep for" at once, and every few minutes while the page stays open. */
export const pruneEntries = () => {
  const next = pruned(entries)
  if (next.length !== entries.length) save(next)
}
setInterval(pruneEntries, 5 * 60_000)

/** True the first time a `once` key is seen on this device. */
function firstTime(key: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]
    if (seen.includes(key)) return false
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, key].slice(-500)))
  } catch {
    /* without storage: once per page load, as before */
  }
  return true
}
