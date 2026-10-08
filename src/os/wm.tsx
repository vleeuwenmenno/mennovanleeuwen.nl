import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'

export type AppId = 'terminal' | 'notes' | 'projects' | 'recents' | 'cv' | 'contact' | 'trash'

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
}

export type Geometry = { x: number; y: number; w: number; h: number }

type Action =
  | { type: 'open'; app: AppId; geometry: Geometry; props?: WinState['props'] }
  | { type: 'close'; pid: number }
  | { type: 'focus'; pid: number }
  | { type: 'minimize'; pid: number }
  | { type: 'toggleMax'; pid: number }
  | { type: 'setGeometry'; pid: number; geometry: Partial<Geometry> }
  | { type: 'viewport'; width: number; height: number; layout: { app: AppId; geometry: Geometry }[] }

/** `touched` flips once the visitor moves, resizes or opens something; until then a viewport
 * change re-applies the opening layout instead of just clamping. */
type State = { windows: WinState[]; nextPid: number; topZ: number; touched: boolean }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'open': {
      const existing = state.windows.find((w) => w.app === action.app)
      const z = state.topZ + 1
      if (existing) {
        return {
          ...state,
          touched: true,
          topZ: z,
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
      return { ...state, touched: true, windows: [...state.windows, win], nextPid: state.nextPid + 1, topZ: z }
    }
    case 'close':
      return { ...state, windows: state.windows.filter((w) => w.pid !== action.pid) }
    case 'focus': {
      const target = state.windows.find((w) => w.pid === action.pid)
      if (!target || (target.z === state.topZ && !target.minimized)) return state
      const z = state.topZ + 1
      return { ...state, topZ: z, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, z, minimized: false } : w)) }
    }
    case 'minimize':
      return { ...state, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, minimized: true } : w)) }
    case 'toggleMax':
      return { ...state, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, maximized: !w.maximized } : w)) }
    case 'setGeometry':
      return { ...state, touched: true, windows: state.windows.map((w) => (w.pid === action.pid ? { ...w, ...action.geometry } : w)) }
    case 'viewport': {
      const { width, height } = action
      return {
        ...state,
        windows: state.windows.map((w) => {
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
  open: (app: AppId, props?: WinState['props']) => void
  close: (pid: number) => void
  focus: (pid: number) => void
  minimize: (pid: number) => void
  toggleMax: (pid: number) => void
  setGeometry: (pid: number, geometry: Partial<Geometry>) => void
}

const Ctx = createContext<WM | null>(null)

export function WindowManagerProvider({
  children,
  initial: relayout,
  placement,
}: {
  children: ReactNode
  initial: () => { app: AppId; geometry: Geometry }[]
  placement: (app: AppId, openCount: number) => Geometry
}) {
  const [state, dispatch] = useReducer(reducer, relayout, (make) => {
    const init = make()
    let s: State = { windows: [], nextPid: 100, topZ: 10, touched: false }
    for (const w of init) s = reducer(s, { type: 'open', app: w.app, geometry: w.geometry })
    return { ...s, touched: false }
  })

  const open = useCallback(
    (app: AppId, props?: WinState['props']) => {
      dispatch({ type: 'open', app, props, geometry: placement(app, state.windows.length) })
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
    return {
      windows: state.windows,
      focusedPid: top?.pid ?? null,
      open,
      close: (pid) => dispatch({ type: 'close', pid }),
      focus: (pid) => dispatch({ type: 'focus', pid }),
      minimize: (pid) => dispatch({ type: 'minimize', pid }),
      toggleMax: (pid) => dispatch({ type: 'toggleMax', pid }),
      setGeometry: (pid, geometry) => dispatch({ type: 'setGeometry', pid, geometry }),
    }
  }, [state.windows, open])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWM() {
  const wm = useContext(Ctx)
  if (!wm) throw new Error('useWM outside WindowManagerProvider')
  return wm
}
