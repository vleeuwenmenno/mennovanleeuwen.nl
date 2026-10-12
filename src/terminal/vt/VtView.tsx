import { memo, useEffect, useLayoutEffect, useReducer, useRef, type CSSProperties, type ReactNode } from 'react'
import { BOLD, DIM, INVERSE, INVISIBLE, ITALIC, OVERLINE, STRIKE, UNDERLINE, type Line, type Style } from './screen.ts'
import { cssColor } from './palette.ts'
import { encodeKey, encodeMouse } from './keys.ts'
import type { VtSession } from './session.ts'

// Draws an emulator's grid (screen.ts) in the terminal window: one row per line, runs of cells
// with the same style as one span. Rows are memoized by their version, so a program that changes
// one line redraws one line. The same rows show a finished session in the scrollback.

type Look = { style?: CSSProperties; className?: string }
const looks = [new WeakMap<Style, Look>(), new WeakMap<Style, Look>()]

/** A style as CSS. `reverse` is the whole screen in reverse video (DECSCNM). */
function look(st: Style, reverse: boolean): Look {
  const cache = looks[reverse ? 1 : 0]
  const known = cache.get(st)
  if (known) return known
  let fg = cssColor(st.fg)
  let bg = cssColor(st.bg)
  if (!!(st.flags & INVERSE) !== reverse) [fg, bg] = [bg ?? 'var(--bg)', fg ?? 'var(--fg)']
  if (st.flags & DIM) fg = `color-mix(in srgb, ${fg ?? 'currentColor'} 55%, transparent)`
  if (st.flags & INVISIBLE) fg = 'transparent'
  const style: CSSProperties = {}
  if (fg) style.color = fg
  if (bg) style.background = bg
  if (st.flags & BOLD) style.fontWeight = 700
  if (st.flags & ITALIC) style.fontStyle = 'italic'
  const deco = [st.flags & UNDERLINE && 'underline', st.flags & STRIKE && 'line-through', st.flags & OVERLINE && 'overline'].filter(Boolean)
  if (deco.length) style.textDecoration = deco.join(' ')
  const result: Look = Object.keys(style).length ? { style } : {}
  cache.set(st, result)
  return result
}

export type CursorLook = { x: number; shape: 'block' | 'underline' | 'bar'; focused: boolean }

/** One row of cells. Trailing blank cells in the default style are left out. */
export const VtRow = memo(function VtRow({ line, cursor, reverse }: { line: Line; ver: number; cursor?: CursorLook | null; reverse?: boolean }) {
  const { ch, st } = line
  let end = ch.length
  if (!reverse) while (end > 0 && ch[end - 1] === ' ' && st[end - 1].bg === -1 && !(st[end - 1].flags & (INVERSE | UNDERLINE | STRIKE))) end--
  const cx = cursor ? cursor.x : -1
  if (cx >= end) end = Math.min(ch.length, cx + 1)

  const out: ReactNode[] = []
  let x = 0
  while (x < end) {
    const s = st[x]
    const wide = ch[x + 1] === ''
    if (x === cx || wide) {
      // The cursor's cell and wide characters stand alone.
      const l = look(s, !!reverse)
      const cls = [l.className, wide && 't-vt-wide', x === cx && `t-vt-cursor is-${cursor!.shape} ${cursor!.focused ? 'is-focused' : ''}`].filter(Boolean).join(' ')
      out.push(wrapLink(s, <span key={x} className={cls} style={l.style}>{ch[x] || ' '}</span>, x))
      x += wide ? 2 : 1
      continue
    }
    let text = ''
    const from = x
    while (x < end && st[x] === s && x !== cx && ch[x + 1] !== '') {
      text += ch[x]
      x++
    }
    const l = look(s, !!reverse)
    out.push(wrapLink(s, l.style || l.className ? <span key={from} className={l.className} style={l.style}>{text}</span> : text, from))
  }
  return <div className="t-vt-row">{out}</div>
})

function wrapLink(s: Style, node: ReactNode, key: number): ReactNode {
  if (!s.link) return node
  return (
    <a key={`l${key}`} href={s.link} target="_blank" rel="noopener noreferrer">
      {node}
    </a>
  )
}

// Stable keys for rows, so a scroll moves DOM rows instead of redrawing every one.
const ids = new WeakMap<Line, number>()
let nextRowId = 1
export const rowKey = (line: Line) => {
  let id = ids.get(line)
  if (id === undefined) ids.set(line, (id = nextRowId++))
  return id
}

/** Rows left behind by a finished session, in the scrollback. */
export function VtLines({ lines }: { lines: Line[] }) {
  return (
    <div className="t-vt t-vt-done">
      {lines.map((line) => (
        <VtRow key={rowKey(line)} line={line} ver={line.ver} />
      ))}
    </div>
  )
}

const SHAPES: CursorLook['shape'][] = ['block', 'block', 'block', 'underline', 'underline', 'bar', 'bar']

/**
 * The live session: its scrollback (on the normal screen) and the screen, with the cursor, the
 * mouse reported to the program when it asks, and the wheel sending arrows on the alternate
 * screen (less, man) when it does not.
 */
