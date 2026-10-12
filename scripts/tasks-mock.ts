// A small stand-in CalDAV server with task lists, for `pnpm check:tasks` (scripts/tasks-check.ts) and
// for trying the Tasks app in a browser without a real account:
//
//   node scripts/tasks-mock.ts 8800      # http://127.0.0.1:8800/, user "mock", password "mock"
//
// It answers what server/caldav.ts and server/tasks.ts ask: the principal and calendar home
// (PROPFIND), the collections in it (one for events only, one for tasks only, one for both),
// calendar-query REPORTs for VTODO and VEVENT, and GET, PUT and DELETE of objects with ETags
// (If-Match, If-None-Match: 412 when they don't hold), MKCALENDAR, PROPPATCH and DELETE of
// collections. Everything is kept in memory. Tests can make an object change "somewhere else" right
// after it was read (`bump`), to see what a conflict does.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type Collection = { name: string; color: string; comps: string[]; objects: Map<string, { etag: string; text: string }> }
export type Mock = {
  server: Server
  origin: string
  collections: Map<string, Collection>
  /** Object paths that change elsewhere right after their next GET (count: how many GETs in a row). */
  bump: Map<string, number>
  /** Every request, as "METHOD path". */
  log: string[]
  close: () => Promise<void>
}

export const USER = 'mock'
export const PASSWORD = 'mock'
const HOME = '/cal/mock/'

let etagN = 0
const etag = () => `"e${++etagN}"`
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Seeds: events in one collection, tasks with other apps' properties and alarms in another. */
function seed(collections: Map<string, Collection>) {
  const today = new Date()
  const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  const tomorrow = new Date(today.getTime() + 864e5)
  const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mock//EN\r\n${body}END:VCALENDAR\r\n`
  collections.set(`${HOME}events/`, { name: 'Events', color: '#7aa2f7FF', comps: ['VEVENT'], objects: new Map() })
  collections.set(`${HOME}tasks/`, {
    name: 'Reminders',
    color: '#e0af68FF',
    comps: ['VTODO'],
    objects: new Map([
      [
        `${HOME}tasks/seed-1.ics`,
        {
          etag: etag(),
          text: cal(
            `BEGIN:VTODO\r\nUID:seed-1\r\nCREATED:20261001T080000Z\r\nSUMMARY:Water the plants\r\nDESCRIPTION:The ones on the balcony\r\nDUE;VALUE=DATE:${ymd(tomorrow)}\r\nPRIORITY:5\r\nX-APPLE-SORT-ORDER:100\r\nX-FOO-UNKNOWN;X-PARAM=keep:Some other app's value\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER;VALUE=DATE-TIME:20300101T090000Z\r\nX-WR-ALARMUID:alarm-1\r\nEND:VALARM\r\nEND:VTODO\r\n`,
          ),
        },
      ],
      [
        `${HOME}tasks/seed-2.ics`,
        {
          etag: etag(),
          text: cal(
            `BEGIN:VTODO\r\nUID:seed-2\r\nSUMMARY:Weekly review\r\nDTSTART;TZID=Europe/Amsterdam:20261013T090000\r\nDUE;TZID=Europe/Amsterdam:20261013T090000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nX-APPLE-SORT-ORDER:200\r\nEND:VTODO\r\n`,
          ),
        },
      ],
      [
        `${HOME}tasks/seed-3.ics`,
        {
          etag: etag(),
          text: cal(`BEGIN:VTODO\r\nUID:seed-3\r\nSUMMARY:Take vitamins\r\nDUE;VALUE=DATE:20261013\r\nRRULE:FREQ=DAILY\r\nX-APPLE-SORT-ORDER:300\r\nEND:VTODO\r\n`),
        },
      ],
      [
        `${HOME}tasks/seed-4.ics`,
        {
          etag: etag(),
          text: cal(`BEGIN:VTODO\r\nUID:seed-4\r\nSUMMARY:Pay rent\r\nDUE;VALUE=DATE:20261031\r\nRRULE:FREQ=MONTHLY\r\nX-APPLE-SORT-ORDER:400\r\nEND:VTODO\r\n`),
        },
      ],
      [
        `${HOME}tasks/seed-5.ics`,
        {
          etag: etag(),
          text: cal(`BEGIN:VTODO\r\nUID:seed-5\r\nSUMMARY:Last one\r\nDUE:20261013T120000Z\r\nRRULE:FREQ=DAILY;COUNT=1\r\nEND:VTODO\r\n`),
        },
      ],
    ]),
  })
  collections.set(`${HOME}both/`, { name: 'Personal', color: '#9ece6aFF', comps: ['VEVENT', 'VTODO'], objects: new Map() })
}

