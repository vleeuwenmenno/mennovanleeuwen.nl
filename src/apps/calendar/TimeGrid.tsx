import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { dayKey, type CalendarEvent } from '../../data/calendar'
import { addDays, atMinutes, hhmm, layoutBars, layoutDay, minutesOf, moved, sameDay, SNAP, span, type Placed } from './time'

// The day, 3-day and week views: all-day events in a lane on top, timed ones on a 24-hour grid.
// With a mouse: drag on an empty spot to make an event there, drag an event to move it (to
// another day too), drag its bottom edge to make it longer or shorter; a click opens it. On a
// touch screen a tap does the same as a click, and swiping scrolls.

export const HOUR = 48
const PX = HOUR / 60

export type Change = { start: string; end: string; allDay: boolean }

type Props = {
  days: Date[]
  events: CalendarEvent[]
  now: Date
  onOpen: (e: CalendarEvent) => void
  onCreate: (start: Date, end: Date, allDay: boolean) => void
  onChange: (e: CalendarEvent, change: Change) => void
  onDay: (d: Date) => void
  /** Right-click on an event, or on an empty spot (`at`). */
  onMenu: (ev: ReactMouseEvent, e: CalendarEvent | null, at: Date, allDay: boolean) => void
}

type Drag =
  | { kind: 'create'; col: number; from: number; to: number; moved: boolean }
  | { kind: 'move'; e: CalendarEvent; grabCol: number; grabMin: number; col: number; min: number; moved: boolean }
  | { kind: 'resize'; e: CalendarEvent; col: number; min: number }
  | { kind: 'create-day'; from: number; to: number }
  | { kind: 'move-day'; e: CalendarEvent; grabCol: number; col: number; moved: boolean }
  | { kind: 'tap'; e: CalendarEvent | null; col: number; min: number; allDay: boolean }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const snap = (m: number) => Math.round(m / SNAP) * SNAP

/** What a drag in progress would make of an event, to draw it there already. */
function previewOf(drag: Drag | null, days: Date[]): { id: string; change: Change } | null {
  if (!drag) return null
  if (drag.kind === 'move' && drag.moved) return { id: drag.e.id, change: moved(drag.e, drag.col - drag.grabCol, snap(drag.min - drag.grabMin)) }
  if (drag.kind === 'move-day' && drag.moved) return { id: drag.e.id, change: moved(drag.e, drag.col - drag.grabCol, 0) }
  if (drag.kind === 'resize') {
    const start = span(drag.e).start
    const end = Math.max(atMinutes(days[drag.col], snap(drag.min)).getTime(), start + SNAP * 60_000)
    return { id: drag.e.id, change: { start: drag.e.start, end: new Date(end).toISOString(), allDay: false } }
  }
  return null
}

