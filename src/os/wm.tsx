import { snapReserve } from './dockPrefs'
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { synced } from './synced'

export type AppId = 'terminal' | 'files' | 'viewer' | 'notes' | 'keys' | 'projects' | 'recents' | 'cv' | 'contact' | 'games' | 'zed' | 'trash' | 'notebook' | 'widget' | 'settings' | 'mcserver' | 'linkforge' | 'calendar'

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
}

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
export const SINGLE_INSTANCE = new Set<AppId>(['notes', 'keys', 'trash', 'notebook', 'settings', 'mcserver', 'linkforge'])

type Action =
  | { type: 'open'; app: AppId; geometry: Geometry; props?: WinState['props']; newInstance?: boolean }
  | { type: 'close'; pid: number }
  | { type: 'focus'; pid: number }
  | { type: 'minimize'; pid: number }
  | { type: 'toggleMax'; pid: number }
  | { type: 'setGeometry'; pid: number; geometry: GeometryPatch }
  | { type: 'viewport'; width: number; height: number; layout: { app: AppId; geometry: Geometry }[] }
  | { type: 'reset'; layout: { app: AppId; geometry: Geometry; props?: WinState['props'] }[] }
  | { type: 'restore'; windows: SavedWindow[] }

/** `touched` flips once the visitor moves, resizes or opens something; until then a viewport
 * change re-applies the opening layout instead of just clamping. `focused` is the window that
 * last received focus; it falls back to the frontmost one when that window closes or minimizes. */
type State = {
  windows: WinState[]
  nextPid: number
  topZ: number
  touched: boolean
  focused: number | null
  /** Counts what the visitor did (open, close, move, focus...), not what the screen size did to
   * the windows: only those changes are saved, so two screens don't keep overwriting each other. */
  edits: number
}

/** Actions that are the visitor's own doing (as opposed to a viewport change or a restore). */
const USER_ACTIONS = new Set<Action['type']>(['open', 'close', 'focus', 'minimize', 'toggleMax', 'setGeometry'])


/** Opens the opening layout on an empty desk, as if nobody had touched it yet. */
function fresh(layout: { app: AppId; geometry: Geometry; props?: WinState['props'] }[]): State {
  let s: State = { windows: [], nextPid: 100, topZ: 10, touched: false, focused: null, edits: 0 }
  for (const w of layout) s = reducer(s, { type: 'open', app: w.app, geometry: w.geometry, props: w.props })
  return { ...s, touched: false, edits: 0 }
}

// ---------------------------------------------------------------------------------------------
// Saved layouts: which windows are open, where, and what they show. Phones and bigger screens
// keep separate layouts, since one rarely fits the other.

export type SavedWindow = Geometry & Pick<WinState, 'app' | 'minimized' | 'maximized' | 'snap' | 'restore' | 'props'>

/** Saved layouts from before widgets: a sticky was its own app. */
function migrate(w: SavedWindow): SavedWindow {
  return (w.app as string) === 'sticky' ? { ...w, app: 'widget', props: { kind: 'sticky', id: w.props.id } } : w
}

/** Props that only make sense once: commands to run, "open this now" stamps, placement hints. */
const TRANSIENT_PROPS = new Set(['run', 't', 'under'])

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
      x: Math.round(w.x),
      y: Math.round(w.y),
      w: Math.round(w.w),
      h: Math.round(w.h),
      minimized: w.minimized,
      maximized: w.maximized,
      snap: w.snap,
      restore: w.restore,
      props: Object.fromEntries(Object.entries(w.props).filter(([k, v]) => v !== undefined && !TRANSIENT_PROPS.has(k))),
    }))
}

/** A state showing `saved`. Windows already open that match one (same app, same props) keep
 * their pid, so their app keeps running (a terminal keeps its history) and just moves. */
