import { snapReserve } from './dockPrefs'
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { appHere } from './cvMode'
import { synced } from './synced'
import { startupPrefs } from './startup'

export type AppId = 'terminal' | 'files' | 'viewer' | 'preview' | 'player' | 'pdf' | 'archive' | 'office' | 'newdoc' | 'newsheet' | 'newslides' | 'notes' | 'keys' | 'projects' | 'recents' | 'cv' | 'contact' | 'games' | 'zed' | 'trash' | 'notebook' | 'widget' | 'settings' | 'mcserver' | 'linkforge' | 'calendar' | 'agents' | 'amp' | 'tasks' | 'contacts'

export type WinState = {
  pid: number
  app: AppId
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized: boolean
  maximized: boolean
  /** Bumped when an already-open app is asked to show something else (e.g. a project) */
  props: Record<string, string | undefined>
  openedAt: number
  /** Set while the window is snapped to a half or quarter of the screen */
  snap?: SnapZone
  /** The geometry to go back to when a snapped window is dragged away */
  restore?: Geometry
  /**
   * Where and how big the window was put (by dragging, resizing or a saved layout), before
   * fitting it to a smaller screen. Saved instead of the fitted geometry, so a visit from a small
   * window does not shrink every window for good.
   */
  want?: Geometry
  /**
   * The note's place in the phone layout's column of notes (stackOrder), once it has been moved
   * there by hand. Only the phone layout reads it; free-standing notes on a big screen ignore it.
   */
  stack?: number
  /**
   * The workspace the window lives on (1 to WORKSPACES). Notes and widgets have none: they are
   * part of the desktop and show on every workspace. Windows saved before workspaces are on 1.
   */
  ws?: number
}

/** How many workspaces there are, numbered from 1 like Omarchy's (Alt+1 to Alt+9 reach them all). */
export const WORKSPACES = 9

export type SnapZone = 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br'

const GAP = 10 // Omarchy's gaps_out; windows next to each other get the same gap between them
const BAR = 28

/** Where a snapped window goes, for the current viewport. */
export function snapRect(zone: SnapZone, vw = window.innerWidth, vh = window.innerHeight): Geometry {
  const x0 = GAP
  const y0 = BAR + GAP
  const w = vw - 2 * GAP
  const h = vh - BAR - 2 * GAP - snapReserve()
  const hw = Math.floor((w - GAP) / 2)
  const hh = Math.floor((h - GAP) / 2)
  const right = x0 + hw + GAP
  const bottom = y0 + hh + GAP
  switch (zone) {
    case 'left':
      return { x: x0, y: y0, w: hw, h }
    case 'right':
      return { x: right, y: y0, w: w - hw - GAP, h }
    case 'tl':
      return { x: x0, y: y0, w: hw, h: hh }
    case 'tr':
      return { x: right, y: y0, w: w - hw - GAP, h: hh }
    case 'bl':
      return { x: x0, y: bottom, w: hw, h: h - hh - GAP }
    case 'br':
      return { x: right, y: bottom, w: w - hw - GAP, h: h - hh - GAP }
  }
}

export type GeometryPatch = Partial<Geometry> & { snap?: SnapZone; restore?: Geometry; maximized?: boolean }

export type Geometry = { x: number; y: number; w: number; h: number }

/** Apps that only ever have one window; everything else can be opened again with "New window". */
export const SINGLE_INSTANCE = new Set<AppId>(['amp', 'notes', 'keys', 'trash', 'notebook', 'settings', 'mcserver', 'linkforge'])

/** Apps where opening always means a new one (New Document makes a new file each time); `create` says it is fresh. */
export const ALWAYS_NEW = new Set<AppId>(['newdoc', 'newsheet', 'newslides'])

/**
 * Apps whose windows each show one thing, named by this prop: opening the app with it focuses the
 * window already showing that thing, or opens another one (the arcade's games: one window per
 * game). Windows without it (the arcade itself) are reused among themselves as usual.
 */
export const INSTANCE_PROP: Partial<Record<AppId, string>> = { games: 'game' }

