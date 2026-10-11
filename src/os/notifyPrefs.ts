import { allows, DEFAULT_PREFS, normalizePrefs, NOTIFY_SOURCES, type NotifyPrefs } from '../data/notifySources'
import { synced } from './synced'

// Which notifications may show, and how long the notification center keeps them. Every
// notification names its source as "app.kind" (src/os/notify.ts); Settings → Notifications turns
// whole apps or single kinds off. Kept in this browser; synced when signed in, like notes.

// The list of sources and the rules for the choices live in src/data/notifySources.ts, which the
// server's notification hub (server/notifier.ts) reads too.
export { ACTIVITY_KIND, ACTIVITY_WINDOWS, activityWindowMs, CALENDAR_LEADS, KEEP, keepMs, NOTIFY_SOURCES, sourceOf } from '../data/notifySources'
export type { ActivityWindow, CalendarLead, Keep, NotifyKind, NotifyPrefs, NotifySource, SourceId } from '../data/notifySources'

// The Minecraft switch was on its own before; an "off" there carries over.
const mcWasOff = (() => {
  try {
    return localStorage.getItem('mvlos.mc.notify') === 'off'
  } catch {
    return false
  }
})()

const DEFAULTS: NotifyPrefs = { ...DEFAULT_PREFS, off: mcWasOff ? ['minecraft'] : [] }

const store = synced<NotifyPrefs>('notify', DEFAULTS, { normalize: (v) => normalizePrefs(v, DEFAULTS) })

export const useNotifyPrefs = store.use
export const notifyPrefs = store.get
export const setNotifyPrefs = (patch: Partial<NotifyPrefs>) => store.set((s) => ({ ...s, ...patch }))

/** Whether a source ("app.kind") may notify: its app and its kind are both on. */
export const sourceOn = (source: string) => allows(store.get(), source)
/** Turns an app ("minecraft") or one of its kinds ("minecraft.players") on or off. */
export function setOn(id: string, on: boolean) {
  store.set((s) => ({ ...s, off: on ? s.off.filter((x) => x !== id) : [...new Set([...s.off, id])] }))
}
export const isOff = (prefs: NotifyPrefs, id: string) => prefs.off.includes(id)

/** For Settings: every source, the owner-only ones only when signed in. */
export const visibleSources = (owner: boolean) => NOTIFY_SOURCES.filter((s) => owner || !s.owner)