function restored(saved: SavedWindow[], current: WinState[] = []): State {
  const unused = current.slice()
  const key = (w: { app: AppId; props: WinState['props'] }) => `${w.app}|${JSON.stringify(Object.entries(w.props).filter(([k, v]) => v !== undefined && !TRANSIENT_PROPS.has(k)).sort())}`
  let pid = Math.max(100, ...current.map((w) => w.pid + 1))
  let z = 10
  const windows: WinState[] = saved.map((w) => {
    const i = unused.findIndex((u) => key(u) === key(w))
    const same = i >= 0 ? unused.splice(i, 1)[0] : null
    return same ? { ...same, ...w, props: same.props, pid: same.pid, z: ++z } : { ...w, props: { ...w.props }, pid: pid++, z: ++z, openedAt: Date.now() }
  })
  const top = windows.filter((w) => !w.minimized).at(-1)
  return { windows, nextPid: pid, topZ: z, touched: true, focused: top?.pid ?? null, edits: 0 }
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
      return restored(action.windows, state.windows)
    case 'open': {
      // Reuse the app's frontmost window unless a new one was asked for.
      const existing = action.newInstance && !SINGLE_INSTANCE.has(action.app)
        ? undefined
        : state.windows.filter((w) => w.app === action.app).sort((a, b) => b.z - a.z)[0]
      const z = state.topZ + 1
      if (existing) {
        return {
          ...state,
          touched: true,
          topZ: z,
          focused: existing.pid,
          windows: state.windows.map((w) =>
            w.pid === existing.pid ? { ...w, z, minimized: false, props: action.props ? { ...action.props } : w.props } : w,
          ),
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
      }
      return { ...state, touched: true, focused: win.pid, windows: [...state.windows, win], nextPid: state.nextPid + 1, topZ: z }
    }
    case 'close':
      return { ...state, focused: state.focused === action.pid ? null : state.focused, windows: state.windows.filter((w) => w.pid !== action.pid) }
    case 'focus': {
      const target = state.windows.find((w) => w.pid === action.pid)
      if (!target) return state
      if (target.z === state.topZ && !target.minimized) return state.focused === action.pid ? state : { ...state, focused: action.pid }
      const z = state.topZ + 1
      return { ...state, topZ: z, focused: action.pid, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, z, minimized: false } : w)) }
    }
    case 'minimize':
      return { ...state, focused: state.focused === action.pid ? null : state.focused, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, minimized: true } : w)) }
    case 'toggleMax':
      return { ...state, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, maximized: !w.maximized } : w)) }
    case 'setGeometry':
      return { ...state, touched: true, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, ...action.geometry } : w)) }
    case 'viewport': {
      const { width, height } = action
      return {
        ...state,
        windows: state.windows.map((w) => {
          if (w.snap) return { ...w, ...snapRect(w.snap, width, height) }
          const fresh = !state.touched && action.layout.find((l) => l.app === w.app)
          const g = fresh ? fresh.geometry : w
          const ww = Math.max(240, Math.min(g.w, width - 16))
          const hh = Math.max(160, Math.min(g.h, height - 140))
          return { ...w, w: ww, h: hh, x: Math.min(Math.max(g.x, 8 - ww + 120), width - 120), y: Math.min(Math.max(g.y, 40), height - 80) }
        }),
      }
    }
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
  /** Closes everything and opens the opening layout again (after a reboot), or nothing at all. */
  reset: (empty?: boolean) => void
}

const Ctx = createContext<WM | null>(null)
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
  placement: (app: AppId, openCount: number) => Geometry
  /** Filters saved layouts down to apps that still exist. */
  isApp: (app: string) => boolean
}) {
  const usable = useCallback((saved: SavedWindow[] | null) => saved?.map(migrate).filter((w) => isApp(w.app)) ?? null, [isApp])
  const [state, dispatch] = useReducer(reducer, null, () => {
    const saved = usable(layoutStore().get())
    return saved ? restored(saved) : fresh(relayout())
  })

  const stateRef = useRef(state)
  stateRef.current = state

  // Save what the visitor did (debounced), not what fitting the windows to this screen did. A
  // newer layout from another device replaces this one unless there is an unsaved change here;
  // the synced store has already checked that it really is newer than what this tab saved.
  const savedEdits = useRef(0)
  useEffect(() => {
    if (state.edits === savedEdits.current) return
    const t = setTimeout(() => {
      savedEdits.current = stateRef.current.edits
      layoutStore().set(serialize(stateRef.current.windows))
    }, 400)
    return () => clearTimeout(t)
  }, [state.edits])
  useEffect(
    () =>
      layoutStore().onRemote((saved) => {
        if (stateRef.current.edits !== savedEdits.current) return
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
      if (app === 'trash') return dispatch({ type: 'open', app: 'files', props: { path: TRASH_PATH, t: String(Date.now()) }, geometry: placement('files', state.windows.length) })
      dispatch({ type: 'open', app, props, geometry: placement(app, state.windows.length) })
    },
    [placement, state.windows.length],
  )
  const openNew = useCallback(
    (app: AppId, props?: WinState['props']) => {
      if (app === 'trash') return dispatch({ type: 'open', app: 'files', props: { path: TRASH_PATH }, newInstance: true, geometry: placement('files', state.windows.length) })
      dispatch({ type: 'open', app, props, newInstance: true, geometry: placement(app, state.windows.length) })
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
    const visible = state.windows.filter((w) => !w.minimized)
    const top = visible.reduce<WinState | null>((a, w) => (!a || w.z > a.z ? w : a), null)
    const focused = visible.some((w) => w.pid === state.focused) ? state.focused : (top?.pid ?? null)
    return {
      windows: state.windows,
      focusedPid: focused,
      open,
      openNew,
      close: (pid) => dispatch({ type: 'close', pid }),
      focus: (pid) => dispatch({ type: 'focus', pid }),
      minimize: (pid) => dispatch({ type: 'minimize', pid }),
      toggleMax: (pid) => dispatch({ type: 'toggleMax', pid }),
      setGeometry: (pid, geometry) => dispatch({ type: 'setGeometry', pid, geometry }),
      reset: (empty) => {
        dispatch({ type: 'reset', layout: empty ? [] : relayout() })
        savedEdits.current = 0
        layoutStore().set(null)
      },
    }
  }, [state.windows, state.focused, open, openNew, relayout])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWM() {
  const wm = useContext(Ctx)
  if (!wm) throw new Error('useWM outside WindowManagerProvider')
  return wm
}
