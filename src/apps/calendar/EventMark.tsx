import { useEventMarks, type CalendarEvent } from '../../data/calendar'

// The small mark beside an event's title in the Calendar's views and the Agenda widget when
// another app has something on it (📝: notes linked to it, src/os/noteEventLinks.tsx). In the
// Calendar it only shows (the event itself is dragged and opened); in the Agenda a click opens it.
export function EventMark({ e, clickable }: { e: CalendarEvent; clickable?: boolean }) {
  const markOf = useEventMarks()
  const m = markOf(e)
  if (!m) return null
  if (clickable && m.open)
    return (
      <button
        type="button"
        className="ev-mark is-button"
        title={m.title}
        aria-label={m.title}
        onClick={(ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          m.open!()
        }}
      >
        {m.glyph}
      </button>
    )
  return (
    <span className="ev-mark" title={m.title} aria-label={m.title} role="img">
      {m.glyph}
    </span>
  )
}
