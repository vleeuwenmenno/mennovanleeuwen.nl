import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useWM, type WinState } from './wm'

const TOP_BAR = 34
const MIN_W = 280
const MIN_H = 180

type Props = {
  win: WinState
  title: string
  chrome?: 'default' | 'note'
  className?: string
  children: ReactNode
}

type Drag = { mode: 'move' | 'resize'; edge: string; startX: number; startY: number; x: number; y: number; w: number; h: number }

export function Window({ win, title, chrome = 'default', className = '', children }: Props) {
  const wm = useWM()
  const drag = useRef<Drag | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focused = wm.focusedPid === win.pid

  const begin = (mode: Drag['mode'], edge = '') => (e: ReactPointerEvent) => {
    if (e.button !== 0 || win.maximized) return
    if ((e.target as HTMLElement).closest('button, a, input')) return
    e.preventDefault()
    wm.focus(win.pid)
    drag.current = { mode, edge, startX: e.clientX, startY: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h }
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
      const x = Math.min(Math.max(d.x + dx, -d.w + 120), window.innerWidth - 120)
      const y = Math.min(Math.max(d.y + dy, TOP_BAR), window.innerHeight - 60)
      wm.setGeometry(win.pid, { x, y })
    } else {
      const g: Partial<WinState> = {}
      if (d.edge.includes('e')) g.w = Math.max(MIN_W, d.w + dx)
      if (d.edge.includes('s')) g.h = Math.max(MIN_H, d.h + dy)
      if (d.edge.includes('w')) {
        const w = Math.max(MIN_W, d.w - dx)
        g.w = w
        g.x = d.x + (d.w - w)
      }
      wm.setGeometry(win.pid, g)
    }
  }

  const end = () => {
    drag.current = null
    document.body.classList.remove('is-dragging', 'is-resizing')
  }

  const handlers = { onPointerMove: onMove, onPointerUp: end, onPointerCancel: end }

  return (
    <section
      className={`window chrome-${chrome} ${focused ? 'is-focused' : ''} ${win.maximized ? 'is-max' : ''} ${win.minimized ? 'is-min' : ''} ${className}`}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
      onPointerDown={() => wm.focus(win.pid)}
      // Focus follows the mouse after a short pause, so sweeping across windows does not flicker.
      onPointerEnter={(e) => {
        if (wm.focusMode !== 'hover' || e.pointerType === 'touch' || document.body.matches('.is-dragging, .is-resizing')) return
        hoverTimer.current = setTimeout(() => wm.hoverFocus(win.pid), 70)
      }}
      onPointerLeave={() => hoverTimer.current && clearTimeout(hoverTimer.current)}
      role="dialog"
      aria-label={title}
      data-app={win.app}
    >
      {chrome === 'default' ? (
        <header className="titlebar" onPointerDown={begin('move')} onDoubleClick={() => wm.toggleMax(win.pid)} {...handlers}>
          <span className="titlebar-title">{title}</span>
          <span className="titlebar-pid">pid {win.pid}</span>
          <div className="win-controls">
            <button className="ctl ctl-min" aria-label="Minimize" onClick={() => wm.minimize(win.pid)} />
            <button className="ctl ctl-max" aria-label="Maximize" onClick={() => wm.toggleMax(win.pid)} />
            <button className="ctl ctl-close" aria-label="Close" onClick={() => wm.close(win.pid)} />
          </div>
        </header>
      ) : (
        <div className="note-grip" onPointerDown={begin('move')} {...handlers}>
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
    </section>
  )
}
