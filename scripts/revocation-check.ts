// Deterministic revocation races against the real HTTP handlers and local provider stand-ins.
// Every slow step has an explicit gate. Network access outside the local mocks is rejected.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startMock, USER, PASSWORD } from './tasks-mock.ts'
import { check, finish } from './empires-harness.ts'

setTimeout(() => { console.error('FAIL revocation check timed out'); process.exit(1) }, 30_000).unref()
const data = mkdtempSync(join(tmpdir(), 'mvlos-revocation-'))
Object.assign(process.env, { DATA_DIR: data, GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', ADMIN_GITHUB_IDS: Array.from({ length: 200 }, (_, i) => i + 1).join(','), NOTIFY_WATCH: 'off', MC_WATCH: 'off' })
const REPO = '11111111-1111-4111-8111-111111111111'
const secretBytes = Buffer.from('private-photo-bytes')
let eventStart = Date.now() + 11 * 60_000
const mock = createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const url = new URL(req.url!, 'http://x')
  const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
  const form = new URLSearchParams(raw)
  if (url.pathname === '/oauth/token') return send({ access_token: 'chat-access', refresh_token: 'chat-refresh', expires_in: 3600 })
  if (url.pathname === '/token') {
    const name = form.get('code') || 'A'
    return send({ access_token: name, refresh_token: `refresh-${name}`, expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: `${name}@example.test` })).toString('base64url')}.x` })
  }
  if (url.pathname === '/revoke' || url.pathname === '/api2/logout-device/') return send({})
  if (url.pathname === '/api2/auth-token/') return send({ token: 'sf-token' })
  if (url.pathname === '/api2/account-info/' || url.pathname === '/api2/server-info/') return send({ name: 'Mock', version: '12' })
  if (url.pathname === '/api/v2.1/repos/') return send({ repos: [{ repo_id: REPO, repo_name: 'private-library', type: 'mine', encrypted: false, permission: 'rw' }] })
  if (url.pathname.endsWith('/dir/')) return send({ user_perm: 'rw', dirent_list: [{ name: 'private-photo.jpg', type: 'file', size: secretBytes.length, mtime: Math.floor(Date.now() / 1000), id: 'file-version' }] })
  if (url.pathname === '/api/v2.1/repos/batch-delete-item/') return send({})
  if (url.pathname.endsWith('/trash/')) return send({ data: [{ parent_dir: '/', obj_name: 'private-photo.jpg', deleted_time: new Date().toISOString(), commit_id: 'a'.repeat(40), is_dir: false, size: secretBytes.length }], more: false, scan_stat: null })
  if (url.pathname.endsWith('/trash/revert-dirents/')) return send({ success: [{ path: '/private-photo.jpg' }], failed: [] })
  if (url.pathname.endsWith('/thumbnail/')) return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(secretBytes)
  if (url.pathname.endsWith('/file/')) return send(`${provider}/files/private-photo.jpg`)
  if (url.pathname.startsWith('/files/')) return res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': secretBytes.length }).end(secretBytes)
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
let gate: { matches: (url: URL) => boolean; arrived: Promise<void>; release: () => void; wait: Promise<void>; hit: () => void; body: boolean } | null = null
function hold(matches: (url: URL) => boolean, body = false) {
  let hit!: () => void, release!: () => void
  const arrived = new Promise<void>((r) => { hit = r })
  const wait = new Promise<void>((r) => { release = r })
  gate = { matches, arrived, release, wait, hit, body }
  return gate
}
const unexpected: string[] = []
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!allowed.has(url.origin)) { unexpected.push(url.origin); throw new Error('Non-mock network request refused') }
  const current = gate
  const response = await realFetch(input, init)
  if (current?.matches(url)) {
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
const { database, encrypt } = await import('../server/db.ts')
const { handleApi } = await import('../server/api.ts')
const { startScan } = await import('../server/photos.ts')
const { unlinkSeafile } = await import('../server/seafile.ts')
const { accounts } = await import('../server/auth.ts')
const { calendar } = await import('../server/watchers.ts')
const { listEntries } = await import('../server/notifier.ts')
const { clearGoogleCache } = await import('../server/google.ts')
const { clearCaldavCache } = await import('../server/caldav.ts')
const { sha256 } = await import('../server/db.ts')
const api = createServer((req, res) => { void handleApi(req, res).then((done) => { if (!done) res.writeHead(404).end() }) })
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
  return { id, call, user, google, caldav, seafile, seedPhoto }
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

try {
  // Verify that the race assertions retain evidence from a stream that leaks before failing.
  let chunkSent = false
  const partial = await collect(new Response(new ReadableStream({ pull(out) {
    if (chunkSent) out.error(new Error('closed after bytes'))
    else { chunkSent = true; out.enqueue(secretBytes) }
  } })))
  check('aborted-body collector retains previously received private bytes', !partial.complete && partial.bytes.equals(secretBytes))
  // Photos: held library, thumbnail-body, download-link and suggestion replies. A status purge is
  // deliberately requested before release, reproducing retention of a row already read into memory.
  const operations = ['info', 'thumb', 'etag', 'remote-thumb', 'original', 'albums', 'bucket', 'buckets', 'status', 'suggest', 'favourite', 'trash', 'move', 'restore', 'zip']
  for (const op of operations) {
    const a = account(); await a.seafile(); const id = a.seedPhoto(op !== 'remote-thumb')
    const undo = op === 'restore' ? (await (await a.call('/api/photos/seafile/trash', 'POST', { ids: [id] })).json()).undo : undefined
    const path = op === 'status' || op === 'suggest' ? `/api/photos/${op}` : `/api/photos/seafile/${op === 'etag' || op === 'remote-thumb' ? 'thumb' : op}?id=${id}&key=${new Date().toISOString().slice(0, 7)}`
    const match = op === 'remote-thumb' ? (u: URL) => u.pathname.endsWith('/thumbnail/') : op === 'original' ? (u: URL) => u.pathname.endsWith('/file/') : op === 'suggest' ? (u: URL) => u.pathname.endsWith('/dir/') : (u: URL) => u.pathname === '/api/v2.1/repos/'
    const g = hold(match)
    const pending = a.call(path, op === 'favourite' ? 'PUT' : ['trash', 'move', 'restore', 'zip'].includes(op) ? 'POST' : 'GET', op === 'favourite' ? { ids: [id], on: true } : op === 'restore' ? { undo } : op === 'move' ? { ids: [id], to: { repo: REPO, path: '/destination' } } : ['zip', 'trash'].includes(op) ? { ids: [id] } : undefined, op === 'etag' ? { 'If-None-Match': '"sf-file-version-small"' } : {})
    await arrived(g)
    await a.call('/api/integrations/seafile', 'DELETE')
    check(`${op}: disconnected status purges index`, (await a.call('/api/photos/status')).ok && !database().prepare('SELECT 1 FROM photos WHERE user_id = ?').get(a.id))
    release(g)
    await denied(`${op}: no held metadata, bytes, link, ETag or success after disconnect`, pending)
  }
  for (const change of ['same-account', 'other-account', 'remove'] as const) {
    const a = account(); await a.seafile(); const id = a.seedPhoto()
    const g = hold((u) => u.pathname === '/api/v2.1/repos/')
    const pending = a.call(`/api/photos/seafile/info?id=${id}`); await arrived(g)
    // New-generation requests must not join the old library listing's in-flight work.
    if (change === 'remove') await a.call('/api/me', 'DELETE')
    else {
      await a.seafile(change === 'same-account' ? 'A' : 'B')
      gate = null
      const fresh = await a.call('/api/photos/status')
      check(`${change}: fresh generation does not join held listing`, fresh.ok)
    }
    release(g); await denied(`${change}: original Photos request refused`, pending)
  }
  for (const change of ['disconnect', 'logout'] as const) {
    const a = account(); await a.seafile(); const id = a.seedPhoto(false)
    const zip = await (await a.call('/api/photos/seafile/zip', 'POST', { ids: [id] })).json()
    const g = hold((u) => u.pathname.startsWith('/files/'), true)
    const response = a.call(zip.url)
    await arrived(g)
    const res = await response
    // Begin consuming before revocation so closure cannot hide a rejected body promise.
    const consumed = collect(res)
    await a.call(change === 'disconnect' ? '/api/integrations/seafile' : '/api/auth/logout', change === 'disconnect' ? 'DELETE' : 'POST')
    release(g)
    const result = await consumed
    check(`ZIP/${change}: stream ends without held private file bytes`, !result.complete && !result.bytes.includes(secretBytes))
  }
  // A held index walk must not repopulate the index after a disconnect.
  {
    const a = account(); await a.seafile(); a.seedPhoto(false)
    database().prepare("UPDATE photos SET file_id = 'old' WHERE user_id = ?").run(a.id)
    const g = hold((u) => u.pathname.startsWith('/files/'))
    const start = startScan(a.user()); await arrived(g)
    await unlinkSeafile(a.user()); release(g); await start
    check('held scan: no old index rows restored after disconnect', !database().prepare('SELECT 1 FROM photos WHERE user_id = ?').get(a.id))
  }
  // ChatGPT: token exchange is complete at the mock but held before the handler can store it.
  for (const change of ['unchanged', 'other-session-logout', 'logout', 'revoke', 'expire', 'ban', 'remove'] as const) {
    const a = account()
    const start = await (await a.call('/api/agents/openai/chatgpt/start', 'POST', { acceptedRisk: true })).json()
    const state = new URL(start.url).searchParams.get('state')!
    const g = hold((u) => u.pathname === '/oauth/token')
    const pending = a.call('/api/agents/openai/chatgpt/finish', 'POST', { callback: `?code=held&state=${state}` })
    await arrived(g)
    if (change === 'other-session-logout') {
      const other = randomBytes(24).toString('hex')
      database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(other), a.id, Date.now(), Date.now() + 86400_000)
      await a.call('/api/auth/logout', 'POST', undefined, { Cookie: `mvlos_sid=${other}` })
    }
    if (change === 'logout') await a.call('/api/auth/logout', 'POST')
    if (change === 'revoke') database().prepare('DELETE FROM sessions WHERE user_id = ?').run(a.id)
    if (change === 'expire') database().prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(a.id)
    if (change === 'ban') database().prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(Date.now(), a.id)
    if (change === 'remove') await a.call('/api/me', 'DELETE')
    release(g)
    const res = await pending
    const rows = database().prepare("SELECT name FROM integrations WHERE user_id = ? AND name IN ('openai-chatgpt', 'openai-images')").all(a.id)
    check(`ChatGPT/${change}: tokens and provider commit only for live original session`, change === 'unchanged' || change === 'other-session-logout' ? res.ok && rows.length === 2 : !res.ok && rows.length === 0)
  }

  // Watcher caches are exercised in the same process as the real link mutations. The virtual
  // minute makes A become due only after its link changed, so any notification is a stale leak.
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    for (const change of ['google-switch', 'google-disconnect', 'caldav-relink', 'caldav-remove', 'remove'] as const) {
      const a = account(); eventStart = now + 11 * 60_000
      await a.google(`A-${a.id}`); const cal = await a.caldav()
      const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
      const objects = dav.collections.get('/cal/mock/events/')!.objects
      objects.clear()
      objects.set('/cal/mock/events/private.ics', { etag: '"a"', text: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:private-caldav-${a.id}\r\nDTSTART:${stamp(eventStart)}\r\nDTEND:${stamp(eventStart + 3600_000)}\r\nSUMMARY:private-caldav-A\r\nLOCATION:private-caldav-location-A\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` })
      await calendar()
      check(`${change}: A cached before it is due`, !listEntries(a.user()).length)
      if (change === 'google-switch') await a.google(`B-${a.id}`)
      if (change === 'google-disconnect') await a.call('/api/google', 'DELETE')
      if (change === 'caldav-relink' || change === 'caldav-remove') {
        objects.clear()
        if (change === 'caldav-relink') await a.caldav()
        else await a.call(`/api/caldav/${cal}`, 'DELETE')
      }
      if (change === 'remove') await a.call('/api/me', 'DELETE')
      now += 60_001
      await calendar()
      const notices = database().prepare('SELECT title, body FROM notifications WHERE user_id = ?').all(a.id)
      const text = JSON.stringify(notices)
      check(`${change}: no invalidated A title/location reminder`, change.startsWith('google') ? !text.includes(`A-${a.id}`) : !text.includes('private-caldav-A') && !text.includes('private-caldav-location-A'))
      if (change !== 'remove') await a.call('/api/me', 'DELETE')
    }
    // Refresh failure after a switch while allEvents is held: the old cache must not be its catch fallback.
    for (const change of ['switch', 'disconnect', 'remove']) {
      const a = account(); eventStart = now + 16 * 60_000; await a.google(`A-${a.id}`); await a.caldav()
      await calendar(); now += 6 * 60_000; clearGoogleCache(a.user()); clearCaldavCache(a.user())
      const g = hold((u) => u.origin === new URL(dav.origin).origin && u.pathname.includes('/events/'))
      const pending = calendar(); await arrived(g)
      if (change === 'switch') await a.google(`B-${a.id}`)
      else if (change === 'disconnect') await a.call('/api/google', 'DELETE')
      else await a.call('/api/me', 'DELETE')
      release(g); await pending
      check(`fallback/${change}: stale A events never notified`, !JSON.stringify(database().prepare('SELECT title, body FROM notifications WHERE user_id = ?').all(a.id)).includes(`A-${a.id}`))
      if (change !== 'remove') await a.call('/api/me', 'DELETE')
    }
  } finally { Date.now = realNow }
  check('only local provider endpoints used', unexpected.length === 0)
} finally {
  gate?.release(); globalThis.fetch = realFetch
  api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r()))
  mock.closeAllConnections(); await new Promise<void>((r) => mock.close(() => r()))
  await dav.close()
  rmSync(data, { recursive: true, force: true })
}
finish()
