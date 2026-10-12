// The freedesktop.org desktop entry format (.desktop files), read and written without a library:
// https://specifications.freedesktop.org/desktop-entry-spec/latest/. Launchers are kept in this
// format (src/data/launchers.ts), as on Linux, so `cat GitHub.desktop` in the terminal shows
// what the desktop shows.
//
// Parsing is strict about the structure (groups, keys, the [Desktop Entry] group first, no key
// twice) and keeps every line as it was: writing a file back changes only the keys that were set,
// so comments, other groups, localised keys (Name[nl]=) and keys this site does not know stay.

export type DesktopLine =
  | { kind: 'blank' | 'comment'; raw: string }
  | { kind: 'group'; name: string; raw: string }
  /** `value` is as written in the file, escapes and all (see unescapeValue). */
  | { kind: 'entry'; key: string; locale: string | null; value: string; raw: string }

export type DesktopFile = { lines: DesktopLine[] }

/** Thrown for a file that is not a desktop entry: which line, and why. */
export class DesktopEntryError extends Error {}

export const MAIN_GROUP = 'Desktop Entry'

const GROUP = /^\[([^[\]\x00-\x1f\x7f]+)\]$/
const ENTRY = /^([A-Za-z0-9-]+)(?:\[([A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,3})?(?:\.[A-Za-z0-9-]+)?(?:@[A-Za-z0-9]+)?)\])?[ \t]*=[ \t]*(.*)$/

/** Reads a desktop entry file. Throws DesktopEntryError for anything that does not follow the format. */
export function parseDesktopFile(text: string): DesktopFile {
  const lines: DesktopLine[] = []
  const groups = new Set<string>()
  let keys: Set<string> | null = null
  const rows = text.replace(/^﻿/, '').split('\n')
  // The final newline ends the last line rather than starting an empty one.
  if (rows.length && rows[rows.length - 1] === '') rows.pop()
  rows.forEach((row, i) => {
    const raw = row.endsWith('\r') ? row.slice(0, -1) : row
    const at = `line ${i + 1}`
    if (!raw.trim()) return void lines.push({ kind: 'blank', raw })
    if (raw.trimStart().startsWith('#')) return void lines.push({ kind: 'comment', raw })
    const g = GROUP.exec(raw)
    if (g) {
      const name = g[1]
      if (!groups.size && name !== MAIN_GROUP) throw new DesktopEntryError(`${at}: the first group must be [${MAIN_GROUP}], not [${name}]`)
      if (groups.has(name)) throw new DesktopEntryError(`${at}: [${name}] comes twice`)
      groups.add(name)
      keys = new Set()
      return void lines.push({ kind: 'group', name, raw })
    }
    const e = ENTRY.exec(raw)
    if (!e) throw new DesktopEntryError(`${at}: not a key=value line, a [group] or a # comment`)
    if (!keys) throw new DesktopEntryError(`${at}: ${e[1]} comes before any [group]`)
    const id = e[2] ? `${e[1]}[${e[2]}]` : e[1]
    if (keys.has(id)) throw new DesktopEntryError(`${at}: ${id} comes twice in its group`)
    keys.add(id)
    lines.push({ kind: 'entry', key: e[1], locale: e[2] ?? null, value: e[3], raw })
  })
  if (!groups.has(MAIN_GROUP)) throw new DesktopEntryError(`there is no [${MAIN_GROUP}] group`)
  return { lines }
}

/** Parses, or answers null for a file that is not a desktop entry. */
export function tryParseDesktopFile(text: string): DesktopFile | null {
  try {
    return parseDesktopFile(text)
  } catch {
    return null
  }
}

/** The file as text again: lines that were not changed come back exactly as they were read. */
export const formatDesktopFile = (file: DesktopFile) => `${file.lines.map((l) => l.raw).join('\n')}\n`

/** A string value as stored: \s \n \t \r and \\ stand for a space, newline, tab, return and backslash. */
export function unescapeValue(value: string): string {
  return value.replace(/\\([sntr\\])/g, (_, c: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c]!)
}

/** A string as a value: backslashes and line breaks escaped, and a leading space as \s (it would be trimmed). */
export function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/^ /, '\\s')
}

