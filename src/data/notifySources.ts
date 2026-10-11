// What can notify, and the owner's choices about it, shared by the browser (src/os/notifyPrefs.ts,
// Settings → Notifications) and the server's notification hub (server/notifier.ts), so Settings
// always lists exactly what the server can send. Every notification names its source as
// "app.kind". No DOM or Node APIs here: both runtimes import it.

export type NotifyKind = { id: string; label: string; hint: string }
export type NotifySource = {
  app: string
  label: string
  /** The app whose icon stands for it (an AppId), or none */
  icon: string | null
  /** Only signed-in accounts get these (they come from the account's own data) */
  owner?: boolean
  kinds: NotifyKind[]
}

export const NOTIFY_SOURCES: NotifySource[] = [
  {
    app: 'agents',
    label: 'Agents',
    icon: 'agents',
    owner: true,
    kinds: [
      { id: 'answer', label: 'Answers', hint: 'An answer comes in while its thread is not on screen' },
      { id: 'ask', label: 'Needs you', hint: 'It waits for you to allow something or answer its questions' },
    ],
  },
  { app: 'calendar', label: 'Calendar', icon: 'calendar', owner: true, kinds: [{ id: 'reminder', label: 'Reminders', hint: 'An event is about to start' }] },
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
    owner: true,
    kinds: [
      { id: 'uploads', label: 'Uploads', hint: 'Uploads to Seafile finish or fail' },
      { id: 'unpacking', label: 'Unpacking', hint: 'An archive is unpacked, stopped or fails' },
    ],
  },
  { app: 'system', label: 'MvL OS', icon: null, kinds: [{ id: 'update', label: 'Updates', hint: 'A new version is ready to restart into' }] },
]

/** A source as notifications name it: "app.kind". */
export type SourceId = `${string}.${string}`

/** An activity event's notification kind: merges count as pull requests, forks as new repositories. */
export const ACTIVITY_KIND: Record<string, string> = { push: 'push', release: 'release', pr: 'pr', merge: 'pr', issue: 'issue', create: 'create', fork: 'create', comment: 'comment', star: 'star' }

/** How far back activity may be to still notify. */
export type ActivityWindow = '15m' | '1h' | '6h' | '1d' | '1w'
export const ACTIVITY_WINDOWS: [ActivityWindow, string, number][] = [
  ['15m', '15 minutes', 15 * 60_000],
  ['1h', '1 hour', 3600_000],
  ['6h', '6 hours', 6 * 3600_000],
  ['1d', '1 day', 864e5],
  ['1w', '1 week', 7 * 864e5],
]
export const activityWindowMs = (w: ActivityWindow) => ACTIVITY_WINDOWS.find(([id]) => id === w)?.[2] ?? 15 * 60_000

/** How long before an event its reminder comes, in minutes (0: when it starts). */
export const CALENDAR_LEADS = [0, 5, 10, 15, 30] as const
export type CalendarLead = (typeof CALENDAR_LEADS)[number]

/** How long the notification center keeps a notification. */
export type Keep = '1h' | '1d' | '1w' | '30d' | 'forever'
export const KEEP: [Keep, string, number][] = [
  ['1h', '1 hour', 3600_000],
  ['1d', '1 day', 864e5],
  ['1w', '1 week', 7 * 864e5],
  ['30d', '30 days', 30 * 864e5],
  ['forever', 'Until cleared', Infinity],
]
export const keepMs = (k: Keep) => KEEP.find(([id]) => id === k)?.[2] ?? 864e5 * 7

export type NotifyPrefs = {
  /** Pop-ups and push; off is do not disturb (the notification center still collects them) */
  popups: boolean
  keep: Keep
  /** A notification leaves the center once it is opened */
  removeOnOpen: boolean
  /** Apps ("minecraft") and kinds ("minecraft.players") that are switched off */
  off: string[]
  /** Activity older than this does not notify */
  activityWindow: ActivityWindow
  /** Minutes before an event that its reminder comes */
  calendarLead: CalendarLead
}

export const DEFAULT_PREFS: NotifyPrefs = { popups: true, keep: '1w', removeOnOpen: false, off: [], activityWindow: '15m', calendarLead: 10 }

/** Stored preferences (synced state "notify") made whole and valid, with `defaults` for what is missing. */
export function normalizePrefs(v: unknown, defaults: NotifyPrefs = DEFAULT_PREFS): NotifyPrefs {
  const s = { ...defaults, ...(v && typeof v === 'object' ? (v as Partial<NotifyPrefs>) : {}) }
  return {
    popups: s.popups !== false,
    keep: KEEP.some(([k]) => k === s.keep) ? s.keep : defaults.keep,
    removeOnOpen: s.removeOnOpen === true,
    off: Array.isArray(s.off) ? s.off.filter((x): x is string => typeof x === 'string').slice(0, 100) : [],
    activityWindow: ACTIVITY_WINDOWS.some(([k]) => k === s.activityWindow) ? s.activityWindow : defaults.activityWindow,
    calendarLead: (CALENDAR_LEADS as readonly number[]).includes(s.calendarLead) ? s.calendarLead : defaults.calendarLead,
  }
}

/** Whether these preferences let a source ("app.kind") notify: its app and its kind are both on. */
export const allows = (prefs: NotifyPrefs, source: string) => !prefs.off.includes(source.split('.')[0]) && !prefs.off.includes(source)

export const sourceOf = (source: string | undefined) => (source ? NOTIFY_SOURCES.find((s) => s.app === source.split('.')[0]) : undefined)

/** What opening a notification does: an app, with props. Kept with it, so it works after a reload. */
export type NoticeAction = { app: string; props?: Record<string, string> }

/** The address a push message opens (the service worker opens it when MvL OS isn't running). */
export function actionUrl(action: NoticeAction | undefined): string {
  if (!action) return '/'
  const thread = action.app === 'agents' ? action.props?.thread : undefined
  return `/?open=${encodeURIComponent(action.app)}${thread ? `&thread=${encodeURIComponent(thread)}` : ''}`
}

/** A notification as kept in the notification center (the server's list, or this browser's). */
export type Entry = { id: string; title: string; body?: string; icon?: string; action?: NoticeAction; source?: SourceId; at: number; read: boolean }
