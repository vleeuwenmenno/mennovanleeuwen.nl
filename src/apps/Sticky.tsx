import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
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

// Checklists: "- [ ] todo" and "- [x] done" lines show as boxes to tick. Other lines show as they
// read: bullets as bullets, "# Title" bold, the rest as written.
const TASK = /^(\s*)[-*+] \[( |x|X)\]\s?(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/
/** A list line's marker, to continue the list on Enter. */
const LIST_LINE = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) )(.*)$/

/** The note with line `i`'s box ticked or unticked. */
function toggleLine(text: string, i: number) {
  const lines = text.split('\n')
  lines[i] = lines[i].replace(/\[( |x|X)\]/, (_, c: string) => (c === ' ' ? '[x]' : '[ ]'))
  return lines.join('\n')
}

/** The note as it reads, with checklists you can tick. Clicking a line edits the note there. */
function StickyView({ text, onToggle, onEdit }: { text: string; onToggle: (line: number) => void; onEdit: (line: number) => void }) {
  return (
    <div
      className="sticky-view"
      onClick={(e) => {
        if (window.getSelection()?.toString()) return
        const line = (e.target as Element).closest<HTMLElement>('[data-line]')?.dataset.line
        onEdit(line === undefined ? -1 : Number(line))
      }}
    >
      {text.split('\n').map((line, i) => {
        const task = TASK.exec(line)
        if (task) {
          const done = task[2] !== ' '
          return (
            <div key={i} data-line={i} className={`sk-line sk-task ${done ? 'is-done' : ''}`} style={{ paddingLeft: `${task[1].length * 0.5}em` }}>
              <button
                className="sk-box"
                role="checkbox"
                aria-checked={done}
                aria-label={task[3] || 'Item'}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggle(i)
                }}
              >
                {done ? '✓' : ''}
              </button>
              <span>{task[3]}</span>
            </div>
          )
        }
        const bullet = BULLET.exec(line)
        if (bullet)
          return (
            <div key={i} data-line={i} className="sk-line sk-bullet" style={{ paddingLeft: `${bullet[1].length * 0.5}em` }}>
              <span aria-hidden>•</span>
              <span>{bullet[2]}</span>
            </div>
          )
        const heading = HEADING.exec(line)
        if (heading)
          return (
            <div key={i} data-line={i} className="sk-line sk-heading">
              {heading[1]}
            </div>
          )
        return (
          <div key={i} data-line={i} className="sk-line">
            {line || '\u00a0'}
          </div>
        )
      })}
    </div>
  )
}

export function Sticky({ win }: { win: WinState }) {
  const wm = useWM()
  const windowMenu = useWindowMenu()
  const all = useAllNotes()
  const note = all.find((n) => n.id === win.props.id && !n.deleted && !n.purged)
  const text = useRef<HTMLTextAreaElement>(null)
  // Showing the note (ticks work) or editing it (a textarea). Empty notes are edited.
  const [editing, setEditing] = useState(() => !note?.text.trim())
  const caret = useRef<number | null>(null)

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

  // Grow with the text, like paper would; and put the caret where it was asked for.
  useLayoutEffect(() => {
    const el = text.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (caret.current !== null) {
      el.focus({ preventScroll: true })
      el.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  }, [note?.text, win.w, editing])

  // A brand-new note starts with the cursor in it.
  useEffect(() => {
    if (note && !note.text && Date.now() - note.created < 2000) text.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!note) return null

  // The whole widget menu (the note's items, then the window's), from its toolbar and its text.
  const menu = windowMenu
  const set = (next: string, at?: number) => {
    if (at !== undefined) caret.current = at
    updateNote(note.id, { text: next })
  }

  /** Edit, with the caret at the end of line `line` (or of the note). */
  const edit = (line: number) => {
    const lines = note.text.split('\n')
    caret.current = line < 0 ? note.text.length : lines.slice(0, line + 1).join('\n').length
    setEditing(true)
  }

  /** A new checklist item at the end (or after the caret's line while editing). */
  const addItem = () => {
    const el = text.current
    if (editing && el) {
      const pos = el.selectionEnd
      const lineEnd = note.text.indexOf('\n', pos) === -1 ? note.text.length : note.text.indexOf('\n', pos)
      const insert = `${lineEnd === 0 && !note.text ? '' : '\n'}- [ ] `
      set(note.text.slice(0, lineEnd) + insert + note.text.slice(lineEnd), lineEnd + insert.length)
      return
    }
    const sep = !note.text || note.text.endsWith('\n') ? '' : '\n'
    const next = `${note.text}${sep}- [ ] `
    caret.current = next.length
    updateNote(note.id, { text: next })
    setEditing(true)
  }

  // Enter on a list line starts the next item (unticked); Enter on an empty item ends the list.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') return e.currentTarget.blur()
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    const el = e.currentTarget
    const pos = el.selectionStart
    if (pos !== el.selectionEnd) return
    const lineStart = note.text.lastIndexOf('\n', pos - 1) + 1
    const m = LIST_LINE.exec(note.text.slice(lineStart, pos))
    if (!m) return
    e.preventDefault()
    if (!m[5].trim()) return set(note.text.slice(0, lineStart) + note.text.slice(pos), lineStart)
    const marker = m[3] ? `${Number(m[3]) + 1}${m[4]} ` : m[2].replace(/\[[xX]\]/, '[ ]')
    const insert = `\n${m[1]}${marker}`
    set(note.text.slice(0, pos) + insert + note.text.slice(pos), pos + insert.length)
  }

  return (
    <div className="sticky">
      <div className="sticky-tools" onContextMenu={menu}>
        {(Object.keys(NOTE_COLORS) as NoteColor[]).map((c) => (
          <button key={c} className={`sticky-dot ${note.color === c ? 'is-on' : ''}`} style={{ background: NOTE_COLORS[c].bg }} aria-label={NOTE_COLORS[c].label} title={NOTE_COLORS[c].label} onClick={() => updateNote(note.id, { color: c })} />
        ))}
        <button className="sticky-btn" title="Add a checklist item" aria-label="Add a checklist item" onMouseDown={(e) => e.preventDefault()} onClick={addItem}>
          ☑
        </button>
        <button className="sticky-btn" title="Tilt it some other way" aria-label="Random tilt" onClick={() => updateNote(note.id, { tilt: randomTilt() })}>
          ⟲
        </button>
        <button className="sticky-btn" title="More" aria-label="Note menu" onClick={menu}>
          ⋯
        </button>
      </div>
      {editing || !note.text.trim() ? (
        <textarea
          ref={text}
          className="sticky-text"
          value={note.text}
          placeholder="Write something… (- [ ] makes a checklist)"
          spellCheck
          onChange={(e) => updateNote(note.id, { text: e.target.value })}
          onBlur={() => note.text.trim() && setEditing(false)}
          // The note's menu, unless text is selected (then the browser's, to copy it or fix spelling).
          onContextMenu={(e) => {
            const el = e.currentTarget
            if (el.selectionStart !== el.selectionEnd) return e.stopPropagation()
            menu(e)
          }}
          onKeyDown={onKeyDown}
        />
      ) : (
        <div onContextMenu={(e) => (window.getSelection()?.toString() ? e.stopPropagation() : menu(e))}>
          <StickyView text={note.text} onToggle={(i) => updateNote(note.id, { text: toggleLine(note.text, i) })} onEdit={edit} />
        </div>
      )}
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