type Action =
  | { type: 'open'; app: AppId; geometry: Geometry; props?: WinState['props']; newInstance?: boolean }
  | { type: 'close'; pid: number }
  | { type: 'focus'; pid: number }
  | { type: 'minimize'; pid: number }
  | { type: 'toggleMax'; pid: number }
  | { type: 'setGeometry'; pid: number; geometry: GeometryPatch }
  | { type: 'setProps'; pid: number; props: WinState['props'] }
  | { type: 'restack'; pids: number[] }
  | { type: 'viewport'; width: number; height: number; layout: { app: AppId; geometry: Geometry }[] }
  | { type: 'reset'; layout: { app: AppId; geometry: Geometry; props?: WinState['props'] }[] }
  | { type: 'restore'; windows: SavedWindow[] }
  | { type: 'workspace'; n: number }
  | { type: 'moveTo'; pid: number; n: number }

/** `touched` flips once the visitor moves, resizes or opens something; until then a viewport
 * change re-applies the opening layout instead of just clamping. `focused` is the window that
 * last received focus; it falls back to the frontmost one when that window closes or minimizes. */
type State = {
  windows: WinState[]
  nextPid: number
  topZ: number
  touched: boolean
  focused: number | null
  /** The workspace on screen. */
  ws: number
  /** Phone-sized screen: there is one workspace's worth of room, so every window counts as shown. */
  phone: boolean
  /** Counts what the visitor did (open, close, move, focus...), not what the screen size did to
   * the windows: only those changes are saved, so two screens don't keep overwriting each other. */
  edits: number
}

/** Actions that are the visitor's own doing (as opposed to a viewport change or a restore). */
const USER_ACTIONS = new Set<Action['type']>(['open', 'close', 'focus', 'minimize', 'toggleMax', 'setGeometry', 'setProps', 'restack', 'moveTo'])

const isPhone = () => window.innerWidth < 720

/** The workspace a window lives on, or null for notes and widgets (they are on all of them). */
export const workspaceOf = (w: Pick<WinState, 'app' | 'ws'>): number | null => (NOTE_APPS.has(w.app) ? null : (w.ws ?? 1))

/** Whether a window is on the screen's workspace (minimized or not): always on a phone, where
 * every window is reachable as if there were just one workspace. */
const onScreen = (state: Pick<State, 'ws' | 'phone'>, w: WinState) => state.phone || workspaceOf(w) === null || workspaceOf(w) === state.ws

/** The frontmost window that shows on the current workspace, for focus to fall back to. */
const topShown = (state: Pick<State, 'ws' | 'phone'>, windows: WinState[]) =>
  windows.filter((w) => !w.minimized && onScreen(state, w)).reduce<WinState | null>((a, w) => (!a || w.z > a.z ? w : a), null)

// Which workspace is on screen is this browser's own business (another device can be looking at
// a different one), so it is kept here rather than in the synced window layout.
const WS_KEY = 'mvlos.workspace'
function savedWorkspace(): number {
  try {
    const n = Number(localStorage.getItem(WS_KEY))
    return Number.isInteger(n) && n >= 1 && n <= WORKSPACES ? n : 1
  } catch {
    return 1
  }
}
function saveWorkspace(n: number) {
  try {
    localStorage.setItem(WS_KEY, String(n))
  } catch {
    /* not kept */
  }
}


/** Opens the opening layout on an empty desk, as if nobody had touched it yet. */
function fresh(layout: { app: AppId; geometry: Geometry; props?: WinState['props'] }[]): State {
  let s: State = { windows: [], nextPid: 100, topZ: 10, touched: false, focused: null, ws: 1, phone: isPhone(), edits: 0 }
  for (const w of layout) s = reducer(s, { type: 'open', app: w.app, geometry: w.geometry, props: w.props })
  return { ...s, touched: false, edits: 0 }
}

// ---------------------------------------------------------------------------------------------
// Saved layouts: which windows are open, where, and what they show. Phones and bigger screens
// keep separate layouts, since one rarely fits the other.

export type SavedWindow = Geometry & Pick<WinState, 'app' | 'minimized' | 'maximized' | 'snap' | 'restore' | 'props' | 'stack' | 'ws'>

/** Saved layouts from before widgets: a sticky was its own app. */
function migrate(w: SavedWindow): SavedWindow {
  return (w.app as string) === 'sticky' ? { ...w, app: 'widget', props: { kind: 'sticky', id: w.props.id } } : w
}

