// Checks the Calendar's .ics import (src/apps/calendar/ics.ts) against files as generators really
// write them: ones that never close their event (no END:VEVENT or END:VCALENDAR), a byte order mark
// or UTF-16, extended ISO dates, lowercase names, a quoted TZID, X-WR-TIMEZONE for floating times,
// and what it says when an event can't be read.

import { decodeText } from '../src/data/decodeText.ts'
import { readVcf } from '../src/apps/contacts/vcf.ts'
import { explainIcs, parseIcs, readIcs } from '../src/apps/calendar/ics.ts'
const head = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//y\r\nMETHOD:PUBLISH\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\nEND:VTIMEZONE\r\n'
const body = 'BEGIN:VEVENT\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT1H\r\nDESCRIPTION:x\r\nEND:VALARM\r\nUID:a@b\r\nSUMMARY:Viewing\r\nSTATUS:CONFIRMED\r\nLOCATION:Somewhere 1\\, Town\r\nDTSTART;TZID=Europe/Amsterdam:20261015T100000\r\nDTEND;TZID=Europe/Amsterdam:20261015T103000\r\n'
const event = (props: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u@x\r\nSUMMARY:Viewing\r\n${props}END:VEVENT\r\nEND:VCALENDAR\r\n`
const utf16 = (s: string, bom = true) => Uint8Array.from([...(bom ? [0xff, 0xfe] : []), ...[...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])])

let fail = 0
const report = (ok: boolean, name: string, detail: string) => {
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

// The user's 10:00-10:30 Amsterdam viewing, in every shape its file may come in.
const cases: [string, string, number][] = [
  ["no END:VEVENT, no END:VCALENDAR (the user's file)", head + body, 1],
  ['closed properly', head + body + 'END:VEVENT\r\nEND:VCALENDAR\r\n', 1],
  ['END:VCALENDAR without END:VEVENT', head + body + 'END:VCALENDAR\r\n', 1],
  ['two events, first unclosed', head + body + body.replace('a@b', 'c@d').replace('20261015T1', '20261016T1') + 'END:VEVENT\r\nEND:VCALENDAR\r\n', 2],
  ['a UTF-8 byte order mark', '﻿' + head + body, 1],
  ['lowercase names and values', (head + body).replace(/^([A-Z-]+)/gm, (m) => m.toLowerCase()).replace('BEGIN:VEVENT', 'begin:vevent'), 1],
  ['a quoted TZID', head + body.replace(/TZID=Europe\/Amsterdam/g, 'TZID="Europe/Amsterdam"'), 1],
  ['VALUE=DATE-TIME', head + body.replace(/;TZID=Europe\/Amsterdam/g, ';VALUE=DATE-TIME;TZID=Europe/Amsterdam'), 1],
  ['extended dates with an offset', head + body.replace(/DTSTART;TZID=Europe\/Amsterdam:20261015T100000/, 'DTSTART:2026-10-15T10:00:00+02:00').replace(/DTEND;TZID=Europe\/Amsterdam:20261015T103000/, 'DTEND:2026-10-15T10:30:00+02:00'), 1],
  ['extended dates in UTC with fractions', head + body.replace(/DTSTART;TZID=Europe\/Amsterdam:20261015T100000/, 'DTSTART:2026-10-15T08:00:00.000Z').replace(/DTEND;TZID=Europe\/Amsterdam:20261015T103000/, 'DTEND:2026-10-15T08:30:00.000Z'), 1],
  ['floating times with X-WR-TIMEZONE', head.replace('METHOD:PUBLISH', 'X-WR-TIMEZONE:Europe/Amsterdam') + body.replace(/;TZID=Europe\/Amsterdam/g, ''), 1],
  ['a UTF-8 file read from bytes', head + body, 1],
  ['a UTF-16 file with a BOM', decodeText(utf16(head + body)), 1],
  ['a UTF-16 file without a BOM', decodeText(utf16(head + body, false)), 1],
  ['a UTF-16 big-endian file', decodeText(Uint8Array.from([0xfe, 0xff, ...[...(head + body)].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255])])), 1],
]
for (const [name, text, n] of cases) {
  const evs = parseIcs(text)
  const ok = evs.length === n && evs[0].title === 'Viewing' && evs[0].start === '2026-10-15T08:00:00.000Z' && evs[0].end === '2026-10-15T08:30:00.000Z' && evs[0].location === 'Somewhere 1, Town' && evs[0].uid === 'a@b'
  report(ok, name, `${evs.length} event(s)${evs[0] ? ` ${evs[0].start} → ${evs[0].end}` : ''}`)
}

// Days: plain and extended, and the end day exclusive.
for (const [name, props, start, end] of [
  ['an all-day event, basic', 'DTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261016\r\n', '2026-10-15', '2026-10-16'],
  ['an all-day event, extended', 'DTSTART:2026-10-15\r\n', '2026-10-15', '2026-10-16'],
  ['no end, a duration', 'DTSTART:2026-10-15T08:00:00Z\r\nDURATION:PT2H\r\n', '2026-10-15T08:00:00.000Z', '2026-10-15T10:00:00.000Z'],
  ['a negative offset', 'DTSTART:2026-10-15T08:00:00-05:00\r\n', '2026-10-15T13:00:00.000Z', '2026-10-15T14:00:00.000Z'],
  ['an offset without a colon', 'DTSTART:20261015T100000+0200\r\n', '2026-10-15T08:00:00.000Z', '2026-10-15T09:00:00.000Z'],
] as const) {
  const [e] = parseIcs(event(props))
  report(!!e && e.start === start && e.end === end, name, e ? `${e.start} → ${e.end}` : 'no event')
}

// A repeating event keeps its rule and the UID the file gave it.
const [weekly] = parseIcs(event('DTSTART:20261015T080000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=4\r\n'))
report(weekly?.recurrence === 'FREQ=WEEKLY;BYDAY=TH;COUNT=4' && weekly.uid === 'u@x', 'a repeating event', `${weekly?.recurrence} ${weekly?.uid}`)

// When nothing imports, the reader says why.
const bad = readIcs(event('DTSTART:next tuesday\r\n'))
report(bad.events.length === 0 && bad.found === 1 && /DTSTART: next tuesday/.test(bad.unreadable[0] ?? ''), 'an unreadable start', `${bad.found} found, ${bad.unreadable.join(' | ')}`)
const none = readIcs(event(''))
report(none.events.length === 0 && none.found === 1 && /no DTSTART/.test(none.unreadable[0] ?? ''), 'no start at all', `${none.found} found, ${none.unreadable.join(' | ')}`)
const empty = readIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
report(empty.found === 0, 'a file with no events', `${empty.found} found`)
const cancelled = readIcs(event('DTSTART:20261015T080000Z\r\nSTATUS:CANCELLED\r\n'))
report(cancelled.events.length === 0 && cancelled.found === 1 && cancelled.unreadable.length === 0, 'a cancelled event is left out quietly', `${cancelled.found} found`)

const why = (text: string) => explainIcs(['x.ics'], [readIcs(text)])
report(why(event('DTSTART:next tuesday\r\n')) === "1 event found, but its start time couldn't be read (Viewing: DTSTART: next tuesday)", 'the notice for an unreadable start', why(event('DTSTART:next tuesday\r\n')))
report(why('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n') === 'x.ics has no events', 'the notice for no events', why('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'))
report(/cancelled/.test(why(event('DTSTART:20261015T080000Z\r\nSTATUS:CANCELLED\r\n'))), 'the notice for a cancelled event', why(event('DTSTART:20261015T080000Z\r\nSTATUS:CANCELLED\r\n')))

// The vCards Contacts lists before importing them: the same tolerance for byte order marks, UTF-16 and case.
const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:j@x\r\nFN:Jane Doe\r\nORG:Acme;Sales\r\nEMAIL;TYPE=work:jane@example.com\r\nTEL:+31 6 1234\r\nEND:VCARD\r\n'
for (const [name, text] of [
  ['a vCard', card],
  ['a vCard with a byte order mark', '\uFEFF' + card],
  ['a UTF-16 vCard', decodeText(utf16(card))],
  ['lowercase names', card.replace(/^([A-Z]+)/gm, (m) => m.toLowerCase())],
  ['a vCard that never closes', card.replace('END:VCARD\r\n', '')],
  ['a folded name', card.replace('FN:Jane Doe', 'FN:Jane\r\n  Doe')],
] as const) {
  const [c] = readVcf(text)
  report(!!c && c.name === 'Jane Doe' && c.uid === 'j@x' && c.detail === 'Acme · jane@example.com · +31 6 1234', name, c ? `${c.name} (${c.detail})` : 'no card')
}
const noFn = readVcf('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Team\r\nKIND:group\r\nEND:VCARD\r\n')
report(noFn.length === 1 && noFn[0].name === 'Jane Doe', 'a name from N, and group cards left out', noFn.map((c) => c.name).join(', '))

process.exit(fail ? 1 : 0)
