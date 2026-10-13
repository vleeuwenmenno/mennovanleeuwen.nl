// Checks the Calendar's .ics import (src/apps/calendar/ics.ts) against files as generators really
// write them, including ones that never close their event (no END:VEVENT or END:VCALENDAR).

import { parseIcs } from '../src/apps/calendar/ics.ts'
const head = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//y\r\nMETHOD:PUBLISH\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\nEND:VTIMEZONE\r\n'
const body = 'BEGIN:VEVENT\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT1H\r\nDESCRIPTION:x\r\nEND:VALARM\r\nUID:a@b\r\nSUMMARY:Viewing\r\nSTATUS:CONFIRMED\r\nLOCATION:Somewhere 1\\, Town\r\nDTSTART;TZID=Europe/Amsterdam:20261015T100000\r\nDTEND;TZID=Europe/Amsterdam:20261015T103000\r\n'
const cases: [string, string, number][] = [
  ['no END:VEVENT, no END:VCALENDAR (the user\'s file)', head + body, 1],
  ['closed properly', head + body + 'END:VEVENT\r\nEND:VCALENDAR\r\n', 1],
  ['END:VCALENDAR without END:VEVENT', head + body + 'END:VCALENDAR\r\n', 1],
  ['two events, first unclosed', head + body + body.replace('a@b', 'c@d').replace('20261015T1', '20261016T1') + 'END:VEVENT\r\nEND:VCALENDAR\r\n', 2],
]
let fail = 0
for (const [name, text, n] of cases) {
  const evs = parseIcs(text)
  const ok = evs.length === n && evs[0].title === 'Viewing' && evs[0].start === '2026-10-15T08:00:00.000Z' && evs[0].end === '2026-10-15T08:30:00.000Z' && evs[0].location === 'Somewhere 1, Town'
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${evs.length} event(s)${evs[0] ? ` ${evs[0].start} → ${evs[0].end}` : ''}`)
}
process.exit(fail ? 1 : 0)
