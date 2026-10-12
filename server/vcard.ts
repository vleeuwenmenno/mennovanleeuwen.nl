// vCards (RFC 6350 for 4.0, RFC 2426 for 3.0, and 2.1 from old phones on import), read and
// written directly: no library. A card is kept as its own lines, unfolded; reading picks out the
// properties the Contacts app shows, and an edit changes only the lines of the fields that were
// changed. Everything else (other apps' X- properties, Apple's item groups and labels, keys,
// sounds, the card's own PRODID) stays exactly as it was, the way server/caldav.ts keeps an
// event's iCalendar text.

/** One phone number, email address or web address, with its label ("work", "mobile", or the user's own). */
export type Labeled = { value: string; type?: string; pref?: boolean }
export type Address = { type?: string; pref?: boolean; pobox: string; ext: string; street: string; locality: string; region: string; postcode: string; country: string }
/** A date of the person's: "YYYY-MM-DD", or "--MM-DD" without the year. */
export type Dated = { label: string; date: string }
export type Name = { family: string; given: string; middle: string; prefix: string; suffix: string }

/** What the Contacts app shows and edits; the same shape goes back and forth as JSON. */
export type ContactFields = {
  fn: string
  n: Name
  nickname: string
  org: string
  department: string
  title: string
  emails: Labeled[]
  phones: Labeled[]
  urls: Labeled[]
  addresses: Address[]
  birthday: string
  anniversaries: Dated[]
  note: string
  categories: string[]
}

/** A card as its unfolded lines, BEGIN:VCARD to END:VCARD. */
export type Card = string[]

export type Line = { group: string; name: string; params: Record<string, string[]>; value: string }

export const emptyFields = (): ContactFields => ({
  fn: '',
  n: { family: '', given: '', middle: '', prefix: '', suffix: '' },
  nickname: '',
  org: '',
  department: '',
  title: '',
  emails: [],
  phones: [],
  urls: [],
  addresses: [],
  birthday: '',
  anniversaries: [],
  note: '',
  categories: [],
})

// ---------------------------------------------------------------------------------------------
// Lines

