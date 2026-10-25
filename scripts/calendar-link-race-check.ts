// Checks, over real HTTP against the real site server, that a combined calendar answer (Google and
// CalDAV together, server/calendars.ts) never carries Google data of a link that changed while the
// answer was being put together. Stand-ins only: a Google that names every account's data after its
// token (and its token endpoint), the CalDAV stand-in (scripts/tasks-mock.ts) behind a proxy that holds
// requests until released, and a scratch DATA_DIR.
//
// For /api/calendar/calendars and /api/calendar/events, each with a CalDAV request held after
// Google's part has already answered:
//   - the Google link changes to another account, is disconnected, or the account is deleted: the
//     response is not a 200 and holds nothing of the old account;
//   - no change: the combined answer comes back whole;
//   - a CalDAV-only account, and one that connects Google while its CalDAV request is held, are not
//     failed for it;
//   - a fresh request after a relink returns only the new account's Google data.
//
//   node scripts/calendar-link-race-check.ts
//
// Exits 1 on any failure.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep } from './empires-harness.ts'
import { PASSWORD, startMock, USER } from './tasks-mock.ts'

// --- Google: data named after the token, so whose it is can be told from the answer ---------------
const googleLog: string[] = []
const google = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x')
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    if (url.pathname === '/revoke') return send({})
    if (url.pathname === '/token') {
      const code = new URLSearchParams(body).get('code') ?? ''
      const name = code.replace(/^code-/, '')
      return send({ access_token: `tok-${name}`, refresh_token: `ref-${name}`, expires_in: 3600, scope: 'openid email', id_token: `x.${Buffer.from(JSON.stringify({ email: `${name}@example.test` })).toString('base64url')}.x` })
    }
    const token = String(req.headers.authorization ?? '').replace('Bearer ', '')
    googleLog.push(`${token} ${url.pathname.endsWith('calendarList') ? 'list' : 'events'}`)
    if (url.pathname.endsWith('/calendarList')) return send({ items: [{ id: `g-${token}`, summary: `Google ${token}`, accessRole: 'owner', selected: true }] })
    send({ items: [{ id: `ev-${token}`, summary: `private ${token}`, start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date(Date.now() + 3600_000).toISOString() } }] })
  })
})
await new Promise<void>((r) => google.listen(0, '127.0.0.1', r))
const googleOrigin = `http://127.0.0.1:${(google.address() as { port: number }).port}`

