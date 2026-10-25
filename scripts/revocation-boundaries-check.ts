// Held media, calendar aggregates, mutations, and linking against real handlers and local mocks.
// Every slow step has an explicit gate. Network access outside the local mocks is rejected.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startMock, USER, PASSWORD } from './tasks-mock.ts'
import { check, finish } from './empires-harness.ts'

setTimeout(() => { console.error('FAIL revocation check timed out'); process.exit(1) }, 90_000).unref()
const data = mkdtempSync(join(tmpdir(), 'mvlos-revocation-'))
Object.assign(process.env, { DATA_DIR: data, GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', ADMIN_GITHUB_IDS: Array.from({ length: 2000 }, (_, i) => i + 1).join(','), NOTIFY_WATCH: 'off', MC_WATCH: 'off' })
const REPO = '11111111-1111-4111-8111-111111111111'
const secretBytes = Buffer.from('private-photo-bytes')
const prefix = Buffer.from('ok:')
const mediaBytes = Buffer.concat([prefix, secretBytes])
const ASSET = 'aaaaaaaa-0000-4000-8000-000000000001'
const providerLog: { method: string; path: string; raw: string }[] = []
let eventStart = Date.now() + 11 * 60_000
const mock = createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const url = new URL(req.url!, 'http://x')
  const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
  const form = new URLSearchParams(raw)
  providerLog.push({ method: req.method!, path: url.pathname, raw })
  if (url.pathname === '/oauth/token') return send({ access_token: 'chat-access', refresh_token: 'chat-refresh', expires_in: 3600 })
  if (url.pathname === '/token') {
    const name = form.get('code') || 'A'
    return send({ access_token: name, refresh_token: `refresh-${name}`, expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: `${name}@example.test` })).toString('base64url')}.x` })
  }
  if (url.pathname === '/revoke' || url.pathname === '/api2/logout-device/') return send({})
  if (url.pathname === '/api2/auth-token/') return send({ token: 'sf-token' })
  if (url.pathname === '/api2/account-info/' || url.pathname === '/api2/server-info/') return send({ name: 'Mock', version: '12' })
  if (url.pathname === '/api/v2.1/repos/') return send({ repos: [{ repo_id: REPO, repo_name: 'private-library', type: 'mine', encrypted: false, permission: 'rw' }] })
  if (url.pathname.endsWith('/dir/')) return send({ user_perm: 'rw', dirent_list: url.searchParams.get('p') === '/destination' ? [] : [{ name: 'private-photo.jpg', type: 'file', size: secretBytes.length, mtime: Math.floor(Date.now() / 1000), id: 'file-version' }] })
  if (url.pathname === '/api/v2.1/repos/batch-delete-item/') return send({})
  if (url.pathname.endsWith('/trash/')) return send({ data: [{ parent_dir: '/', obj_name: 'private-photo.jpg', deleted_time: new Date().toISOString(), commit_id: 'a'.repeat(40), is_dir: false, size: secretBytes.length }], more: false, scan_stat: null })
  if (url.pathname.endsWith('/trash/revert-dirents/')) return send({ success: [{ path: '/private-photo.jpg' }], failed: [] })
  if (url.pathname.endsWith('/thumbnail/')) return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(secretBytes)
  if (url.pathname.endsWith('/file/')) return send(`${provider}/files/private-photo.jpg`)
  if (url.pathname.startsWith('/files/') || /\/api\/assets\/.*\/(original|video\/playback)$/.test(url.pathname)) {
    const range = req.headers.range
    return res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': mediaBytes.length, ...(range ? { 'Content-Range': `bytes 0-${mediaBytes.length - 1}/${mediaBytes.length}` } : {}) }).end(mediaBytes)
  }
  if (url.pathname === '/api/server/version') return send({ major: 3, minor: 0, patch: 0 })
  if (url.pathname === '/api/timeline/buckets') return send([])
  if (url.pathname === '/api/users/me') return send({ id: 'owner' })
  if (url.pathname.startsWith('/api/assets/')) return send({ id: ASSET, ownerId: 'owner', originalFileName: 'private-photo.jpg' })
  if (url.pathname === '/api/assets' || url.pathname.includes('/api/albums/')) return send([{ id: ASSET, success: true }])
  if (url.pathname.startsWith('/api/v2.1/repos/')) return send({ encrypted: false })
  const token = String(req.headers.authorization).replace('Bearer ', '')
  if (url.pathname.endsWith('/calendarList')) return send({ items: [{ id: `calendar-${token}`, summary: `private-${token}`, accessRole: 'owner', selected: true }] })
  if (url.pathname.endsWith('/events')) return send({ items: [{ id: `event-${token}`, summary: `private-${token}`, location: `location-${token}`, start: { dateTime: new Date(eventStart).toISOString() }, end: { dateTime: new Date(eventStart + 3600_000).toISOString() } }] })
  res.writeHead(404).end()
})
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
const provider = `http://127.0.0.1:${(mock.address() as { port: number }).port}`
Object.assign(process.env, { GOOGLE_API_URL: `${provider}/calendar/v3`, GOOGLE_TOKEN_URL: `${provider}/token`, GOOGLE_REVOKE_URL: `${provider}/revoke`, OPENAI_AUTH_URL: provider })
const dav = await startMock()
const realFetch = globalThis.fetch
const allowed = new Set([new URL(provider).origin, new URL(dav.origin).origin])
let gate: { matches: (url: URL) => boolean; arrived: Promise<void>; release: () => void; wait: Promise<void>; hit: () => void; body: boolean; tail: boolean; signals: AbortSignal[] } | null = null
function hold(matches: (url: URL) => boolean, body = false, tail = false) {
  let hit!: () => void, release!: () => void
  const arrived = new Promise<void>((r) => { hit = r })
  const wait = new Promise<void>((r) => { release = r })
  gate = { matches, arrived, release, wait, hit, body, tail, signals: [] }
  return gate
}
const unexpected: string[] = []
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!allowed.has(url.origin)) { unexpected.push(url.origin); throw new Error('Non-mock network request refused') }
  const current = gate
  const response = await realFetch(input, init)
  if (current?.matches(url)) {
    if (init?.signal) current.signals.push(init.signal)
    if (current.tail) {
      const bytes = Buffer.from(await response.arrayBuffer())
      let part = 0
      return new Response(new ReadableStream({ async pull(out) {
        if (part++ === 0) { out.enqueue(bytes.subarray(0, prefix.length)); return }
        if (part === 2) { current.hit(); await current.wait; out.enqueue(bytes.subarray(prefix.length)); return }
        out.close()
      } }), { status: response.status, headers: response.headers })
    }
    if (current.body && response.body) {
      const reader = response.body.getReader()
      return new Response(new ReadableStream({
        async pull(out) {
          current.hit(); await current.wait
          const chunk = await reader.read()
          if (chunk.done) out.close()
          else out.enqueue(chunk.value)
        },
        cancel: (reason) => reader.cancel(reason),
      }), { status: response.status, headers: response.headers })
    }
    current.hit(); await current.wait
  }
  return response
}
const { database, encrypt, decrypt } = await import('../server/db.ts')
const { handleApi } = await import('../server/api.ts')
const { photoCapabilitiesForTest } = await import('../server/photos.ts')
const { allCalendars, allEvents } = await import('../server/calendars.ts')
const { findLinked } = await import('../server/noteLinks.ts')
const { prepareCalendarCall, eventId } = await import('../server/agentCalendar.ts')
const { prepareNoteLinkCall } = await import('../server/agentNoteLinks.ts')
const { removeCaldav } = await import('../server/caldav.ts')
const { deleteUser, ban } = await import('../server/users.ts')
const { sweep, liveCount } = await import('../server/liveSessions.ts')
const { unlinkSeafile } = await import('../server/seafile.ts')
const { accounts } = await import('../server/auth.ts')
const { calendar } = await import('../server/watchers.ts')
const { listEntries } = await import('../server/notifier.ts')
const { clearGoogleCache } = await import('../server/google.ts')
const { clearCaldavCache } = await import('../server/caldav.ts')
const { sha256 } = await import('../server/db.ts')
const active = new Set<Promise<unknown>>()
const api = createServer((req, res) => {
  const task = handleApi(req, res).then((done) => { if (!done) res.writeHead(404).end() })
  active.add(task); void task.finally(() => active.delete(task))
})
async function drain() { while (active.size) await Promise.all([...active]) }
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
allowed.add(origin)
let nextId = 1
function account() {
  const id = nextId++, sid = randomBytes(24).toString('hex'), now = Date.now()
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `test-${id}`, encrypt(''), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + 86400_000)
  const call = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${origin}${path}`, { method, redirect: 'manual', headers: { Cookie: `mvlos_sid=${sid}`, 'X-MVL-Account': String(id), Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
  const user = () => accounts().find((u) => u.id === id)!
  const google = async (name: string) => {
    const start = await call('/api/google/connect')
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const sealed = /mvlos_google=([^;]*)/.exec(start.headers.get('set-cookie')!)![1]
    const done = await call(`/api/google/callback?code=${name}&state=${encodeURIComponent(state)}`, 'GET', undefined, { Cookie: `mvlos_sid=${sid}; mvlos_google=${sealed}` })
    if (!done.headers.get('location')?.includes('google=ok')) throw new Error(`Google consent failed: ${done.headers.get('location')}`)
  }
  const caldav = async () => {
    const res = await call('/api/caldav', 'POST', { url: dav.origin, username: USER, password: PASSWORD })
    if (!res.ok) throw new Error(`CalDAV link failed: ${await res.text()}`)
    return (await res.json()).id as number
  }
  const seafile = async (username = 'A') => {
    const res = await call('/api/integrations/seafile', 'POST', { url: provider, username, password: 'mock' })
    if (!res.ok) throw new Error(`Seafile link failed: ${await res.text()}`)
  }
  const seedPhoto = (thumb = true) => {
    database().prepare('INSERT OR REPLACE INTO photo_accounts (user_id, seafile, scanned_at) VALUES (?, ?, ?)').run(id, `${provider}|A`, Date.now())
    database().prepare('INSERT OR IGNORE INTO photo_sources (user_id, repo, path) VALUES (?, ?, ?)').run(id, REPO, '/')
    const r = database().prepare("INSERT INTO photos (user_id, repo, path, kind, size, mtime, file_id, taken_at, taken_src, lat, lon, thumb) VALUES (?, ?, '/private-photo.jpg', 'image', ?, ?, 'file-version', ?, 'exif', 52.37, 4.89, ?)").run(id, REPO, secretBytes.length, Date.now(), Date.now(), thumb ? secretBytes : null)
    return String(r.lastInsertRowid)
  }
  const immich = () => database().prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(id, 'immich', encrypt(JSON.stringify({ url: provider, key: 'mock-key', name: 'private-immich-name', email: 'private-email@example.test', version: '3.0.0' })), now)
  return { id, sid, call, user, google, caldav, seafile, seedPhoto, immich }
}
async function arrived(g: NonNullable<typeof gate>) {
  await Promise.race([g.arrived, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Provider gate was never reached')), 5000); timer.unref(); void g.arrived.then(() => clearTimeout(timer)) })])
}
function release(g: NonNullable<typeof gate>) { if (gate === g) gate = null; g.release() }
/** Keep every byte already delivered, including when revocation aborts the rest of a body. */
async function collect(response: Response): Promise<{ complete: boolean; bytes: Buffer }> {
  const chunks: Buffer[] = []
  const reader = response.body?.getReader()
  if (!reader) return { complete: true, bytes: Buffer.alloc(0) }
  let complete = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) { complete = true; break }
      chunks.push(Buffer.from(chunk.value))
    }
  } catch { /* Partial bytes remain evidence even when the response is aborted. */ }
  finally { reader.releaseLock() }
  return { complete, bytes: Buffer.concat(chunks) }
}
async function denied(label: string, pending: Promise<Response>) {
  let res: Response
  try { res = await pending }
  catch (error) {
    // A revoked live response can close before HTTP headers arrive.
    check(label, error instanceof TypeError)
    return
  }
  const { bytes } = await collect(res), text = bytes.toString()
  check(label, res.status >= 400 && !res.headers.has('etag') && !res.headers.has('location') && !text.includes('private-photo') && !text.includes('private-library') && !text.includes('52.37') && !bytes.includes(secretBytes))
}

type Account = ReturnType<typeof account>
type Change = 'none' | 'other-logout' | 'logout' | 'remove' | 'ban' | 'expire' | 'revoke' | 'disconnect' | 'relink'
const revoked: Change[] = ['logout', 'remove', 'ban', 'expire', 'revoke']
async function change(a: Account, kind: Change) {
  if (kind === 'logout') await a.call('/api/auth/logout', 'POST')
  if (kind === 'remove') await deleteUser(a.id) // the admin removal implementation
  if (kind === 'ban') ban(a.id, 'mock')
  if (kind === 'expire') database().prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(a.id)
  if (kind === 'revoke') database().prepare('DELETE FROM sessions WHERE user_id = ?').run(a.id)
  if (kind === 'expire' || kind === 'revoke') sweep()
  if (kind === 'disconnect') await a.call('/api/integrations/seafile', 'DELETE')
  if (kind === 'relink') { gate = null; await a.seafile('B') }
  if (kind === 'other-logout') {
    const sid = randomBytes(24).toString('hex')
    database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), a.id, Date.now(), Date.now() + 86400_000)
    await a.call('/api/auth/logout', 'POST', undefined, { Cookie: `mvlos_sid=${sid}` })
  }
}
async function mediaChange(a: Account, kind: Change, media: string) {
  if (media.startsWith('im-') && (kind === 'disconnect' || kind === 'relink')) {
    gate = null
    await a.call('/api/integrations/immich', kind === 'disconnect' ? 'DELETE' : 'POST', kind === 'relink' ? { url: provider, key: 'mock-key-B' } : undefined)
  } else await change(a, kind)
}
const privateData = (bytes: Buffer) => bytes.includes(secretBytes) || /private-photo|private-library|private-title|private-location|private-immich|private-email|52\.37/.test(bytes.toString())
const settle = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }))
const mutationLog = () => providerLog.filter((r) => /batch-delete|batch-move|revert-dirents|set-password|\/api\/assets$|\/albums\//.test(r.path) && !['GET', 'HEAD'].includes(r.method))
function seedEvent(lead = 11) {
  const at = Date.now() + lead * 60_000
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const collection = dav.collections.get('/cal/mock/events/')!
  collection.name = 'private-library'
  collection.objects.clear()
  collection.objects.set('/cal/mock/events/private.ics', { etag: '"private"', text: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:private-event\r\nDTSTART:${stamp(at)}\r\nDTEND:${stamp(at + 3600_000)}\r\nSUMMARY:private-title\r\nLOCATION:private-location\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` })
  return at
}
try {
  // Before headers, including HEAD and conditional thumbnail responses.
  for (const media of ['sf-photo-thumb', 'sf-photo-original', 'sf-thumb', 'sf-raw', 'sf-stream', 'im-original', 'im-video']) {
    for (const method of ['GET', 'HEAD', ...(media === 'sf-photo-thumb' ? ['304'] : [])]) {
      for (const kind of ['none', 'other-logout', ...revoked, ...['disconnect', 'relink']] as Change[]) {
        const a = account(); let id = ASSET
        if (media.startsWith('sf')) { await a.seafile(); id = a.seedPhoto() } else a.immich()
        const path = media === 'sf-photo-thumb' ? `/api/photos/seafile/thumb?id=${id}` : media === 'sf-photo-original' ? `/api/photos/seafile/original?id=${id}` : media.startsWith('sf-') ? `/api/seafile/${media.slice(3)}?repo=${REPO}&p=/private-photo.jpg` : `/api/photos/immich/${media === 'im-video' ? 'video' : 'original'}?id=${id}`
        const g = hold((u) => media === 'sf-photo-thumb' ? u.pathname === '/api/v2.1/repos/' : media === 'sf-photo-original' ? u.pathname.endsWith('/file/') : media === 'sf-thumb' ? u.pathname.endsWith('/thumbnail/') : media.startsWith('sf') ? u.pathname.startsWith('/files/') : u.pathname.includes('/api/assets/'))
        const pending = a.call(path, method === '304' ? 'GET' : method, undefined, { ...(media === 'sf-raw' ? { Range: `bytes=0-${mediaBytes.length - 1}` } : {}), ...(method === '304' ? { 'If-None-Match': '"sf-file-version-small"' } : {}) })
        await arrived(g); await mediaChange(a, kind, media); release(g); const res = await pending; const body = await collect(res); await drain()
        const valid = kind === 'none' || kind === 'other-logout'
        check(`media/${media}/${method}/${kind}`, valid ? res.status === (method === '304' ? 304 : media === 'sf-photo-original' ? 302 : media === 'sf-raw' ? 206 : 200) : res.status >= 400 && !privateData(body.bytes) && !res.headers.has('location') && !res.headers.has('etag'))
        if (!valid && g.signals.length) check(`media/${media}/${method}/${kind}: upstream aborted`, g.signals.every((s) => s.aborted))
      }
    }
  }
  for (const kind of ['disconnect', 'relink'] as Change[]) {
    const a = account(); await a.seafile(); a.seedPhoto(); a.immich()
    const g = hold((u) => u.pathname === '/api/v2.1/repos/')
    const pending = a.call('/api/photos/status'); await arrived(g)
    await mediaChange(a, kind, 'im-original'); release(g)
    const res = await pending; const body = await collect(res); await drain()
    check(`status/Immich/${kind}: no stale account metadata while Seafile waits`, res.status >= 400 && !privateData(body.bytes))
  }
  // After headers and a harmless prefix have been delivered: keep partial bytes on errors.
  for (const media of ['sf-stream', 'im-original', 'im-video']) {
    for (const kind of [...revoked, ...['disconnect', 'relink']] as Change[]) {
      const a = account(); if (media === 'sf-stream') await a.seafile(); else a.immich()
      const path = media === 'sf-stream' ? `/api/seafile/stream?repo=${REPO}&p=/private-photo.jpg` : `/api/photos/immich/${media === 'im-video' ? 'video' : 'original'}?id=${ASSET}`
      const g = hold((u) => u.pathname.startsWith('/files/') || u.pathname.includes('/api/assets/'), false, true)
      const pending = a.call(path); await arrived(g); const res = await pending; const receiving = collect(res)
      await mediaChange(a, kind, media); release(g); const result = await receiving; await drain()
      check(`delivery/${media}/${kind}: no partial private bytes`, !result.complete && result.bytes.equals(prefix))
      check(`delivery/${media}/${kind}: upstream aborted`, g.signals.length > 0 && g.signals.every((s) => s.aborted))
    }
  }
  // A CalDAV-only read must never outlive its account set, including nested note searches.
  for (const op of ['calendars', 'events', 'find', 'note-tool', 'watcher']) {
    for (const mutation of ['remove', 'relink', 'add']) {
      const a = account(); const at = seedEvent(op === 'watcher' ? 9 : 11); const cal = await a.caldav(); const user = a.user()
      const note = { id: 'note-12345678', text: 'Meeting', events: [{ source: 'caldav', calendarId: `caldav:${cal}:${dav.origin}/cal/mock/events/`, uid: 'private-event', title: 'private-title', start: new Date(at).toISOString(), end: new Date(at + 3600_000).toISOString(), allDay: false, linked: Date.now() }] }
      database().prepare('INSERT INTO state (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(a.id, 'notes', JSON.stringify([note]), Date.now())
      const g = hold((u) => u.origin === new URL(dav.origin).origin && (op === 'calendars' ? u.pathname === '/cal/mock/' : u.pathname === '/cal/mock/events/'))
      const pending = settle(op === 'calendars' ? allCalendars(user) : op === 'events' ? allEvents(user, null, { from: new Date(at - 864e5), to: new Date(at + 864e5) }) : op === 'find' ? findLinked(user, { uid: 'private-event' }, true) : op === 'watcher' ? calendar() : prepareNoteLinkCall(user, 'events_for_note', { note_id: note.id }, 'UTC').then((p) => p.run()))
      await arrived(g); gate = null
      if (mutation === 'remove') removeCaldav(user, cal)
      else {
        const linked = await a.call('/api/caldav', 'POST', { url: mutation === 'add' ? `${dav.origin}/dav/` : dav.origin, username: USER, password: PASSWORD, label: mutation === 'relink' ? 'New' : 'Added' })
        if (!linked.ok) throw new Error('CalDAV mutation failed')
      }
      release(g); const result = await pending
      check(`CalDAV/${op}/${mutation}: no old title/location`, op === 'watcher' ? !privateData(Buffer.from(JSON.stringify(database().prepare('SELECT title, body FROM notifications WHERE user_id = ?').all(a.id)))) : result.error !== null && result.value === null)
      await deleteUser(a.id)
    }
  }
  for (const op of ['find', 'known', 'note-link']) for (const kind of revoked) {
    const a = account(); const at = seedEvent(); const cal = await a.caldav()
    const g = hold((u) => u.origin === new URL(dav.origin).origin && u.pathname === '/cal/mock/events/')
    const pending = a.call(`/api/calendar/${op}`, 'POST', op === 'known' ? { calendar: `caldav:${cal}:${dav.origin}/cal/mock/events/`, uids: ['private-event'] } : op === 'note-link' ? { note: 'note-12345678', link: { uid: 'private-event', source: 'caldav', calendarId: `caldav:${cal}:${dav.origin}/cal/mock/events/`, start: new Date(at).toISOString(), title: 'private-title', end: new Date(at + 3600_000).toISOString(), allDay: false, linked: Date.now() } } : { uid: 'private-event', fresh: true })
    await arrived(g); await change(a, kind); release(g); const res = await pending; const body = await collect(res); await drain()
    check(`calendar/${op}/${kind}: no private response`, res.status >= 400 && !privateData(body.bytes))
  }
  for (const tool of ['calendar_delete_event', 'notes_for_event']) for (const mutation of ['remove', 'relink', 'add']) {
    const a = account(); const at = seedEvent(); const cal = await a.caldav(); const user = a.user()
    const events = await allEvents(user, null, { from: new Date(at - 864e5), to: new Date(at + 864e5) })
    const ref = events.events.find((e) => e.uid === 'private-event')!.ref!
    const g = hold((u) => u.origin === new URL(dav.origin).origin && u.pathname.endsWith('.ics'), true)
    const pending = settle(tool === 'calendar_delete_event' ? prepareCalendarCall(user, tool, { event_id: eventId(ref) }, 'UTC') : prepareNoteLinkCall(user, tool, { event_id: eventId(ref) }, 'UTC'))
    await arrived(g); gate = null
    if (mutation === 'remove') removeCaldav(user, cal)
    else await a.call('/api/caldav', 'POST', { url: mutation === 'add' ? `${dav.origin}/dav/` : dav.origin, username: USER, password: PASSWORD })
    release(g); const result = await pending
    check(`CalDAV/GET-body/${tool}/${mutation}: no private prepared summary`, result.error !== null && result.value === null)
    await deleteUser(a.id)
  }
  for (const tool of ['make_meeting_note', 'calendar_delete_event', 'notes_for_event']) for (const mutation of ['none', 'remove', 'relink', 'add']) {
    const a = account(); const at = seedEvent(); const cal = await a.caldav(); const user = a.user()
    const events = await allEvents(user, null, { from: new Date(at - 864e5), to: new Date(at + 864e5) })
    const ref = events.events.find((e) => e.uid === 'private-event')!.ref!
    const prepared = tool === 'calendar_delete_event' ? await prepareCalendarCall(user, tool, { event_id: eventId(ref) }, 'UTC') : await prepareNoteLinkCall(user, tool, { event_id: eventId(ref) }, 'UTC')
    if (mutation === 'remove') removeCaldav(user, cal)
    else if (mutation !== 'none') await a.call('/api/caldav', 'POST', { url: mutation === 'add' ? `${dav.origin}/dav/` : dav.origin, username: USER, password: PASSWORD })
    const before = JSON.stringify(database().prepare('SELECT * FROM state WHERE user_id = ?').all(a.id))
    const writesBefore = dav.log.filter((l) => /^(PUT|DELETE) /.test(l)).length
    const result = await settle(prepared.run())
    check(`approval/${tool}/${mutation}: original provider authority preserved`, mutation === 'none' ? result.error === null && result.value !== null : result.error !== null && result.value === null && before === JSON.stringify(database().prepare('SELECT * FROM state WHERE user_id = ?').all(a.id)) && writesBefore === dav.log.filter((l) => /^(PUT|DELETE) /.test(l)).length)
    await deleteUser(a.id)
  }
  // Competing sessions must not inherit the canceled request's in-flight promise.
  for (const source of ['photos', 'google', 'caldav']) {
    const a = account(); let id = ''
    if (source === 'photos') { await a.seafile(); id = a.seedPhoto() }
    if (source === 'google') await a.google('private-title')
    if (source === 'caldav') { seedEvent(); await a.caldav() }
    const sidB = randomBytes(24).toString('hex'), sidC = randomBytes(24).toString('hex')
    for (const sid of [sidB, sidC]) database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), a.id, Date.now(), Date.now() + 86400_000)
    const g = hold((u) => source === 'photos' ? u.pathname === '/api/v2.1/repos/' : source === 'google' ? u.pathname.endsWith('/calendarList') : u.origin === new URL(dav.origin).origin && u.pathname === '/cal/mock/')
    const path = source === 'photos' ? `/api/photos/seafile/info?id=${id}` : '/api/calendar/calendars'
    const first = a.call(path); await arrived(g)
    const second = a.call(path, 'GET', undefined, { Cookie: `mvlos_sid=${sidB}` })
    const third = a.call(path, 'GET', undefined, { Cookie: `mvlos_sid=${sidC}` })
    const deadline = performance.now() + 5000
    while (active.size < 3 && performance.now() < deadline) await new Promise((r) => setImmediate(r))
    if (active.size !== 3) throw new Error('Competing requests did not all reach their provider waits')
    await a.call('/api/auth/logout', 'POST', undefined, { Cookie: `mvlos_sid=${source === 'photos' ? sidB : a.sid}` })
    release(g)
    const responses = await Promise.all([first, second, third]); const bodies = await Promise.all(responses.map(collect)); await drain()
    const survivors = source === 'photos' ? [0, 2] : [1, 2]
    check(`shared/${source}: surviving sessions get complete private data`, survivors.every((i) => responses[i].ok && privateData(bodies[i].bytes)))
    check(`shared/${source}: only ended session refused`, responses[source === 'photos' ? 1 : 0].status >= 400)
  }
  // Hold authorization before any mutation. Compare both upstream log and persistent index.
  for (const op of ['favourite', 'trash', 'move', 'restore', 'zip']) {
    for (const kind of ['none', 'other-logout', ...revoked] as Change[]) {
      const a = account(); await a.seafile(); const id = a.seedPhoto()
      const undo = op === 'restore' ? (await (await a.call('/api/photos/seafile/trash', 'POST', { ids: [id] })).json()).undo : undefined
      const before = JSON.stringify(database().prepare('SELECT * FROM photos WHERE user_id = ?').all(a.id))
      providerLog.length = 0
      const g = hold((u) => u.pathname === '/api/v2.1/repos/')
      const pending = a.call(`/api/photos/seafile/${op}`, op === 'favourite' ? 'PUT' : 'POST', op === 'restore' ? { undo } : op === 'move' ? { ids: [id], to: { repo: REPO, path: '/destination' } } : { ids: [id], on: true })
      await arrived(g); const capabilities = JSON.stringify(photoCapabilitiesForTest(a)); await change(a, kind); const sent = mutationLog().length; release(g); const res = await pending; await collect(res); await drain()
      const after = JSON.stringify(database().prepare('SELECT * FROM photos WHERE user_id = ?').all(a.id))
      const valid = kind === 'none' || kind === 'other-logout'
      check(`mutation/${op}/${kind}: response and DB/upstream state`, valid ? res.ok && (op === 'zip' || before !== after) : res.status >= 400 && mutationLog().length === sent && (kind === 'remove' ? after === '[]' : before === after) && (kind === 'remove' ? Object.values(photoCapabilitiesForTest(a)).every((n) => n === 0) : JSON.stringify(photoCapabilitiesForTest(a)) === capabilities))
    }
  }
  // The scan was accepted and answered, but still belongs to its initiating session.
  for (const kind of ['logout', 'ban', 'expire', 'revoke'] as Change[]) {
    const a = account(); await a.seafile(); const id = a.seedPhoto(false)
    database().prepare("UPDATE photos SET file_id = 'old' WHERE id = ?").run(Number(id))
    const other = randomBytes(24).toString('hex')
    database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(other), a.id, Date.now(), Date.now() + 86400_000)
    const g = hold((u) => u.pathname.startsWith('/files/'))
    const started = a.call('/api/photos/scan', 'POST')
    await arrived(g); check(`scan/${kind}: started before revocation`, (await started).ok)
    await change(a, kind); release(g); await drain()
    // A ban also blocks the observing session; unban only after the original authority ended.
    if (kind === 'ban') database().prepare('UPDATE users SET banned_at = NULL WHERE id = ?').run(a.id)
    database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at').run(sha256(other), a.id, Date.now(), Date.now() + 86400_000)
    let state = ''
    for (let n = 0; n < 100; n++) {
      const status = await (await a.call('/api/photos/status', 'GET', undefined, { Cookie: `mvlos_sid=${other}` })).json()
      state = status.seafile?.job?.state ?? ''
      if (state === 'done' || state === 'failed') break
    }
    const row = database().prepare('SELECT file_id FROM photos WHERE id = ?').get(Number(id)) as { file_id: string }
    check(`scan/${kind}: no index commit after held metadata`, state === 'failed' && row.file_id === 'old')
  }
  for (const kind of revoked) {
    const a = account(); await a.seafile()
    const user = a.user()
    const g = hold((u) => u.pathname.endsWith('/set-password/'))
    const pending = a.call('/api/seafile/unlock', 'POST', { repo: REPO, password: 'mock' })
    await arrived(g); await change(a, kind); release(g); await pending; await drain()
    const { unlocked } = await import('../server/seafile.ts')
    check(`unlock/${kind}: no late local unlock`, !unlocked(user)[REPO])
  }
  for (const kind of revoked) {
    const a = account(); a.immich()
    providerLog.length = 0
    const g = hold((u) => u.pathname === `/api/assets/${ASSET}`)
    const pending = a.call('/api/photos/immich/trash', 'POST', { ids: [ASSET] })
    await arrived(g); await change(a, kind); const sent = mutationLog().length
    release(g); const res = await pending; await collect(res); await drain()
    check(`Immich/trash/${kind}: no delete after held ownership`, res.status >= 400 && mutationLog().length === sent)
  }
  // Linking must retain existing good credentials while authentication/discovery is held.
  for (const providerName of ['seafile', 'caldav']) {
    const phases = providerName === 'seafile' ? ['auth', 'auth-body', 'account', 'account-body', 'server'] : ['principal', 'home', 'collections']
    for (const existing of [true, false]) for (const phase of phases) for (const kind of ['none', 'other-logout', ...revoked] as Change[]) {
      const a = account(); if (existing) { if (providerName === 'seafile') await a.seafile(); else await a.caldav() }
      const before = providerName === 'seafile' ? database().prepare("SELECT secret FROM integrations WHERE user_id = ? AND name = 'seafile'").get(a.id) : database().prepare('SELECT password, label FROM caldav WHERE user_id = ?').get(a.id)
      providerLog.length = 0
      const g = hold((u) => providerName === 'seafile' ? u.pathname === (phase.startsWith('auth') ? '/api2/auth-token/' : phase.startsWith('account') ? '/api2/account-info/' : '/api2/server-info/') : u.origin === new URL(dav.origin).origin && u.pathname === (phase === 'principal' ? '/' : phase === 'home' ? '/principals/mock/' : '/cal/mock/'), phase.endsWith('body'))
      const pending = a.call(providerName === 'seafile' ? '/api/integrations/seafile' : '/api/caldav', 'POST', providerName === 'seafile' ? { url: provider, username: 'B', password: 'new' } : { url: dav.origin, username: USER, password: PASSWORD, label: 'New label' })
      await arrived(g); await change(a, kind); const revokes = providerLog.filter((l) => l.path === '/api2/logout-device/').length; release(g); const res = await pending; await collect(res); await drain()
      const after = providerName === 'seafile' ? database().prepare("SELECT secret FROM integrations WHERE user_id = ? AND name = 'seafile'").get(a.id) : database().prepare('SELECT password, label FROM caldav WHERE user_id = ?').get(a.id)
      const valid = kind === 'none' || kind === 'other-logout'
      check(`link/${providerName}/${existing ? 'replace' : 'new'}/${phase}/${kind}: credentials protected`, valid ? res.ok && JSON.stringify(before) !== JSON.stringify(after) : !res.ok && (kind === 'remove' ? after === undefined : JSON.stringify(before) === JSON.stringify(after)) && providerLog.filter((l) => l.path === '/api2/logout-device/').length === revokes)
    }
  }
  {
    const a = account(); await a.seafile()
    const g = hold((u) => u.pathname === '/api2/logout-device/')
    const pending = a.call('/api/integrations/seafile', 'POST', { url: provider, username: 'B', password: 'new' })
    await arrived(g)
    const row = database().prepare("SELECT secret FROM integrations WHERE user_id = ? AND name = 'seafile'").get(a.id) as { secret: string }
    check('Seafile: replacement commits before old-token cleanup starts', JSON.parse(decrypt(row.secret)).username === 'B')
    await change(a, 'logout'); release(g); await pending; await drain()
    const kept = database().prepare("SELECT secret FROM integrations WHERE user_id = ? AND name = 'seafile'").get(a.id) as { secret: string }
    check('Seafile: held cleanup never commits credentials after logout', kept.secret === row.secret)
  }
  check('only local provider endpoints used', unexpected.length === 0)
  await drain()
  await new Promise((r) => setImmediate(r))
  check('all request lifetimes released', liveCount().connections === 0)
} finally {
  gate?.release(); globalThis.fetch = realFetch
  api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r()))
  mock.closeAllConnections(); await new Promise<void>((r) => mock.close(() => r()))
  await dav.close(); rmSync(data, { recursive: true, force: true })
}
finish()
