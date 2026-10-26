import { Socket, connect, createServer as createNetServer } from 'node:net'
import { Resolver } from 'node:dns/promises'
import { startMock, USER, PASSWORD } from './tasks-mock.ts'
// Held aggregate/provider/route boundaries. All network dispatches terminate at local mocks.
import { createServer, IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockJmap } from './mail-mock.ts'
import { check, finish } from './empires-harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mvlos-round10-'))
Object.assign(process.env, { DATA_DIR: scratch, ADMIN_GITHUB_IDS: Array.from({ length: 1000 }, (_, n) => n + 1).join(','), NOTIFY_WATCH: 'off', MC_WATCH: 'off', GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' })
setTimeout(() => { console.error('FAIL race suite timed out'); process.exit(1) }, 180_000).unref()
const aProvider = await startMockJmap({ token: 'token-A', eventSource: false })
const bProvider = await startMockJmap({ token: 'token-B', eventSource: false })
const secret = Buffer.from('private-attachment-content')
const prefix = Buffer.from('ok:')
for (const blob of aProvider.blobs.values()) if (blob.data.length > 1_000_000) blob.data = Buffer.concat([prefix, secret])
aProvider.blobs.set('privateblob', { type: 'image/png', data: Buffer.concat([prefix, secret]) })
const REPO = '11111111-1111-4111-8111-111111111111'
let officeOrigin = ''
let encryptedLibrary = false
const inputs: { path: string; body: string; auth: string }[] = []
const officeLog: string[] = []
const officeMock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const path = new URL(req.url!, 'http://local').pathname
  officeLog.push(path)
  inputs.push({ path, body: raw, auth: String(req.headers.authorization ?? '') })
  const send = (body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  if (path.startsWith('/preview-page/')) {
    const held = gate
    if (held?.matches(new URL(`${officeOrigin}${path}`))) {
      res.on('close', () => { if (!res.writableFinished) held.cancelled = true })
      held.hit(); await held.wait
    }
    if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'text/html' }).end('<head><title>private-repository-preview</title></head>')
    return
  }
  if (path.endsWith('/prompt')) return send({ prompt_id: 'accepted-prompt-A' })
  if (path.includes('/history/')) return send({})
  if (path.endsWith('/queue')) return send({})
  if (path === '/google-token') return send({ access_token: 'google-refreshed', expires_in: 3600 })
  if (path === '/google/users/me/calendarList') return send({ items: [{ id: 'mock-calendar', summary: 'private-calendar', accessRole: 'owner' }] })
  if (path === '/oauth/token') {
    const form = new URLSearchParams(raw), code = form.get('code') ?? (form.get('refresh_token')?.includes('B') ? 'B2' : 'A2')
    return send({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: `${code}@example.test`, 'https://api.openai.com/auth': { chatgpt_account_id: code } })).toString('base64url')}.x` })
  }
  if (path === '/models') return send({ models: [{ slug: 'gpt-test', display_name: 'Test', visibility: 'list', supported_in_api: true }] })
  if (path === '/responses' || path === '/images/generations') {
    if (req.headers.authorization === 'Bearer access-A') return res.writeHead(401).end('expired')
    return send({ data: [{ b64_json: 'aGVsbG8=' }] })
  }
  if (path === '/api/chat') {
    const body = JSON.parse(raw)
    const message = { role: 'assistant', content: body.stream ? 'Queue fixture answer' : '{"title":"Queue fixture"}' }
    return body.stream ? res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(JSON.stringify({ message, done: true }) + '\n') : send({ message })
  }
  if (path === '/api/tags') return send({ models: [{ name: 'private-model', details: {} }] })
  if (path === '/api/show') return send({ capabilities: ['completion'] })
  if (path.startsWith('/github/')) {
    if (path.endsWith('/search/issues')) return send({ items: [{ id: 1, title: 'private-repository-title', number: 1, html_url: 'https://example.test/private', state: 'open', labels: [], body: 'private-body', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), repository_url: 'https://api.github.com/repos/private/repository' }] })
    if (path.endsWith('/user')) return send({ login: 'mock-user' })
    if (path.includes('/repos/')) return send({ id: 1, full_name: 'private/repository', name: 'repository', html_url: 'https://example.test/private', private: true, owner: { login: 'private' }, default_branch: 'main' })
    return send([])
  }
  if (path === '/api/v2.1/repos/') return send({ repos: [{ repo_id: REPO, repo_name: 'private-library', type: 'mine', encrypted: encryptedLibrary, permission: 'rw' }] })
  if (path.endsWith('/thumbnail/')) return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.concat([prefix, secret]))
  if (path === '/api2/auth-token/') return send({ token: 'sf-token' })
  if (path === '/api2/account-info/' || path === '/api2/server-info/') return send({ name: 'Mock', version: '12' })
  if (path.endsWith('/file/detail/')) return send({ id: 'version-A', size: 24 })
  if (path.endsWith('/update-link/')) return send(`${officeOrigin}/upload`)
  if (path.endsWith('/file/')) return send(`${officeOrigin}/document`)
  if (path === '/document') return res.writeHead(req.headers.range ? 206 : 200, { ...(req.headers.range ? { 'Content-Range': `bytes 0-${prefix.length + secret.length - 1}/${prefix.length + secret.length}` } : {}), 'Content-Type': 'video/mp4', 'Content-Length': prefix.length + secret.length }).end(Buffer.concat([prefix, secret]))
  if (path.includes('/repos/')) return send({ permission: 'rw', encrypted: encryptedLibrary })
  if (path.endsWith('/api.js')) return res.writeHead(200).end('/* local mock */')
  return send({})
})
await new Promise<void>((resolve) => officeMock.listen(0, '127.0.0.1', resolve))
officeOrigin = `http://127.0.0.1:${(officeMock.address() as { port: number }).port}`
Object.assign(process.env, { OPENAI_AUTH_URL: officeOrigin, CHATGPT_CODEX_URL: officeOrigin, OLLAMA_URL: officeOrigin, OLLAMA_API_KEY: 'fixture-key', GOOGLE_API_URL: officeOrigin + '/google', GOOGLE_TOKEN_URL: officeOrigin + '/google-token', GOOGLE_REVOKE_URL: officeOrigin + '/revoke', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test' })
const dav = await startMock()
const realFetch = globalThis.fetch
const allowed = new Set([aProvider.origin, bProvider.origin, officeOrigin, dav.origin])
const dispatch: { origin: string; path: string; token: string; method: string }[] = []
type Gate = { matches: (u: URL, init?: RequestInit) => boolean; tail: boolean; hit: () => void; arrived: Promise<void>; wait: Promise<void>; release: () => void; signals: AbortSignal[]; cancelled: boolean }
let gate: Gate | null = null
function hold(matches: Gate['matches'], tail = false) {
  let hit!: () => void, release!: () => void
  const arrived = new Promise<void>((r) => { hit = r }), wait = new Promise<void>((r) => { release = r })
  gate = { matches, tail, hit, arrived, wait, release, signals: [], cancelled: false }
  return gate
}
function release(g: Gate) { if (gate === g) gate = null; g.release() }
async function arrived(g: Gate) {
  await Promise.race([g.arrived, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Provider gate not reached')), 5000).unref()
    void g.arrived.then(() => clearTimeout(timer))
  })])
}
globalThis.fetch = async (input, init) => {
  let url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname === 'api.github.com') { url = new URL(`${officeOrigin}/github${url.pathname}${url.search}`); input = url.href }
  if (url.hostname === 'ollama.com') { url = new URL(`${officeOrigin}${url.pathname}${url.search}`); input = url.href }
  if (!allowed.has(url.origin)) throw new Error('Non-local provider request refused')
  dispatch.push({ origin: url.origin, path: url.pathname, token: new Headers(init?.headers).get('authorization') ?? '', method: init?.method ?? 'GET' })
  const current = gate
  const response = await realFetch(input, init)
  if (current?.matches(url, init)) {
    if (init?.signal) current.signals.push(init.signal)
    if (current.tail) {
      const bytes = Buffer.from(await response.arrayBuffer())
      let part = 0
      return new Response(new ReadableStream({
        async pull(out) {
          if (part++ === 0) return out.enqueue(bytes.subarray(0, prefix.length))
          if (part === 2) { current.hit(); await current.wait; out.enqueue(bytes.subarray(prefix.length)); return }
          out.close()
        },
        cancel() { current.cancelled = true },
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers })
    }
    current.hit(); await current.wait
  }
  return response
}
const { database, encrypt, sha256 } = await import('../server/db.ts')
// Preview's pinned transport still exercises DNS validation. Its checked public address is
// connected to the local mock by this test-only agent; no socket leaves loopback.
const { pinnedHttp } = await import('../server/egress.ts')
const resolve4 = Resolver.prototype.resolve4, resolve6 = Resolver.prototype.resolve6
Resolver.prototype.resolve4 = (async () => ['93.184.216.34']) as typeof resolve4
Resolver.prototype.resolve6 = (async () => []) as typeof resolve6
const connection = pinnedHttp.createConnection
pinnedHttp.createConnection = ((_options: unknown, callback: unknown) => connect(new URL(officeOrigin).port as unknown as number, '127.0.0.1', callback as () => void)) as typeof connection
const { handleApi } = await import('../server/api.ts')
const { accounts } = await import('../server/auth.ts')
const { addMail, removeMail, mailAccount, mailMeta } = await import('../server/jmap.ts')
const { ban, deleteUser } = await import('../server/users.ts')
const { sweep, liveCount } = await import('../server/liveSessions.ts')
const { prepareMailCall } = await import('../server/agentMail.ts')
const { responsesChat } = await import('../server/agentChatGPT.ts')
const { image, chatgptSignInForTest: signIn } = await import('../server/agentOpenAI.ts')
const { clearCaldavCache } = await import('../server/caldav.ts')
const active = new Set<Promise<unknown>>()
const api = createServer((req, res) => {
  const work = handleApi(req, res).then((done) => { if (!done) res.writeHead(404).end() })
  active.add(work); void work.finally(() => active.delete(work))
})
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
allowed.add(origin)
let next = 1
function account() {
  const id = next++, now = Date.now(), sid = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `test-${id}`, encrypt('mock-github-token'), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + 86400_000)
  const user = () => accounts().find((u) => u.id === id)!
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, 'X-MVL-Account': String(id), Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const mail = () => addMail(user(), { url: aProvider.sessionUrl, token: aProvider.token })
  const sf = async (name = 'A') => {
    const r = await call('/api/integrations/seafile', 'POST', { url: officeOrigin, username: name, password: 'mock' })
    if (!r.ok) throw new Error(await r.text())
  }
  const office = async () => {
    const r = await call('/api/integrations/onlyoffice', 'PUT', { url: officeOrigin, secret: 'office-secret' })
    if (!r.ok) throw new Error(await r.text())
  }
  return { id, sid, user, call, mail, sf, office }
}
type Account = ReturnType<typeof account>
const changes = ['logout', 'remove', 'ban', 'expire', 'revoke', 'unlink', 'relink'] as const
type Change = typeof changes[number] | 'none' | 'other-logout'
async function change(a: Account, kind: Change, mailId: number) {
  if (kind === 'logout') await a.call('/api/auth/logout', 'POST')
  if (kind === 'remove') await deleteUser(a.id)
  if (kind === 'ban') ban(a.id, 'mock')
  if (kind === 'expire') database().prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(a.id)
  if (kind === 'revoke') database().prepare('DELETE FROM sessions WHERE user_id = ?').run(a.id)
  if (kind === 'expire' || kind === 'revoke') sweep()
  if (kind === 'unlink' || kind === 'relink') removeMail(a.user(), mailId)
  if (kind === 'relink') await a.mail()
  if (kind === 'other-logout') {
    const sid = randomBytes(24).toString('hex')
    database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), a.id, Date.now(), Date.now() + 86400_000)
    await a.call('/api/auth/logout', 'POST', undefined, { Cookie: `mvlos_sid=${sid}` })
  }
}
const settled = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }))
async function collect(res: Response) {
  const chunks: Buffer[] = []
  try { for await (const c of res.body ?? []) chunks.push(Buffer.from(c)) } catch { /* Retain partial bytes. */ }
  return Buffer.concat(chunks)
}
const drain = async () => { while (active.size) await Promise.all([...active]) }
const only = process.env.REVOCATION_CASE
async function linkedChat(a: Account, name: string) {
  const start = new URL(signIn.startSignIn(a.user(), { acceptedRisk: true }).url)
  const req = new IncomingMessage(new Socket()); req.headers.cookie = `mvlos_sid=${a.sid}`
  const { currentUser } = await import('../server/auth.ts'); currentUser(req)
  await signIn.finishSignIn(a.user(), { callback: `?code=${name}&state=${start.searchParams.get('state')}` }, req)
}
function photo(a: Account, cached = false) {
  database().prepare('INSERT OR REPLACE INTO photo_accounts (user_id, seafile, scanned_at) VALUES (?, ?, ?)').run(a.id, `${officeOrigin}|A`, Date.now())
  database().prepare('INSERT OR IGNORE INTO photo_sources (user_id, repo, path) VALUES (?, ?, ?)').run(a.id, REPO, '/')
  const row = database().prepare("INSERT INTO photos (user_id, repo, path, kind, size, mtime, file_id, taken_at, taken_src, thumb) VALUES (?, ?, '/private.jpg', 'image', ?, ?, 'version-A', ?, 'file', ?)").run(a.id, REPO, secret.length, Date.now(), Date.now(), cached ? secret : null)
  return String(row.lastInsertRowid)
}
let lastUnlockExpiry: (() => void) | undefined
async function unlockLibrary(a: Account) {
  const timeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay && delay >= 5 * 60_000 && delay <= 55 * 60_000) lastUnlockExpiry = () => fn(...args)
    return timeout(fn, delay, ...args)
  }) as typeof setTimeout
  let response: Response
  try { response = await a.call('/api/seafile/unlock', 'POST', { repo: REPO, password: 'mock', minutes: 5 }) }
  finally { globalThis.setTimeout = timeout }
  if (!response.ok) throw new Error(`Unlock failed: ${await response.text()}`)
}
async function revokeLibrary(a: Account, kind: string) {
  if (kind === 'lock' || kind === 'reunlock') await a.call('/api/seafile/lock', 'POST', { repo: REPO })
  if (kind === 'reunlock') await unlockLibrary(a)
}
const noPrivate = (bytes: Buffer) => !bytes.includes(secret) && !/private-repository|private-library|private-model|private-mail|private-body/.test(bytes.toString())
async function rejected(pending: Promise<Response>) {
  const result = await settled(pending)
  if (!result.value) return true
  const bytes = await collect(result.value)
  return result.value.status >= 400 && noPrivate(bytes) && !['etag', 'location', 'content-range'].some((key) => result.value!.headers.has(key))
}
try {
  if (!only || only === 'aggregates') {
    for (const target of ['pim', 'agent']) for (const kind of ['none', 'unlink', 'relink', 'remove']) {
      const a = account(), first = await a.mail(), second = await addMail(a.user(), { url: bProvider.sessionUrl, token: bProvider.token })
      const email = aProvider.deliver({ subject: 'private-mail-A', text: 'private-body', from: [{ name: 'Sender', email: 'person@example.test' }] })
      let completed = false
      const g = hold((u) => u.origin === bProvider.origin && u.pathname === '/jmap/session')
      const pending = target === 'pim' ? settled(a.call('/api/pim/mail-with?emails=person@example.test')) : settled(prepareMailCall(a.user(), 'mail_search', { query: 'private-mail' }, 'UTC').then((p) => p.run()))
      // Observe A's finished provider work before revoking it; B remains held.
      await arrived(g)
      const until = Date.now() + 3000
      while (!completed && Date.now() < until) {
        completed = dispatch.some((d) => d.origin === aProvider.origin && d.path === '/jmap/api/' && d.method === 'POST')
        if (!completed) await new Promise((r) => setTimeout(r, 5))
      }
      // A separate cached helper proves A can finish while B is still held, without releasing B.
      await mailMeta(mailAccount(a.user(), first.id))
      if (kind === 'unlink' || kind === 'relink') removeMail(a.user(), first.id)
      if (kind === 'relink') await a.mail()
      if (kind === 'remove') await deleteUser(a.id)
      release(g); const result = await pending
      if (target === 'pim') {
        const r = result.value as Response | null, bytes = r ? await collect(r) : Buffer.alloc(0)
        check(`aggregate/${target}/${kind}`, kind === 'none' ? r?.ok === true && bytes.includes(Buffer.from(email.subject)) : !!result.error || (!!r && r.status >= 400 && noPrivate(bytes)))
      } else check(`aggregate/${target}/${kind}`, kind === 'none' ? !result.error && JSON.stringify(result.value).includes(email.subject) : !!result.error && !JSON.stringify(result.value).includes(email.subject))
      await drain()
      if (kind !== 'remove') { removeMail(a.user(), first.id); removeMail(a.user(), second.id) }
    }
    // Mail has finished; task-list discovery is still held. An unlink must prevent the PUT.
    for (const kind of ['none', 'unlink', 'relink']) {
      const a = account(), info = await a.mail()
      const email = aProvider.deliver({ subject: 'private-mail-task', text: 'private-body' })
      const added = await a.call('/api/caldav', 'POST', { url: dav.origin, username: USER, password: PASSWORD }); await added.arrayBuffer()
      clearCaldavCache(a.user())
      const g = hold((u) => u.origin === dav.origin && u.pathname.includes('/cal/'))
      const pending = a.call('/api/pim/task-from-mail', 'POST', { account: info.id, email: email.id })
      await arrived(g)
      if (kind !== 'none') removeMail(a.user(), info.id)
      if (kind === 'relink') await a.mail()
      const before = dispatch.length
      release(g); const response = await pending; const bytes = await collect(response)
      check(`aggregate/PIM write/${kind}: no stale task`, kind === 'none' ? response.ok : response.status >= 400 && noPrivate(bytes) && !dispatch.slice(before).some((d) => d.origin === dav.origin && d.method === 'PUT'))
    }
  }
  if (!only || only === 'routes') {
    // Each family starts private work before logout. Representative lower-level provider gates
    // exercise the common default boundary, rather than a list of specially wrapped routes.
    for (const family of ['inbox', 'repos', 'code-hosts', 'agents', 'preview', 'files', 'photos', 'mail', 'pim', 'calendar']) for (const kind of ['none', 'other-logout', 'logout', 'remove', 'ban', 'expire', 'revoke'] as Change[]) {
      const a = account(); let path = '', matches: Gate['matches']
      if (family === 'inbox') { path = '/api/inbox?fresh=1'; matches = (u) => u.pathname.includes('/github/search/issues') }
      else if (family === 'repos') { path = '/api/repos/github/private/repository'; matches = (u) => u.pathname.includes('/github/repos/') }
      else if (family === 'code-hosts') { path = '/api/code/orgs?fresh=1'; matches = (u) => u.pathname.startsWith('/github/') }
      else if (family === 'agents') { await linkedChat(a, 'A'); path = '/api/agents/models'; matches = (u) => u.pathname === '/models' }
      else if (family === 'preview') { path = `/api/preview?url=${encodeURIComponent(`http://preview.example.test/preview-page/${a.id}`)}`; matches = (u) => u.pathname.startsWith('/preview-page/') }
      else if (family === 'files' || family === 'photos') {
        await a.sf(); encryptedLibrary = false
        if (family === 'files') { path = `/api/seafile/raw?repo=${REPO}&p=/private.jpg`; matches = (u) => u.pathname === '/document' }
        else { path = `/api/photos/seafile/thumb?id=${photo(a)}`; matches = (u) => u.pathname.endsWith('/thumbnail/') }
      } else if (family === 'mail' || family === 'pim') {
        const info = await a.mail(); path = family === 'mail' ? `/api/mail/${info.id}/blob/privateblob?name=private.png` : '/api/pim/mail-with?emails=person@example.test'; matches = (u) => u.origin === aProvider.origin && u.pathname.includes(family === 'mail' ? '/download/' : '/session')
      } else {
        const r = await a.call('/api/caldav', 'POST', { url: dav.origin, username: USER, password: PASSWORD }); await r.arrayBuffer(); clearCaldavCache(a.user())
        path = '/api/calendar/calendars'; matches = (u) => u.origin === dav.origin && u.pathname.includes('/cal/')
      }
      const g = hold(matches), pending = a.call(path, 'GET', undefined, family === 'files' ? { Range: `bytes=0-${prefix.length + secret.length - 1}` } : {})
      await arrived(g); gate = null
      await change(a, kind, -1)
      if (family === 'preview' && kind !== 'none' && kind !== 'other-logout') {
        const until = Date.now() + 2000
        while (!g.cancelled && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
      }
      release(g)
      const valid = kind === 'none' || kind === 'other-logout'
      const result = await settled(pending)
      const bytes = result.value ? await collect(result.value) : Buffer.alloc(0)
      check(`routes/${family}/${kind}`, valid ? result.value?.ok === true : !!result.error || (!!result.value && result.value.status >= 400 && noPrivate(bytes)))
      if (!valid) check(`routes/${family}/${kind}: upstream aborted`, family === 'preview' ? g.cancelled : g.signals.length > 0 && g.signals.every((signal) => signal.aborted))
      await drain()
    }
    // A second session can complete the same cached private request while the first is held.
    {
      const a = account(), g = hold((u) => u.pathname.includes('/github/search/issues'))
      const pending = a.call('/api/inbox?fresh=1'); await arrived(g); gate = null
      const sid = randomBytes(24).toString('hex')
      database().prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(sid), a.id, Date.now(), Date.now() + 86400_000)
      await a.call('/api/auth/logout', 'POST')
      const parallel = a.call('/api/inbox', 'GET', undefined, { Cookie: `mvlos_sid=${sid}` })
      const other = await Promise.race([parallel, new Promise<null>((r) => setTimeout(() => r(null), 2000).unref())])
      check('routes/cache: parallel session completes independently', !!other?.ok && (await other.text()).includes('private-repository-title'))
      release(g); if (!other) await collect(await parallel)
      check('routes/cache: original session gets no stale data', await rejected(pending))
    }
    // Admin removal waits for target credential cleanup, then loses initiating admin authority.
    for (const kind of ['none', 'other-logout', 'logout', 'expire', 'revoke'] as Change[]) {
      const a = account(), target = account()
      database().prepare('UPDATE users SET github_id=? WHERE id=?').run(20_000 + target.id, target.id)
      const g = hold((u) => u.pathname.startsWith('/github/applications/'))
      const pending = a.call(`/api/admin/users/${target.id}`, 'DELETE'); await arrived(g); gate = null
      await change(a, kind, -1); release(g); const result = await pending; await collect(result)
      check(`routes/admin/${kind}: commit authority`, kind === 'none' || kind === 'other-logout' ? result.ok && !database().prepare('SELECT 1 FROM users WHERE id=?').get(target.id) : result.status >= 400 && !!database().prepare('SELECT 1 FROM users WHERE id=?').get(target.id))
    }
  }
  if (!only || only === 'chatgpt') {
    for (const target of ['text', 'image', 'reference', 'models']) for (const kind of ['none', 'disconnect', 'relink']) {
      const a = account(); await linkedChat(a, 'A')
      const endpoint = target === 'models' ? '/models' : target === 'image' ? '/images/generations' : '/responses'
      const g = hold((u) => u.pathname === endpoint)
      const pending = settled(target === 'text' || target === 'models' ? responsesChat(a.user(), { model: 'chatgpt/gpt-test', messages: [{ role: 'user', content: 'private-prompt-A' }] }, new AbortController().signal, () => {}) : image(a.user(), { prompt: 'private-image-A', size: '1024x1024', quality: 'low', background: 'opaque', ...(target === 'reference' ? { references: [{ name: 'private.png', mime: 'image/png', bytes: secret }] } : {}) }, new AbortController().signal))
      await arrived(g); gate = null
      if (kind !== 'none') signIn.signOut(a.user())
      if (kind === 'relink') await linkedChat(a, 'B')
      const before = inputs.length
      release(g); const result = await pending
      check(`chatgpt/${target}/${kind}: never crosses account`, !inputs.slice(before).some((r) => /^Bearer access-B/.test(r.auth) && /private-prompt-A|private-image-A/.test(r.body)))
      if (kind !== 'none') check(`chatgpt/${target}/${kind}: stale operation rejected`, !!result.error)
    }
    // A refresh held at token exchange cannot overwrite a newly linked account B.
    {
      const a = account(); await linkedChat(a, 'A')
      const g = hold((u) => u.pathname === '/oauth/token')
      const pending = settled(responsesChat(a.user(), { model: 'chatgpt/gpt-test', messages: [{ role: 'user', content: 'private-prompt-refresh' }] }, new AbortController().signal, () => {}))
      await arrived(g); gate = null; signIn.signOut(a.user()); await linkedChat(a, 'B'); release(g); await pending
      const row = database().prepare("SELECT secret FROM integrations WHERE user_id=? AND name='openai-chatgpt'").get(a.id) as { secret: string }
      check('chatgpt/stale refresh: B credentials retained', JSON.parse((await import('../server/db.ts')).decrypt(row.secret)).access === 'access-B')
    }
  }
  if (!only || only === 'refreshes') {
    for (const provider of ['chatgpt', 'google']) for (const leave of ['logout', 'other-logout', 'close']) {
      const a = account()
      if (provider === 'chatgpt') {
        await linkedChat(a, 'A')
        const row = database().prepare("SELECT secret FROM integrations WHERE user_id=? AND name='openai-chatgpt'").get(a.id) as { secret: string }
        const t = JSON.parse((await import('../server/db.ts')).decrypt(row.secret)); t.expires = 0
        database().prepare("UPDATE integrations SET secret=? WHERE user_id=? AND name='openai-chatgpt'").run(encrypt(JSON.stringify(t)), a.id)
      } else database().prepare('INSERT INTO google (user_id,email,refresh_token,access_token,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(a.id, 'mock@example.test', encrypt('google-refresh'), null, 0, Date.now())
      const sid = randomBytes(24).toString('hex')
      database().prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(sid), a.id, Date.now(), Date.now() + 86400_000)
      const before = inputs.length, g = hold((u) => u.pathname === (provider === 'chatgpt' ? '/oauth/token' : '/google-token'))
      const ctl = new AbortController(), path = provider === 'chatgpt' ? '/api/agents/models' : '/api/calendar/calendars'
      const first = settled(fetch(`${origin}${path}`, { headers: { Cookie: `mvlos_sid=${a.sid}` }, signal: ctl.signal })); await arrived(g)
      const second = a.call(path, 'GET', undefined, { Cookie: `mvlos_sid=${sid}` })
      const until = Date.now() + 2000
      while (liveCount().connections < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
      if (leave === 'close') ctl.abort()
      else await change(a, leave, -1)
      await new Promise((r) => setImmediate(r))
      check(`refresh/${provider}/${leave}: remaining subscriber keeps transport`, g.signals.length > 0 && g.signals.every((s) => !s.aborted))
      release(g); const one = await first, two = await second
      check(`refresh/${provider}/${leave}: parallel session succeeds`, two.ok && (await two.text()).includes(provider === 'chatgpt' ? 'gpt-test' : 'mock-calendar'))
      if (one.value) await collect(one.value)
      check(`refresh/${provider}/${leave}: single provider refresh`, inputs.slice(before).filter((r) => r.path === (provider === 'chatgpt' ? '/oauth/token' : '/google-token')).length === 1)
    }
    for (const target of ['text', 'image']) {
      const a = account(); await linkedChat(a, 'A2')
      const g = hold((u) => u.pathname === (target === 'text' ? '/responses' : '/images/generations'), true)
      const pending = settled(target === 'text' ? responsesChat(a.user(), { model: 'chatgpt/gpt-test', messages: [{ role: 'user', content: 'private-held-prompt' }] }, new AbortController().signal, () => {}) : image(a.user(), { prompt: 'private-held-image', size: '1024x1024', quality: 'low', background: 'opaque' }, new AbortController().signal))
      await arrived(g); gate = null; signIn.signOut(a.user()); await linkedChat(a, 'B')
      const until = Date.now() + 2000
      while (!g.cancelled && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
      check(`chatgpt/${target}: relink aborts stalled body promptly`, g.cancelled && g.signals.length > 0 && g.signals.every((s) => s.aborted))
      release(g); check(`chatgpt/${target}: stale body rejected`, !!(await pending).error)
    }
  }
  if (!only || only === 'transactions') {
    const a = account(); encryptedLibrary = false; await a.sf(); const id = photo(a)
    const realNow = Date.now
    database().function('expire_photo_transaction', () => { Date.now = () => realNow() + 2 * 86400_000; return 1 })
    database().exec(`CREATE TEMP TRIGGER expire_photo_delete AFTER DELETE ON photos WHEN OLD.user_id=${a.id} BEGIN SELECT expire_photo_transaction(); END`)
    const r = await a.call('/api/photos/sources', 'PUT', { sources: [] }); await collect(r); Date.now = realNow
    database().exec('DROP TRIGGER expire_photo_delete')
    check('transaction: expiry rolls back photo pruning', r.status >= 400 && !!database().prepare('SELECT 1 FROM photos WHERE id=?').get(id) && !!database().prepare('SELECT 1 FROM photo_sources WHERE user_id=?').get(a.id))
    let usable = false
    try { database().exec('BEGIN'); database().exec('ROLLBACK'); usable = true } catch { try { database().exec('ROLLBACK') } catch { /* Old guard leaves the transaction open. */ } }
    check('transaction: expired commit does not leave shared transaction open', usable)
  }
  if (!only || only === 'rcon') {
    const commands: string[] = [], sockets = new Set<Socket>()
    const packet = (id: number, kind: number, text: string) => {
      const b = Buffer.from(text), out = Buffer.alloc(b.length + 14)
      out.writeInt32LE(b.length + 10, 0); out.writeInt32LE(id, 4); out.writeInt32LE(kind, 8); b.copy(out, 12); return out
    }
    const rcon = createNetServer((socket) => {
      sockets.add(socket); let buffered = Buffer.alloc(0)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      socket.on('data', (bytes) => {
        buffered = Buffer.concat([buffered, bytes])
        while (buffered.length >= 4 && buffered.length >= buffered.readInt32LE(0) + 4) {
          const size = buffered.readInt32LE(0), id = buffered.readInt32LE(4), kind = buffered.readInt32LE(8), text = buffered.subarray(12, size + 2).toString()
          buffered = buffered.subarray(size + 4)
          if (kind === 3) {
            const current = gate
            if (current) {
              current.hit(); socket.on('close', () => { current.cancelled = true })
              void current.wait.then(() => { if (!socket.destroyed) socket.write(packet(id, 2, '')) })
            } else socket.write(packet(id, 2, ''))
          } else { commands.push(text); socket.write(packet(id, 0, 'private-command-result')) }
        }
      })
    })
    await new Promise<void>((resolve) => rcon.listen(0, '127.0.0.1', resolve))
    Object.assign(process.env, { MC_RCON: `127.0.0.1:${(rcon.address() as { port: number }).port}`, MC_RCON_PASSWORD: 'mock' })
    try {
      for (const kind of ['none', 'other-logout', 'logout', 'remove', 'ban', 'expire', 'revoke'] as Change[]) {
        const a = account(), g = hold(() => false), before = commands.length
        const pending = a.call('/api/minecraft/rcon', 'POST', { action: 'whitelist', op: 'add', name: 'ReviewPlayer' }); await arrived(g)
        await change(a, kind, -1)
        if (kind !== 'none' && kind !== 'other-logout') {
          const until = Date.now() + 2000
          while (!g.cancelled && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
        }
        release(g); const r = await pending; await collect(r)
        check(`RCON/auth/${kind}: no stale command`, kind === 'none' || kind === 'other-logout' ? r.ok && commands.slice(before).includes('whitelist add ReviewPlayer') : r.status >= 400 && commands.length === before && g.cancelled)
      }
    } finally { delete process.env.MC_RCON; delete process.env.MC_RCON_PASSWORD; for (const s of sockets) s.destroy(); await new Promise<void>((r) => rcon.close(() => r())) }
  }
  if (!only || only === 'comfy-cleanup') {
    const { withPrivateOperation } = await import('../server/privateRequest.ts')
    const { comfyGraphForTest } = await import('../server/agentImages.ts')
    for (const changeBackend of [false, true]) {
      const a = account(), ctl = new AbortController()
      const g = hold((u) => u.pathname.includes('/history/'))
      const settings = { url: officeOrigin + '/comfy-A', token: 'backend-A' } as Parameters<typeof comfyGraphForTest>[1]
      const before = inputs.length
      const pending = settled(withPrivateOperation(() => comfyGraphForTest(a.user(), settings, {}, ['output'], ctl.signal), ctl.signal))
      await arrived(g)
      if (changeBackend) database().prepare('INSERT INTO integrations (user_id,name,secret,created_at) VALUES (?,?,?,?)').run(a.id, 'agents-comfyui', encrypt(JSON.stringify({ url: officeOrigin + '/comfy-B', token: 'backend-B' })), Date.now())
      ctl.abort(); release(g); const result = await pending
      const calls = inputs.slice(before)
      check(`ComfyUI/cleanup/${changeBackend ? 'replacement' : 'Stop'}: only accepted prompt deleted`, !!result.error && calls.filter((r) => r.path === '/comfy-A/queue' && r.auth === 'Bearer backend-A' && r.body === JSON.stringify({ delete: ['accepted-prompt-A'] })).length === 1 && !calls.some((r) => r.path.startsWith('/comfy-B/') || r.path.endsWith('/interrupt')) && calls.filter((r) => r.path.endsWith('/prompt')).length === 1)
    }
  }
  if (!only || only === 'send-now') {
    const a = account()
    const made = await a.call('/api/agents/threads', 'POST', { mode: 'quick', model: 'test-model', permission: 'bypass' })
    const data = await made.json() as { id: string }, thread = data.id
    database().prepare("UPDATE agent_threads SET title='Queue fixture', title_source='manual' WHERE id=?").run(thread)
    const g = hold((u, init) => u.pathname === '/api/chat' && JSON.parse(String(init?.body ?? '{}')).stream === true)
    const before = inputs.length
    const started = a.call(`/api/agents/threads/${thread}/messages`, 'POST', { text: 'first-input' }); await arrived(g)
    const reading = collect(await started)
    const queued = await a.call(`/api/agents/threads/${thread}/queue`, 'POST', { text: 'second-input' })
    const item = await queued.json() as { thread: { queue: { id: string }[] } }
    gate = null
    const sent = await a.call(`/api/agents/threads/${thread}/queue/${item.thread.queue[0].id}/send`, 'POST'); await sent.arrayBuffer()
    release(g); await reading; await drain()
    const messages = database().prepare('SELECT role, content FROM agent_messages WHERE thread_id=? ORDER BY id').all(thread) as { role: string; content: string }[]
    const calls = inputs.slice(before).filter((r) => r.path === '/api/chat' && JSON.parse(r.body).stream === true)
    check('Agents/Send now: cancelled operation hands off replacement exactly once', sent.ok && messages.filter((m) => m.role === 'user').length === 2 && messages.some((m) => m.role === 'user' && m.content === 'second-input') && calls.length === 2 && JSON.parse(calls[1].body).messages.some((m: { role: string; content: string }) => m.role === 'user' && m.content === 'second-input'))
  }
  if (!only || only === 'office') {
    for (const kind of ['none', 'remove-absent', 'remove-set', 'concurrent-set']) {
      const a = account(); await a.sf()
      const g = hold((u) => u.pathname.endsWith('/api.js'))
      const pending = a.call('/api/integrations/onlyoffice', 'PUT', { url: officeOrigin + '/A', secret: 'A' }); await arrived(g); gate = null
      if (kind === 'remove-absent' || kind === 'remove-set') await a.call('/api/integrations/onlyoffice', 'DELETE')
      if (kind === 'remove-set' || kind === 'concurrent-set') await a.call('/api/integrations/onlyoffice', 'PUT', { url: officeOrigin + '/B', secret: 'B' })
      release(g); const result = await pending; await collect(result)
      const row = database().prepare("SELECT secret FROM integrations WHERE user_id=? AND name='onlyoffice'").get(a.id) as { secret: string } | undefined
      const office = row ? JSON.parse((await import('../server/db.ts')).decrypt(row.secret)) as { secret: string } : null
      check(`office/setup/${kind}`, kind === 'none' ? result.ok && office?.secret === 'A' : result.status >= 400 && (kind === 'remove-absent' ? !office : office?.secret === 'B'))
    }
  }
  if (!only || only === 'libraries') {
    for (const target of ['thumb', 'cached-thumb', 'head-thumb', 'head-cached-thumb', 'info', 'original', 'raw', 'stream', 'zip-token', 'list']) for (const kind of ['none', 'lock', 'reunlock', 'expire']) {
      const a = account(); encryptedLibrary = true; await a.sf(); await unlockLibrary(a); const id = photo(a, target.includes('cached-thumb'))
      const path = target === 'raw' || target === 'stream' ? `/api/seafile/${target}?repo=${REPO}&p=/private.jpg` : target === 'list' ? '/api/photos/seafile/buckets' : target === 'zip-token' ? '/api/photos/seafile/zip' : `/api/photos/seafile/${target.includes('thumb') ? 'thumb' : target}?id=${id}`
      const g = hold((u) => target === 'raw' || target === 'stream' ? u.pathname === '/document' : target === 'thumb' || target === 'head-thumb' ? u.pathname.endsWith('/thumbnail/') : target === 'original' ? u.pathname.endsWith('/file/') : u.pathname === '/api/v2.1/repos/')
      const pending = a.call(path, target === 'zip-token' ? 'POST' : target.startsWith('head-') ? 'HEAD' : 'GET', target === 'zip-token' ? { ids: [id] } : undefined, { 'If-None-Match': '"sf-version-A-small"', ...(target === 'raw' ? { Range: `bytes=0-${prefix.length + secret.length - 1}` } : {}) })
      await arrived(g); gate = null
      const realNow = Date.now
      if (kind === 'expire') { Date.now = () => realNow() + 6 * 60_000; lastUnlockExpiry?.() }
      else await revokeLibrary(a, kind)
      release(g); const result = await settled(pending)
      const bytes = result.value ? await collect(result.value) : Buffer.alloc(0)
      Date.now = realNow
      check(`library/${target}/${kind}: no stale bytes/metadata/validator`, kind === 'none' ? result.value?.ok === true : !!result.error || (!!result.value && result.value.status >= 400 && noPrivate(bytes) && !result.value.headers.has('etag') && !result.value.headers.has('location')))
      await drain()
    }
    // Grants are sealed into download capabilities; a re-unlock never revives an old ZIP.
    {
      const a = account(); encryptedLibrary = true; await a.sf(); await unlockLibrary(a); const id = photo(a)
      const made = await a.call('/api/photos/seafile/zip', 'POST', { ids: [id] }), token = await made.json() as { url: string }
      await revokeLibrary(a, 'reunlock')
      check('library/ZIP capability: re-unlock does not revive token', await rejected(a.call(token.url)))
    }
    // Abort the body while a harmless prefix is already delivered; retain partial bytes on error.
    for (const kind of ['lock', 'reunlock', 'expire']) {
      const a = account(); encryptedLibrary = true; await a.sf(); await unlockLibrary(a)
      const g = hold((u) => u.pathname === '/document', true)
      const pending = a.call(`/api/seafile/stream?repo=${REPO}&p=/private.jpg`); await arrived(g)
      const response = await pending, reading = collect(response), realNow = Date.now
      if (kind === 'expire') { Date.now = () => realNow() + 6 * 60_000; lastUnlockExpiry?.() } else await revokeLibrary(a, kind)
      release(g); const bytes = await reading; Date.now = realNow
      check(`library/stream/${kind}: no private tail`, !bytes.includes(secret) && g.signals.every((s) => s.aborted))
    }
  }
  await drain(); await new Promise((r) => setImmediate(r))
  check('all request lifetime registrations released', liveCount().connections === 0)
} finally {
  gate?.release(); globalThis.fetch = realFetch
  pinnedHttp.createConnection = connection; Resolver.prototype.resolve4 = resolve4; Resolver.prototype.resolve6 = resolve6
  api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r()))
  officeMock.closeAllConnections(); await new Promise<void>((r) => officeMock.close(() => r()))
  await aProvider.close(); await bProvider.close(); await dav.close()
  rmSync(scratch, { recursive: true, force: true })
}
finish()