/** Props that only make sense once: commands to run, "open this now" stamps, placement hints. */
const TRANSIENT_PROPS = new Set(['run', 't', 'under', 'create', 'unsaved'])

type LayoutStore = ReturnType<typeof synced<SavedWindow[] | null>>
let layout: LayoutStore | null = null
/** The saved layout for the kind of screen this page loaded on (null: the opening layout). It
 * stays the same store when the window is resized, so a narrowed desktop doesn't overwrite the
 * phone layout. */
export function layoutStore(): LayoutStore {
  // When this device and another both changed the layout, the change just made here wins.
  layout ??= synced<SavedWindow[] | null>(`windows:${window.innerWidth < 720 ? 'mobile' : 'desktop'}`, null, { merge: (local) => local })
  return layout
}

function serialize(windows: WinState[]): SavedWindow[] {
  return windows
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((w) => ({
      app: w.app,
      x: Math.round(w.want?.x ?? w.x),
      y: Math.round(w.want?.y ?? w.y),
      w: Math.round(w.want?.w ?? w.w),
      h: Math.round(w.want?.h ?? w.h),
      minimized: w.minimized,
      maximized: w.maximized,
      snap: w.snap,
      restore: w.restore,
      stack: w.stack,
      ws: workspaceOf(w) ?? undefined,
      props: Object.fromEntries(Object.entries(w.props).filter(([k, v]) => v !== undefined && !TRANSIENT_PROPS.has(k))),
    }))
}

/** A state showing `saved`. Windows already open that match one (same app, same props) keep
 * their pid, so their app keeps running (a terminal keeps its history) and just moves. */
function restored(saved: SavedWindow[], current: WinState[] = [], ws = 1): State {
  const unused = current.slice()
  const key = (w: { app: AppId; props: WinState['props'] }) => `${w.app}|${JSON.stringify(Object.entries(w.props).filter(([k, v]) => v !== undefined && !TRANSIENT_PROPS.has(k)).sort())}`
  let pid = Math.max(100, ...current.map((w) => w.pid + 1))
  let z = 10
  const windows: WinState[] = saved.map((w) => {
    const i = unused.findIndex((u) => key(u) === key(w))
    const same = i >= 0 ? unused.splice(i, 1)[0] : null
    const want = { x: w.x, y: w.y, w: w.w, h: w.h }
    w = { ...w, ws: NOTE_APPS.has(w.app) ? undefined : Math.min(WORKSPACES, Math.max(1, Math.round(w.ws ?? 1))) }
    return same ? { ...same, ...w, want, props: same.props, pid: same.pid, z: ++z } : { ...w, want, props: { ...w.props }, pid: pid++, z: ++z, openedAt: Date.now() }
  })
  const view = { ws, phone: isPhone() }
  return { windows, nextPid: pid, topZ: z, touched: true, focused: topShown(view, windows)?.pid ?? null, ...view, edits: 0 }
}

function reducer(state: State, action: Action): State {
  const next = apply(state, action)
  return next !== state && USER_ACTIONS.has(action.type) ? { ...next, edits: state.edits + 1 } : next
}