/** The lines of one group, as indexes into file.lines (empty when the group is not there). */
function groupRange(file: DesktopFile, group: string): { start: number; end: number } | null {
  const start = file.lines.findIndex((l) => l.kind === 'group' && l.name === group)
  if (start < 0) return null
  let end = start + 1
  while (end < file.lines.length && file.lines[end].kind !== 'group') end++
  return { start, end }
}

/** A key's value (unescaped) in a group, without a locale; null when it is not there. */
export function getValue(file: DesktopFile, key: string, group = MAIN_GROUP): string | null {
  const r = groupRange(file, group)
  if (!r) return null
  for (let i = r.start + 1; i < r.end; i++) {
    const l = file.lines[i]
    if (l.kind === 'entry' && l.key === key && l.locale === null) return unescapeValue(l.value)
  }
  return null
}

/**
 * A localestring's value for the first of `languages` (BCP 47, "nl-NL", as navigator.languages
 * has them) that the file has, matched the spec's way: lang_COUNTRY@MODIFIER, lang_COUNTRY,
 * lang@MODIFIER, lang, then the key without a locale.
 */
export function getLocalized(file: DesktopFile, key: string, languages: readonly string[] = [], group = MAIN_GROUP): string | null {
  const r = groupRange(file, group)
  if (!r) return null
  const byLocale = new Map<string, string>()
  for (let i = r.start + 1; i < r.end; i++) {
    const l = file.lines[i]
    if (l.kind === 'entry' && l.key === key && l.locale) byLocale.set(l.locale.replace(/\.[^@]*/, '').toLowerCase(), l.value)
  }
  for (const tag of languages) {
    const [lang, country] = tag.toLowerCase().split(/[-_]/)
    for (const want of country ? [`${lang}_${country}`, lang] : [lang]) {
      const hit = byLocale.get(want)
      if (hit !== undefined) return unescapeValue(hit)
    }
  }
  return getValue(file, key, group)
}

/**
 * Sets a key in a group (made at the end of the file if it is missing), in place when it is
 * already there; null removes it. `dropLocalized` also removes its localised forms (Name[nl]=), for
 * a rename that should show in every language. Answers a new file; the old one is unchanged.
 */
export function setValue(file: DesktopFile, key: string, value: string | null, opts: { group?: string; dropLocalized?: boolean } = {}): DesktopFile {
  const group = opts.group ?? MAIN_GROUP
  const lines = file.lines.slice()
  let r = groupRange({ lines }, group)
  if (!r) {
    if (value === null) return file
    lines.push({ kind: 'group', name: group, raw: `[${group}]` })
    r = { start: lines.length - 1, end: lines.length }
  }
  const raw = value === null ? '' : `${key}=${escapeValue(value)}`
  let done = false
  for (let i = r.end - 1; i > r.start; i--) {
    const l = lines[i]
    if (l.kind !== 'entry' || l.key !== key) continue
    if (l.locale === null) {
      done = true
      if (value === null) lines.splice(i, 1)
      else if (unescapeValue(l.value) !== value) lines[i] = { kind: 'entry', key, locale: null, value: escapeValue(value), raw }
    } else if (opts.dropLocalized) lines.splice(i, 1)
  }
  if (!done && value !== null) {
    // After the group's last entry, so blank lines and comments that end the group stay at its end.
    const g = groupRange({ lines }, group)!
    let at = g.end
    while (at - 1 > g.start && lines[at - 1].kind !== 'entry') at--
    lines.splice(at, 0, { kind: 'entry', key, locale: null, value: escapeValue(value), raw })
  }
  return { lines }
}

/** A new file with just a [Desktop Entry] group and these keys, in this order (nulls left out). */
export function newDesktopFile(entries: [string, string | null | undefined][]): DesktopFile {
  let file: DesktopFile = { lines: [{ kind: 'group', name: MAIN_GROUP, raw: `[${MAIN_GROUP}]` }] }
  for (const [k, v] of entries) if (v !== null && v !== undefined) file = setValue(file, k, v)
  return file
}

/** A string list (Keywords=a;b;), split on unescaped semicolons, each item unescaped. */
export function splitList(value: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && value[i + 1] === ';') {
      cur += ';'
      i++
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** A string list as a value: each item with its semicolons escaped, each followed by one. */
export const joinList = (items: string[]) => items.map((s) => `${s.replace(/;/g, '\\;')};`).join('')
