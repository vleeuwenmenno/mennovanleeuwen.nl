import { type CSSProperties } from 'react'
import { PackageHost } from '../widgets/platform/Host'
import { createNote, NOTE_COLORS, noteActions, randomTilt, trashNote, updateNote, useAllNotes, type Note, type NoteColor } from '../data/notes'
import type { MenuItem } from '../os/ContextMenu'
import { useWidgetConfig, setWidgetConfig, TILTS } from '../widgets/config'
import type { WidgetDef, WM } from '../widgets/types'
import { closeWidget, openWidget, widgetWindows } from '../widgets/windows'
// The sticky note widget: one of your notes (src/data/notes.ts) on the desktop. Its colour and
// tilt belong to the note, so the Notebook and every device show the same.

/** Shows a note on the desktop: focuses its sticky if one is open, otherwise opens one. */
export const openSticky = (wm: WM, id: string) => openWidget(wm, 'sticky', id)
export const closeStickies = (wm: WM, id: string) => closeWidget(wm, 'sticky', id)
export const stickyOpen = (wm: WM, id: string) => widgetWindows(wm, 'sticky', id).length > 0

/** Colour and slant choices, and what other apps offer for a note (linking it to an event), shared by the sticky's menu and the Notebook. */
export function noteMenu(note: Note, extra: MenuItem[] = []): MenuItem[] {
  const more = noteActions(note).map((a): MenuItem => ({ label: a.label, onSelect: () => a.run(note) }))
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
    ...(more.length ? [{ separator: true as const }, ...more] : []),
    ...extra,
  ]
}

function useStickyFrame(id: string): CSSProperties | undefined {
  const config = useWidgetConfig(id, { appearance: 'panel' })
  const note = useAllNotes().find((n) => n.id === id)
  if (!note || note.deleted || note.purged) return { display: 'none' }
  const c = NOTE_COLORS[note.color]
  return { ['--widget-bg' as string]: config.appearance === 'sticky' ? c.bg : 'var(--panel)', ['--widget-fg' as string]: config.appearance === 'sticky' ? c.fg : 'var(--fg)', ['--widget-tilt' as string]: `${note.tilt}deg` }
}

function useStickyMenu(id: string, wm: WM): MenuItem[] {
  const config = useWidgetConfig(id, { appearance: 'panel' })
  const note = useAllNotes().find((n) => n.id === id)
  if (!note) return []
  return noteMenu(note, [
    { label: 'Paper appearance', checked: config.appearance === 'sticky', onSelect: () => setWidgetConfig(id, { appearance: config.appearance === 'sticky' ? 'panel' : 'sticky' }) },
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
  Component: PackageHost,
  useFrame: useStickyFrame,
  useMenu: useStickyMenu,
  create: () => createNote().id,
}