function apply(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return fresh(action.layout)
    case 'restore':
      return restored(action.windows, state.windows, state.ws)
    case 'workspace': {
      const n = Math.min(WORKSPACES, Math.max(1, action.n))
      if (n === state.ws) return state
      return { ...state, ws: n, focused: topShown({ ...state, ws: n }, state.windows)?.pid ?? null }
    }
    case 'moveTo': {
      // Like Hyprland's movetoworkspace: the window goes, and the screen follows it there.
      const target = state.windows.find((w) => w.pid === action.pid)
      const n = Math.min(WORKSPACES, Math.max(1, action.n))
      if (!target || NOTE_APPS.has(target.app)) return state
      const z = state.topZ + 1
      const windows = state.windows.map((w) => (w.pid === action.pid ? { ...w, ws: n, z } : w))
      return { ...state, touched: true, topZ: z, ws: n, windows, focused: target.minimized ? (topShown({ ...state, ws: n }, windows)?.pid ?? null) : target.pid }
    }
    case 'open': {
      // Reuse the app's frontmost window unless a new one was asked for. An app with an instance
      // prop only reuses the window showing the same thing, and a thing never gets a second window.
      const key = INSTANCE_PROP[action.app]
      const thing = key ? action.props?.[key] : undefined
      const existing = action.newInstance && !SINGLE_INSTANCE.has(action.app) && thing === undefined
        ? undefined
        : state.windows.filter((w) => w.app === action.app && (!key || w.props[key] === thing)).sort((a, b) => b.z - a.z)[0]
      const z = state.topZ + 1
      if (existing) {
        // That window keeps its own props (a game's session), with the new ones on top.
        const props = !action.props ? existing.props : thing !== undefined ? { ...existing.props, ...action.props } : { ...action.props }
        return {
          ...state,
          touched: true,
          topZ: z,
          // Its workspace comes on screen with it.
          ws: workspaceOf(existing) ?? state.ws,
          focused: existing.pid,
          windows: state.windows.map((w) => (w.pid === existing.pid ? { ...w, z, minimized: false, props } : w)),
        }
      }
      const win: WinState = {
        pid: state.nextPid,
        app: action.app,
        ...action.geometry,
        z,
        minimized: false,
        maximized: false,
        props: action.props ?? {},
        openedAt: Date.now(),
        // New windows open on the workspace on screen; notes and widgets belong to all of them.
        ws: NOTE_APPS.has(action.app) ? undefined : state.ws,
      }
      return { ...state, touched: true, focused: win.pid, windows: [...state.windows, win], nextPid: state.nextPid + 1, topZ: z }
    }
    case 'close':
      return { ...state, focused: state.focused === action.pid ? null : state.focused, windows: state.windows.filter((w) => w.pid !== action.pid) }
    case 'focus': {
      const target = state.windows.find((w) => w.pid === action.pid)
      if (!target) return state
      const ws = workspaceOf(target) ?? state.ws
      if (target.z === state.topZ && !target.minimized && ws === state.ws) return state.focused === action.pid ? state : { ...state, focused: action.pid }
      const z = state.topZ + 1
      // Focusing a window on another workspace (from the dock, Spotlight) goes there.
      return { ...state, topZ: z, ws, focused: action.pid, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, z, minimized: false } : w)) }
    }
    case 'minimize':
      return { ...state, focused: state.focused === action.pid ? null : state.focused, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, minimized: true } : w)) }
    case 'toggleMax':
      return { ...state, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, maximized: !w.maximized } : w)) }
    case 'setGeometry':
      return {
        ...state,
        touched: true,
        windows: state.windows.map((w) => {
          if (w.pid !== action.pid) return w
          const next = { ...w, ...action.geometry }
          // Moved or resized by hand (not snapped or maximized): that is where it should be from now on.
          return next.snap || next.maximized ? next : { ...next, want: { x: next.x, y: next.y, w: next.w, h: next.h } }
        }),
      }
    case 'setProps':
      return { ...state, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, props: { ...w.props, ...action.props } } : w)) }
    case 'restack': {
      const at = new Map(action.pids.map((pid, i) => [pid, i]))
      return { ...state, touched: true, windows: state.windows.map((w) => (at.has(w.pid) ? { ...w, stack: at.get(w.pid) } : w)) }
    }
    case 'viewport': {
      const { width, height } = action
      return {
        ...state,
        phone: width < 720,
        windows: state.windows.map((w) => {
          if (w.snap) return { ...w, ...snapRect(w.snap, width, height) }
          const fresh = !state.touched && action.layout.find((l) => l.app === w.app)
          // Fitted from where it was put, not from an earlier fitting: a bigger screen gets it back as it was.
          const g = fresh ? fresh.geometry : (w.want ?? w)
          if (NOTE_APPS.has(w.app) && !w.maximized) return { ...w, want: fresh ? undefined : (w.want ?? { x: w.x, y: w.y, w: w.w, h: w.h }), ...fitNote(g, width, height, drawnHeights.get(w.pid)) }
          const ww = Math.max(240, Math.min(g.w, width - 16))
          const hh = Math.max(160, Math.min(g.h, height - 140))
          return { ...w, want: fresh ? undefined : (w.want ?? { x: w.x, y: w.y, w: w.w, h: w.h }), w: ww, h: hh, x: Math.min(Math.max(g.x, 8 - ww + 120), width - 120), y: Math.min(Math.max(g.y, 40), height - 80) }
        }),
      }
    }
  }
}