export function VtView({ session, focused, onCellSize, onDrawn }: { session: VtSession; focused: boolean; onCellSize: (w: number, h: number) => void; onDrawn: (alt: boolean) => void }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const vt = session.vt
  const screenRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)

  // One redraw per frame at most, and none in the middle of a synchronized update (2026).
  useEffect(() => {
    let frame = 0
    let waited = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (vt.modes.sync && waited < 12) {
          waited++
          schedule()
          return
        }
        waited = 0
        redraw()
      })
    }
    const stop = session.onDraw(schedule)
    return () => {
      stop()
      cancelAnimationFrame(frame)
    }
  }, [session, vt])

  // After every draw: the window keeps the newest output in view and knows about the alternate screen.
  useLayoutEffect(() => onDrawn(vt.altActive))

  // The cell size, measured from the font as drawn, sets the columns and rows.
  useLayoutEffect(() => {
    const probe = probeRef.current
    if (!probe) return
    const measure = () => {
      const r = probe.getBoundingClientRect()
      if (r.width) onCellSize(r.width / 10, r.height)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(probe)
    return () => ro.disconnect()
  }, [onCellSize])

  // Mouse reports: the button held, so moves and the release can say which.
  const held = useRef<number | null>(null)
  const cellAt = (e: { clientX: number; clientY: number }) => {
    const el = screenRef.current
    const probe = probeRef.current?.getBoundingClientRect()
    if (!el || !probe) return null
    const r = el.getBoundingClientRect()
    const w = probe.width / 10
    const h = r.height / vt.rows
    return { x: Math.max(0, Math.min(vt.cols - 1, Math.floor((e.clientX - r.left) / w))), y: Math.max(0, Math.min(vt.rows - 1, Math.floor((e.clientY - r.top) / h))) }
  }
  const mods = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean }) => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey })
  // Shift keeps the mouse for selecting text, as in xterm; the right button keeps the menu.
  const tracking = (e: { shiftKey: boolean }) => vt.modes.mouse !== 0 && !e.shiftKey

  useEffect(() => {
    const up = (e: MouseEvent) => {
      if (held.current === null) return
      const cell = cellAt(e)
      const b = held.current
      held.current = null
      if (cell) session.send(encodeMouse('up', b, cell.x, cell.y, mods(e), vt.modes) ?? '')
    }
    const move = (e: MouseEvent) => {
      if (!vt.modes.mouse) return
      const cell = cellAt(e)
      if (!cell) return
      if (held.current === null && !screenRef.current?.contains(e.target as Node)) return
      const key = `${cell.x},${cell.y}`
      if (key === lastMove.current) return
      lastMove.current = key
      session.send(encodeMouse('move', held.current ?? 0, cell.x, cell.y, mods(e), vt.modes, held.current !== null) ?? '')
    }
    window.addEventListener('mouseup', up)
    window.addEventListener('mousemove', move)
    return () => {
      window.removeEventListener('mouseup', up)
      window.removeEventListener('mousemove', move)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])
  const lastMove = useRef('')

  // The wheel: reported, or arrows on the alternate screen, or the page's own scrolling.
  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    let acc = 0
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return // zoom
      const reported = tracking(e)
      if (!reported && !(vt.altActive && vt.modes.altScroll)) return
      e.preventDefault()
      acc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      const steps = Math.trunc(acc / 40)
      if (!steps) return
      acc -= steps * 40
      const cell = cellAt(e)
      for (let i = 0; i < Math.min(10, Math.abs(steps)); i++) {
        if (reported && cell) session.send(encodeMouse('wheel', steps < 0 ? 0 : 1, cell.x, cell.y, mods(e), vt.modes) ?? '')
        else session.send(encodeKey({ key: steps < 0 ? 'ArrowUp' : 'ArrowDown', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, vt.modes) ?? '')
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const cursor: CursorLook | null = vt.modes.cursorVisible ? { x: vt.x, shape: SHAPES[vt.cursorShape] ?? 'block', focused } : null
  const reverse = vt.modes.reverse
  return (
    <div className={`t-vt ${vt.altActive ? 't-alt' : ''} ${reverse ? 'is-reverse' : ''}`}>
      <span className="t-vt-probe" ref={probeRef} aria-hidden>
        MMMMMMMMMM
      </span>
      {!vt.altActive && vt.scrollback.map((line) => <VtRow key={rowKey(line)} line={line} ver={line.ver} />)}
      <div
        className="t-vt-screen"
        ref={screenRef}
        style={{ width: `${vt.cols}ch` }}
        onMouseDown={(e) => {
          if (!tracking(e) || e.button > 1) return
          const cell = cellAt(e)
          if (!cell) return
          e.preventDefault()
          held.current = e.button
          lastMove.current = ''
          session.send(encodeMouse('down', e.button, cell.x, cell.y, mods(e), vt.modes) ?? '')
        }}
      >
        {vt.screen.map((line, y) => (
          <VtRow key={rowKey(line)} line={line} ver={line.ver} reverse={reverse} cursor={y === vt.y ? cursor : null} />
        ))}
      </div>
    </div>
  )
}
