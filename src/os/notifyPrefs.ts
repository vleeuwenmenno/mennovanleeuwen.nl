import { cvMode } from './cvMode'
import { synced } from './synced'
import type { AppId } from './wm'

// Which notifications may show, and how long the notification center keeps them. Every
// notification names its source as "app.kind" (src/os/notify.ts); Settings → Notifications turns
// whole apps or single kinds off. Kept in this browser; synced when signed in, like notes.

export type NotifyKind = { id: string; label: string; hint: string }
export type NotifySource = { app: string; label: string; /** The app whose icon stands for it */ icon: AppId | null; /** Only signed-in users get these */ account?: boolean; kinds: NotifyKind[] }

export const NOTIFY_SOURCES: NotifySource[] = [
  { app: 'agents', label: 'Agents', icon: 'agents', account: true, kinds: [{ id: 'answer', label: 'Answers', hint: 'An answer comes in while its thread is not on screen' }] },
  {
    app: 'minecraft',
    label: 'Minecraft server',
    icon: 'mcserver',
    kinds: [
      { id: 'players', label: 'Players', hint: 'Someone joins or leaves' },
      { id: 'status', label: 'Online and offline', hint: 'The server goes down or comes back' },
    ],
  },
  {
    app: 'activity',
    label: 'Activity',
    icon: 'recents',
    // By what happened, on GitHub and git.mvl.sh alike (see ACTIVITY_KIND for how events map).
    kinds: [
      { id: 'push', label: 'Pushes', hint: 'Commits pushed to a branch' },
      { id: 'release', label: 'Releases', hint: 'A new version is published' },
      { id: 'pr', label: 'Pull requests', hint: 'Opened or merged' },
      { id: 'issue', label: 'Issues', hint: 'Opened or closed' },
      { id: 'create', label: 'New repositories', hint: 'Created or forked' },
      { id: 'comment', label: 'Comments', hint: 'On issues, pull requests and commits' },
      { id: 'star', label: 'Stars', hint: 'A repository gets a star' },
    ],
  },
  {
    app: 'files',
    label: 'Files',
    icon: 'files',
    account: true,
    kinds: [
      { id: 'uploads', label: 'Uploads', hint: 'Uploads to Seafile finish or fail' },
      { id: 'unpacking', label: 'Unpacking', hint: 'An archive is unpacked, stopped or fails' },
    ],
  },
  {
    app: 'system',
    label: 'MvL OS',
    icon: null,
    kinds: [
      { id: 'update', label: 'Updates', hint: 'A new version is ready to restart into' },
      { id: 'storage', label: 'File storage', hint: 'Your files are only kept in this browser (it stays in the notification center until Seafile is set up)' },
    ],
  },
]

/** An activity event's notification kind: merges count as pull requests, forks as new repositories. */
export const ACTIVITY_KIND: Record<string, string> = { push: 'push', release: 'release', pr: 'pr', merge: 'pr', issue: 'issue', create: 'create', fork: 'create', comment: 'comment', star: 'star' }

/** How far back activity may be to still notify, when the desktop comes up. */
export type ActivityWindow = '15m' | '1h' | '6h' | '1d' | '1w'
export const ACTIVITY_WINDOWS: [ActivityWindow, string, number][] = [
  ['15m', '15 minutes', 15 * 60_000],
  ['1h', '1 hour', 3600_000],
  ['6h', '6 hours', 6 * 3600_000],
  ['1d', '1 day', 864e5],
  ['1w', '1 week', 7 * 864e5],
]
export const activityWindowMs = (w: ActivityWindow) => ACTIVITY_WINDOWS.find(([id]) => id === w)?.[2] ?? 15 * 60_000

/** A source as notify() takes it: "app.kind". */
export type SourceId = `${string}.${string}`

/** How long the notification center keeps a notification. */
export type Keep = '1h' | '1d' | '1w' | '30d' | 'forever'
export const KEEP: [Keep, string, number][] = [
  ['1h', '1 hour', 3600_000],
  ['1d', '1 day', 864e5],
  ['1w', '1 week', 7 * 864e5],
  ['30d', '30 days', 30 * 864e5],
  ['forever', 'Until cleared', Infinity],
]

export type NotifyPrefs = {
  /** Pop-ups in the corner; off is do not disturb (the notification center still collects them) */
  popups: boolean
  keep: Keep
  /** A notification leaves the center once it is opened */
  removeOnOpen: boolean
  /** Apps ("minecraft") and kinds ("minecraft.players") that are switched off */
  off: string[]
  /** Activity older than this does not notify */
  activityWindow: ActivityWindow
}

// The Minecraft switch was on its own before; an "off" there carries over.
const mcWasOff = (() => {
  try {
    return localStorage.getItem('mvlos.mc.notify') === 'off'
  } catch {
    return false
  }
})()

const DEFAULTS: NotifyPrefs = { popups: true, keep: '1w', removeOnOpen: false, off: mcWasOff ? ['minecraft'] : [], activityWindow: '15m' }

const store = synced<NotifyPrefs>('notify', DEFAULTS, {
  normalize: (v) => {
    const s = { ...DEFAULTS, ...(v && typeof v === 'object' ? (v as Partial<NotifyPrefs>) : {}) }
    return {
      popups: s.popups !== false,
      keep: KEEP.some(([k]) => k === s.keep) ? s.keep : DEFAULTS.keep,
      removeOnOpen: s.removeOnOpen === true,
      off: Array.isArray(s.off) ? s.off.filter((x): x is string => typeof x === 'string').slice(0, 100) : [],
      activityWindow: ACTIVITY_WINDOWS.some(([k]) => k === s.activityWindow) ? s.activityWindow : DEFAULTS.activityWindow,
    }
  },
})

export const useNotifyPrefs = store.use
export const notifyPrefs = store.get
export const setNotifyPrefs = (patch: Partial<NotifyPrefs>) => store.set((s) => ({ ...s, ...patch }))

/** Whether a source ("app.kind") may notify: its app and its kind are both on. */
export function sourceOn(source: string) {
  const { off } = store.get()
  return !off.includes(source.split('.')[0]) && !off.includes(source)
}
/** Turns an app ("minecraft") or one of its kinds ("minecraft.players") on or off. */
export function setOn(id: string, on: boolean) {
  store.set((s) => ({ ...s, off: on ? s.off.filter((x) => x !== id) : [...new Set([...s.off, id])] }))
}
export const isOff = (prefs: NotifyPrefs, id: string) => prefs.off.includes(id)

export const keepMs = (k: Keep) => KEEP.find(([id]) => id === k)?.[2] ?? 864e5 * 7
export const sourceOf = (source: string | undefined) => (source ? NOTIFY_SOURCES.find((s) => s.app === source.split('.')[0]) : undefined)

/** For Settings: every source, the account-only ones only when signed in. */
// Menno's Minecraft server and activity only notify on his CV page (src/os/cvMode.ts).
export const visibleSources = (signedIn: boolean) => NOTIFY_SOURCES.filter((s) => (signedIn || !s.account) && (cvMode() || (s.app !== 'minecraft' && s.app !== 'activity')))