/** Notes (the headline note, the shortcuts, sticky and other widgets): the windows with note chrome. */
export const NOTE_APPS = new Set<AppId>(['notes', 'keys', 'widget'])

/**
 * The notes in the order the phone layout stacks them, top to bottom: the ones moved by hand by
 * their place (stack), then the rest in the order they are kept in (the order they were opened),
 * so a note added later goes to the bottom.
 */
export function stackOrder(windows: WinState[]): number[] {
  return windows
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => NOTE_APPS.has(w.app))
    .sort((a, b) => (a.w.stack ?? Infinity) - (b.w.stack ?? Infinity) || a.i - b.i)
    .map(({ w }) => w.pid)
}
/** How tall each note is drawn (pid → px): a long note runs on below its box (Window.tsx measures it). */
const drawnHeights = new Map<number, number>()
export const drawnHeight = (pid: number) => drawnHeights.get(pid)
export function setDrawnHeight(pid: number, h: number | null) {
  if (h === null) drawnHeights.delete(pid)
  else drawnHeights.set(pid, h)
}

/** Room around a note: notes hang at a slant of up to 3.5°, which takes their corners ~12px out. */
const NOTE_MARGIN = 16
const NOTE_TOP = 28 + NOTE_MARGIN

/**
 * Where a note goes on a screen of this size: never hanging off an edge, made smaller when the
 * screen is smaller than the note. Phones scroll the desktop down, so there a note only has to
 * fit across and below the top bar.
 */
export function fitNote(g: Geometry, width: number, height: number, drawn = g.h): Geometry {
  const phone = width < 720
  const w = Math.max(160, Math.min(g.w, width - 2 * NOTE_MARGIN))
  const h = phone ? g.h : Math.max(140, Math.min(g.h, height - NOTE_TOP - NOTE_MARGIN))
  // Kept clear of the bottom by what shows, which can be more than its box.
  const shown = Math.max(h, drawn)
  return {
    w,
    h,
    x: Math.max(NOTE_MARGIN, Math.min(g.x, width - w - NOTE_MARGIN)),
    y: phone ? Math.max(g.y, NOTE_TOP) : Math.max(NOTE_TOP, Math.min(g.y, height - shown - NOTE_MARGIN)),
  }
}

type WM = {
  windows: WinState[]
  focusedPid: number | null
  /** Focuses the app's frontmost window (passing it `props`), or opens one if none is open. */
  open: (app: AppId, props?: WinState['props']) => void
  /** Always opens another window, except for single-instance apps. */
  openNew: (app: AppId, props?: WinState['props']) => void
  close: (pid: number) => void
  /** Raises and focuses a window. */
  focus: (pid: number) => void
  minimize: (pid: number) => void
  toggleMax: (pid: number) => void
  setGeometry: (pid: number, geometry: GeometryPatch) => void
  /** A window changing what it shows itself (Preview going to the next picture): its title and saved layout follow. */
  setProps: (pid: number, props: WinState['props']) => void
  /** Puts the notes in this order in the phone layout's column (pids, top to bottom). */
  restack: (pids: number[]) => void
  /** Closes everything and opens the opening layout again (after a reboot), or nothing at all. */
  reset: (empty?: boolean) => void
  /** Fits the windows to the screen again (a note that turned out taller than its box). */
  refit: () => void
  /** The workspace on screen (1 to WORKSPACES). */
  workspace: number
  /** Puts another workspace on screen; its windows show and the others' hide (they keep running). */
  setWorkspace: (n: number) => void
  /** Moves a window to a workspace and goes there with it. Notes and widgets stay on all of them. */
  moveToWorkspace: (pid: number, n: number) => void
  /** Whether a window is on the workspace on screen (minimized or not). Always true on a phone,
   * which shows every window as if there were one workspace. */
  shown: (w: WinState) => boolean
  /** Whether workspaces are in use: not on a phone. */
  workspaces: boolean
}

const Ctx = createContext<WM | null>(null)

