import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { openSticky } from '../apps/Sticky'
import { createNote } from '../data/notes'
import { APP_META } from './apps'
import { linkAt, linkMenu, openContextMenu, wantsNativeMenu, type MenuItem } from './ContextMenu'
import { getDockMode, snapReserve } from './dockPrefs'
import { setSnapPreview } from './snapPreview'
import { SINGLE_INSTANCE, snapRect, useWM, type Geometry, type SnapZone, type WinState } from './wm'

const TOP_BAR = 28
const MIN_W = 280
const MIN_H = 180
const EDGE = 14 // how close to a screen edge the pointer must be to snap
const CORNER = 110 // within this distance of the top or bottom, a side edge means a quarter

type Props = {
  win: WinState
  title: string
  chrome?: 'default' | 'note'
  className?: string
  /** Extra inline style, e.g. a sticky's colour and tilt as CSS variables */
  style?: CSSProperties
  children: ReactNode
}

type Drag = { mode: 'move' | 'resize'; edge: string; startX: number; startY: number; x: number; y: number; w: number; h: number; moved: boolean }
type Target = SnapZone | 'max' | null

/** Which snap zone the pointer is in: sides halve, corners quarter, the top edge maximizes. */
function zoneAt(x: number, y: number): Target {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = x <= EDGE
  const right = x >= vw - EDGE
  const nearTop = y <= TOP_BAR + CORNER
  const nearBottom = y >= vh - CORNER
  if (left || right) {
    if (nearTop) return left ? 'tl' : 'tr'
    if (nearBottom) return left ? 'bl' : 'br'
    return left ? 'left' : 'right'
  }
  if (y <= TOP_BAR + 4) return 'max'
  return null
}

const SNAPS: [SnapZone, string][] = [
  ['left', 'Left half'],
  ['right', 'Right half'],
  ['tl', 'Top left quarter'],
  ['tr', 'Top right quarter'],
  ['bl', 'Bottom left quarter'],
  ['br', 'Bottom right quarter'],
]

/**
 * Notes hang from their tape: dragging one sways it like a pendulum, the faster the further, and
 * letting go lets it swing back and settle. A damped spring on one angle (--swing, in degrees),
 * written straight to the element so React doesn't re-render 60 times a second.
 */
function useSwing(ref: { current: HTMLElement | null }) {
  const s = useRef({ angle: 0, vel: 0, target: 0, lastX: 0, lastT: 0, dragging: false, frame: 0, prev: 0 })
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  const step = (now: number) => {
    const st = s.current
    const dt = Math.min(0.05, (now - st.prev) / 1000 || 0.016)
    st.prev = now
    // While dragging, the push fades when the pointer stops; after letting go it is gone.
    st.target = st.dragging ? st.target * Math.pow(0.02, dt) : 0
    st.vel += (110 * (st.target - st.angle) - 7 * st.vel) * dt
    st.angle += st.vel * dt
    const el = ref.current
    if (!st.dragging && Math.abs(st.angle) < 0.05 && Math.abs(st.vel) < 0.5) {
      st.angle = st.vel = 0
      st.frame = 0
      el?.style.removeProperty('--swing')
      el?.style.removeProperty('transition')
      return
    }
    el?.style.setProperty('--swing', `${st.angle.toFixed(2)}deg`)
    st.frame = requestAnimationFrame(step)
  }
  const run = () => {
    if (s.current.frame) return
    // Inline, not a class: React rewrites className on re-render. No transition fighting the frames.
    ref.current?.style.setProperty('transition', 'none')
    s.current.prev = performance.now()
    s.current.frame = requestAnimationFrame(step)
  }

  useEffect(() => () => cancelAnimationFrame(s.current.frame), [])

  return {
    start(x: number) {
      if (reduced) return
      Object.assign(s.current, { dragging: true, lastX: x, lastT: performance.now() })
      run()
    },
    move(x: number) {
      const st = s.current
      if (!st.dragging) return
      const now = performance.now()
      const v = (x - st.lastX) / Math.max(8, now - st.lastT) // px per ms
      st.lastX = x
      st.lastT = now
      // Moving right leaves the bottom behind, to the left: a clockwise turn about the tape.
      st.target = Math.max(-10, Math.min(10, st.target * 0.5 + v * 6))
    },
    end() {
      s.current.dragging = false
    },
  }
}

const maxRect = (): Geometry => ({ x: 10, y: TOP_BAR + 10, w: window.innerWidth - 20, h: window.innerHeight - TOP_BAR - 20 - (getDockMode() === 'show' ? snapReserve() : 0) })

