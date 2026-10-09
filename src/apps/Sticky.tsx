import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { createNote, getNote, NOTE_COLORS, randomTilt, trashNote, updateNote, useAllNotes, type Note, type NoteColor } from '../data/notes'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import { useWM, type WinState } from '../os/wm'
import { TILTS } from '../widgets/config'
import type { WidgetDef, WM } from '../widgets/types'
import { closeWidget, openWidget, widgetWindows } from '../widgets/windows'

// The sticky note widget: one of your notes (src/data/notes.ts) on the desktop. Its colour and
// tilt belong to the note, so the Notebook and every device show the same.

/** Shows a note on the desktop: focuses its sticky if one is open, otherwise opens one. */
export const openSticky = (wm: WM, id: string) => openWidget(wm, 'sticky', id)
export const closeStickies = (wm: WM, id: string) => closeWidget(wm, 'sticky', id)
export const stickyOpen = (wm: WM, id: string) => widgetWindows(wm, 'sticky', id).length > 0

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
  const windowMenu = useWindowMenu()
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

  // The whole widget menu (the note's items, then the window's), from its toolbar and its text.
  const menu = windowMenu

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
        // The note's menu, unless text is selected (then the browser's, to copy it or fix spelling).
        onContextMenu={(e) => {
          const el = e.currentTarget
          if (el.selectionStart !== el.selectionEnd) return e.stopPropagation()
          menu(e)
        }}
        onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
      />
    </div>
  )
}

function useStickyFrame(id: string): CSSProperties | undefined {
  const note = useAllNotes().find((n) => n.id === id)
  if (!note) return undefined
  const c = NOTE_COLORS[note.color]
  return { ['--widget-bg' as string]: c.bg, ['--widget-fg' as string]: c.fg, ['--widget-tilt' as string]: `${note.tilt}deg` }
}

function useStickyMenu(id: string, wm: WM): MenuItem[] {
  const note = useAllNotes().find((n) => n.id === id)
  if (!note) return []
  return noteMenu(note, [
    { separator: true },
    { label: 'Copy text', disabled: !note.text.trim(), onSelect: () => navigator.clipboard?.writeText(note.text).catch(() => {}) },
    { label: 'Open in Notebook', onSelect: () => wm.open('notebook', { id: note.id, t: String(Date.now()) }) },
    { label: 'Delete note', danger: true, onSelect: () => trashNote(note.id) },
  ])
}

export const stickyWidget: WidgetDef = {
  kind: 'sticky',
  name: 'Sticky note',
  blurb: 'A note of your own on the desktop',
  glyph: '✎',
  size: [260, 240],
  resizable: true,
  closeLabel: 'Take off the desktop',
  Component: ({ win }) => <Sticky win={win} />,
  useFrame: useStickyFrame,
  useMenu: useStickyMenu,
  create: () => createNote().id,
}
