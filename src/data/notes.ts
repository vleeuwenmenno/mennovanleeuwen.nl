import { useSyncExternalStore, type ReactNode } from 'react'
import { syncedNotes } from '../os/synced'
import { textTitle, type NoteEvent } from './noteEvents'
import { editedNote, noteNow, relinkedNote, restoredNote, trashedNote } from './noteClock'

// Notes of your own: each one can sit on the desktop as a sticky (the "sticky" widget, see
// apps/Sticky.tsx) and is listed in the Notebook app. Kept per browser for visitors, synced for the
// signed-in user. Deleting for good leaves a tombstone (kept TOMBSTONE_DAYS, so the list doesn't
// grow without end) so another device or tab can't bring the note back when the two merge. Two tabs of one browser merge the same way as two
// devices (the note replica journal). A note can be linked to calendar events (src/data/noteEvents.ts): other
// apps add to the Notebook and the sticky through the hooks at the end (src/os/noteEventLinks.tsx).

export { NOTE_COLORS, normalizeNotes, mergeNotes } from './noteModel'
export type { Note, NoteColor } from './noteModel'
import { NOTE_COLORS, type Note, type NoteColor } from './noteModel'

const COLOR_NAMES = Object.keys(NOTE_COLORS) as NoteColor[]

/** A random slant that still reads as "stuck on by hand": 0.8 to 3.5 degrees either way. */
export const randomTilt = () => Math.round((Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.7) * 10) / 10
export const randomColor = (): NoteColor => COLOR_NAMES[Math.floor(Math.random() * 5)]

const store = syncedNotes()

export const useAllNotes = store.use
export const getNote = (id: string) => store.get().find((n) => n.id === id && !n.purged)

export function createNote(init: Partial<Pick<Note, 'text' | 'color' | 'tilt'>> = {}): Note {
  const now = Date.now()
  const note: Note = { id: crypto.randomUUID(), text: '', color: randomColor(), tilt: randomTilt(), created: now, updated: now, edited: now, ...init }
  store.set((all) => [...all, note])
  return note
}

export function updateNote(id: string, patch: Partial<Pick<Note, 'text' | 'color' | 'tilt'>>) {
  store.set((all) => all.map((n) => (n.id === id ? editedNote(n, patch) : n)))
}

export const trashNote = (id: string) => store.set((all) => all.map((n) => (n.id === id ? trashedNote(n) : n)))
export const restoreNote = (id: string) => store.set((all) => all.map((n) => (n.id === id ? restoredNote(n) : n)))
export const purgeNote = (id: string) => {
  const n = getNote(id)
  purgeNow(id)
  if (n) purgeListeners.forEach((l) => l(n))
}
const purgeNow = (id: string) => store.set((all) => all.map((n) => (n.id === id ? { id: n.id, text: '', color: n.color, tilt: 0, created: n.created, updated: noteNow(n), deleted: n.deleted ?? noteNow(n), purged: true } : n)))

/** The first non-empty line, without Markdown heading or list marks. */
export const noteTitle = (n: Note) => textTitle(n.text)

/** Changes a note's links to calendar events. */
export function setNoteEvents(id: string, change: (events: NoteEvent[]) => NoteEvent[]) {
  store.set((all) =>
    all.map((n) => {
      if (n.id !== id) return n
      // Not an edit of the text: `updated` (the list's order, "edited …") stays.
      return relinkedNote(n, { events: change(n.events ?? []) })
    }),
  )
}

/** Every note's links at once (the Calendar saw events again: their titles and times brought up to date). Not a change of the text. */
export function setAllNoteEvents(change: (n: Note) => NoteEvent[] | null) {
  store.set((all) => {
    let changed = false
    const next = all.map((n) => {
      const events = n.events?.length ? change(n) : null
      if (!events) return n
      changed = true
      return relinkedNote(n, { events })
    })
    return changed ? next : all
  })
}

export const allNotes = () => store.get()
export const subscribeNotes = store.subscribe
/** Wait for checkpointing as well as synchronous journal admission. */
export const flushNotes = () => store.persist!()

// ---------------------------------------------------------------------------------------------
// Hooks for other apps (how Contacts and Mail take part, src/os/pimLinks.tsx): the Notebook and
// the sticky's menus get their actions, the note gets their section (chips under the toolbar), and
// the Notebook's list their mark beside a note's title. Deleting a note for good is told, so what
// pointed at it can go too.

export type NoteAction = { id: string; label: string; when?: (n: Note) => boolean; run: (n: Note) => void }
export type NoteSlot = 'chips' | 'mark'

const actions = new Map<string, NoteAction>()
const slots = new Map<NoteSlot, (n: Note, where: 'notebook' | 'sticky' | 'list') => ReactNode>()
const hookListeners = new Set<() => void>()
let hookVersion = 0
const hooksChanged = () => {
  hookVersion++
  hookListeners.forEach((l) => l())
}
const purgeListeners = new Set<(n: Note) => void>()

export function registerNoteAction(a: NoteAction): () => void {
  actions.set(a.id, a)
  hooksChanged()
  return () => {
    if (actions.get(a.id) === a) actions.delete(a.id)
    hooksChanged()
  }
}

/** The actions other apps offer for a note, for its menus. */
export const noteActions = (n: Note) => [...actions.values()].filter((a) => !a.when || a.when(n))

export function registerNoteSlot(slot: NoteSlot, render: (n: Note, where: 'notebook' | 'sticky' | 'list') => ReactNode): () => void {
  slots.set(slot, render)
  hooksChanged()
  return () => {
    if (slots.get(slot) === render) slots.delete(slot)
    hooksChanged()
  }
}

export function useNoteSlot(slot: NoteSlot) {
  useSyncExternalStore(
    (l) => (hookListeners.add(l), () => void hookListeners.delete(l)),
    () => hookVersion,
  )
  return slots.get(slot) ?? null
}

/** Called with the previous note after its permanent deletion is durably admitted. */
export function onNotePurged(l: (n: Note) => void): () => void {
  purgeListeners.add(l)
  return () => purgeListeners.delete(l)
}