export function Window({ win, title, chrome = 'default', className = '', style, children }: Props) {
  const wm = useWM()
  const drag = useRef<Drag | null>(null)
  const target = useRef<Target>(null)
  const focused = wm.focusedPid === win.pid
  const canSnap = chrome === 'default' && window.innerWidth >= 720
  const sectionRef = useRef<HTMLElement>(null)
  const swing = useSwing(sectionRef)

  const begin = (mode: Drag['mode'], edge = '') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    if (win.maximized && mode === 'resize') return
    e.preventDefault()
    wm.focus(win.pid)
    drag.current = { mode, edge, startX: e.clientX, startY: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h, moved: false }
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    document.body.classList.add(mode === 'move' ? 'is-dragging' : 'is-resizing')
  }

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'move') {
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      if (chrome === 'note') d.moved ? swing.move(e.clientX) : swing.start(e.clientX)
      if (!d.moved) {
        d.moved = true
        // Dragging a snapped or maximized window away gives it back its old size, under the pointer.
        const restore = win.maximized ? { x: win.x, y: win.y, w: win.w, h: win.h } : win.restore
        if (win.maximized || win.snap) {
          const from = win.maximized ? maxRect() : { x: win.x, y: win.y, w: win.w, h: win.h }
          const size = restore ?? from
          const ratio = (d.startX - from.x) / from.w
          d.w = size.w
          d.h = size.h
          d.x = d.startX - ratio * size.w
          d.y = from.y
          wm.setGeometry(win.pid, { x: d.x, y: d.y, w: d.w, h: d.h, snap: undefined, restore: undefined, maximized: false })
        }
      }
      const x = Math.min(Math.max(d.x + dx, -d.w + 120), window.innerWidth - 120)
      const y = Math.min(Math.max(d.y + dy, TOP_BAR), window.innerHeight - 60)
      wm.setGeometry(win.pid, { x, y })
      if (canSnap) {
        target.current = zoneAt(e.clientX, e.clientY)
        setSnapPreview(target.current === 'max' ? maxRect() : target.current ? snapRect(target.current) : null)
      }
    } else {
      const g: Partial<Geometry> = {}
      if (d.edge.includes('e')) g.w = Math.max(MIN_W, d.w + dx)
      if (d.edge.includes('s')) g.h = Math.max(MIN_H, d.h + dy)
      if (d.edge.includes('w')) {
        const w = Math.max(MIN_W, d.w - dx)
        g.w = w
        g.x = d.x + (d.w - w)
      }
      // Resizing a snapped window makes it a normal one again.
      wm.setGeometry(win.pid, { ...g, snap: undefined, restore: undefined })
    }
  }

  const end = () => {
    const d = drag.current
    drag.current = null
    swing.end()
    document.body.classList.remove('is-dragging', 'is-resizing')
    setSnapPreview(null)
    const zone = target.current
    target.current = null
    if (!d || d.mode !== 'move' || !d.moved || !zone) return
    const restore = { x: d.x, y: d.y, w: d.w, h: d.h }
    if (zone === 'max') wm.setGeometry(win.pid, { maximized: true, restore })
    else wm.setGeometry(win.pid, { ...snapRect(zone), snap: zone, restore, maximized: false })
  }

  const handlers = { onPointerMove: onMove, onPointerUp: end, onPointerCancel: end }

  // Right-clicking the title bar (or a note's top strip): quick window actions instead of the
  // browser's own menu.
  const geometry = () => ({ x: win.x, y: win.y, w: win.w, h: win.h })
  const snapTo = (zone: SnapZone) => wm.setGeometry(win.pid, { ...snapRect(zone), snap: zone, restore: win.restore ?? geometry(), maximized: false })
  const unsnap = () => win.restore && wm.setGeometry(win.pid, { ...win.restore, snap: undefined, restore: undefined })
  const center = () => {
    const base = win.snap && win.restore ? win.restore : geometry()
    wm.setGeometry(win.pid, {
      ...base,
      x: Math.round(Math.max(8, (window.innerWidth - base.w) / 2)),
      y: Math.round(Math.max(TOP_BAR + 8, TOP_BAR + (window.innerHeight - TOP_BAR - base.h) / 2 - 30)),
      snap: undefined,
      restore: undefined,
      maximized: false,
    })
  }
  const windowMenu = (): MenuItem[] => {
    const others = wm.windows.filter((w) => w.pid !== win.pid)
    const siblings = others.filter((w) => w.app === win.app)
    return [
      { label: 'Minimize', onSelect: () => wm.minimize(win.pid) },
      ...(chrome === 'default'
        ? [
            { label: win.maximized ? 'Restore size' : 'Maximize', shortcut: 'dbl-click', onSelect: () => wm.toggleMax(win.pid) },
            ...(canSnap ? [{ label: 'Snap', submenu: [...SNAPS.map(([zone, label]) => ({ label, checked: win.snap === zone, onSelect: () => snapTo(zone) })), ...(win.snap ? [{ separator: true as const }, { label: 'Unsnap', onSelect: unsnap }] : [])] }] : []),
          ]
        : []),
      { label: 'Center on screen', onSelect: center },
      ...(chrome === 'note' ? [{ label: 'New sticky note', onSelect: () => openSticky(wm, createNote().id) }] : []),
      ...(!SINGLE_INSTANCE.has(win.app) && win.app !== 'sticky' ? [{ separator: true as const }, { label: 'New window', onSelect: () => wm.openNew(win.app) }] : []),
      { separator: true },
      ...(siblings.length ? [{ label: `Close all ${siblings.length + 1} ${APP_META[win.app].dock} windows`, onSelect: () => [win, ...siblings].forEach((w) => wm.close(w.pid)) }] : []),
      ...(others.length ? [{ label: 'Close other windows', onSelect: () => others.forEach((w) => wm.close(w.pid)) }] : []),
      { label: 'Close', danger: true, onSelect: () => wm.close(win.pid) },
    ]
  }
  const onMenu = (e: React.MouseEvent, before: MenuItem[] = []) => {
    wm.focus(win.pid)
    openContextMenu(e, [...before, ...windowMenu()])
  }
  // Inside the window, wherever the app has no menu of its own: links get theirs, text fields and
  // selections keep the browser's, the rest gets the window menu.
  const onBodyMenu = (e: React.MouseEvent) => {
    if (wantsNativeMenu(e)) return
    const href = linkAt(e.target)
    onMenu(e, href ? [...linkMenu(href), { separator: true }] : [])
  }

  return (
    <section
      ref={sectionRef}
      className={`window chrome-${chrome} ${focused ? 'is-focused' : ''} ${win.maximized ? 'is-max' : ''} ${win.minimized ? 'is-min' : ''} ${win.snap ? 'is-snapped' : ''} ${className}`}
      style={{ ...style, left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
      onPointerDown={() => wm.focus(win.pid)}
      onContextMenu={onBodyMenu}
      role="dialog"
      aria-label={title}
      data-app={win.app}
      data-pid={win.pid}
    >
      {chrome === 'default' ? (
        <header className="titlebar" onPointerDown={begin('move')} onDoubleClick={() => wm.toggleMax(win.pid)} onContextMenu={onMenu} {...handlers}>
          <span className="titlebar-title">{title}</span>
          <span className="titlebar-pid">pid {win.pid}</span>
          <div className="win-controls">
            <button className="ctl ctl-min" aria-label="Minimize" onClick={() => wm.minimize(win.pid)} />
            <button className="ctl ctl-max" aria-label="Maximize" onClick={() => wm.toggleMax(win.pid)} />
            <button className="ctl ctl-close" aria-label="Close" onClick={() => wm.close(win.pid)} />
          </div>
        </header>
      ) : (
        <div className="note-grip" onPointerDown={begin('move')} onContextMenu={onMenu} {...handlers}>
          <span className="note-tape" />
          <button className="note-close" aria-label="Close note" onClick={() => wm.close(win.pid)}>
            ×
          </button>
        </div>
      )}
      <div className="window-body">{children}</div>
      {chrome === 'default' && !win.maximized && (
        <>
          <div className="rz rz-e" onPointerDown={begin('resize', 'e')} {...handlers} />
          <div className="rz rz-s" onPointerDown={begin('resize', 's')} {...handlers} />
          <div className="rz rz-w" onPointerDown={begin('resize', 'w')} {...handlers} />
          <div className="rz rz-se" onPointerDown={begin('resize', 'se')} {...handlers} />
          <div className="rz rz-sw" onPointerDown={begin('resize', 'sw')} {...handlers} />
        </>
      )}
      {/* Stickies grow with their text; only their width is up to you. */}
      {win.app === 'sticky' && <div className="rz rz-e" onPointerDown={begin('resize', 'e')} {...handlers} />}
    </section>
  )
}
