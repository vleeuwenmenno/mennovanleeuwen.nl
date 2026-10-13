import { useSyncExternalStore, type ReactNode } from 'react'
import { synced } from '../os/synced'
import { cleanNoteEvents, textTitle, type NoteEvent } from './noteEvents'

// Notes of your own: each one can sit on the desktop as a sticky (the "sticky" widget, see
// apps/Sticky.tsx) and is listed in the Notebook app. Kept per browser for visitors, synced for the
// signed-in user. Deleting leaves a tombstone so another device can't bring the note back
// when the two merge. A note can be linked to calendar events (src/data/noteEvents.ts): other
// apps add to the Notebook and the sticky through the hooks at the end (src/os/noteEventLinks.tsx).

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'orange' | 'white'

export type Note = {
  id: string
  text: string
  color: NoteColor
  /** Degrees; a sticky's slant on the desktop */
  tilt: number
  created: number
  updated: number
  /** In the Notebook's trash since */
  deleted?: number
  /** Gone for good; kept only so the deletion syncs */
  purged?: boolean
  /** Calendar events it is linked to (meeting notes). */
  events?: NoteEvent[]
  /** When its links last changed, so a merge keeps the newest links even when the text changed elsewhere. */
  eventsAt?: number
}

export const NOTE_COLORS: Record<NoteColor, { bg: string; fg: string; label: string }> = {
  yellow: { bg: 'linear-gradient(175deg, #fff1a8 0%, #fde27a 100%)', fg: '#3b2f05', label: 'Yellow' },
  pink: { bg: 'linear-gradient(175deg, #ffd6e4 0%, #fbb3cb 100%)', fg: '#4f1328', label: 'Pink' },
  blue: { bg: 'linear-gradient(175deg, #dcefff 0%, #b8dafa 100%)', fg: '#12324f', label: 'Blue' },
  green: { bg: 'linear-gradient(175deg, #dcf7c9 0%, #b7e8a0 100%)', fg: '#1d3d10', label: 'Green' },
  purple: { bg: 'linear-gradient(175deg, #ece0ff 0%, #d3bdfb 100%)', fg: '#2e1650', label: 'Purple' },
  orange: { bg: 'linear-gradient(175deg, #ffe2c2 0%, #fcc58f 100%)', fg: '#4a2603', label: 'Orange' },
  white: { bg: 'linear-gradient(175deg, #ffffff 0%, #eceae4 100%)', fg: '#2a2a2a', label: 'Paper' },
}

const COLOR_NAMES = Object.keys(NOTE_COLORS) as NoteColor[]
const TOMBSTONE_DAYS = 90

/** A random slant that still reads as "stuck on by hand": 0.8 to 3.5 degrees either way. */
export const randomTilt = () => Math.round((Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.7) * 10) / 10
export const randomColor = (): NoteColor => COLOR_NAMES[Math.floor(Math.random() * 5)]

function normalize(v: unknown): Note[] {
  if (!Array.isArray(v)) return []
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5
  return v
    .filter((n): n is Note => !!n && typeof n.id === 'string' && !(n.purged && n.updated < cutoff))
    .map((n) => {
      const events = cleanNoteEvents(n.events)
      return { ...n, color: NOTE_COLORS[n.color] ? n.color : 'yellow', ...(events ? { events } : { events: undefined }) }
    })
}

/** Per note, the side that changed it last wins; notes only one side has are kept. Its links to events go by when they changed, on their own. */
function merge(local: Note[], remote: Note[]): Note[] {
  const byId = new Map(remote.map((n) => [n.id, n]))
  for (const n of local) {
    const r = byId.get(n.id)
    if (!r) {
      byId.set(n.id, n)
      continue
    }
    const won = n.updated > r.updated ? n : r
    const lost = won === n ? r : n
    byId.set(n.id, !won.purged && (lost.eventsAt ?? 0) > (won.eventsAt ?? 0) ? { ...won, events: lost.events, eventsAt: lost.eventsAt } : won)
  }
  return [...byId.values()].sort((a, b) => a.created - b.created)
}

const store = synced<Note[]>('notes', [], { normalize, merge })

export const useAllNotes = store.use
export const getNote = (id: string) => store.get().find((n) => n.id === id && !n.purged)

export function createNote(init: Partial<Pick<Note, 'text' | 'color' | 'tilt'>> = {}): Note {
  const now = Date.now()
  const note: Note = { id: crypto.randomUUID(), text: '', color: randomColor(), tilt: randomTilt(), created: now, updated: now, ...init }
  store.set((all) => [...all, note])
  return note
}

export function updateNote(id: string, patch: Partial<Pick<Note, 'text' | 'color' | 'tilt'>>) {
  store.set((all) => all.map((n) => (n.id === id ? { ...n, ...patch, updated: Date.now() } : n)))
}

export const trashNote = (id: string) => store.set((all) => all.map((n) => (n.id === id ? { ...n, deleted: Date.now(), updated: Date.now() } : n)))
export const restoreNote = (id: string) => store.set((all) => all.map((n) => (n.id === id ? { ...n, deleted: undefined, updated: Date.now() } : n)))
export const purgeNote = (id: string) => {
  const n = getNote(id)
  if (n) purgeListeners.forEach((l) => l(n))
  purgeNow(id)
}
const purgeNow = (id: string) => store.set((all) => all.map((n) => (n.id === id ? { id: n.id, text: '', color: n.color, tilt: 0, created: n.created, updated: Date.now(), deleted: n.deleted ?? Date.now(), purged: true } : n)))

/** The first non-empty line, without Markdown heading or list marks. */
export const noteTitle = (n: Note) => textTitle(n.text)

/** Changes a note's links to calendar events. */
export function setNoteEvents(id: string, change: (events: NoteEvent[]) => NoteEvent[]) {
  store.set((all) =>
    all.map((n) => {
      if (n.id !== id) return n
      // Not an edit of the text: `updated` (the list's order, "edited …") stays.
      return { ...n, events: change(n.events ?? []), eventsAt: Date.now() }
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
      return { ...n, events, eventsAt: Date.now() }
    })
    return changed ? next : all
  })
}

export const allNotes = () => store.get()
export const subscribeNotes = store.subscribe

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

/** Called with a note right before it is deleted for good. */
export function onNotePurged(l: (n: Note) => void): () => void {
  purgeListeners.add(l)
  return () => purgeListeners.delete(l)
}
