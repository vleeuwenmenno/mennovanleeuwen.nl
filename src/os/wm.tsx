import { snapReserve } from './dockPrefs'
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { synced } from './synced'

export type AppId = 'terminal' | 'files' | 'viewer' | 'notes' | 'keys' | 'projects' | 'recents' | 'cv' | 'contact' | 'games' | 'zed' | 'trash' | 'notebook' | 'sticky' | 'settings'

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
export const SINGLE_INSTANCE = new Set<AppId>(['notes', 'keys', 'trash', 'notebook', 'settings'])

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
type State = { windows: WinState[]; nextPid: number; topZ: number; touched: boolean; focused: number | null }


/** Opens the opening layout on an empty desk, as if nobody had touched it yet. */
function fresh(layout: { app: AppId; geometry: Geometry; props?: WinState['props'] }[]): State {
  let s: State = { windows: [], nextPid: 100, topZ: 10, touched: false, focused: null }
  for (const w of layout) s = reducer(s, { type: 'open', app: w.app, geometry: w.geometry, props: w.props })
  return { ...s, touched: false }
}

// ---------------------------------------------------------------------------------------------
// Saved layouts: which windows are open, where, and what they show. Phones and bigger screens
// keep separate layouts, since one rarely fits the other.

export type SavedWindow = Geometry & Pick<WinState, 'app' | 'minimized' | 'maximized' | 'snap' | 'restore' | 'props'>

/** Props that only make sense once: commands to run, "open this now" stamps, placement hints. */
const TRANSIENT_PROPS = new Set(['run', 't', 'under'])

type LayoutStore = ReturnType<typeof synced<SavedWindow[] | null>>
let layout: LayoutStore | null = null
/** The saved layout for the kind of screen this page loaded on (null: the opening layout). It
 * stays the same store when the window is resized, so a narrowed desktop doesn't overwrite the
 * phone layout. */
export function layoutStore(): LayoutStore {
  layout ??= synced<SavedWindow[] | null>(`windows:${window.innerWidth < 720 ? 'mobile' : 'desktop'}`, null)
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

function restored(saved: SavedWindow[]): State {
  let pid = 100
  let z = 10
  const windows: WinState[] = saved.map((w) => ({ ...w, props: { ...w.props }, pid: pid++, z: ++z, openedAt: Date.now() }))
  const top = windows.filter((w) => !w.minimized).at(-1)
  return { windows, nextPid: pid, topZ: z, touched: true, focused: top?.pid ?? null }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return fresh(action.layout)
    case 'restore':
      return restored(action.windows)
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
  const usable = useCallback((saved: SavedWindow[] | null) => saved?.filter((w) => isApp(w.app)) ?? null, [isApp])
  const [state, dispatch] = useReducer(reducer, null, () => {
    const saved = usable(layoutStore().get())
    return saved ? restored(saved) : fresh(relayout())
  })

  const stateRef = useRef(state)
  stateRef.current = state

  // Save the layout once the visitor has changed something; take a newer one from another device
  // only while this tab hasn't changed anything since it last loaded or saved.
  const lastSynced = useRef<string>(JSON.stringify(state.touched ? serialize(state.windows) : null))
  useEffect(() => {
    if (!state.touched) return
    const t = setTimeout(() => {
      const json = JSON.stringify(serialize(state.windows))
      if (json === lastSynced.current) return
      lastSynced.current = json
      layoutStore().set(serialize(state.windows))
    }, 400)
    return () => clearTimeout(t)
  }, [state.windows, state.touched])
  useEffect(
    () =>
      layoutStore().onRemote((saved) => {
        const current = JSON.stringify(serialize(stateRef.current.windows))
        if (stateRef.current.touched && current !== lastSynced.current) return
        const next = usable(saved)
        lastSynced.current = JSON.stringify(next)
        if (next) dispatch({ type: 'restore', windows: next })
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
        lastSynced.current = 'null'
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
