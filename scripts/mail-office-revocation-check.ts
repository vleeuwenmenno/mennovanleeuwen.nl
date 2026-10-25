// Deterministic local-provider races: reusable Mail row IDs, private attachment delivery,
// queued Mail writes, and durable OnlyOffice/Seafile callback authority.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockJmap } from './mail-mock.ts'
import { check, finish } from './empires-harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mvlos-mail-office-'))
Object.assign(process.env, { DATA_DIR: scratch, ADMIN_GITHUB_IDS: Array.from({ length: 1000 }, (_, n) => n + 1).join(','), NOTIFY_WATCH: 'off', MC_WATCH: 'off', GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' })
setTimeout(() => { console.error('FAIL race suite timed out'); process.exit(1) }, 90_000).unref()
const aProvider = await startMockJmap({ token: 'token-A', eventSource: false })
const bProvider = await startMockJmap({ token: 'token-B', eventSource: false })
const secret = Buffer.from('private-attachment-content')
const prefix = Buffer.from('ok:')
for (const blob of aProvider.blobs.values()) if (blob.data.length > 1_000_000) blob.data = Buffer.concat([prefix, secret])
aProvider.blobs.set('privateblob', { type: 'image/png', data: Buffer.concat([prefix, secret]) })
const REPO = '11111111-1111-4111-8111-111111111111'
let officeOrigin = ''
const officeLog: string[] = []
const officeMock = createServer(async (req, res) => {
  for await (const _ of req) { /* Drain uploads. */ }
  const path = new URL(req.url!, 'http://local').pathname
  officeLog.push(path)
  const send = (body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  if (path === '/api2/auth-token/') return send({ token: 'sf-token' })
  if (path === '/api2/account-info/' || path === '/api2/server-info/') return send({ name: 'Mock', version: '12' })
  if (path.endsWith('/file/detail/')) return send({ id: 'version-A', size: 24 })
  if (path.endsWith('/update-link/')) return send(`${officeOrigin}/upload`)
  if (path.endsWith('/file/')) return send(`${officeOrigin}/document`)
  if (path === '/document') return res.writeHead(200).end('private-document-A')
  if (path.includes('/repos/')) return send({ permission: 'rw', encrypted: false })
  if (path.endsWith('/api.js')) return res.writeHead(200).end('/* local mock */')
  return send({})
})
await new Promise<void>((resolve) => officeMock.listen(0, '127.0.0.1', resolve))
officeOrigin = `http://127.0.0.1:${(officeMock.address() as { port: number }).port}`
const realFetch = globalThis.fetch
const allowed = new Set([aProvider.origin, bProvider.origin, officeOrigin])
const dispatch: { origin: string; path: string; token: string; method: string }[] = []
type Gate = { matches: (u: URL) => boolean; tail: boolean; hit: () => void; arrived: Promise<void>; wait: Promise<void>; release: () => void; signals: AbortSignal[]; cancelled: boolean }
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
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!allowed.has(url.origin)) throw new Error('Non-local provider request refused')
  dispatch.push({ origin: url.origin, path: url.pathname, token: new Headers(init?.headers).get('authorization') ?? '', method: init?.method ?? 'GET' })
  const current = gate
  const response = await realFetch(input, init)
  if (current?.matches(url)) {
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
const { handleApi } = await import('../server/api.ts')
const { accounts } = await import('../server/auth.ts')
const { addMail, removeMail, mailAccount, mailMeta, plainMessages } = await import('../server/jmap.ts')
const { ban, deleteUser } = await import('../server/users.ts')
const { sweep, liveCount } = await import('../server/liveSessions.ts')
const { signJwt } = await import('../server/office.ts')
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
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `test-${id}`, encrypt(''), now, now)
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
async function inlinePath(a: Account, id: number) {
  const message = [...aProvider.emails.values()].find((e) => e.htmlBody.length && e.attachments.some((p) => p.size > 1_000_000))!
  const r = await a.call(`/api/mail/${id}/message/${message.id}?images=1`)
  const text = await r.text()
  const path = /\/api\/mail\/inline\/[\w-]+/.exec(text)?.[0]
  if (!path) throw new Error(`No sealed inline URL: ${text.slice(0, 300)}`)
  return path
}
async function restartCallback(ticket: string) {
  const code = `import {officeCallback,signJwt} from './server/office.ts'; const data={status:2,url:${JSON.stringify(officeOrigin + '/document')}}; try {const r=await officeCallback({headers:{}},${JSON.stringify(ticket)},{token:signJwt(data,'office-secret')}); console.log(JSON.stringify(r))}catch(e){console.log(JSON.stringify({error:1}))}`
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', (s) => { output += s }); child.stderr.on('data', () => {})
    child.on('error', reject); child.on('exit', () => resolve(output))
  })
}
const only = process.env.REVOCATION_CASE
try {
  if (!only || only === 'cache') {
    // The exact ID-reuse exploit: discovery A finishes after unlink and after B is inserted.
    for (const sameOwner of [false, true]) {
      const a = account(), b = sameOwner ? a : account()
      const first = await a.mail()
      const g = hold((u) => u.origin === aProvider.origin && u.pathname === '/jmap/session')
      const stale = settled(mailMeta(mailAccount(a.user(), first.id)))
      await arrived(g)
      removeMail(a.user(), first.id)
      const second = await addMail(b.user(), { url: bProvider.sessionUrl, token: bProvider.token })
      check(`cache/${sameOwner ? 'same owner' : 'cross user'}: SQLite reused row ID`, second.id === first.id)
      release(g); const old = await stale
      const before = dispatch.length
      const fresh = await settled(mailMeta(mailAccount(b.user(), second.id)))
      await settled(plainMessages(mailAccount(b.user(), second.id), { emailIds: [[...bProvider.emails.keys()][0]] }, false))
      check(`cache/${sameOwner ? 'same owner' : 'cross user'}: old discovery rejected`, !!old.error)
      check(`cache/${sameOwner ? 'same owner' : 'cross user'}: B token never dispatched to A`, !dispatch.slice(before).some((d) => d.origin === aProvider.origin && d.token === 'Bearer token-B') && (fresh.value?.mailboxes.length ?? 0) > 0)
      removeMail(b.user(), second.id)
    }
    // Relinking the same row (including the same token) also ends prepared account authority.
    {
      const a = account(), info = await a.mail(), old = mailAccount(a.user(), info.id)
      const g = hold((u) => u.origin === aProvider.origin && u.pathname === '/jmap/session')
      const pending = settled(mailMeta(old)); await arrived(g); gate = null
      await a.mail(); release(g)
      check('cache/same record relink: held loader rejected', !!(await pending).error)
      check('cache/same record relink: prepared account rejected', !!(await settled(mailMeta(old))).error)
    }
  }
  if (!only || only === 'attachments') {
    for (const inline of [false, true]) for (const mode of ['GET', 'HEAD', 'range', 'tail']) for (const kind of ['none', 'other-logout', ...changes] as Change[]) {
      const a = account(), info = await a.mail()
      const path = inline ? await inlinePath(a, info.id) : `/api/mail/${info.id}/blob/privateblob?name=private.png&type=${mode === 'range' ? 'video/mp4' : 'image/png'}&inline=1`
      const g = hold((u) => u.origin === aProvider.origin && u.pathname.startsWith('/jmap/download/'), mode === 'tail')
      const pending = settled(inline ? fetch(`${origin}${path}`, { method: mode === 'HEAD' ? 'HEAD' : 'GET' }) : a.call(path, mode === 'HEAD' ? 'HEAD' : 'GET', undefined, mode === 'range' ? { Range: 'bytes=0-27' } : {}))
      await arrived(g)
      let reading: Promise<Buffer> | null = null
      if (mode === 'tail') {
        const opened = await pending
        if (!opened.value) throw opened.error
        reading = collect(opened.value)
      }
      await change(a, kind, info.id); release(g)
      const result = await pending
      const bytes = reading ? await reading : result.value ? await collect(result.value) : Buffer.alloc(0)
      await drain()
      const valid = kind === 'none' || kind === 'other-logout'
      check(`attachment/${inline ? 'sealed' : 'cookie'}/${mode}/${kind}`, valid ? result.value?.status === (!inline && mode === 'range' ? 206 : 200) : !bytes.includes(secret) && (mode === 'tail' || !result.value || result.value.status >= 400) && (mode === 'tail' || !['content-disposition', 'content-range', 'etag', 'location'].some((h) => result.value?.headers.has(h))))
      if (!valid) check(`attachment/${inline ? 'sealed' : 'cookie'}/${mode}/${kind}: upstream aborted`, g.signals.length > 0 && g.signals.every((s) => s.aborted))
      if (!valid && mode === 'tail') check(`attachment/${inline ? 'sealed' : 'cookie'}/${mode}/${kind}: body cancelled`, g.cancelled)
    }
    // A sealed URL reused after revocation must fail before even discovering the provider.
    for (const kind of ['none', 'other-logout', ...changes] as Change[]) {
      const a = account(), info = await a.mail(), path = await inlinePath(a, info.id)
      await change(a, kind, info.id)
      const before = dispatch.length
      const r = await fetch(`${origin}${path}`), bytes = await collect(r)
      const valid = kind === 'none' || kind === 'other-logout'
      check(`inline/reused/${kind}: entry authority`, valid ? r.ok : r.status >= 400 && !bytes.includes(secret) && !dispatch.slice(before).some((d) => d.origin === aProvider.origin))
    }
  }
  if (!only || only === 'writes') {
    // Side effects must not dispatch after held authorization, even if the final response is 401.
    for (const operation of ['act', 'draft', 'send', 'upload', 'link']) for (const kind of ['logout', 'remove', 'ban', 'expire', 'revoke', ...(operation === 'link' ? [] : ['unlink', 'relink'])] as Change[]) {
      const a = account(), info = await a.mail()
      database().prepare('UPDATE jmap_accounts SET id = ? WHERE id = ?').run(100_000 + a.id, info.id)
      info.id = 100_000 + a.id
      const g = hold((u) => u.origin === aProvider.origin && u.pathname === '/jmap/session')
      delete [...aProvider.emails.values()][0].keywords.$seen
      const body = operation === 'act' ? { emailIds: [[...aProvider.emails.keys()][0]], op: 'seen' } : operation === 'link' ? { url: aProvider.sessionUrl, token: aProvider.token } : { subject: 'private-draft', text: 'private-body', to: [{ email: 'recipient@example.test' }] }
      const pending = settled(a.call(operation === 'link' ? '/api/mail/accounts' : `/api/mail/${info.id}/${operation}`, 'POST', body, operation === 'upload' ? { 'X-Mail-Upload': '1' } : {}))
      await arrived(g); gate = null; await change(a, kind, info.id)
      const before = dispatch.length, rows = database().prepare('SELECT * FROM jmap_accounts WHERE user_id = ?').all(a.id)
      const providerState = () => JSON.stringify({ emails: [...aProvider.emails], blobs: [...aProvider.blobs.keys()], submissions: aProvider.submissions })
      const kept = providerState()
      release(g); const r = await pending; if (r.value) await collect(r.value); await drain()
      check(`write/${operation}/${kind}: no provider write`, !dispatch.slice(before).some((d) => d.origin === aProvider.origin && d.method === 'POST'))
      check(`write/${operation}/${kind}: provider state unchanged`, providerState() === kept)
      check(`write/${operation}/${kind}: no link commit`, JSON.stringify(database().prepare('SELECT * FROM jmap_accounts WHERE user_id = ?').all(a.id)) === JSON.stringify(rows))
    }
  }
  if (!only || only === 'office') {
    for (const at of ['document', 'update-link', 'upload']) for (const kind of ['none', 'seafile', 'office', 'remove', 'ban']) {
      const a = account(); await a.sf(); await a.office()
      const config = await (await a.call(`/api/office/config?repo=${REPO}&p=/file.docx`)).json() as { config: { editorConfig: { callbackUrl: string } } }
      const callback = new URL(config.config.editorConfig.callbackUrl)
      const token = signJwt({ status: 2, url: `${officeOrigin}/document` }, 'office-secret')
      const g = hold((u) => u.origin === officeOrigin && (at === 'update-link' ? u.pathname.endsWith('/update-link/') : u.pathname === `/${at}`))
      const pending = settled(fetch(`${origin}${callback.pathname}${callback.search}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }))
      await arrived(g); gate = null
      if (kind === 'seafile') await a.sf('B')
      if (kind === 'office') await a.office() // same URL/secret still creates a new link identity
      if (kind === 'remove') await deleteUser(a.id)
      if (kind === 'ban') ban(a.id, 'mock')
      const before = officeLog.length
      release(g); const result = await pending
      const body = result.value ? await result.value.json() as { error?: number } : null
      check(`office/${at}/${kind}: stale save not accepted`, kind === 'none' ? body?.error === 0 : result.value?.status !== 200 || body?.error !== 0)
      if (kind !== 'none' && at !== 'upload') check(`office/${at}/${kind}: no later update/upload`, !officeLog.slice(before).some((p) => p === '/upload' || p.endsWith('/update-link/')))
      if (kind !== 'none') check(`office/${at}/${kind}: upstream aborted`, g.signals.length > 0 && g.signals.every((s) => s.aborted))
    }
    {
      const a = account(); await a.sf(); await a.office()
      const config = await (await a.call(`/api/office/config?repo=${REPO}&p=/file.docx`)).json() as { config: { editorConfig: { callbackUrl: string } } }
      const ticket = new URL(config.config.editorConfig.callbackUrl).searchParams.get('t')!
      check('office/restart: unchanged persisted links accept old ticket', (await restartCallback(ticket)).includes('"error":0'))
      await a.sf('B')
      const before = officeLog.length
      check('office/restart: replaced persisted link rejects old ticket', (await restartCallback(ticket)).includes('"error":1') && !officeLog.slice(before).some((p) => p === '/document' || p === '/upload' || p.endsWith('/update-link/')))
      // Legacy sealed tickets without link claims fail closed too.
      const legacy = encrypt(JSON.stringify({ u: a.id, r: REPO, p: '/file.docx', e: Date.now() + 86400_000 }))
      check('office/legacy ticket: missing link claims refused', (await restartCallback(legacy)).includes('"error":1'))
    }
  }
  await drain(); await new Promise((r) => setImmediate(r))
  check('all request lifetime registrations released', liveCount().connections === 0)
} finally {
  gate?.release(); globalThis.fetch = realFetch
  api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r()))
  officeMock.closeAllConnections(); await new Promise<void>((r) => officeMock.close(() => r()))
  await aProvider.close(); await bProvider.close()
  rmSync(scratch, { recursive: true, force: true })
}
finish()
