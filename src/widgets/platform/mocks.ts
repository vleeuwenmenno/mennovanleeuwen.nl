import type { WidgetInput } from './package'
// Preview has no resource handles: rendered data is synthetic and every effect is inert.
const page = { total: 1, shown: 1, page: 0, pages: 1, truncated: false }
export const MOCK_INPUT: WidgetInput = {
  custom: { now: 1_793_000_000_000, today: '2026-10-30', state: null, revision: 'mock:1' },
  note: { text: 'Sample note\n- [ ] Try a checklist', revision: 'mock:1' },
  weather: { place: 'Sample city', units: 'c', summary: '☀ 18° · Clear sky', hours: ['12:00 18°', '13:00 19°'], days: ['Tomorrow 20° / 12°'] },
  agenda: { state: 'ready', now: 0, today: '2026-10-30', page, errors: [], days: [{ key: '2026-10-30', label: 'Today', tasks: [{ title: 'Sample recurring task', notes: 'Mock task details', due: '2026-10-30', time: 'today', allDay: true, open: '', complete: '', color: '' }], events: [{ title: 'Sample meeting', time: '10:00', calendar: 'Sample calendar', location: 'Office', start: 1, end: 2, allDay: false, open: '', color: '', mark: { glyph: '📝', title: 'Sample linked note' } }] }] },
  inbox: { state: 'ready', count: 1, errors: [], page, sections: [{ key: 'review', title: 'Waiting for your review', empty: '', total: 1, items: [{ title: 'Sample pull request', repo: 'sample/project', number: 12, kind: 'pr', draft: true, state: 'open', ago: 'now', source: 'Sample forge', open: '' }] }] },
  status: { state: 'ready', down: 0, page, checks: [{ name: 'Sample service', address: 'https://example.invalid', enabled: true, down: false, error: '', downSince: '', uptime: 99.99, responseTime: 42, sslDays: 30, sslValid: true, open: '' }] },
  minecraft: { state: 'ready', online: true, address: 'example.invalid', copy: '', open: '', motd: 'Sample server', version: '1.21', software: 'Paper', difficulty: 'Hard', latency: 42, world: { day: 12, clock: '14:20', phase: 'day' }, players: { online: 1, max: 20, totalNamed: 1, list: [{ name: 'SamplePlayer', dimension: 'Nether', vitals: 'Lv 30 · ♥ 10/10' }] }, page },
}