/**
 * Windows that want a say before they close (Agents while a thread is answering): the guard
 * answers whether to close after all. Set by the window itself, removed when it unmounts.
 */
const closeGuards = new Map<number, () => Promise<boolean> | boolean>()
const asking = new Set<number>()
export function setCloseGuard(pid: number, guard: (() => Promise<boolean> | boolean) | null) {
  if (guard) closeGuards.set(pid, guard)
  else closeGuards.delete(pid)
}
/** Files' trash view (see apps/Files.tsx). */
const TRASH_PATH = 'trash://'

export function WindowManagerProvider({
  children,
  initial: relayout,
  placement,
  isApp,
}: {
  children: ReactNode
  initial: () => { app: AppId; geometry: Geometry; props?: WinState['props'] }[]
  placement: (app: AppId, openCount: number, props?: WinState['props']) => Geometry
  /** Filters saved layouts down to apps that still exist. */
  isApp: (app: string) => boolean
}) {
  const usable = useCallback((saved: SavedWindow[] | null) => saved?.map(migrate).filter((w) => isApp(w.app)) ?? null, [isApp])
  const [state, dispatch] = useReducer(reducer, null, () => {
    // Settings → Windows: last time's windows, the welcome windows, or an empty desktop.
    const start = startupPrefs().windows
    if (start === 'empty') return fresh([])
    const saved = start === 'last' ? usable(layoutStore().get()) : null
    return saved ? restored(saved, [], savedWorkspace()) : fresh(relayout())
  })

  // A phone shows every window as one workspace, so it leaves the desktop's choice alone.
  useEffect(() => {
    if (!state.phone) saveWorkspace(state.ws)
  }, [state.ws, state.phone])

  const stateRef = useRef(state)
  stateRef.current = state

  // Save what the visitor did (debounced), not what fitting the windows to this screen did. A
  // newer layout from another device replaces this one unless there is an unsaved change here;
  // the synced store has already checked that it really is newer than what this tab saved.
  const savedEdits = useRef(0)
  const saveNow = useCallback(() => {
    if (stateRef.current.edits === savedEdits.current) return
    // Starting with the welcome windows or nothing: the layout saved before stays as it was, for
    // when Last windows is chosen again (and other devices keep theirs).
    if (startupPrefs().windows !== 'last') return
    savedEdits.current = stateRef.current.edits
    layoutStore().set(serialize(stateRef.current.windows))
  }, [])
  useEffect(() => {
    if (state.edits === savedEdits.current) return
    const t = setTimeout(saveNow, 400)
    return () => clearTimeout(t)
  }, [state.edits, saveNow])
  // Closing the tab (or switching away) right after closing a window must not lose that: save
  // straight away. Capturing, so it runs before the synced stores send their last saves.
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && saveNow()
    document.addEventListener('visibilitychange', onHide, true)
    window.addEventListener('pagehide', saveNow, true)
    return () => {
      document.removeEventListener('visibilitychange', onHide, true)
      window.removeEventListener('pagehide', saveNow, true)
    }
  }, [saveNow])
  useEffect(
    () =>
      layoutStore().onRemote((saved) => {
        if (stateRef.current.edits !== savedEdits.current) return
        // Starting fresh each time means not taking another device's windows either.
        if (startupPrefs().windows !== 'last') return
        const next = usable(saved)
        if (next) {
          savedEdits.current = 0
          dispatch({ type: 'restore', windows: next })
        }
      }),
    [usable],
  )

  // "Trash" is a place, not an app: it opens in Files (whose trash:// view lists trashed items).
  const open = useCallback(
    (app: AppId, props?: WinState['props']) => {
      // A CV app asked for away from /cv (an old link, a widget): it lives on the CV page.
      if (!appHere(app)) return location.assign(`/cv?open=${app}`)
      if (app === 'trash') return dispatch({ type: 'open', app: 'files', props: { path: TRASH_PATH, t: String(Date.now()) }, geometry: placement('files', state.windows.length) })
      if (ALWAYS_NEW.has(app)) return dispatch({ type: 'open', app, props: { ...props, create: String(Date.now()) }, newInstance: true, geometry: placement(app, state.windows.length, props) })
      dispatch({ type: 'open', app, props, geometry: placement(app, state.windows.length, props) })
    },
    [placement, state.windows.length],
  )
  const openNew = useCallback(
    (app: AppId, props?: WinState['props']) => {
      // A CV app asked for away from /cv (an old link, a widget): it lives on the CV page.
      if (!appHere(app)) return location.assign(`/cv?open=${app}`)
      if (app === 'trash') return dispatch({ type: 'open', app: 'files', props: { path: TRASH_PATH }, newInstance: true, geometry: placement('files', state.windows.length) })
      dispatch({ type: 'open', app, props: ALWAYS_NEW.has(app) ? { ...props, create: String(Date.now()) } : props, newInstance: true, geometry: placement(app, state.windows.length, props) })
    },
    [placement, state.windows.length],
  )

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(t)
      t = setTimeout(() => dispatch({ type: 'viewport', width: window.innerWidth, height: window.innerHeight, layout: relayout() }), 120)
    }
    // The first layout can run before the viewport has its final size (embedded previews, slow paints).
    onResize()
    window.addEventListener('resize', onResize)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [relayout])

  const value = useMemo<WM>(() => {
    const visible = state.windows.filter((w) => !w.minimized && onScreen(state, w))
    const top = topShown(state, state.windows)
    const focused = visible.some((w) => w.pid === state.focused) ? state.focused : (top?.pid ?? null)
    return {
      windows: state.windows,
      focusedPid: focused,
      open,
      openNew,
      close: (pid) => {
        const guard = closeGuards.get(pid)
        if (!guard) return dispatch({ type: 'close', pid })
        if (asking.has(pid)) return // its question is already on screen
        asking.add(pid)
        Promise.resolve()
          .then(guard)
          .catch(() => true)
          .then((ok) => ok && dispatch({ type: 'close', pid }))
          .finally(() => asking.delete(pid))
      },
      focus: (pid) => dispatch({ type: 'focus', pid }),
      minimize: (pid) => dispatch({ type: 'minimize', pid }),
      toggleMax: (pid) => dispatch({ type: 'toggleMax', pid }),
      setGeometry: (pid, geometry) => dispatch({ type: 'setGeometry', pid, geometry }),
      setProps: (pid, props) => dispatch({ type: 'setProps', pid, props }),
      restack: (pids) => dispatch({ type: 'restack', pids }),
      refit: () => dispatch({ type: 'viewport', width: window.innerWidth, height: window.innerHeight, layout: relayout() }),
      workspace: state.ws,
      setWorkspace: (n) => dispatch({ type: 'workspace', n }),
      moveToWorkspace: (pid, n) => dispatch({ type: 'moveTo', pid, n }),
      shown: (w) => onScreen(state, w),
      workspaces: !state.phone,
      reset: (empty) => {
        dispatch({ type: 'reset', layout: empty ? [] : relayout() })
        savedEdits.current = 0
        layoutStore().set(null)
      },
    }
  }, [state.windows, state.focused, state.ws, state.phone, open, openNew, relayout])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * A window manager with one window that is the whole page: a game opened by its direct link
 * (/play/<game>, src/apps/games/Play.tsx), without the desktop around it. The game sees the window
 * manager it expects (its window always focused, so its keys work), and the page has no other
 * windows to move, close or switch to, so those do nothing. Opening an app leaves for MvL OS.
 */
export function SoloWindowProvider({ win, children }: { win: WinState; children: ReactNode }) {
  const value = useMemo<WM>(() => {
    const none = () => {}
    return {
      windows: [win],
      focusedPid: win.pid,
      open: (app, props) => location.assign(app === 'games' && props?.game ? `/play/${encodeURIComponent(props.game)}` : '/'),
      openNew: (app, props) => location.assign(app === 'games' && props?.game ? `/play/${encodeURIComponent(props.game)}` : '/'),
      close: none,
      focus: none,
      minimize: none,
      toggleMax: none,
      setGeometry: none,
      setProps: none,
      restack: none,
      reset: none,
      refit: none,
      workspace: 1,
      setWorkspace: none,
      moveToWorkspace: none,
      shown: () => true,
      workspaces: false,
    }
  }, [win])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWM() {
  const wm = useContext(Ctx)
  if (!wm) throw new Error('useWM outside WindowManagerProvider')
  return wm
}
