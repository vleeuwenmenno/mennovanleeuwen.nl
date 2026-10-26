// Two local DAV origins, deliberately reusable SQLite IDs, and held response boundaries. No real
// accounts or provider endpoints. Assertions cover dispatch credentials and committed effects.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMock, USER, PASSWORD } from './tasks-mock.ts'
import { check, finish } from './empires-harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mvlos-dav-link-'))
Object.assign(process.env, { DATA_DIR: scratch, ADMIN_GITHUB_IDS: Array.from({ length: 500 }, (_, i) => i + 1).join(','), NOTIFY_WATCH: 'off', MC_WATCH: 'off', GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' })
setTimeout(() => { console.error('FAIL DAV races timed out'); process.exit(1) }, 120_000).unref()
const realFetch = globalThis.fetch
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const response = (href: string, props: string) => `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
async function provider(name: string) {
  const tasks = await startMock()
  const cards = new Map([['/contacts/home/book/private.vcf', `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:private\r\nFN:${name} private contact\r\nEND:VCARD\r\n`]])
  const seen: { method: string; path: string; auth: string; body: string }[] = []
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://local').pathname
    let body = ''; for await (const chunk of req) body += chunk
    seen.push({ method: req.method!, path, auth: req.headers.authorization ?? '', body })
    const xml = (parts: string[]) => res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${parts.join('')}</d:multistatus>`)
    if (path.startsWith('/contacts') || path === '/.well-known/carddav') {
      if (req.method === 'PROPFIND') {
        if (path === '/contacts/' || path === '/.well-known/carddav') return xml([response(path, '<d:current-user-principal><d:href>/contacts/principal/</d:href></d:current-user-principal>')])
        if (path === '/contacts/principal/') return xml([response(path, '<card:addressbook-home-set><d:href>/contacts/home/</d:href></card:addressbook-home-set>')])
        if (path === '/contacts/home/') return xml([response('/contacts/home/book/', `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>${name} addressbook</d:displayname>`)])
        return xml([...cards].map(([href]) => response(href, '<d:resourcetype/><d:getetag>&quot;one&quot;</d:getetag>')))
      }
      if (req.method === 'REPORT') return xml([...cards].map(([href, text]) => response(href, `<d:getetag>&quot;one&quot;</d:getetag><card:address-data>${esc(text)}</card:address-data>`)))
      if (path.endsWith('/photo')) return res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: '"private-photo"' }).end(`${name} private photo`)
      if (req.method === 'GET') return res.writeHead(cards.has(path) ? 200 : 404, { ETag: '"one"' }).end(cards.get(path))
      if (req.method === 'PUT') { cards.set(path, body); return res.writeHead(201, { ETag: '"one"' }).end() }
      if (req.method === 'DELETE') { cards.delete(path); return res.writeHead(204).end() }
      return res.writeHead(405).end()
    }
    // Preserve the caller's Authorization in this origin's log, then adapt to the existing mock.
    const upstream = await realFetch(`${tasks.origin}${req.url}`, { method: req.method, headers: { ...Object.fromEntries(Object.entries(req.headers).filter(([k, v]) => typeof v === 'string' && !['authorization', 'host', 'connection'].includes(k))) as Record<string, string>, Authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`, host: new URL(tasks.origin).host }, body: body || undefined })
    const bytes = Buffer.from(await upstream.arrayBuffer())
    const headers = new Headers(upstream.headers); headers.delete('transfer-encoding'); headers.delete('content-length')
    res.writeHead(upstream.status, Object.fromEntries(headers)).end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { name, origin, seen, cards, tasks, close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await tasks.close() } }
}
const x = await provider('X'), y = await provider('Y')
type Gate = { body: boolean; match: (url: URL, init?: RequestInit) => boolean; arrived: Promise<void>; hit: () => void; wait: Promise<void>; release: () => void; signals: AbortSignal[] }
let gate: Gate | null = null
function hold(match: Gate['match'], body = false) {
  let hit!: () => void, release!: () => void
  const arrived = new Promise<void>((r) => { hit = r }), wait = new Promise<void>((r) => { release = r })
  return gate = { body, match, arrived, hit, wait, release, signals: [] }
}
function release(g: Gate) { if (gate === g) gate = null; g.release() }
async function arrived(g: Gate) { await Promise.race([g.arrived, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('DAV gate not reached')), 5000).unref(); void g.arrived.then(() => clearTimeout(timer)) })]) }
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (![x.origin, y.origin].includes(url.origin)) throw new Error(`Non-local provider dispatch refused: ${url.origin}`)
  const current = gate, res = await realFetch(input, init)
  if (current?.match(url, init)) {
    if (init?.signal) current.signals.push(init.signal)
    if (current.body) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      let part = 0
      return new Response(new ReadableStream({
        async pull(out) {
          if (part++ === 0) return out.enqueue(bytes.subarray(0, 3))
          if (part === 2) { current.hit(); await current.wait; out.enqueue(bytes.subarray(3)); return }
          out.close()
        },
      }, { highWaterMark: 0 }), { status: res.status, headers: res.headers })
    }
    current.hit(); await current.wait
  }
  return res
}
const { database, encrypt, sha256 } = await import('../server/db.ts')
const { accounts } = await import('../server/auth.ts')
const caldav = await import('../server/caldav.ts')
const carddav = await import('../server/carddav.ts')
const tasks = await import('../server/tasks.ts')
const contacts = await import('../server/contacts.ts')
const { handleApi } = await import('../server/api.ts')
const { deleteUser } = await import('../server/users.ts')
const sharedDav = await import('../server/dav.ts')
const { withPrivateOperation } = await import('../server/privateRequest.ts')
const active = new Set<Promise<unknown>>()
const apiServer = createServer((req, res) => {
  const work = handleApi(req, res).then((ok) => { if (!ok) res.writeHead(404).end() }).catch(() => res.destroy())
  active.add(work); void work.finally(() => active.delete(work))
})
await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`
let nextId = 0
function account() {
  const id = ++nextId, sid = randomBytes(24).toString('hex'), now = Date.now()
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `dav-user-${id}`, encrypt('fixture'), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + 86400_000)
  const user = () => accounts().find((a) => a.id === id)!
  const call = (path: string, method = 'GET', body?: unknown) => realFetch(`${origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, 'X-MVL-Account': String(id), Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { id, sid, user, call }
}
type Account = ReturnType<typeof account>
async function linked(a: Account, p: typeof x, kind: 'tasks' | 'contacts') {
  const body = { url: `${p.origin}${kind === 'tasks' ? '/' : '/contacts/'}`, username: `user${p.name}`, password: `pass${p.name}` }
  return kind === 'tasks' ? caldav.addCaldav(a.user(), body) : carddav.addCarddav(a.user(), body)
}
const result = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }))
let credentialStart = 0
const noYatX = () => !x.seen.slice(credentialStart).some((r) => r.auth === `Basic ${Buffer.from('userY:passY').toString('base64')}`)
async function drop(a: Account, kind: 'tasks' | 'contacts', id: number) { if (kind === 'tasks') caldav.removeCaldav(a.user(), id); else carddav.removeCarddav(a.user(), id) }
async function drain() { while (active.size) await Promise.all([...active]) }

try {
  // A settled Tasks cache must not be combined with a replacement account's credentials.
  for (const operation of ['read', 'create', 'update', 'delete', 'move', 'order', 'rename-list', 'delete-list'] as const) {
    const saved = new Map([...x.tasks.collections].map(([k, v]) => [k, { ...v, objects: new Map([...v.objects].map(([h, o]) => [h, { ...o }])) }]))
    const a = account(), old = await linked(a, x, 'tasks'), before = await tasks.allTasks(a.user())
    const list = before.lists.find((l) => l.name === 'Reminders')!, task = before.tasks.find((t) => t.list === list.id)!
    const local = await tasks.createList(a.user(), { account: 'local', name: 'Destination' })
    // createList invalidates caches; prime again immediately before unlink.
    await tasks.allTasks(a.user())
    await drop(a, 'tasks', old.id)
    const replacement = await linked(a, y, 'tasks')
    check(`Tasks ${operation}: SQLite ID reused`, old.id === replacement.id)
    credentialStart = x.seen.length
    const count = x.seen.length, snapshot = JSON.stringify([...x.tasks.collections].map(([k, v]) => [k, [...v.objects]]))
    let outcome: { value: unknown; error: unknown }
    if (operation === 'read') outcome = await result(tasks.allTasks(a.user()))
    else if (operation === 'create') outcome = await result(tasks.createTask(a.user(), { list: list.id, task: { title: 'Stale write' } }))
    else if (operation === 'update') outcome = await result(tasks.updateTask(a.user(), { ref: task.ref, task: { title: 'Stale edit' } }))
    else if (operation === 'delete') outcome = await result(tasks.deleteTask(a.user(), { ref: task.ref }))
    else if (operation === 'move') outcome = await result(tasks.updateTask(a.user(), { ref: task.ref, list: local.id, task: {} }))
    else if (operation === 'order') outcome = await result(tasks.orderTasks(a.user(), { list: list.id, refs: [task.ref], moved: task.ref }))
    else if (operation === 'rename-list') outcome = await result(tasks.updateList(a.user(), { id: list.id, name: 'Stale name' }))
    else outcome = await result(tasks.deleteList(a.user(), { id: list.id }))
    check(`Tasks ${operation}: no request to old X origin`, x.seen.length === count)
    check(`Tasks ${operation}: Y credentials never reach X`, noYatX())
    check(`Tasks ${operation}: X objects unchanged`, snapshot === JSON.stringify([...x.tasks.collections].map(([k, v]) => [k, [...v.objects]])))
    if (operation === 'read') check('Tasks read excludes old X list', !JSON.stringify(outcome.value).includes(x.origin))
    else check(`Tasks ${operation}: stale handle rejected`, !!outcome.error)
    if (operation === 'move') check('Tasks move has no local copy', !(await tasks.allTasks(a.user())).tasks.some((t) => t.list === local.id))
    await deleteUser(a.id)
    x.tasks.collections.clear(); for (const [k, v] of saved) x.tasks.collections.set(k, v)
  }

  // Old AddressBooks retain the discovering account, including direct low-level callers.
  for (const operation of ['list', 'get', 'photo', 'put', 'delete'] as const) {
    const a = account(), old = await linked(a, x, 'contacts')
    const book = (await carddav.carddavBooks(a.user())).books[0]!, href = `${book.href}private.vcf`
    const original = x.cards.get('/contacts/home/book/private.vcf')!
    await drop(a, 'contacts', old.id)
    const replacement = await linked(a, y, 'contacts')
    check(`CardDAV ${operation}: SQLite ID reused`, replacement.id === old.id)
    credentialStart = x.seen.length
    const count = x.seen.length
    const outcome = await result(operation === 'list' ? carddav.bookCards(a.user(), book, 0) : operation === 'get' ? carddav.getCard(a.user(), book, href) : operation === 'photo' ? carddav.fetchPhoto(a.user(), book, `${book.href}photo`) : operation === 'put' ? carddav.putCard(a.user(), book, href, ['BEGIN:VCARD', 'VERSION:3.0', 'UID:private', 'FN:Stale', 'END:VCARD'], 'new') : carddav.deleteCard(a.user(), book, href))
    check(`CardDAV ${operation}: stale book rejected`, !!outcome.error)
    check(`CardDAV ${operation}: no old-origin dispatch`, x.seen.length === count)
    check(`CardDAV ${operation}: Y credentials never reach X`, noYatX())
    check(`CardDAV ${operation}: stored card unchanged`, x.cards.get('/contacts/home/book/private.vcf') === original)
    x.cards.set('/contacts/home/book/private.vcf', original)
    await deleteUser(a.id)
  }

  // Setup discovery is also a captured operation: removal while absent, or a successful
  // concurrent replacement, cannot let a late candidate add credentials back afterward.
  for (const mutation of ['absent-remove', 'replace'] as const) {
    const a = account()
    const g = hold((url, init) => url.origin === x.origin && init?.method === 'PROPFIND' && url.pathname === '/contacts/home/')
    const pending = result(linked(a, x, 'contacts')); await arrived(g)
    carddav.removeCarddav(a.user(), 99999)
    if (mutation === 'replace') { gate = null; await linked(a, y, 'contacts') }
    release(g)
    check(`CardDAV setup ${mutation}: late candidate rejected`, !!(await pending).error)
    const current = carddav.listCarddav(a.user())
    check(`CardDAV setup ${mutation}: no X credential committed`, !current.some((c) => c.url.startsWith(x.origin)))
    check(`CardDAV setup ${mutation}: replacement preserved`, current.length === (mutation === 'replace' ? 1 : 0))
    await deleteUser(a.id)
  }

  // A retained handle cannot be used by a different MvL owner after deletion and row reuse.
  {
    const a = account(), old = await linked(a, x, 'contacts'), book = (await carddav.carddavBooks(a.user())).books[0]!
    await deleteUser(a.id)
    const b = account(), replacement = await linked(b, y, 'contacts'), count = x.seen.length
    check('CardDAV cross-owner: SQLite ID reused', old.id === replacement.id)
    check('CardDAV cross-owner: old book rejected', !!(await result(carddav.bookCards(b.user(), book, 0))).error)
    check('CardDAV cross-owner: no request to X', x.seen.length === count)
    await deleteUser(b.id)
  }

  // Discovery and aggregate results held across unlink/relink, including same-owner/same-URL
  // replacement. The real API keeps the generation bound through response serialization.
  for (const kind of ['tasks', 'contacts'] as const) for (const mutation of ['unlink', 'relink', 'replace', 'remove'] as const) {
    const a = account(), old = await linked(a, x, kind)
    const g = hold((url, init) => url.origin === x.origin && init?.method === 'PROPFIND' && url.pathname === (kind === 'tasks' ? '/cal/mock/' : '/contacts/home/'))
    const pending = result(a.call(kind === 'tasks' ? '/api/tasks' : '/api/contacts').then(async (r) => ({ status: r.status, text: await r.text() })))
    await arrived(g)
    if (mutation === 'remove') await deleteUser(a.id)
    else {
      if (mutation !== 'replace') await drop(a, kind, old.id)
      if (mutation === 'relink') await linked(a, y, kind)
      if (mutation === 'replace') {
        // The held discovery gate must only intercept the original request.
        gate = null; await linked(a, x, kind)
      }
    }
    check(`${kind} held ${mutation}: upstream aborted`, g.signals.every((s) => s.aborted) && g.signals.length > 0)
    release(g)
    const outcome = await pending
    check(`${kind} held ${mutation}: no stale response`, !outcome.value || outcome.value.status !== 200 && !outcome.value.text.includes(kind === 'tasks' ? 'Water the plants' : 'X private contact'))
    await drain()
    if (mutation !== 'remove') {
      const fresh = kind === 'tasks' ? await tasks.allTasks(a.user()) : await contacts.listContacts(a.user(), false)
      if (mutation !== 'replace') check(`${kind} held ${mutation}: late loader cannot publish X`, !JSON.stringify(fresh).includes(x.origin) && !JSON.stringify(fresh).includes('X private contact'))
      await deleteUser(a.id)
    }
  }

  // Held authorization discovery must prevent the subsequent mutation itself, including moves
  // into a local destination. Check provider and local DB state, not just the final HTTP status.
  for (const kind of ['tasks', 'contacts'] as const) for (const action of ['create', 'edit', 'delete', 'move', 'import'] as const) {
    if (kind === 'tasks' && action === 'import') continue
    const savedCards = new Map(x.cards)
    const a = account(), old = await linked(a, x, kind)
    let work: () => Promise<unknown>
    if (kind === 'tasks') {
      const all = await tasks.allTasks(a.user()), task = all.tasks[0]!, list = all.lists.find((l) => l.id === task.list)!
      const local = await tasks.createList(a.user(), { account: 'local', name: 'Destination' })
      work = () => action === 'create' ? tasks.createTask(a.user(), { list: list.id, task: { title: 'Held stale task' } }) : action === 'edit' ? tasks.updateTask(a.user(), { ref: task.ref, task: { title: 'Held stale edit' } }) : action === 'delete' ? tasks.deleteTask(a.user(), { ref: task.ref }) : tasks.updateTask(a.user(), { ref: task.ref, list: local.id, task: {} })
    } else {
      const all = await contacts.listContacts(a.user(), false), contact = all.contacts[0]!, book = all.books.find((b) => b.id === contact.book)!
      carddav.clearCarddavCache(a.user())
      work = () => action === 'create' ? contacts.createContact(a.user(), { book: book.id, fields: { fn: 'Held stale contact' } }) : action === 'edit' ? contacts.updateContact(a.user(), { id: contact.id, base: { fn: contact.fn }, fields: { fn: 'Held stale edit' } }) : action === 'delete' ? contacts.deleteContact(a.user(), { id: contact.id }) : action === 'move' ? contacts.moveContact(a.user(), { id: contact.id, book: 'local' }) : contacts.importCards(a.user(), { book: book.id, text: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:held\r\nFN:Held stale import\r\nEND:VCARD\r\n' })
    }
    const g = hold((url, init) => url.origin === x.origin && init?.method === 'PROPFIND' && url.pathname === (kind === 'tasks' ? '/cal/mock/' : '/contacts/home/'))
    const pending = result(work()); await arrived(g)
    await drop(a, kind, old.id); gate = null; await linked(a, y, kind)
    const count = x.seen.length
    release(g)
    const outcome = await pending
    check(`${kind} held ${action}: rejects stale operation`, !!outcome.error)
    check(`${kind} held ${action}: no later X dispatch/effect`, x.seen.length === count)
    const localCount = database().prepare(kind === 'tasks' ? 'SELECT COUNT(*) AS n FROM task_items WHERE list_id IN (SELECT id FROM task_lists WHERE user_id = ?)'  : 'SELECT COUNT(*) AS n FROM contacts_local WHERE user_id = ?').get(a.id) as { n: number }
    check(`${kind} held ${action}: local DB unchanged`, localCount.n === 0)
    await deleteUser(a.id)
    x.cards.clear(); for (const [href, card] of savedCards) x.cards.set(href, card)
  }

  // Body checks survive a helper returning Response, and protect buffered photo metadata too.
  for (const kind of ['tasks', 'contacts'] as const) for (const mutation of ['unlink', 'relink'] as const) {
    const a = account(), old = await linked(a, x, kind)
    const book = kind === 'contacts' ? (await carddav.carddavBooks(a.user())).books[0]! : null
    const g = hold((url, init) => url.origin === x.origin && init?.method === 'GET', true)
    const pending = result(kind === 'contacts' ? carddav.fetchPhoto(a.user(), book!, `${book!.href}photo`) : caldav.davRequest(caldav.caldavAccounts(a.user())[0]!, 'GET', `${x.origin}/cal/mock/tasks/seed-1.ics`).then((r) => r.text()))
    await arrived(g); await drop(a, kind, old.id)
    if (mutation === 'relink') { gate = null; await linked(a, y, kind) }
    release(g)
    check(`${kind} body ${mutation}: no stale result`, !!(await pending).error)
    check(`${kind} body ${mutation}: upstream aborted`, g.signals.length > 0 && g.signals.every((s) => s.aborted))
    await deleteUser(a.id)
  }

  // Shared transport subscriptions must end on discarded write/error bodies and cancellation,
  // even if a caller never consumes a returned successful body.
  {
    const a = account()
    let subscribed = 0
    const login = { user: a.user(), username: 'userX', password: 'passX', authority: { key: 'transport-cleanup', check() {}, subscribe() { subscribed++; return () => { subscribed-- } } } }
    await sharedDav.davRequest(login, 'PUT', `${x.origin}/contacts/cleanup.vcf`, { body: 'cleanup' })
    check('DAV write discard releases subscription', subscribed === 0)
    const refused = await sharedDav.davRequest(login, 'GET', `${x.origin}/contacts/missing.vcf`)
    check('DAV error discard releases subscription', refused.status === 404 && subscribed === 0)
    const stop = new AbortController()
    await result(withPrivateOperation(async () => {
      await sharedDav.davRequest(login, 'GET', `${x.origin}/contacts/home/book/photo`)
      stop.abort(new Error('mock session cancelled'))
      await new Promise<void>((r) => setImmediate(r))
      check('DAV abandoned body cancellation releases transport subscription', subscribed === 1) // enclosing operation still owns one
    }, stop.signal))
    check('DAV operation releases retained subscription', subscribed === 0)
    await deleteUser(a.id)
  }

  // Reminder cache must discard old provider data before a later minute becomes due.
  for (const mutation of ['unlink', 'relink', 'remove'] as const) {
    const a = account(), old = await linked(a, x, 'tasks'), all = await tasks.allTasks(a.user())
    const list = all.lists.find((l) => l.name === 'Reminders')!, now = Date.now()
    const created = await tasks.createTask(a.user(), { list: list.id, task: { title: `X reminder ${a.id}`, due: new Date(now + 60_000).toISOString(), alarms: [new Date(now + 60_000).toISOString()] } })
    await tasks.taskReminders(now)
    if (mutation === 'remove') await deleteUser(a.id)
    else { await drop(a, 'tasks', old.id); if (mutation === 'relink') await linked(a, y, 'tasks') }
    await tasks.taskReminders(now + 61_000)
    const sent = database().prepare("SELECT title FROM notifications WHERE user_id = ? AND source = 'tasks.due' AND title = ?").all(a.id, `X reminder ${a.id}`)
    check(`Tasks reminder ${mutation}: no X title notification`, sent.length === 0)
    // Remove only this test's provider object, without involving replacement credentials.
    x.tasks.collections.get('/cal/mock/tasks/')?.objects.delete(`/cal/mock/tasks/${created.uid}.ics`)
    if (mutation !== 'remove') await deleteUser(a.id)
  }

  // Enclosing agent/PIM operations keep link authority after one helper finishes.
  for (const kind of ['tasks', 'contacts'] as const) {
    const a = account(), old = await linked(a, x, kind)
    let hit!: () => void, release!: () => void
    const arrived = new Promise<void>((r) => { hit = r }), wait = new Promise<void>((r) => { release = r })
    const pending = result(withPrivateOperation(async () => {
      const data = kind === 'tasks' ? await tasks.allTasks(a.user()) : await contacts.listContacts(a.user(), false)
      hit(); await wait
      // Local effects based on stale remote data are rejected too.
      database().prepare('INSERT INTO task_lists (user_id, name, color, created_at) VALUES (?, ?, ?, ?)').run(a.id, 'Stale aggregate copy', '#7aa2f7', Date.now())
      return data
    }))
    await arrived; await drop(a, kind, old.id); release()
    check(`${kind} agent aggregate: rejects completed helper data`, !!(await pending).error)
    check(`${kind} agent aggregate: no local commit`, !database().prepare("SELECT 1 FROM task_lists WHERE user_id = ? AND name = 'Stale aggregate copy'").get(a.id))
    await deleteUser(a.id)
  }
} finally {
  if (gate) release(gate)
  await drain()
  globalThis.fetch = realFetch
  apiServer.closeAllConnections(); await new Promise<void>((r) => apiServer.close(() => r()))
  await Promise.all([x.close(), y.close()])
  rmSync(scratch, { recursive: true, force: true })
}
finish()
