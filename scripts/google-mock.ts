// A minimal stand-in for Google Calendar's API (v3), for `pnpm check:pim-links`
// (scripts/pim-check.ts) and for trying the apps without a Google account:
//
//   node scripts/google-mock.ts 8852     # then run the site with GOOGLE_API_URL=http://127.0.0.1:8852/calendar/v3
//
// It answers what server/google.ts asks: the calendar list, events by range or by iCalUID, one
// event, PATCH (attendees and their answers), import, insert and delete, with a fixed bearer
// token. Everything is kept in memory; `log` keeps every request with its sendUpdates.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export type GCalendar = { id: string; summary: string; accessRole: 'owner' | 'writer' | 'reader'; primary?: boolean; backgroundColor: string; events: Map<string, J> }
export type GoogleMock = { origin: string; api: string; token: string; calendars: Map<string, GCalendar>; log: string[]; close: () => Promise<void> }

export const GOOGLE_TOKEN = 'mock-google-access-token'

export async function startMockGoogle(port = 0, me = 'me@example.test'): Promise<GoogleMock> {
  const calendars = new Map<string, GCalendar>([
    [me, { id: me, summary: 'Google (mock)', accessRole: 'owner', primary: true, backgroundColor: '#4285f4', events: new Map() }],
    ['family@group.calendar.google.com', { id: 'family@group.calendar.google.com', summary: 'Family', accessRole: 'writer', backgroundColor: '#0b8043', events: new Map() }],
  ])
  const log: string[] = []
  const send = (res: ServerResponse, status: number, body?: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body))
  const read = async (req: IncomingMessage) => {
    let s = ''
    for await (const c of req) s += c
    return s ? (JSON.parse(s) as J) : {}
  }
  const calendarOf = (raw: string) => calendars.get(decodeURIComponent(raw) === 'primary' ? me : decodeURIComponent(raw))
  const startOf = (e: J) => e.start?.dateTime ?? e.start?.date ?? ''

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/calendar\/v3/, '')
    log.push(`${req.method} ${path}${url.searchParams.has('sendUpdates') ? ` sendUpdates=${url.searchParams.get('sendUpdates')}` : ''}`)
    if (req.method === 'POST' && url.pathname === '/token') return send(res, 200, { access_token: GOOGLE_TOKEN, expires_in: 3600 })
    if (req.headers.authorization !== `Bearer ${GOOGLE_TOKEN}`) return send(res, 401, { error: { code: 401 } })
    if (path === '/users/me/calendarList') return send(res, 200, { items: [...calendars.values()].map(({ events: _, ...c }) => ({ ...c, selected: true })) })
    const list = /^\/calendars\/([^/]+)\/events$/.exec(path)
    const one = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path)
    const imp = /^\/calendars\/([^/]+)\/events\/import$/.exec(path)
    const cal = calendarOf((imp ?? one ?? list)?.[1] ?? '')
    if (!cal) return send(res, 404, { error: { code: 404 } })
    if (imp && req.method === 'POST') {
      const body = await read(req)
      const existing = [...cal.events.values()].find((e) => e.iCalUID === body.iCalUID)
      const id = existing?.id ?? randomBytes(8).toString('hex')
      const e = { ...body, id, status: 'confirmed', htmlLink: `https://calendar.example/${id}` }
      cal.events.set(id, e)
      return send(res, 200, e)
    }
    if (list && req.method === 'GET') {
      const uid = url.searchParams.get('iCalUID')
      const min = url.searchParams.get('timeMin')
      const max = url.searchParams.get('timeMax')
      const items = [...cal.events.values()].filter((e) => (uid ? e.iCalUID === uid : (!min || (e.end?.dateTime ?? e.end?.date ?? '') > min) && (!max || startOf(e) < max)) && (url.searchParams.get('showDeleted') === 'true' || e.status !== 'cancelled'))
      return send(res, 200, { items: items.sort((a, b) => startOf(a).localeCompare(startOf(b))) })
    }
    if (list && req.method === 'POST') {
      const body = await read(req)
      const id = randomBytes(8).toString('hex')
      const e = { ...body, id, iCalUID: `${id}@google.com`, status: 'confirmed' }
      cal.events.set(id, e)
      return send(res, 200, e)
    }
    if (!one) return send(res, 404, { error: { code: 404 } })
    const e = cal.events.get(decodeURIComponent(one[2]))
    if (!e) return send(res, 404, { error: { code: 404 } })
    if (req.method === 'GET') return send(res, 200, e)
    if (req.method === 'PATCH') {
      Object.assign(e, await read(req))
      return send(res, 200, e)
    }
    if (req.method === 'DELETE') {
      cal.events.delete(e.id)
      return send(res, 204)
    }
    send(res, 405, { error: { code: 405 } })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, api: `${origin}/calendar/v3`, token: GOOGLE_TOKEN, calendars, log, close: () => new Promise((r) => server.close(() => r())) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockGoogle(Number(process.argv[2] ?? 8852))
  console.log(`Google Calendar mock on ${mock.api} (GOOGLE_API_URL), token endpoint ${mock.origin}/token (GOOGLE_TOKEN_URL)`)
}
