import type { CSSProperties } from 'react'
import { synced } from '../os/synced'
import type { WinState } from '../os/wm'

// Notes of your own: each one can sit on the desktop as a sticky (a "sticky" window with
// props.id) and is listed in the Notebook app. Kept per browser for visitors, synced for the
// signed-in owner. Deleting leaves a tombstone so another device can't bring the note back
// when the two merge.

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
  return v.filter((n): n is Note => !!n && typeof n.id === 'string' && !(n.purged && n.updated < cutoff)).map((n) => ({ ...n, color: NOTE_COLORS[n.color] ? n.color : 'yellow' }))
}

/** Per note, the side that changed it last wins; notes only one side has are kept. */
function merge(local: Note[], remote: Note[]): Note[] {
  const byId = new Map(remote.map((n) => [n.id, n]))
  for (const n of local) {
    const r = byId.get(n.id)
    if (!r || n.updated > r.updated) byId.set(n.id, n)
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
export const purgeNote = (id: string) => store.set((all) => all.map((n) => (n.id === id ? { id: n.id, text: '', color: n.color, tilt: 0, created: n.created, updated: Date.now(), deleted: n.deleted ?? Date.now(), purged: true } : n)))

/** The first non-empty line, without Markdown heading or list marks. */
export function noteTitle(n: Note) {
  const line = n.text.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').trim().slice(0, 80) || 'New note'
}

/** Colour and slant for a sticky window (undefined for every other window). */
export function useStickyStyle(win: WinState): CSSProperties | undefined {
  const all = store.use()
  if (win.app !== 'sticky') return undefined
  const note = all.find((n) => n.id === win.props.id)
  if (!note) return undefined
  const c = NOTE_COLORS[note.color]
  return { ['--note-bg' as string]: c.bg, ['--note-fg' as string]: c.fg, ['--note-tilt' as string]: `${note.tilt}deg` }
}
