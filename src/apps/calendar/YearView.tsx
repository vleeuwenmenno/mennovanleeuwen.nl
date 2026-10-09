import { useMemo } from 'react'
import { dayKey, type CalendarEvent } from '../../data/calendar'
import { addDays, parseDay, sameDay, span, startOfWeek } from './time'

// The year as twelve small months, each day shaded by how much is on it (with the colours of
// its first calendars), and the same small month in the sidebar for getting around.

/** Per day: how many events, and the colours of the first few. */
export type DayLoad = Map<string, { count: number; colors: string[] }>

export function dayLoad(events: CalendarEvent[]): DayLoad {
  const out: DayLoad = new Map()
  for (const e of events) {
    const { start, end } = span(e)
    let d = e.allDay ? parseDay(e.start) : new Date(start)
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    // Every day it covers (up to two months of a long one).
    for (let i = 0; i < 62 && (i === 0 || d.getTime() < end); i++, d = addDays(d, 1)) {
      const key = dayKey(d)
      const slot = out.get(key) ?? { count: 0, colors: [] }
      slot.count++
      if (slot.colors.length < 3 && !slot.colors.includes(e.color)) slot.colors.push(e.color)
      out.set(key, slot)
    }
  }
  return out
}

type MiniProps = {
  month: Date
  now: Date
  load?: DayLoad
  /** Days to mark as being in view. */
  selected?: [Date, Date]
  onDay: (d: Date) => void
  onMonth?: (d: Date) => void
}

export function MiniMonth({ month, now, load, selected, onDay, onMonth }: MiniProps) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const days = Array.from({ length: 42 }, (_, i) => addDays(startOfWeek(first), i))
  const lo = selected && dayKey(selected[0])
  const hi = selected && dayKey(selected[1])
  const title = first.toLocaleDateString('en-GB', { month: 'long' })
  return (
    <div className="ca-mini">
      {onMonth ? (
        <button className="ca-mini-title" onClick={() => onMonth(first)}>
          {title}
        </button>
      ) : null}
      <div className="ca-mini-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="ca-mini-dow">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const key = dayKey(d)
          const l = load?.get(key)
          const other = d.getMonth() !== first.getMonth()
          return (
            <button
              key={key}
              className={`ca-mini-day ${other ? 'is-other' : ''} ${sameDay(d, now) ? 'is-today' : ''} ${lo && key >= lo && key < hi! ? 'is-in' : ''} ${l && !other ? 'has-events' : ''}`}
              style={l && !other ? { ['--load' as string]: `${Math.min(4, l.count) * 14}%`, ['--c1' as string]: l.colors[0] } : undefined}
              onClick={() => onDay(d)}
              title={l ? `${l.count} event${l.count === 1 ? '' : 's'}` : undefined}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function YearView({ year, events, now, onDay, onMonth }: { year: number; events: CalendarEvent[]; now: Date; onDay: (d: Date) => void; onMonth: (d: Date) => void }) {
  const load = useMemo(() => dayLoad(events), [events])
  return (
    <div className="ca-year">
      {Array.from({ length: 12 }, (_, m) => (
        <MiniMonth key={m} month={new Date(year, m, 1)} now={now} load={load} onDay={onDay} onMonth={onMonth} />
      ))}
    </div>
  )
}
