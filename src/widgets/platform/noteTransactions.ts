import { LIMITS, type Mutation, type WidgetInput } from './package.ts'
import { noteRevision } from './editor.ts'
const bytes = (text: string) => new TextEncoder().encode(text).length
export type NoteState = { text: string; edited?: number; updated: number }
/** Window boundaries are host-owned UTF-16 offsets; never split a surrogate pair. */
export function projectNote(note: NoteState, start = 0): NonNullable<WidgetInput['note']> {
  start = Math.max(0, Math.min(start, note.text.length))
  if (start > 0 && /[\uDC00-\uDFFF]/.test(note.text[start] ?? '') && /[\uD800-\uDBFF]/.test(note.text[start - 1])) start--
  const lineStart = note.text.lastIndexOf('\n', start - 1) + 1
  const continues = /\S/.test(note.text.slice(lineStart, start))
  let end = start, size = 0, lines = 0, completeLine = start, firstContent = start
  let foundContent = false
  for (const char of note.text.slice(start)) {
    const length = bytes(char)
    if (size + length > LIMITS.noteWindowBytes || lines >= LIMITS.noteWindowLines) break
    if (!foundContent && /\S/.test(char)) { firstContent = end; foundContent = true }
    end += char.length; size += length
    if (char === '\n') { lines++; completeLine = end }
  }
  if (end < note.text.length && note.text[end - 1] !== '\n') {
    // Do not strand a short line's prefix at the end of the preceding page.
    if (completeLine > start) end = completeLine
    // A single oversized, indented line may still split its first token. Put that
    // token on the next page; whitespace-only continuation is safe to parse there.
    else if (!continues && foundContent && firstContent > start) end = firstContent
    // Otherwise keep the bounded code-point chunk, guaranteeing forward progress.
  }
  return { text: note.text.slice(start, end), revision: noteRevision(note), offset: start, ...(continues ? { continues: true } : {}), ...(end < note.text.length ? { next: end } : {}) }
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
