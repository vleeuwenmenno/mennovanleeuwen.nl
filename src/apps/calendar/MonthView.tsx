import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { dayKey, eventsOn, startOfDay, type CalendarEvent } from '../../data/calendar'
import { addDays, atMinutes, hhmm, isoWeek, moved, sameDay, span } from './time'
import type { Change } from './TimeGrid'

// Six weeks around the month. Each day lists its all-day events, then its timed ones, as far as
// they fit, then "+3 more" (which opens that day). Drag an event to another day to move it there
// (same time), drag over empty days to make an all-day event across them, click an empty day for
// a new event that morning.

type Props = {
  days: Date[]
  month: number
  events: CalendarEvent[]
  now: Date
  onOpen: (e: CalendarEvent) => void
  onCreate: (start: Date, end: Date, allDay: boolean) => void
  onChange: (e: CalendarEvent, change: Change) => void
  onDay: (d: Date) => void
  onMenu: (ev: ReactMouseEvent, e: CalendarEvent | null, at: Date, allDay: boolean) => void
}

type Drag = { kind: 'create'; from: number; to: number } | { kind: 'move'; e: CalendarEvent; grab: number; at: number; moved: boolean } | { kind: 'tap'; e: CalendarEvent | null; at: number }

const LINE = 19

export function MonthView({ days, month, events, now, onOpen, onCreate, onChange, onDay, onMenu }: Props) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState(3)
  const [drag, setDragState] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const startRef = useRef({ x: 0, y: 0 })
  const setDrag = (d: Drag | null) => {
    dragRef.current = d
    setDragState(d)
  }

  // As many event lines per day as the cells are tall.
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setLines(Math.max(1, Math.floor((el.clientHeight / 6 - 24) / LINE))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrag(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drag])

  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events])
  const perDay = useMemo(
    () =>
      days.map((d) => {
        const key = dayKey(d)
        // All-day ones first, longest first, so a long one keeps its place from day to day.
        return eventsOn(events, key).sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.allDay && b.allDay ? a.start.localeCompare(b.start) || b.end.localeCompare(a.end) : 0))
      }),
    [events, days],
  )

  const cellAt = (x: number, y: number) => {
    const r = gridRef.current!.getBoundingClientRect()
    const col = Math.min(6, Math.max(0, Math.floor(((x - r.left) / r.width) * 7)))
    const row = Math.min(5, Math.max(0, Math.floor(((y - r.top) / r.height) * 6)))
    return row * 7 + col
  }

  const down = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return
    const target = ev.target as HTMLElement
    if (target.closest('button')) return
    const id = target.closest<HTMLElement>('[data-ev]')?.dataset.ev
    const e = id ? (byId.get(id) ?? null) : null
    const at = cellAt(ev.clientX, ev.clientY)
    startRef.current = { x: ev.clientX, y: ev.clientY }
    if (ev.pointerType === 'touch' || (e && !e.editable)) return setDrag({ kind: 'tap', e, at })
    ev.preventDefault()
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId)
    } catch {
      /* the pointer is already gone */
    }
    setDrag(e ? { kind: 'move', e, grab: at, at, moved: false } : { kind: 'create', from: at, to: at })
  }
  const move = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const far = Math.hypot(ev.clientX - startRef.current.x, ev.clientY - startRef.current.y) > 4
    if (d.kind === 'tap') return far && setDrag(null)
    const at = cellAt(ev.clientX, ev.clientY)
    setDrag(d.kind === 'create' ? { ...d, to: at } : { ...d, at, moved: d.moved || far })
  }
  const up = () => {
    const d = dragRef.current
    setDrag(null)
    if (!d) return
    // One day: a timed event that morning; several: all day across them.
    const morning = (i: number) => onCreate(atMinutes(days[i], 9 * 60), atMinutes(days[i], 10 * 60), false)
    if (d.kind === 'tap') return d.e ? onOpen(d.e) : morning(d.at)
    if (d.kind === 'create') {
      const [a, b] = [Math.min(d.from, d.to), Math.max(d.from, d.to)]
      return a === b ? morning(a) : onCreate(days[a], addDays(days[b], 1), true)
    }
    if (!d.moved) return onOpen(d.e)
    if (d.at !== d.grab) onChange(d.e, moved(d.e, d.at - d.grab, 0))
  }

  // Days to highlight: where a new event would go, or where the dragged one would land.
  let picked: [number, number] | null = null
  if (drag?.kind === 'create' && drag.from !== drag.to) picked = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)]
  if (drag?.kind === 'move' && drag.moved) {
    const { start, end } = span(drag.e)
    const first = Math.round((startOfDay(new Date(start)).getTime() - days[0].getTime()) / 864e5) + drag.at - drag.grab
    picked = [first, first + (drag.e.allDay ? Math.max(1, Math.round((end - start) / 864e5)) - 1 : 0)]
  }

  return (
    <div className="ca-month">
      <div className="ca-month-head">
        <span className="ca-wk" />
        {days.slice(0, 7).map((d) => (
          <span key={d.getDay()}>{d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
        ))}
      </div>
      <div className="ca-month-body">
        <div className="ca-wks">
          {Array.from({ length: 6 }, (_, w) => (
            <span key={w} className="ca-wk">
              {isoWeek(days[w * 7])}
            </span>
          ))}
        </div>
        <div
          ref={gridRef}
          className="ca-month-grid"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => setDrag(null)}
          onContextMenu={(ev) => {
            const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-ev]')?.dataset.ev
            onMenu(ev, id ? (byId.get(id) ?? null) : null, atMinutes(days[cellAt(ev.clientX, ev.clientY)], 9 * 60), false)
          }}
        >
          {days.map((d, i) => {
            const list = perDay[i]
            const fits = list.length <= lines ? list.length : lines - 1
            return (
              <div
                key={dayKey(d)}
                className={`ca-cell ${d.getMonth() !== month ? 'is-other' : ''} ${sameDay(d, now) ? 'is-today' : ''} ${d.getDay() % 6 === 0 ? 'is-weekend' : ''} ${picked && i >= picked[0] && i <= picked[1] ? 'is-picked' : ''}`}
              >
                <button className="ca-cell-day" onClick={() => onDay(d)} title="Show this day">
                  {d.getDate() === 1 ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : d.getDate()}
                </button>
                {list.slice(0, fits).map((e) => (
                  <div
                    key={e.id}
                    data-ev={e.id}
                    className={`ca-chip ${e.allDay ? 'is-allday' : ''} ${e.editable ? '' : 'is-ro'} ${drag?.kind === 'move' && drag.moved && drag.e.id === e.id ? 'is-dragging' : ''} ${!e.allDay && span(e).end < now.getTime() ? 'is-past' : ''}`}
                    style={{ ['--c' as string]: e.color }}
                    title={`${e.title} · ${e.calendar}`}
                  >
                    {!e.allDay && <span className="ca-chip-time">{hhmm(new Date(e.start))}</span>}
                    <span className="ca-chip-title">{e.title}</span>
                  </div>
                ))}
                {list.length > fits && (
                  <button className="ca-more" onClick={() => onDay(d)}>
                    +{list.length - fits} more
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