const multistatus = (parts: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/">${parts.join('')}</d:multistatus>`
const response = (href: string, props: string) => `<d:response><d:href>${xmlEsc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`

export async function startMock(port = 0): Promise<Mock> {
  const collections = new Map<string, Collection>()
  seed(collections)
  const bump = new Map<string, number>()
  const log: string[] = []

  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const path = decodeURI(new URL(req.url ?? '/', 'http://x').pathname)
    const method = req.method ?? 'GET'
    log.push(`${method} ${path}`)
    const auth = req.headers.authorization ?? ''
    if (auth !== `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`) return void res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' }).end()
    const xml = (status: number, text: string) => res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' }).end(text)
    const dir = path.endsWith('/') ? path : `${path}/`
    const collection = collections.get(dir)
    const objectDir = path.slice(0, path.lastIndexOf('/') + 1)
    const owner = collections.get(objectDir)

    if (method === 'PROPFIND') {
      if (path === '/' || path === '/.well-known/caldav' || path === '/dav/') return xml(207, multistatus([response(path, '<d:current-user-principal><d:href>/principals/mock/</d:href></d:current-user-principal>')]))
      if (path === '/principals/mock/') return xml(207, multistatus([response(path, `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`)]))
      if (path === HOME) {
        const parts = [response(HOME, '<d:resourcetype><d:collection/></d:resourcetype>')]
        for (const [href, c] of collections)
          parts.push(
            response(
              href,
              `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${xmlEsc(c.name)}</d:displayname><a:calendar-color>${c.color}</a:calendar-color><c:supported-calendar-component-set>${c.comps.map((n) => `<c:comp name="${n}"/>`).join('')}</c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set>`,
            ),
          )
        return xml(207, multistatus(parts))
      }
      return void res.writeHead(404).end()
    }
    if (method === 'REPORT' && collection) {
      const want = /comp-filter name="VTODO"/.test(body) ? 'VTODO' : 'VEVENT'
      const parts = [...collection.objects].filter(([, o]) => o.text.includes(`BEGIN:${want}`)).map(([href, o]) => response(href, `<d:getetag>${xmlEsc(o.etag)}</d:getetag><c:calendar-data>${xmlEsc(o.text)}</c:calendar-data>`))
      return xml(207, multistatus(parts))
    }
    if (method === 'MKCALENDAR') {
      if (collections.has(dir)) return void res.writeHead(405).end()
      if (!dir.startsWith(HOME)) return void res.writeHead(403).end()
      const name = /<d:displayname>([^<]*)</.exec(body)?.[1] ?? 'Untitled'
      const color = /<a:calendar-color>([^<]*)</.exec(body)?.[1] ?? '#ffffff'
      const comps = [...body.matchAll(/<c:comp name="(\w+)"/g)].map((m) => m[1])
      collections.set(dir, { name, color, comps: comps.length ? comps : ['VEVENT', 'VTODO'], objects: new Map() })
      return void res.writeHead(201).end()
    }
    if (method === 'PROPPATCH' && collection) {
      const name = /<d:displayname>([^<]*)</.exec(body)?.[1]
      const color = /<a:calendar-color>([^<]*)</.exec(body)?.[1]
      if (name) collection.name = name
      if (color) collection.color = color
      return xml(207, multistatus([response(dir, '<d:displayname/>')]))
    }
    if (method === 'DELETE' && collection && path.endsWith('/')) {
      collections.delete(dir)
      return void res.writeHead(204).end()
    }
    if (!owner) return void res.writeHead(404).end()
    const obj = owner.objects.get(path)
    if (method === 'GET') {
      if (!obj) return void res.writeHead(404).end()
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', ETag: obj.etag }).end(obj.text)
      // Changed elsewhere right after this read: another app adds a property and the ETag moves on.
      const n = bump.get(path) ?? 0
      if (n > 0) {
        bump.set(path, n - 1)
        owner.objects.set(path, { etag: etag(), text: obj.text.replace('END:VTODO', `X-OTHER-APP:changed ${etagN}\r\nEND:VTODO`) })
      }
      return
    }
    if (method === 'PUT') {
      const ifMatch = req.headers['if-match']
      const ifNone = req.headers['if-none-match']
      if ((ifNone === '*' && obj) || (ifMatch && (!obj || obj.etag !== ifMatch))) return void res.writeHead(412).end()
      const tag = etag()
      owner.objects.set(path, { etag: tag, text: body })
      return void res.writeHead(obj ? 204 : 201, { ETag: tag }).end()
    }
    if (method === 'DELETE') {
      if (!obj) return void res.writeHead(404).end()
      owner.objects.delete(path)
      return void res.writeHead(204).end()
    }
    res.writeHead(405).end()
  }

  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (d) => (body += d))
    req.on('end', () => handle(req, res, body))
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { server, origin, collections, bump, log, close: () => new Promise((r) => server.close(() => r())) }
}

// Run on its own: a mock to point the Tasks app at.
if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMock(Number(process.argv[2] ?? 8800))
  console.log(`CalDAV mock on ${mock.origin}/ (user "${USER}", password "${PASSWORD}")`)
}
