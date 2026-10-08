import { useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react'
import { getNote, NOTE_COLORS, randomTilt, trashNote, updateNote, useAllNotes, type Note, type NoteColor } from '../data/notes'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { useWM, type WinState } from '../os/wm'

type WM = ReturnType<typeof useWM>

/** Shows a note on the desktop: focuses its sticky if one is open, otherwise opens one. */
export function openSticky(wm: WM, id: string) {
  const open = wm.windows.find((w) => w.app === 'sticky' && w.props.id === id)
  if (open) wm.focus(open.pid)
  else wm.openNew('sticky', { id })
}

export function closeStickies(wm: WM, id: string) {
  wm.windows.filter((w) => w.app === 'sticky' && w.props.id === id).forEach((w) => wm.close(w.pid))
}

const TILTS: [string, number][] = [
  ['Straight', 0],
  ['A little left', -2],
  ['A little right', 2],
  ['Far left', -4.5],
  ['Far right', 4.5],
]

/** Colour and slant choices, shared by the sticky's menu and the Notebook. */
export function noteMenu(note: Note, extra: MenuItem[] = []): MenuItem[] {
  return [
    {
      label: 'Colour',
      submenu: (Object.keys(NOTE_COLORS) as NoteColor[]).map((c) => ({ label: NOTE_COLORS[c].label, swatch: NOTE_COLORS[c].bg, checked: note.color === c, onSelect: () => updateNote(note.id, { color: c }) })),
    },
    {
      label: 'Tilt',
      submenu: [
        ...TILTS.map(([label, tilt]) => ({ label, checked: note.tilt === tilt, onSelect: () => updateNote(note.id, { tilt }) })),
        { separator: true as const },
        { label: 'Random', onSelect: () => updateNote(note.id, { tilt: randomTilt() }) },
      ],
    },
    ...extra,
  ]
}

export function Sticky({ win }: { win: WinState }) {
  const wm = useWM()
  const all = useAllNotes()
  const note = all.find((n) => n.id === win.props.id && !n.deleted && !n.purged)
  const text = useRef<HTMLTextAreaElement>(null)

  // A sticky whose note was deleted (here or on another device) goes away. A layout restored from
  // the server can arrive a moment before its notes do, so look again before closing.
  useEffect(() => {
    if (note) return
    const t = setTimeout(() => {
      const n = getNote(win.props.id ?? '')
      if (!n || n.deleted) wm.close(win.pid)
    }, 1500)
    return () => clearTimeout(t)
  }, [note, win.pid, win.props.id, wm])

  // Grow with the text, like paper would.
  useLayoutEffect(() => {
    const el = text.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [note?.text, win.w])

  // A brand-new note starts with the cursor in it.
  useEffect(() => {
    if (note && !note.text && Date.now() - note.created < 2000) text.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!note) return null

  const menu = (e: MouseEvent) =>
    openContextMenu(
      e,
      noteMenu(note, [
        { separator: true },
        { label: 'Open in Notebook', onSelect: () => wm.open('notebook', { id: note.id, t: String(Date.now()) }) },
        { label: 'Take off the desktop', onSelect: () => wm.close(win.pid) },
        { separator: true },
        { label: 'Delete note', danger: true, onSelect: () => trashNote(note.id) },
      ]),
    )

  return (
    <div className="sticky">
      <div className="sticky-tools" onContextMenu={menu}>
        {(Object.keys(NOTE_COLORS) as NoteColor[]).map((c) => (
          <button key={c} className={`sticky-dot ${note.color === c ? 'is-on' : ''}`} style={{ background: NOTE_COLORS[c].bg }} aria-label={NOTE_COLORS[c].label} title={NOTE_COLORS[c].label} onClick={() => updateNote(note.id, { color: c })} />
        ))}
        <button className="sticky-btn" title="Tilt it some other way" aria-label="Random tilt" onClick={() => updateNote(note.id, { tilt: randomTilt() })}>
          ⟲
        </button>
        <button className="sticky-btn" title="More" aria-label="Note menu" onClick={menu}>
          ⋯
        </button>
      </div>
      <textarea
        ref={text}
        className="sticky-text"
        value={note.text}
        placeholder="Write something…"
        spellCheck
        onChange={(e) => updateNote(note.id, { text: e.target.value })}
        onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
      />
    </div>
  )
}
