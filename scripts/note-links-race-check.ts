// Checks the Agents app's events_for_note tool (server/agentNoteLinks.ts) when the Google link
// changes while its lookups are still running, in-process against stand-ins (a Google that names its
// data after the token, the CalDAV stand-in behind a proxy that holds REPORTs) and a scratch
// DATA_DIR. A note is linked to one Google event and one CalDAV event; the Google lookup completes
// while the CalDAV one is held:
//   - no change: both come back;
//   - the Google link is replaced, or disconnected, before the CalDAV lookup finishes: the whole tool
//     call fails and nothing of the old Google account (title, time) is in it;
//   - Google not connected when the tool call started, connected while it runs: Google takes no part
//     (nothing of it in the answer, no request to it); the next call does use it.
// The accounts have no GitHub token, so deleting nothing here ever contacts github.com.
//
//   node scripts/note-links-race-check.ts
//
// Exits 1 on any failure.

import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PASSWORD, startMock, USER } from './tasks-mock.ts'

const DATA = mkdtempSync(join(tmpdir(), 'mvlos-note-race-'))
let failed = false
const check = (what: string, test: boolean) => {
  console.log(test ? 'PASS' : 'FAIL', what)
  if (!test) failed = true
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (test: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !test(); t += 25) await sleep(25)
  return test()
}

// --- Google stand-in -------------------------------------------------------------------------------
const googleLog: string[] = []
const google = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x')
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    if (url.pathname === '/revoke') return send({})
    if (url.pathname === '/token') {
      const name = (new URLSearchParams(body).get('code') ?? '').replace(/^code-/, '')
      return send({ access_token: `tok-${name}`, refresh_token: `ref-${name}`, expires_in: 3600, scope: 'openid email', id_token: `x.${Buffer.from(JSON.stringify({ email: `${name}@example.test` })).toString('base64url')}.x` })
    }
    const token = String(req.headers.authorization ?? '').replace('Bearer ', '')
    googleLog.push(`${token} ${url.pathname.endsWith('calendarList') ? 'list' : 'events'}`)
    if (url.pathname.endsWith('/calendarList')) return send({ items: [{ id: 'gcal', summary: 'Google', accessRole: 'owner', selected: true }] })
    send({ items: [{ id: 'gev', iCalUID: 'google-uid', summary: `private ${token}`, start: { dateTime: '2030-05-05T10:00:00Z' }, end: { dateTime: '2030-05-05T11:00:00Z' } }] })
  })
})
await new Promise<void>((r) => google.listen(0, '127.0.0.1', r))
const googleOrigin = `http://127.0.0.1:${(google.address() as { port: number }).port}`

