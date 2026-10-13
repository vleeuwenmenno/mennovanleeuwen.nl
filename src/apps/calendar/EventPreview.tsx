import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useEventSlot, type CalendarEvent, type CalendarInfo } from '../../data/calendar'
import { PersonChip } from '../contacts/people'
import { STATUS } from './EventEditor'
import { addDays, hhmm, parseDay, span } from './time'

// A click on an event shows this first: what the event is, beside it like Google Calendar's card
// (or as a sheet from the bottom in a narrow window), read-only, with Edit and Delete for events
// you can change and a ⋯ menu with the same items as the event's right-click menu. The Calendar
// decides what each button does (Calendar.tsx); this places the card, takes the keys and looks.

const GAP = 8
const MAX_GUESTS = 8
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

type Props = {
  event: CalendarEvent
  calendar?: CalendarInfo
  rootRef: RefObject<HTMLDivElement | null>
  /** Where the event was clicked: a month view repeats a long event in every day it covers. */
  near: { x: number; y: number } | null
  /** Opened from outside (an Agenda click, a note's link): bring the event into view first. */
  reveal: boolean
  /** A narrow window: a sheet from the bottom instead of a card beside the event. */
  sheet: boolean
  onEdit: () => void
  onDelete: () => void
  onMenu: (at: { x: number; y: number }) => void
  /** `focus`: the keyboard closed it, so the calendar takes the keys back. */
  onClose: (focus: boolean) => void
}

/** The event's box in the views (the clicked day's, for one shown on several). */
function elementOf(root: HTMLElement, id: string, near: { x: number; y: number } | null): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>('[data-ev]')].filter((el) => el.dataset.ev === id)
  const hit = near && all.find((el) => {
    const r = el.getBoundingClientRect()
    return near.x >= r.left && near.x <= r.right && near.y >= r.top && near.y <= r.bottom
  })
  return hit || all[0] || null
}

const URLS = /\b(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]|www\.[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g

/** Text with its web links clickable; everything else stays text (never HTML). */
function Linked({ text }: { text: string }) {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(URLS)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const href = m[1].startsWith('www.') ? `https://${m[1]}` : m[1]
    out.push(
      <a key={m.index} href={href} target="_blank" rel="noopener noreferrer" title={href}>
        {m[1]}
      </a>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

/** "Tue 14 Oct, 10:00–11:00", "Tue 14 Oct · All day", across days "Tue 14 Oct 22:00 – Wed 15 Oct 02:00" (the year when it isn't this year's). */
function whenOf(e: CalendarEvent): string {
  const { start, end } = span(e)
  const first = new Date(start)
  const year = first.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}
  const day = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...year }).replace(',', '')
  if (e.allDay) {
    const last = addDays(parseDay(e.end), -1)
    return `${day(first)}${last.getTime() > start ? ` – ${day(last)}` : ''} · All day`
  }
  const finish = new Date(end)
  if (finish.toDateString() === first.toDateString()) return `${day(first)}, ${hhmm(first)}–${hhmm(finish)}`
  return `${day(first)} ${hhmm(first)} – ${day(finish)} ${hhmm(finish)}`
}