/** NAME;PARAM=a,b;PARAM="c:d":value with an optional "group." in front; 2.1's bare parameters (TEL;WORK;VOICE) are TYPEs. */
export function parseLine(line: string): Line | null {
  let i = 0
  let quoted = false
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) break
  }
  if (i >= line.length) return null
  const [head, ...rawParams] = line.slice(0, i).match(/(?:[^;"]|"[^"]*")+/g) ?? ['']
  const dot = head.lastIndexOf('.')
  const params: Record<string, string[]> = {}
  for (const p of rawParams) {
    const eq = p.indexOf('=')
    const key = eq > 0 ? p.slice(0, eq).trim().toUpperCase() : 'TYPE'
    const raw = eq > 0 ? p.slice(eq + 1) : p
    const values = (raw.match(/(?:[^,"]|"[^"]*")+/g) ?? ['']).map((v) => v.trim().replace(/^"|"$/g, ''))
    params[key] = [...(params[key] ?? []), ...values]
  }
  return { group: dot > 0 ? head.slice(0, dot) : '', name: head.slice(dot + 1).trim().toUpperCase(), params, value: line.slice(i + 1) }
}

const paramValue = (v: string) => (/[:;,"]/.test(v) ? `"${v.replace(/"/g, "'")}"` : v)

export function printLine(l: Line): string {
  const params = Object.entries(l.params)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `;${k}=${v.map(paramValue).join(',')}`)
    .join('')
  return `${l.group ? `${l.group}.` : ''}${l.name}${params}:${l.value}`
}

/** Text escaped for a value: backslash, newline, comma and (in structured values) semicolon. */
export const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1')

/** A value's text, escapes undone. */
export const unesc = (s: string) => s.replace(/\\([\\,;nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

/** Splits on `sep` where it is not escaped (N, ADR and ORG on ";", CATEGORIES and NICKNAME on ","). */
export function splitValue(value: string, sep: ';' | ','): string[] {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[++i]
      continue
    }
    if (ch === sep) {
      out.push(current)
      current = ''
    } else current += ch
  }
  out.push(current)
  return out
}

/** Lines over 75 octets folded, as both RFCs ask (never inside a character). */
export function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  parts.push(current)
  return parts.join('\r\n ')
}

// ---------------------------------------------------------------------------------------------
// Cards

/**
 * The cards in a text (a .vcf can hold many), each as its unfolded lines. Folding is a line break
 * followed by a space or tab; 2.1's quoted-printable values continue after a "=" at the end of a
 * line instead. A card in 2.1 is brought up to 3.0 on the way (see upgrade21).
 */
export function splitCards(text: string): Card[] {
  const physical = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  const logical: string[] = []
  for (const line of physical) {
    const last = logical.length - 1
    if (/^[ \t]/.test(line) && last >= 0) logical[last] += line.slice(1)
    else if (last >= 0 && /QUOTED-PRINTABLE/i.test(logical[last].split(':')[0]) && logical[last].endsWith('=')) logical[last] = logical[last].slice(0, -1) + line
    else logical.push(line)
  }
  const cards: Card[] = []
  let card: Card | null = null
  let depth = 0
  for (const line of logical) {
    if (!line.trim()) continue
    const upper = line.toUpperCase()
    if (upper === 'BEGIN:VCARD') {
      if (card) depth++
      else {
        card = [line]
        depth = 0
        continue
      }
    }
    if (!card) continue
    card.push(line)
    if (upper === 'END:VCARD') {
      if (depth === 0) {
        cards.push(upgrade21(card))
        card = null
      } else depth--
    }
  }
  return cards
}

export const printCard = (card: Card) => `${card.map(fold).join('\r\n')}\r\n`
export const printCards = (cards: Card[]) => cards.map(printCard).join('')

export function versionOf(card: Card): '2.1' | '3.0' | '4.0' {
  const v = card.find((l) => /^VERSION:/i.test(l))?.slice(8).trim()
  return v === '4.0' ? '4.0' : v === '2.1' ? '2.1' : '3.0'
}

/** Indexes of the card's lines named `name` (in any group). */
function linesNamed(card: Card, name: string): number[] {
  const out: number[] = []
  for (let i = 1; i < card.length - 1; i++) if (parseLine(card[i])?.name === name) out.push(i)
  return out
}

const first = (card: Card, name: string): Line | null => {
  const i = linesNamed(card, name)[0]
  return i === undefined ? null : parseLine(card[i])
}

/** The card's UID without "urn:uuid:", which group cards point at members with. */
export function uidOf(card: Card): string {
  return (first(card, 'UID')?.value ?? '').trim().replace(/^urn:uuid:/i, '')
}

/**
 * 2.1 brought up to 3.0: quoted-printable values decoded (in their CHARSET) and escaped like 3.0
 * text, BASE64 called "b", and the version changed. Everything else is already the same.
 */
function upgrade21(card: Card): Card {
  if (versionOf(card) !== '2.1') return card
  return card.map((raw) => {
    if (/^VERSION:/i.test(raw)) return 'VERSION:3.0'
    const l = parseLine(raw)
    if (!l || l.name === 'BEGIN' || l.name === 'END') return raw
    const enc = (l.params.ENCODING?.[0] ?? '').toUpperCase()
    if (enc === 'QUOTED-PRINTABLE') {
      const bytes: number[] = []
      for (let i = 0; i < l.value.length; i++) {
        const hex = l.value[i] === '=' ? /^[0-9A-Fa-f]{2}/.exec(l.value.slice(i + 1, i + 3)) : null
        if (hex) {
          bytes.push(parseInt(hex[0], 16))
          i += 2
        } else bytes.push(...Buffer.from(l.value[i], 'utf8'))
      }
      const charset = (l.params.CHARSET?.[0] ?? 'utf-8').toLowerCase()
      let text: string
      try {
        text = new TextDecoder(charset).decode(Uint8Array.from(bytes))
      } catch {
        text = Buffer.from(bytes).toString('utf8')
      }
      delete l.params.ENCODING
      delete l.params.CHARSET
      // Structured values keep their separators; only newlines and backslashes need escaping (2.1 never escaped commas).
      l.value = text.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n')
    } else if (enc === 'BASE64') l.params.ENCODING = ['b']
    delete l.params.CHARSET
    return printLine(l)
  })
}

// ---------------------------------------------------------------------------------------------
// Reading

const APPLE_LABEL = /^_\$!<(.+)>!\$_$/

/** The X-ABLabel of a line's item group ("item1."), as Apple and Fastmail write custom labels. */
function groupLabel(card: Card, group: string): string | undefined {
  if (!group) return undefined
  for (const raw of card) {
    const l = parseLine(raw)
    if (l && l.group.toLowerCase() === group.toLowerCase() && l.name === 'X-ABLABEL') {
      const v = unesc(l.value).trim()
      const apple = APPLE_LABEL.exec(v)
      return apple ? apple[1].toLowerCase() : v
    }
  }
  return undefined
}

const types = (l: Line) => (l.params.TYPE ?? []).flatMap((t) => t.split(',')).map((t) => t.trim().toLowerCase()).filter(Boolean)

/** A line's label: its item group's own, else the first TYPE that says something (cell is "mobile"). */
function labelOf(card: Card, l: Line, kind: 'email' | 'tel' | 'url' | 'adr'): { type?: string; pref?: boolean } {
  const t = types(l)
  const pref = t.includes('pref') || (l.params.PREF?.[0] !== undefined && l.params.PREF[0] !== '') || undefined
  const custom = groupLabel(card, l.group)
  if (custom) return { type: custom, ...(pref ? { pref } : {}) }
  const known = kind === 'tel' ? ['cell', 'mobile', 'iphone', 'home', 'work', 'main', 'pager', 'fax', 'other'] : ['home', 'work', 'other']
  let type = t.find((x) => known.includes(x))
  if (type === 'cell') type = 'mobile'
  if (kind === 'tel' && type !== 'fax' && t.includes('fax')) type = type ? `${type} fax` : 'fax'
  return { ...(type ? { type } : {}), ...(pref ? { pref } : {}) }
}

/** "YYYY-MM-DD" or "--MM-DD" from the forms vCards use (19800102, 1980-01-02, --0102, Apple's year 1604 for "no year"). */
export function parseDate(value: string, params: Record<string, string[]> = {}): string {
  const v = value.trim()
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(v)
  if (m) return params['X-APPLE-OMIT-YEAR'] || m[1] === '1604' ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`
  m = /^--(\d{2})-?(\d{2})$/.exec(v)
  if (m) return `--${m[1]}-${m[2]}`
  return ''
}

/** The fields the Contacts app shows, read from a card. */
export function readFields(card: Card): ContactFields {
  const f = emptyFields()
  const lines = card.slice(1, -1).map(parseLine).filter((l): l is Line => !!l)
  for (const l of lines) {
    switch (l.name) {
      case 'FN':
        if (!f.fn) f.fn = unesc(l.value).trim()
        break
      case 'N': {
        const [family = '', given = '', middle = '', prefix = '', suffix = ''] = splitValue(l.value, ';').map((x) => unesc(x).trim())
        f.n = { family, given, middle, prefix, suffix }
        break
      }
      case 'NICKNAME':
        if (!f.nickname) f.nickname = splitValue(l.value, ',').map((x) => unesc(x).trim()).filter(Boolean).join(', ')
        break
      case 'ORG': {
        const [org = '', ...units] = splitValue(l.value, ';').map((x) => unesc(x).trim())
        f.org = org
        f.department = units.filter(Boolean).join(', ')
        break
      }
      case 'TITLE':
        if (!f.title) f.title = unesc(l.value).trim()
        break
      case 'NOTE':
        f.note = f.note ? `${f.note}\n${unesc(l.value)}` : unesc(l.value)
        break
      case 'EMAIL': {
        const value = unesc(l.value).trim().replace(/^mailto:/i, '')
        if (value) f.emails.push({ value, ...labelOf(card, l, 'email') })
        break
      }
      case 'TEL': {
        const value = unesc(l.value).trim().replace(/^tel:/i, '')
        if (value) f.phones.push({ value, ...labelOf(card, l, 'tel') })
        break
      }
      case 'URL': {
        const value = unesc(l.value).trim()
        if (value) f.urls.push({ value, ...labelOf(card, l, 'url') })
        break
      }
      case 'ADR': {
        const [pobox = '', ext = '', street = '', locality = '', region = '', postcode = '', country = ''] = splitValue(l.value, ';').map((x) => unesc(x).trim())
        if ([pobox, ext, street, locality, region, postcode, country].some(Boolean)) f.addresses.push({ ...labelOf(card, l, 'adr'), pobox, ext, street, locality, region, postcode, country })
        break
      }
      case 'BDAY':
        if (!f.birthday) f.birthday = parseDate(l.value, l.params)
        break
      case 'ANNIVERSARY':
      case 'X-ANNIVERSARY': {
        const date = parseDate(l.value, l.params)
        if (date) f.anniversaries.push({ label: 'anniversary', date })
        break
      }
      case 'X-ABDATE': {
        const date = parseDate(l.value, l.params)
        if (date) f.anniversaries.push({ label: groupLabel(card, l.group) ?? 'other', date })
        break
      }
      case 'CATEGORIES':
        for (const c of splitValue(l.value, ',').map((x) => unesc(x).trim()).filter(Boolean)) if (!f.categories.includes(c)) f.categories.push(c)
        break
    }
  }
  if (!f.fn) f.fn = nameFrom(f)
  return f
}

/** A name to show when FN is empty: from N, else the organisation, else the first email address. */
export function nameFrom(f: ContactFields): string {
  return [f.n.prefix, f.n.given, f.n.middle, f.n.family, f.n.suffix].filter(Boolean).join(' ') || f.org || f.emails[0]?.value || f.phones[0]?.value || ''
}

/** A group card (Apple's and Fastmail's way of keeping groups) and the UIDs of its members. */
export function groupOf(card: Card): { members: string[] } | null {
  const kind = (first(card, 'KIND')?.value ?? first(card, 'X-ADDRESSBOOKSERVER-KIND')?.value ?? '').trim().toLowerCase()
  if (kind !== 'group') return null
  const members = card
    .map(parseLine)
    .filter((l): l is Line => !!l && (l.name === 'MEMBER' || l.name === 'X-ADDRESSBOOKSERVER-MEMBER'))
    .map((l) => l.value.trim().replace(/^urn:uuid:/i, ''))
  return { members }
}

export type PhotoRef = { kind: 'inline'; type: string; bytes: Buffer } | { kind: 'uri'; uri: string }

const IMAGE_TYPES: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

/** The card's photo: inline (3.0's ENCODING=b, 4.0's data: URI) or an address to fetch it from. */
export function photoOf(card: Card): PhotoRef | null {
  const l = first(card, 'PHOTO')
  if (!l) return null
  const value = l.value.trim()
  const data = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(value)
  if (data) {
    const bytes = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]), 'utf8')
    return bytes.length ? { kind: 'inline', type: data[1].toLowerCase() || 'image/jpeg', bytes } : null
  }
  const enc = (l.params.ENCODING?.[0] ?? '').toLowerCase()
  if (enc === 'b' || enc === 'base64') {
    const t = types(l)[0] ?? (l.params.MEDIATYPE?.[0] ?? '').replace(/^image\//i, '')
    const bytes = Buffer.from(value.replace(/\s+/g, ''), 'base64')
    return bytes.length ? { kind: 'inline', type: IMAGE_TYPES[t.toLowerCase()] ?? 'image/jpeg', bytes } : null
  }
  if (/^https?:\/\//i.test(value)) return { kind: 'uri', uri: value }
  return null
}

// ---------------------------------------------------------------------------------------------
// Writing

const REV = (v: string) => {
  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return v === '4.0' ? iso.replace(/[-:]/g, '') : iso
}

/** A new, empty card with its UID (3.0 unless asked otherwise: every CardDAV server takes it, iCloud only takes 3.0). */
export function newCard(uid: string, version: '3.0' | '4.0' = '3.0'): Card {
  return ['BEGIN:VCARD', `VERSION:${version}`, 'PRODID:-//mvlos//Contacts//EN', `UID:${version === '4.0' ? `urn:uuid:${uid}` : uid}`, 'END:VCARD']
}

/** Where a new line goes: after the last line of the same name, else before END:VCARD. */
function insertAt(card: Card, name: string): number {
  const at = linesNamed(card, name)
  return at.length ? at[at.length - 1] + 1 : card.length - 1
}

/** Replaces every `name` line with `lines` (none: removes them), where the first one was. */
function replaceLines(card: Card, name: string, lines: string[]) {
  const at = linesNamed(card, name)
  const where = at[0] ?? card.length - 1
  for (const i of [...at].reverse()) card.splice(i, 1)
  card.splice(Math.min(where, card.length - 1), 0, ...lines)
}

/** Item groups ("item3.") whose property is gone: their leftover labels go too. */
function dropOrphanGroups(card: Card) {
  const groups = new Map<string, { real: boolean; at: number[] }>()
  card.forEach((raw, i) => {
    const l = parseLine(raw)
    if (!l?.group) return
    const g = groups.get(l.group.toLowerCase()) ?? { real: false, at: [] }
    g.at.push(i)
    if (!/^X-AB(LABEL|ADR)/.test(l.name)) g.real = true
    groups.set(l.group.toLowerCase(), g)
  })
  const drop = [...groups.values()].filter((g) => !g.real).flatMap((g) => g.at)
  for (const i of drop.sort((a, b) => b - a)) card.splice(i, 1)
}

/** The next free "itemN" group name. */
function nextGroup(card: Card): string {
  let max = 0
  for (const raw of card) {
    const m = /^item(\d+)\./i.exec(raw)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `item${max + 1}`
}

const STANDARD: Record<'email' | 'tel' | 'url' | 'adr', string[]> = {
  email: ['home', 'work', 'other'],
  tel: ['mobile', 'home', 'work', 'main', 'pager', 'fax', 'home fax', 'work fax', 'other', 'iphone'],
  url: ['home', 'work', 'other'],
  adr: ['home', 'work', 'other'],
}

/** A new line for one labelled value, written the way this card's version wants. A label of the user's own goes in an item group with X-ABLabel. */
function labeledLines(card: Card, kind: 'email' | 'tel' | 'url' | 'adr', name: string, value: string, entry: { type?: string; pref?: boolean }, v: string): string[] {
  const type = entry.type?.trim().toLowerCase() ?? ''
  const v4 = v === '4.0'
  const t: string[] = []
  let custom = ''
  if (type && STANDARD[kind].includes(type)) {
    for (const part of type.split(' ')) t.push(part === 'mobile' ? 'cell' : part)
    if (kind === 'tel' && type === 'mobile' && !v4) t.push('voice')
  } else if (type) custom = entry.type!.trim()
  if (kind === 'email' && !v4) t.unshift('internet')
  if (entry.pref && !v4) t.push('pref')
  const params: Record<string, string[]> = {}
  if (t.length) params.TYPE = v4 ? t : t.map((x) => x.toUpperCase())
  if (entry.pref && v4) params.PREF = ['1']
  if (!custom) return [printLine({ group: '', name, params, value })]
  const group = reserveGroup(card)
  return [printLine({ group, name, params, value }), printLine({ group, name: 'X-ABLabel', params: {}, value: esc(custom) })]
}

/** A field's value in one canonical form, to tell whether it changed (key order, blanks and false flags aside). */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined && y !== '' && y !== false).sort(([a], [b]) => a.localeCompare(b))) : x))

const labeledKey = (e: Labeled, kind: string) => `${kind === 'email' ? e.value.trim().toLowerCase() : e.value.trim()}|${(e.type ?? '').toLowerCase()}|${e.pref ? 1 : 0}`
const addressKey = (a: Address) => [a.type ?? '', a.pref ? 1 : 0, a.pobox, a.ext, a.street, a.locality, a.region, a.postcode, a.country].map((x) => String(x ?? '').trim()).join('|')

/**
 * The lines named `names` rewritten as the list `next`. An entry that is still there unchanged
 * keeps its own line (its item group and label, its parameters); changed and new ones are written
 * fresh, where the first of the old lines was; the lines of removed ones go (and their item
 * groups' labels with them, see dropOrphanGroups).
 */
function rewriteList<T>(card: Card, names: string[], read: (l: Line) => T | null, next: T[], key: (entry: T) => string, write: (entry: T) => string[]) {
  const at = names.flatMap((n) => linesNamed(card, n)).sort((a, b) => a - b)
  // A line's label lines (same item group) move along with it, so they stay next to each other.
  const labelsOf = (i: number) => {
    const group = parseLine(card[i])!.group.toLowerCase()
    return group ? card.map((raw, j) => ({ j, l: parseLine(raw) })).filter(({ j, l }) => j !== i && l?.group.toLowerCase() === group && /^X-AB(LABEL|ADR)/.test(l.name)).map(({ j }) => j) : []
  }
  const existing = at.map((i) => ({ raw: card[i], labels: labelsOf(i), entry: read(parseLine(card[i])!) }))
  const kept = new Set<number>()
  const out: string[] = []
  for (const entry of next) {
    const k = key(entry)
    const match = existing.findIndex((e, i) => !kept.has(i) && e.entry && key(e.entry) === k)
    if (match >= 0) {
      kept.add(match)
      out.push(existing[match].raw, ...existing[match].labels.map((j) => card[j]))
    } else out.push(...write(entry))
  }
  const gone = [...new Set([...at, ...[...kept].flatMap((m) => existing[m].labels)])].sort((a, b) => a - b)
  const where = at[0] ?? card.length - 1
  for (const i of [...gone].reverse()) card.splice(i, 1)
  card.splice(Math.min(where - gone.filter((i) => i < where).length, card.length - 1), 0, ...out)
}

/** Reserves an "itemN" group for a new labelled line (a placeholder line, removed at the end of applyFields). */
function reserveGroup(card: Card): string {
  const group = nextGroup(card)
  card.splice(card.length - 1, 0, `${group}.X-ABLABEL-PENDING:`)
  return group
}

/** Applies to a card what changed between `base` (the fields as the editor got them) and `next`. Fields nobody changed are left alone, so an edit made elsewhere meanwhile stays. */
export function applyFields(card: Card, base: ContactFields, next: ContactFields) {
  const v = versionOf(card)
  const changed = (k: keyof ContactFields) => canon(base[k]) !== canon(next[k])
  const text = (name: string, value: string) => replaceLines(card, name, value.trim() ? [`${name}:${esc(value.trim())}`] : [])

  // 3.0 requires N, 4.0 does not.
  if (changed('n') || (!first(card, 'N') && v !== '4.0')) {
    const n = next.n
    replaceLines(card, 'N', [`N:${[n.family, n.given, n.middle, n.prefix, n.suffix].map((x) => esc(x.trim())).join(';')}`])
  }
  // FN is required: when cleared it is made from the rest.
  if (changed('fn') || changed('n') || changed('org') || !first(card, 'FN')) text('FN', next.fn.trim() || nameFrom({ ...next, fn: '' }) || 'Unnamed')
  if (changed('nickname')) replaceLines(card, 'NICKNAME', next.nickname.trim() ? [`NICKNAME:${next.nickname.split(',').map((x) => esc(x.trim())).filter(Boolean).join(',')}`] : [])
  if (changed('org') || changed('department')) {
    const units = next.department.split(',').map((x) => esc(x.trim())).filter(Boolean)
    replaceLines(card, 'ORG', next.org.trim() || units.length ? [`ORG:${[esc(next.org.trim()), ...units].join(';')}`] : [])
  }
  if (changed('title')) text('TITLE', next.title)
  if (changed('note')) text('NOTE', next.note)
  if (changed('categories')) replaceLines(card, 'CATEGORIES', next.categories.length ? [`CATEGORIES:${next.categories.map(esc).join(',')}`] : [])

  if (changed('emails'))
    rewriteList(
      card,
      ['EMAIL'],
      (l) => ({ value: unesc(l.value).trim().replace(/^mailto:/i, ''), ...labelOf(card, l, 'email') }),
      next.emails.filter((e) => e.value.trim()),
      (e) => labeledKey(e, 'email'),
      (e) => labeledLines(card, 'email', 'EMAIL', esc(e.value.trim()), e, v),
    )
  if (changed('phones'))
    rewriteList(
      card,
      ['TEL'],
      (l) => ({ value: unesc(l.value).trim().replace(/^tel:/i, ''), ...labelOf(card, l, 'tel') }),
      next.phones.filter((e) => e.value.trim()),
      (e) => labeledKey(e, 'tel'),
      (e) => labeledLines(card, 'tel', 'TEL', esc(e.value.trim()), e, v),
    )
  if (changed('urls'))
    rewriteList(
      card,
      ['URL'],
      (l) => ({ value: unesc(l.value).trim(), ...labelOf(card, l, 'url') }),
      next.urls.filter((e) => e.value.trim()),
      (e) => labeledKey(e, 'url'),
      // A URL is not text: only a backslash would need escaping (commas and semicolons stay as they are).
      (e) => labeledLines(card, 'url', 'URL', e.value.trim().replace(/\\/g, '\\\\'), e, v),
    )
  if (changed('addresses'))
    rewriteList(
      card,
      ['ADR'],
      (l) => {
        const [pobox = '', ext = '', street = '', locality = '', region = '', postcode = '', country = ''] = splitValue(l.value, ';').map((x) => unesc(x).trim())
        return { ...labelOf(card, l, 'adr'), pobox, ext, street, locality, region, postcode, country }
      },
      next.addresses.filter((a) => [a.pobox, a.ext, a.street, a.locality, a.region, a.postcode, a.country].some((x) => x?.trim())),
      addressKey,
      (a) => labeledLines(card, 'adr', 'ADR', [a.pobox, a.ext, a.street, a.locality, a.region, a.postcode, a.country].map((x) => esc((x ?? '').trim())).join(';'), a, v),
    )

  if (changed('birthday')) {
    const was = first(card, 'BDAY')
    replaceLines(card, 'BDAY', next.birthday ? [dateLine('BDAY', next.birthday, v, !!was?.params['X-APPLE-OMIT-YEAR'])] : [])
  }
  if (changed('anniversaries')) {
    // One "anniversary" goes in ANNIVERSARY (4.0) or X-ANNIVERSARY (3.0); other dates, and a second
    // anniversary, in Apple's labelled X-ABDATE, which Fastmail and Apple show with their labels.
    let own = false
    rewriteList(
      card,
      ['ANNIVERSARY', 'X-ANNIVERSARY', 'X-ABDATE'],
      (l) => ({ label: l.name === 'X-ABDATE' ? (groupLabel(card, l.group) ?? 'other') : 'anniversary', date: parseDate(l.value, l.params) }),
      next.anniversaries.filter((d) => d.date),
      (d) => `${d.label.trim().toLowerCase()}|${d.date}`,
      (d) => {
        if (d.label.trim().toLowerCase() === 'anniversary' && !own) {
          own = true
          return [dateLine(v === '4.0' ? 'ANNIVERSARY' : 'X-ANNIVERSARY', d.date, v, false)]
        }
        const group = reserveGroup(card)
        const date = d.date.startsWith('--') ? `X-ABDATE;X-APPLE-OMIT-YEAR=1604:1604-${d.date.slice(2)}` : `X-ABDATE:${d.date}`
        return [`${group}.${date}`, `${group}.X-ABLabel:${esc(d.label.trim() || 'other')}`]
      },
    )
  }
  // The placeholders that reserved item numbers, and labels left without their property.
  for (let i = card.length - 1; i >= 0; i--) if (/^item\d+\.X-ABLABEL-PENDING:$/i.test(card[i])) card.splice(i, 1)
  dropOrphanGroups(card)
  touch(card)
}

/** BDAY and friends: 4.0's basic form (--MMDD without a year), 3.0's extended one (Apple's 1604 for no year, when the card used it before). */
function dateLine(name: string, date: string, v: string, apple: boolean): string {
  const noYear = date.startsWith('--')
  if (v === '4.0') return `${name}:${noYear ? `--${date.slice(2).replace('-', '')}` : date.replace(/-/g, '')}`
  if (noYear && apple) return `${name};X-APPLE-OMIT-YEAR=1604:1604-${date.slice(2)}`
  return `${name}:${date}`
}

/** The photo set (bytes and type) or removed (null). */
export function setPhoto(card: Card, photo: { type: string; bytes: Buffer } | null) {
  if (!photo) return replaceLines(card, 'PHOTO', []), touch(card)
  const b64 = photo.bytes.toString('base64')
  const v = versionOf(card)
  replaceLines(card, 'PHOTO', [v === '4.0' ? `PHOTO:data:${photo.type};base64,${b64}` : `PHOTO;ENCODING=b;TYPE=${photo.type.replace(/^image\//, '').toUpperCase()}:${b64}`])
  touch(card)
}

/** A group card's members, as UIDs (urn:uuid: in 4.0's MEMBER, Apple's X-ADDRESSBOOKSERVER-MEMBER in 3.0). */
export function setMembers(card: Card, uids: string[]) {
  const name = linesNamed(card, 'MEMBER').length || versionOf(card) === '4.0' ? 'MEMBER' : 'X-ADDRESSBOOKSERVER-MEMBER'
  replaceLines(card, 'MEMBER', [])
  replaceLines(card, 'X-ADDRESSBOOKSERVER-MEMBER', [...new Set(uids)].map((u) => `${name}:urn:uuid:${u}`))
  touch(card)
}

/** A new group card named `name`, in the style of the book's other groups (Apple's 3.0 one unless they are 4.0). */
export function newGroupCard(uid: string, name: string, version: '3.0' | '4.0'): Card {
  const card = newCard(uid, version)
  card.splice(card.length - 1, 0, `FN:${esc(name)}`, `N:${esc(name)};;;;`, version === '4.0' ? 'KIND:group' : 'X-ADDRESSBOOKSERVER-KIND:group')
  return card
}

/** REV says when the card last changed. */
function touch(card: Card) {
  replaceLines(card, 'REV', [`REV:${REV(versionOf(card))}`])
}

/** Makes sure a card has a UID (an imported one may not); answers it. */
export function ensureUid(card: Card, make: () => string): string {
  const uid = uidOf(card)
  if (uid) return uid
  const fresh = make()
  card.splice(insertAt(card, 'VERSION'), 0, `UID:${versionOf(card) === '4.0' ? `urn:uuid:${fresh}` : fresh}`)
  return fresh
}