// --- CalDAV behind a proxy that holds the requests of one method until released -------------------
const caldav = await startMock()
{
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const start = Date.now() + 3600_000
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mock//EN\r\nBEGIN:VEVENT\r\nUID:race-event\r\nDTSTAMP:${stamp(Date.now())}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(start + 3600_000)}\r\nSUMMARY:CalDAV event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
  caldav.collections.get('/cal/mock/events/')!.objects.set('/cal/mock/events/race-event.ics', { etag: '"race"', text: ics })
}
const gate = { method: '', held: 0, release: null as null | (() => void), wait: null as null | Promise<void> }
const proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
  const forward = () => {
    const up = httpRequest(`${caldav.origin}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(caldav.origin).host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  }
  if (gate.method && req.method === gate.method && gate.wait) {
    gate.held++
    req.pause()
    void gate.wait.then(() => (req.resume(), forward()))
  } else forward()
})
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
function hold(method: string) {
  gate.method = method
  gate.held = 0
  gate.wait = new Promise<void>((r) => (gate.release = r))
}
function release() {
  gate.release?.()
  gate.method = ''
}

// --- The site, with accounts that are admins (they may reach 127.0.0.1) ---------------------------
const IDS = Array.from({ length: 40 }, (_, i) => i + 1).join(',')
const server = new Server({
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'x',
  NOTIFY_WATCH: 'off',
  ADMIN_GITHUB_IDS: IDS,
  GOOGLE_CLIENT_ID: 'x',
  GOOGLE_CLIENT_SECRET: 'x',
  GOOGLE_API_URL: `${googleOrigin}/calendar/v3`,
  GOOGLE_TOKEN_URL: `${googleOrigin}/token`,
  GOOGLE_REVOKE_URL: `${googleOrigin}/revoke`,
})
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
await server.start()

let nextId = 1
/** A new account with a session; returns its id and a request helper. */
function account() {
  const id = nextId++
  const sid = randomBytes(24).toString('hex')
  const now = Date.now()
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `race-${id}`, encrypt(''), now, now) // no GitHub token: deleting an account never sends anything to github.com
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + 86400_000)
  const call = (method: string, path: string, body?: unknown, cookie = '') =>
    fetch(`${server.origin}${path}`, { method, redirect: 'manual', headers: { Cookie: `mvlos_sid=${sid}${cookie}`, 'X-MVL-Account': String(id), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  /** The real consent flow, finishing as `name` (the stand-in's token endpoint answers for it). */
  const consent = async (name: string) => {
    const start = await call('GET', '/api/google/connect')
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const sealed = /mvlos_google=([^;]*)/.exec(start.headers.get('set-cookie') ?? '')![1]
    const done = await call('GET', `/api/google/callback?code=code-${name}&state=${encodeURIComponent(state)}`, undefined, `; mvlos_google=${sealed}`)
    return done.headers.get('location')
  }
  const addCaldav = async () => {
    const r = await call('POST', '/api/caldav', { url: `${proxyOrigin}/`, username: USER, password: PASSWORD, label: 'Mock' })
    if (!r.ok) console.log('caldav add', r.status, await r.text())
    return r
  }
  return { id, call, consent, addCaldav }
}

const endpoints = { calendars: { path: '/api/calendar/calendars', held: 'PROPFIND' }, events: { path: '/api/calendar/events?days=3&fresh=1', held: 'REPORT' } } as const
const waitFor = async (test: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !test(); t += 25) await sleep(25)
  return test()
}

type Change = 'relink' | 'disconnect' | 'deletion' | 'logout' | 'revoke' | 'expire' | 'ban'
for (const [kind, ep] of Object.entries(endpoints)) {
  for (const change of ['relink', 'disconnect', 'deletion', 'logout', 'revoke', 'expire', 'ban'] as Change[]) {
    const a = account()
    const name = `A${a.id}`
    const token = `tok-${name}`
    await a.consent(name)
    await a.addCaldav()
    googleLog.length = 0
    hold(ep.held)
    const pending = a.call('GET', ep.path)
    const waitedFor = kind === 'calendars' ? 1 : 2 // the list, then the events
    const ready = await waitFor(() => gate.held > 0 && googleLog.filter((l) => l.startsWith(token)).length >= waitedFor)
    check(`${kind}/${change}: Google answered and CalDAV is held`, ready)
    if (change === 'relink') await a.consent(`B${a.id}`)
    else if (change === 'disconnect') await a.call('DELETE', '/api/google')
    else if (change === 'logout') await a.call('POST', '/api/auth/logout')
    else if (change === 'revoke') database().prepare('DELETE FROM sessions WHERE user_id = ?').run(a.id)
    else if (change === 'expire') database().prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(a.id)
    else if (change === 'ban') database().prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(Date.now(), a.id)
    else await a.call('DELETE', '/api/me')
    release()
    const res = await pending
    const text = await res.text()
    check(`${kind}/${change}: not served as a 200`, res.status !== 200, String(res.status))
    check(`${kind}/${change}: nothing of the old Google account in the response`, !text.includes(token) && !text.includes(name), text.slice(0, 80))
    if (change === 'relink') {
      const next = await a.call('GET', ep.path.replace('fresh=1', 'fresh=1'))
      const body = await next.text()
      check(`${kind}/relink: a fresh request returns only the new account's data`, next.status === 200 && body.includes(`tok-B${a.id}`) && !body.includes(token))
    }
  }

  // No change: whole.
  const n = account()
  await n.consent(`N${n.id}`)
  await n.addCaldav()
  hold(ep.held)
  const normal = n.call('GET', ep.path)
  await waitFor(() => gate.held > 0)
  release()
  const nr = await normal
  const nt = await nr.text()
  check(`${kind}/no change: the combined answer is whole (Google and CalDAV)`, nr.status === 200 && nt.includes(`tok-N${n.id}`) && /caldav:/.test(nt) && (kind === 'calendars' || nt.includes('CalDAV event')) && JSON.parse(nt).errors.length === 0)

  // CalDAV only.
  const c = account()
  await c.addCaldav()
  hold(ep.held)
  const only = c.call('GET', ep.path)
  await waitFor(() => gate.held > 0)
  release()
  const cr = await only
  const ct = await cr.text()
  check(`${kind}/CalDAV only: answered`, cr.status === 200 && /caldav:/.test(ct) && (kind === 'calendars' || ct.includes('CalDAV event')))

  // Google absent when the request starts: it takes no part, however it is connected, relinked or
  // disconnected while CalDAV discovery and the events are held. (For the calendar list the only
  // CalDAV step is discovery; for events there is a second one, the events themselves.)
  for (const later of ['connect', 'connect then relink', 'connect then disconnect'] as const) {
    const g = account()
    await g.addCaldav()
    googleLog.length = 0
    hold('PROPFIND')
    const early = g.call('GET', ep.path)
    await waitFor(() => gate.held > 0)
    await g.consent(`G${g.id}`)
    if (kind === 'events') {
      // Discovery goes on to the held events step; Google is changed again while that waits.
      const open = gate.release!
      hold('REPORT')
      open()
      await waitFor(() => gate.held > 0)
    }
    if (later === 'connect then relink') await g.consent(`H${g.id}`)
    else if (later === 'connect then disconnect') await g.call('DELETE', '/api/google')
    await sleep(150)
    check(`${kind}/absent at start, ${later} meanwhile: Google is not asked`, !googleLog.some((l) => l.startsWith('tok-G') || l.startsWith('tok-H')))
    release()
    const er = await early
    const et = await er.text()
    check(`${kind}/absent at start, ${later} meanwhile: answered with CalDAV only, nothing of Google`, er.status === 200 && !et.includes('tok-G') && !et.includes('tok-H') && /caldav:/.test(et))
    if (later === 'connect') {
      const after = await g.call('GET', ep.path)
      check(`${kind}/...the next request uses the new link`, (await after.text()).includes(`tok-G${g.id}`))
    }
  }

  for (const change of ['logout', 'deletion'] as const) {
    const removed = account()
    await removed.addCaldav()
    hold(ep.held)
    const pending = removed.call('GET', ep.path)
    check(`${kind}/CalDAV only ${change}: provider held`, await waitFor(() => gate.held > 0))
    await removed.call(change === 'logout' ? 'POST' : 'DELETE', change === 'logout' ? '/api/auth/logout' : '/api/me')
    release()
    const res = await pending
    const body = await res.text()
    check(`${kind}/CalDAV only ${change}: no private payload`, res.status !== 200 && !body.includes('CalDAV event') && !body.includes('caldav:'))
  }

  // Google connected while a CalDAV-only request waits: not failed.
  const late = account()
  await late.addCaldav()
  hold(ep.held)
  const waiting = late.call('GET', ep.path)
  await waitFor(() => gate.held > 0)
  await late.consent(`L${late.id}`)
  release()
  check(`${kind}/Google connected meanwhile: the CalDAV-only request is not failed`, (await waiting).status === 200)
}

await server.dispose()
await caldav.close()
proxy.close()
google.close()
finish()