export function EventPreview({ event: e, calendar, rootRef, near, reveal, sheet, onEdit, onDelete, onMenu, onClose }: Props) {
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const notesSlot = useEventSlot('notes')
  const guests = e.attendees ?? []
  const editable = !!e.editable

  // Opened from outside: scroll the time grid so the event is in view.
  useLayoutEffect(() => {
    if (!reveal || !rootRef.current) return
    const el = elementOf(rootRef.current, e.id, null)
    const scroller = el?.closest<HTMLElement>('.ca-tg-scroll')
    if (!el || !scroller) return
    const s = scroller.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top < s.top || r.bottom > s.bottom) scroller.scrollTop += r.top - s.top - (s.height - r.height) / 2
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Beside the event, on the side with room; below or above it when neither side fits (a wide
  // event); in the middle of the window when the event is not in view.
  const place = useCallback(() => {
    const root = rootRef.current
    const pop = popRef.current
    if (!root || !pop || sheet) return
    const rr = root.getBoundingClientRect()
    const view = root.querySelector('.ca-view')?.getBoundingClientRect() ?? rr
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    const r = elementOf(root, e.id, near)?.getBoundingClientRect()
    const seen = r && r.bottom > view.top && r.top < view.bottom && r.right > view.left && r.left < view.right ? r : null
    let x = (rr.width - w) / 2
    let y = (rr.height - h) / 2
    if (seen) {
      const right = seen.right + GAP
      const left = seen.left - GAP - w
      if (right + w <= rr.right - GAP || left >= rr.left + GAP) {
        x = (right + w <= rr.right - GAP ? right : left) - rr.left
        y = clamp(seen.top, rr.top + GAP, rr.bottom - GAP - h) - rr.top
      } else {
        x = clamp(seen.left + seen.width / 2 - w / 2, rr.left + GAP, rr.right - GAP - w) - rr.left
        y = (seen.bottom + GAP + h <= rr.bottom - GAP ? seen.bottom + GAP : Math.max(rr.top + GAP, seen.top - GAP - h)) - rr.top
      }
    }
    setPos((p) => (p && Math.abs(p.left - x) < 0.5 && Math.abs(p.top - y) < 0.5 ? p : { left: x, top: y }))
  }, [e.id, near, sheet, rootRef])
  useLayoutEffect(place)
  useEffect(() => {
    const root = rootRef.current
    const pop = popRef.current
    if (!root || !pop) return
    const ro = new ResizeObserver(place)
    ro.observe(root)
    ro.observe(pop)
    root.addEventListener('scroll', place, true)
    return () => {
      ro.disconnect()
      root.removeEventListener('scroll', place, true)
    }
  }, [place, rootRef])

  // The keyboard goes into the card; clicking anywhere else closes it (another event moves it:
  // the Calendar gets that click). On the views a click that closes it is not also a click on them.
  useEffect(() => popRef.current?.focus({ preventScroll: true }), [e.id])
  useEffect(() => {
    const down = (ev: PointerEvent) => {
      const t = ev.target instanceof Element ? ev.target : null
      const root = rootRef.current
      if (!t || ev.button !== 0 || popRef.current?.contains(t) || t.closest('.ctx-menu, .dlg')) return
      const inside = !!root?.contains(t)
      if (inside && t.closest('[data-ev]')) return
      onClose(false)
      if (inside && t.closest('.ca-view') && !t.closest('button')) ev.stopPropagation()
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [onClose, rootRef])

  const onKey = (ev: KeyboardEvent) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const onControl = !!(ev.target as HTMLElement).closest('a, button')
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      onClose(true)
    } else if (!editable) return
    else if ((ev.key === 'Enter' && !onControl) || ev.key.toLowerCase() === 'e') onEdit()
    else if (ev.key === 'Delete' || ev.key === 'Backspace') onDelete()
    else return
    ev.preventDefault()
  }

  const card = (
    <div
      ref={popRef}
      className={`ca-pv ${sheet ? 'is-sheet' : ''}`}
      style={sheet ? undefined : { left: pos?.left ?? 0, top: pos?.top ?? 0, opacity: pos ? 1 : 0, pointerEvents: pos ? undefined : 'none' }}
      role="dialog"
      aria-label={e.title || 'Event'}
      tabIndex={-1}
      onKeyDown={onKey}
    >
      <div className="ca-pv-head">
        <span className="ca-swatch" style={{ background: calendar?.color ?? e.color }} />
        <h3 className="ca-pv-title">{e.title || '(No title)'}</h3>
        <button type="button" className="ca-x" onClick={() => onClose(true)} aria-label="Close">
          ×
        </button>
      </div>
      <div className="ca-pv-when">
        {whenOf(e)}
        {e.recurring && <span className="muted"> · ↻ Repeats</span>}
      </div>
      <div className="ca-pv-rows">
        {e.location && (
          <div className="ca-pv-row">
            <span>Where</span>
            <span className="ca-pv-text">
              <Linked text={e.location} />
            </span>
          </div>
        )}
        {e.meet && (
          <div className="ca-pv-row">
            <span>Call</span>
            <a className="btn btn-small" href={e.meet} target="_blank" rel="noopener noreferrer">
              Join call
            </a>
          </div>
        )}
        <div className="ca-pv-row">
          <span>Calendar</span>
          <span className="ca-pv-text">
            <i className="ca-pv-dot" style={{ background: calendar?.color ?? e.color }} />
            {e.calendar}
            {calendar?.source && <span className="muted"> · {calendar.source}</span>}
          </span>
        </div>
        {guests.length > 0 && (
          <div className="ca-pv-row">
            <span>Guests</span>
            <div className="ca-pv-guests">
              {guests.slice(0, MAX_GUESTS).map((a) => {
                const [icon, label] = STATUS[a.status ?? ''] ?? ['', '']
                return (
                  <PersonChip
                    key={a.email}
                    email={a.email}
                    name={a.name}
                    compact
                    badge={
                      icon ? (
                        <b className={`ca-guest-status is-${a.status}`} title={`${label}${a.organizer ? ' · organiser' : ''}`}>
                          {icon}
                        </b>
                      ) : null
                    }
                  />
                )
              })}
              {guests.length > MAX_GUESTS && <span className="muted">and {guests.length - MAX_GUESTS} more</span>}
            </div>
          </div>
        )}
        {e.description && (
          <div className="ca-pv-row">
            <span>Notes</span>
            <div className="ca-pv-desc">
              <Linked text={e.description} />
            </div>
          </div>
        )}
      </div>
      {notesSlot?.(e)}
      {!editable && <p className="ca-hint">This calendar is read-only here.</p>}
      <div className="ca-pv-foot">
        <button type="button" className="btn btn-small btn-ghost" onClick={(ev) => onMenu({ x: ev.currentTarget.getBoundingClientRect().left, y: ev.currentTarget.getBoundingClientRect().bottom + 2 })} aria-label="More" title="More">
          ⋯
        </button>
        <span className="nb-spacer" />
        {editable && (
          <>
            <button type="button" className="btn btn-small is-danger" onClick={onDelete} title="Delete (Del)">
              Delete
            </button>
            <button type="button" className="btn btn-small btn-primary" onClick={onEdit} title="Edit (E or Enter)">
              Edit
            </button>
          </>
        )}
      </div>
    </div>
  )
  return sheet ? <div className="ca-sheet-back ca-pv-back">{card}</div> : card
}
