import { cleanNoteEvents, type NoteEvent } from './noteEvents'

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'orange' | 'white'

export type Note = {
  id: string
  text: string
  color: NoteColor
  /** Degrees; a sticky's slant on the desktop */
  tilt: number
  created: number
  /** When anything about it last changed (the Notebook sorts by it); see src/data/noteClock.ts */
  updated: number
  /** When its text, colour or tilt last changed; `updated` for notes saved before this existed */
  edited?: number
  /** In the Notebook's trash since */
  deleted?: number
  /** Taken out of the trash at; a merge then doesn't put it back for a trashing from before. */
  restored?: number
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

const TOMBSTONE_DAYS = 90

export function normalizeNotes(v: unknown, expirePurged = true): Note[] {
  if (!Array.isArray(v)) return []
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5
  return v
    .filter((n): n is Note => !!n && typeof n.id === 'string' && !(expirePurged && n.purged && n.updated < cutoff))
    .map((n) => {
      const events = cleanNoteEvents(n.events)
      return { ...n, color: NOTE_COLORS[n.color] ? n.color : 'yellow', ...(events ? { events } : { events: undefined }) }
    })
}

const editedAt = (n: Note) => n.edited ?? n.updated
/** Whether `a`'s text is the later one: by `edited`, then (a tie) the same pick on every side. */
const laterText = (a: Note, b: Note) => (editedAt(a) !== editedAt(b) ? editedAt(a) > editedAt(b) : JSON.stringify([a.text, a.color, a.tilt]) > JSON.stringify([b.text, b.color, b.tilt]))
const most = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b))

/** One note from two copies: each part from the side that changed that part last. */
function mergeNote(a: Note, b: Note): Note {
  const updated = Math.max(a.updated, b.updated)
  // Deleted for good is final, whatever the other side did since.
  if (a.purged || b.purged) {
    const p = a.purged ? a : b
    return { ...p, updated, deleted: most(a.deleted, b.deleted) }
  }
  // The text, colour and tilt: the later edit.
  const text = laterText(a, b) ? a : b
  // In the trash or not: the later of the last trashing and the last restore, from either side.
  const deleted = most(a.deleted, b.deleted)
  // Older restores only cleared deleted and advanced updated. Preserve that evidence
  // before materializing edited, otherwise the next merge could retrash the note.
  const restoredAt = (n: Note) => most(n.restored, n.edited === undefined && n.deleted === undefined ? n.updated : undefined)
  const restored = most(restoredAt(a), restoredAt(b))
  const trashed = deleted !== undefined && deleted > (restored ?? 0)
  // Its links to events: the later change of them (a tie: the same pick on every side).
  const linksKey = (n: Note) => JSON.stringify(n.events ?? [])
  const links = (a.eventsAt ?? 0) !== (b.eventsAt ?? 0) ? ((a.eventsAt ?? 0) > (b.eventsAt ?? 0) ? a : b) : linksKey(a) >= linksKey(b) ? a : b
  return {
    ...text,
    edited: editedAt(text),
    updated,
    deleted: trashed ? deleted : undefined,
    ...(restored !== undefined ? { restored } : {}),
    events: links.events,
    eventsAt: links.eventsAt,
  }
}

/**
 * Per note, each part from the side that changed it last (see mergeNote); notes only one side
 * has are kept, once each.
 */
export function mergeNotes(local: Note[], remote: Note[]): Note[] {
  const byId = new Map(remote.map((n) => [n.id, n]))
  for (const n of local) {
    const r = byId.get(n.id)
    byId.set(n.id, r ? mergeNote(n, r) : n)
  }
  return [...byId.values()].sort((a, b) => a.created - b.created)
}

/** Only actual note edits enter the journal. Unchanged rows are never promoted to dirty state. */
export function changedNotes(before: Note[], after: Note[]): Note[] {
  const prior = new Map(before.map(note => [note.id, note]))
  return after.filter(note => JSON.stringify(prior.get(note.id)) !== JSON.stringify(note))
}