// --- CalDAV stand-in behind a proxy that can hold REPORTs ---------------------------------------------
const caldav = await startMock()
{
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const start = Date.parse('2030-05-06T10:00:00Z')
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mock//EN\r\nBEGIN:VEVENT\r\nUID:caldav-uid\r\nDTSTAMP:${stamp(Date.now())}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(start + 3600_000)}\r\nSUMMARY:CalDAV event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
  caldav.collections.get('/cal/mock/events/')!.objects.set('/cal/mock/events/caldav-uid.ics', { etag: '"c"', text: ics })
}
const gate = { method: '', held: 0, release: null as null | (() => void), wait: null as null | Promise<void> }
const proxy = createServer((req, res) => {
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
const hold = (method: string) => {
  gate.method = method
  gate.held = 0
  gate.wait = new Promise<void>((r) => (gate.release = r))
}
const release = () => {
  gate.release?.()
  gate.method = ''
}

Object.assign(process.env, {
  DATA_DIR: DATA,
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'x',
  ADMIN_GITHUB_IDS: '1',
  GOOGLE_CLIENT_ID: 'x',
  GOOGLE_CLIENT_SECRET: 'x',
  GOOGLE_API_URL: `${googleOrigin}/calendar/v3`,
  GOOGLE_TOKEN_URL: `${googleOrigin}/token`,
  GOOGLE_REVOKE_URL: `${googleOrigin}/revoke`,
  PUBLIC_URL: 'http://localhost',
})
const { database, encrypt, sha256, userGone } = await import('../server/db.ts')
const { addCaldav, caldavCalendars, clearCaldavCache } = await import('../server/caldav.ts')
const { disconnectGoogle, startGoogle, finishGoogle } = await import('../server/google.ts')
const { currentUser } = await import('../server/auth.ts')
const { prepareNoteLinkCall } = await import('../server/agentNoteLinks.ts')
const { writeState } = await import('../server/state.ts')

const now = Date.now()
// No GitHub token: deleting or revoking never has anything to send to github.com.
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run('note-race', encrypt(''), now, now)
const user = { id: 1, githubId: 1, login: 'note-race', name: null, avatar: null, githubToken: '', githubScopes: [], admin: true }
const sid = randomBytes(24).toString('hex')
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
await addCaldav(user, { url: `${proxyOrigin}/`, username: USER, password: PASSWORD, label: 'Mock' })
const calId = (await caldavCalendars(user)).calendars.find((c) => c.name === 'Events')!.id

const link = (source: 'google' | 'caldav', calendarId: string, uid: string, title: string, start: string) => ({ source, calendarId, uid, title, start, end: start, allDay: false, linked: now })
writeState(user, 'notes', { value: [{ id: 'n1', text: 'Meeting notes', events: [link('google', 'gcal', 'google-uid', 'Old Google title', '2030-05-05T10:00:00Z'), link('caldav', calId, 'caldav-uid', 'Old CalDAV title', '2030-05-06T10:00:00Z')] }] })

const seedGoogle = (name: string) => {
  database().prepare('DELETE FROM google WHERE user_id = 1').run()
  database().prepare("INSERT INTO google (user_id, email, refresh_token, access_token, expires_at, scopes, created_at) VALUES (1, ?, ?, ?, ?, '', ?)").run(`${name}@example.test`, encrypt(`ref-${name}`), encrypt(`tok-${name}`), Date.now() + 3600_000, Date.now())
}
const reset = () => {
  userGone(1) // drops cached reads and moves the generation
  clearCaldavCache(user)
  gate.method = ''
  googleLog.length = 0
}
const fakeRes = () => {
  const r = { headers: {} as Record<string, string | string[]>, writeHead(_s: number, h: Record<string, string | string[]>) { r.headers = h; return r }, end() {} }
  return r
}
const request = (cookie: string) => ({ headers: { host: 'localhost', cookie } }) as never
/** The real consent flow, finishing as `name`. */
async function consent(name: string) {
  const start = fakeRes()
  startGoogle(request(`mvlos_sid=${sid}`), start as never)
  const state = new URL(start.headers.Location as string).searchParams.get('state')!
  const sealed = /mvlos_google=([^;]*)/.exec(String(start.headers['Set-Cookie']))![1]
  const req = request(`mvlos_sid=${sid}; mvlos_google=${sealed}`)
  await finishGoogle(req, fakeRes() as never, new URL(`http://localhost/api/google/callback?code=code-${name}&state=${state}`), currentUser(req))
}
const run = async () => {
  const call = await prepareNoteLinkCall(user, 'events_for_note', { note_id: 'n1' }, 'UTC')
  return call.run!()
}
const settled = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null as T | null, error }))

// Normal: Google and CalDAV both answer.
reset()
seedGoogle('A')
let out = await settled(run())
check('no change: the Google event is as it is now', out.error === null && out.value!.includes('private tok-A'))
check('no change: the CalDAV event is as it is now', out.error === null && out.value!.includes('CalDAV event'))

for (const how of ['relink', 'disconnect'] as const) {
  reset()
  seedGoogle('A')
  hold('REPORT')
  const pending = settled(run())
  const ready = await waitFor(() => gate.held > 0 && googleLog.some((l) => l === 'tok-A events'))
  check(`${how}: the Google lookup is done and the CalDAV one is held`, ready)
  if (how === 'relink') await consent('B')
  else await disconnectGoogle(user)
  release()
  out = await pending
  check(`${how}: the whole tool call fails`, out.value === null && out.error !== null)
  check(`${how}: nothing of the old Google account in it`, !String(out.value).includes('tok-A') && !String(out.error?.message).includes('tok-A'))
}

// Google not connected when the call started.
for (const how of ['connect', 'connect then relink'] as const) {
  reset()
  database().prepare('DELETE FROM google WHERE user_id = 1').run()
  hold('REPORT')
  const pending = settled(run())
  await waitFor(() => gate.held > 0)
  await consent('L')
  if (how === 'connect then relink') await consent('L2')
  release()
  out = await pending
  check(`absent at start, ${how} meanwhile: Google took no part`, !googleLog.some((l) => l.startsWith('tok-L')) && !String(out.value).includes('tok-L'))
  check(`absent at start, ${how} meanwhile: the call itself is not failed`, out.error === null && String(out.value).includes('CalDAV event'))
  const next = await settled(run())
  check(`...and the next call uses the new link`, next.error === null && String(next.value).includes(how === 'connect' ? 'private tok-L' : 'private tok-L2'))
}

await caldav.close()
proxy.close()
google.close()
rmSync(DATA, { recursive: true, force: true })
console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