export function TimeGrid({ days, events, now, onOpen, onCreate, onChange, onDay, onMenu }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const colsRef = useRef<HTMLDivElement>(null)
  const laneRef = useRef<HTMLDivElement>(null)
  const [drag, setDragState] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const startRef = useRef({ x: 0, y: 0 })
  const setDrag = (d: Drag | null) => {
    dragRef.current = d
    setDragState(d)
  }

  // Open at the start of the working day, or around now when today is in view.
  const hasToday = days.some((d) => sameDay(d, now))
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = Math.max(0, ((hasToday ? minutesOf(new Date()) - 90 : 7 * 60) * PX) | 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length])

  // Escape drops a drag.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrag(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drag])

  const preview = previewOf(drag, days)
  const shown = useMemo(() => (preview ? events.map((e) => (e.id === preview.id ? { ...e, ...preview.change } : e)) : events), [events, preview?.id, preview?.change.start, preview?.change.end]) // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events])
  const { bars, rows } = useMemo(() => layoutBars(shown, days), [shown, days])
  const placed = useMemo(() => days.map((d) => layoutDay(shown, d)), [shown, days])

  const point = (el: HTMLElement | null, x: number, y: number) => {
    const r = el!.getBoundingClientRect()
    return { col: clamp(Math.floor(((x - r.left) / r.width) * days.length), 0, days.length - 1), min: clamp((y - r.top) / PX, 0, 1440) }
  }

  const down = (allDay: boolean) => (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return
    const target = ev.target as HTMLElement
    const id = target.closest<HTMLElement>('[data-ev]')?.dataset.ev
    const e = id ? (byId.get(id) ?? null) : null
    const p = point(allDay ? laneRef.current : colsRef.current, ev.clientX, ev.clientY)
    startRef.current = { x: ev.clientX, y: ev.clientY }
    // Touch: a tap opens or makes; anything else is the page scrolling.
    if (ev.pointerType === 'touch' || (e && !e.editable)) return setDrag({ kind: 'tap', e, col: p.col, min: p.min, allDay })
    ev.preventDefault()
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId)
    } catch {
      /* the pointer is already gone */
    }
    if (allDay) setDrag(e ? { kind: 'move-day', e, grabCol: p.col, col: p.col, moved: false } : { kind: 'create-day', from: p.col, to: p.col })
    else if (e && target.closest('.ca-ev-grip')) setDrag({ kind: 'resize', e, col: p.col, min: p.min })
    else if (e) setDrag({ kind: 'move', e, grabCol: p.col, grabMin: p.min, col: p.col, min: p.min, moved: false })
    else setDrag({ kind: 'create', col: p.col, from: p.min, to: p.min, moved: false })
  }

  const move = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const far = Math.hypot(ev.clientX - startRef.current.x, ev.clientY - startRef.current.y) > 4
    if (d.kind === 'tap') return far && setDrag(null)
    if (d.kind === 'create-day' || d.kind === 'move-day') {
      const p = point(laneRef.current, ev.clientX, ev.clientY)
      return setDrag(d.kind === 'create-day' ? { ...d, to: p.col } : { ...d, col: p.col, moved: d.moved || far })
    }
    const p = point(colsRef.current, ev.clientX, ev.clientY)
    if (d.kind === 'create') setDrag({ ...d, to: p.min, moved: d.moved || far })
    else if (d.kind === 'move') setDrag({ ...d, col: p.col, min: p.min, moved: d.moved || far })
    else setDrag({ ...d, col: p.col, min: p.min })
    // Near the top or bottom edge: scroll along.
    const s = scrollRef.current!.getBoundingClientRect()
    if (ev.clientY < s.top + 28) scrollRef.current!.scrollTop -= 14
    else if (ev.clientY > s.bottom - 28) scrollRef.current!.scrollTop += 14
  }

  const up = () => {
    const d = dragRef.current
    setDrag(null)
    if (!d) return
    if (d.kind === 'tap') {
      if (d.e) return onOpen(d.e)
      if (d.allDay) return onCreate(days[d.col], addDays(days[d.col], 1), true)
      const at = Math.floor(d.min / 30) * 30
      return onCreate(atMinutes(days[d.col], at), atMinutes(days[d.col], at + 60), false)
    }
    if (d.kind === 'create') {
      if (!d.moved) {
        const at = Math.floor(d.from / 30) * 30
        return onCreate(atMinutes(days[d.col], at), atMinutes(days[d.col], at + 60), false)
      }
      const a = Math.floor(Math.min(d.from, d.to) / SNAP) * SNAP
      const b = Math.max(Math.ceil(Math.max(d.from, d.to) / SNAP) * SNAP, a + SNAP)
      return onCreate(atMinutes(days[d.col], a), atMinutes(days[d.col], b), false)
    }
    if (d.kind === 'create-day') {
      const [a, b] = [Math.min(d.from, d.to), Math.max(d.from, d.to)]
      return onCreate(days[a], addDays(days[b], 1), true)
    }
    if ((d.kind === 'move' || d.kind === 'move-day') && !d.moved) return onOpen(d.e)
    const p = previewOf(d, days)
    if (p && (p.change.start !== d.e.start || p.change.end !== d.e.end)) onChange(d.e, p.change)
  }

  const context = (allDay: boolean) => (ev: ReactMouseEvent<HTMLDivElement>) => {
    const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-ev]')?.dataset.ev
    const p = point(allDay ? laneRef.current : colsRef.current, ev.clientX, ev.clientY)
    onMenu(ev, id ? (byId.get(id) ?? null) : null, allDay ? days[p.col] : atMinutes(days[p.col], Math.floor(p.min / 30) * 30), allDay)
  }

  const handlers = (allDay: boolean) => ({ onPointerDown: down(allDay), onPointerMove: move, onPointerUp: up, onPointerCancel: () => setDrag(null), onContextMenu: context(allDay) })
  const dragging = drag && drag.kind !== 'tap' && drag.kind !== 'create' && drag.kind !== 'create-day' ? drag.e.id : null
  const nowMin = minutesOf(now)
  const cols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }

  return (
    <div className="ca-tg">
      <div className="ca-tg-head">
        <span className="ca-gutter" />
        <div className="ca-tg-days" style={cols}>
          {days.map((d) => (
            <button key={dayKey(d)} className={`ca-dayhead ${sameDay(d, now) ? 'is-today' : ''} ${d.getDay() % 6 === 0 ? 'is-weekend' : ''}`} onClick={() => onDay(d)} title="Show this day">
              <span>{d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
              <strong>{d.getDate()}</strong>
            </button>
          ))}
        </div>
      </div>
      <div className="ca-tg-allday">
        <span className="ca-gutter">all day</span>
        <div ref={laneRef} className="ca-lane" style={{ height: Math.max(1, rows) * 22 + 6 }} {...handlers(true)}>
          <div className="ca-lane-cells" style={cols}>
            {days.map((d, i) => (
              <span key={dayKey(d)} className={drag?.kind === 'create-day' && i >= Math.min(drag.from, drag.to) && i <= Math.max(drag.from, drag.to) ? 'is-picked' : ''} />
            ))}
          </div>
          {bars.map((b) => (
            <div
              key={b.e.id}
              data-ev={b.e.id}
              className={`ca-bar ${b.startsBefore ? 'cont-l' : ''} ${b.endsAfter ? 'cont-r' : ''} ${b.e.editable ? '' : 'is-ro'} ${dragging === b.e.id ? 'is-dragging' : ''}`}
              style={{ left: `calc(${(b.startCol / days.length) * 100}% + 2px)`, width: `calc(${((b.endCol - b.startCol) / days.length) * 100}% - 4px)`, top: b.row * 22 + 3, ['--c' as string]: b.e.color }}
              title={`${b.e.title} · ${b.e.calendar}`}
            >
              {b.e.recurring && '↻ '}
              {b.e.title}
            </div>
          ))}
        </div>
      </div>
      <div ref={scrollRef} className="ca-tg-scroll">
        <div className="ca-tg-body" style={{ height: 24 * HOUR }}>
          <div className="ca-hours">
            {Array.from({ length: 23 }, (_, h) => (
              <span key={h} style={{ top: (h + 1) * HOUR }}>
                {String(h + 1).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          <div ref={colsRef} className="ca-cols" style={cols} {...handlers(false)}>
            {days.map((d, i) => (
              <div key={dayKey(d)} className={`ca-col ${sameDay(d, now) ? 'is-today' : ''} ${d.getDay() % 6 === 0 ? 'is-weekend' : ''}`}>
                {placed[i].map((p) => (
                  <EventBlock key={p.e.id} p={p} past={span(p.e).end < now.getTime()} dragging={dragging === p.e.id} />
                ))}
                {drag?.kind === 'create' && drag.col === i && <Ghost from={drag.moved ? Math.min(drag.from, drag.to) : Math.floor(drag.from / 30) * 30} to={drag.moved ? Math.max(drag.from, drag.to) : Math.floor(drag.from / 30) * 30 + 60} />}
                {sameDay(d, now) && <div className="ca-now" style={{ top: nowMin * PX }} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function EventBlock({ p, past, dragging }: { p: Placed; past: boolean; dragging: boolean }) {
  const { start, end } = span(p.e)
  const height = (p.bottom - p.top) * PX
  const style: CSSProperties & Record<string, string | number> = {
    top: p.top * PX,
    height: Math.max(height - 1, 14),
    left: `calc(${(p.col / p.cols) * 100}% + 1px)`,
    width: `calc(${100 / p.cols}% - 3px)`,
    '--c': p.e.color,
  }
  const time = `${p.startsBefore ? '…' : hhmm(new Date(start))} – ${p.endsAfter ? '…' : hhmm(new Date(end))}`
  return (
    <div data-ev={p.e.id} className={`ca-ev ${height < 34 ? 'is-short' : height >= 64 ? 'is-tall' : ''} ${past ? 'is-past' : ''} ${p.e.editable ? '' : 'is-ro'} ${dragging ? 'is-dragging' : ''}`} style={style} title={`${p.e.title}\n${time} · ${p.e.calendar}${p.e.location ? `\n${p.e.location}` : ''}`}>
      <span className="ca-ev-title">
        {p.e.recurring && <span className="ca-ev-repeat" aria-label="repeats">↻ </span>}
        {p.e.title}
      </span>
      <span className="ca-ev-time">{time}</span>
      {p.e.editable && !p.endsAfter && <span className="ca-ev-grip" aria-hidden />}
    </div>
  )
}

function Ghost({ from, to }: { from: number; to: number }) {
  const a = Math.floor(from / SNAP) * SNAP
  const b = Math.max(Math.ceil(to / SNAP) * SNAP, a + SNAP)
  const label = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return (
    <div className="ca-ghost" style={{ top: a * PX, height: (b - a) * PX - 1 }}>
      {label(a)} – {label(b)}
    </div>
  )
}
