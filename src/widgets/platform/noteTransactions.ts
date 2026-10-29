import { LIMITS, type Mutation, type WidgetInput } from './package.ts'
import { noteRevision } from './editor.ts'
const bytes = (text: string) => new TextEncoder().encode(text).length
export type NoteState = { text: string; edited?: number; updated: number }
/** Window boundaries are host-owned UTF-16 offsets; never split a surrogate pair. */
export function projectNote(note: NoteState, start = 0): NonNullable<WidgetInput['note']> {
  start = Math.max(0, Math.min(start, note.text.length))
  if (start > 0 && /[\uDC00-\uDFFF]/.test(note.text[start] ?? '') && /[\uD800-\uDBFF]/.test(note.text[start - 1])) start--
  let end = start, size = 0, lines = 0
  for (const char of note.text.slice(start)) {
    const length = bytes(char)
    if (size + length > LIMITS.noteWindowBytes || lines >= LIMITS.noteWindowLines) break
    end += char.length; size += length
    if (char === '\n') lines++
  }
  return { text: note.text.slice(start, end), revision: noteRevision(note), offset: start, ...(start > 0 && note.text[start - 1] !== '\n' ? { continues: true } : {}), ...(end < note.text.length ? { next: end } : {}) }
}
export function sameNote(note: NoteState, bound: { text: string; revision: string }) { return note.text === bound.text && noteRevision(note) === bound.revision }
/** Whole-note replacement is retained only for older small packages with a complete projection. */
export function applyPackageEdit(note: NoteState, bound: { text: string; revision: string }, projection: NonNullable<WidgetInput['note']>, effect: Mutation): string | null {
  if (!sameNote(note, bound) || effect.expectedRevision !== projection.revision || effect.expectedRevision !== bound.revision) return null
  if (effect.type === 'note.replace') {
    if (projection.offset || projection.next !== undefined || projection.text !== note.text) return null
    return allowNativeText(note.text, effect.text) ? effect.text : null
  }
  const from = projection.offset ?? 0, to = from + projection.text.length
  if (effect.start < from || effect.end > to || effect.end > note.text.length || bytes(effect.text) > LIMITS.fileBytes) return null
  const next = note.text.slice(0, effect.start) + effect.text + note.text.slice(effect.end)
  return allowNativeText(note.text, next) ? next : null
}
/** Large legacy notes remain readable/editable. Existing oversized content may shrink or grow by one bounded transaction. */
export function allowNativeText(previous: string, next: string) {
  const before = bytes(previous), after = bytes(next)
  return after <= LIMITS.noteBytes || before > LIMITS.noteBytes && after <= before + LIMITS.fileBytes
}
