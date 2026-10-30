// Checks that one account's state never reaches another, when tabs of one browser sign out, in or
// as someone else (src/os/accountSpace.ts, src/os/account.ts, src/os/synced.ts, server/auth.ts):
//
//   1. The real server (server/index.ts on a free port, scratch DATA_DIR, two signed-in test
//      accounts): requests say whose state their page holds (X-MvL-Account); a page of another
//      account is refused, synced state and notifications can't be written without saying, and
//      the account id cookie (mvlos_uid) is set and cleared with the session.
//   2. Tabs in memory: each tab is its own copy of the page's modules in a stand-in window; the
//      tabs share a stand-in localStorage (a write in one tab is a `storage` event in the others)
//      and one cookie jar, and talk to a stand-in of the same server rules. Covers a tab running
//      the release before account spaces, a tab starting while the account changes, stale saves,
//      pushes and notifications, terminal history, a session that ran out, storage that is full
//      or blocked, moving the old keys in, and a visitor signing in.
//
//   node scripts/sync-accounts-check.ts
//
// Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Server, check, finish, sleep } from './empires-harness.ts'

// The app's modules import each other without extensions (Vite finds them): so does this. A module
// loaded for a tab (`?tab=N`) gets that tab's own copies of the app's modules it imports.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
      const url = new URL(/\.[cm]?[jt]sx?$/.test(specifier) ? specifier : `${specifier}.ts`, context.parentURL)
      const tab = /[?&]tab=\d+/.exec(context.parentURL)?.[0].slice(1)
      if (tab) url.search = `?${tab}`
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

const realFetch = globalThis.fetch

// --- 1. the real server -------------------------------------------------------------------------
{
  const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '999999' })
  process.env.DATA_DIR = server.data
  const { database, encrypt, sha256 } = await import('../server/db.ts')
  const now = Date.now()
  const sids: Record<number, string> = {}
  for (const id of [1, 2]) {
    database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `acct-${id}`, encrypt('none'), now, now)
    sids[id] = randomBytes(24).toString('hex')
    database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sids[id]), id, now, now + 86400_000)
  }
  const expired = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(expired), now - 2000, now - 1000)
  await server.start()
  const req = (path: string, opts: { sid?: string; held?: string; method?: string; json?: unknown; uid?: string } = {}) =>
    realFetch(`${server.origin}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Cookie: [opts.sid ? `mvlos_sid=${opts.sid}` : '', opts.uid ? `mvlos_uid=${opts.uid}` : ''].filter(Boolean).join('; '),
        Origin: server.origin,
        'Content-Type': 'application/json',
        ...(opts.held !== undefined ? { 'X-MvL-Account': opts.held } : {}),
      },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    })
  const put = (sid: string, held: string | undefined, value: unknown) => req('/api/state/notes', { sid, held, method: 'PUT', json: { value, base: 0 } })
  const stateOf = async (id: number) => (await (await req('/api/state', { sid: sids[id], held: String(id) })).json()) as Record<string, { value: unknown }>

  // Finding 1: a page from the release before (no header) can't write or read synced state.
  check('server: a PUT of synced state without X-MvL-Account is refused (409)', (await put(sids[2], undefined, ['account-1-private'])).status === 409)
  check('server: a GET of synced state without it too', (await req('/api/state', { sid: sids[2] })).status === 409)
  check('server: and a notification without it', (await req('/api/notifications', { sid: sids[2], method: 'POST', json: { source: 'calendar.reminder', title: 'secret.pdf uploaded' } })).status === 409)
  // A page of account 1 under account 2's cookie: refused anywhere.
  check('server: a PUT from a page of account 1 under account 2’s session is refused', (await put(sids[2], '1', ['account-1-private'])).status === 409)
  check('server: a notification from it too', (await req('/api/notifications', { sid: sids[2], held: '1', method: 'POST', json: { source: 'calendar.reminder', title: 'secret.pdf uploaded' } })).status === 409)
  check('server: and any other request from it (deleting the account, say)', (await req('/api/me', { sid: sids[2], held: '1', method: 'DELETE' })).status === 409)
  check('server: a visitor’s page under a session is refused', (await put(sids[2], 'visitor', ['x'])).status === 409)
  check('server: nothing of account 1 reached account 2', !JSON.stringify(await stateOf(2)).includes('account-1'))
  // The page of the session's own account goes through.
  check('server: account 2’s own page saves', (await put(sids[2], '2', ['account-2-own'])).status === 200 && JSON.stringify(await stateOf(2)).includes('account-2-own'))
  check('server: and sends notifications', (await req('/api/notifications', { sid: sids[2], held: '2', method: 'POST', json: { source: 'calendar.reminder', title: 'done' } })).status === 200)
  // Browser caches: an account-scoped response must never be reusable by another session.
  const threadId = '00000000-0000-4000-8000-000000000001'
  database().prepare('INSERT INTO agent_threads (id, user_id, title, mode, model, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)').run(threadId, 't', 'ask', 'm', now, now)
  const attachments = JSON.stringify([{ kind: 'image', mime: 'image/png', name: 'a.png', data: Buffer.from('account-1-bytes').toString('base64') }])
  const msg = Number(database().prepare('INSERT INTO agent_messages (thread_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)').run(threadId, 'user', 'hi', attachments, now).lastInsertRowid)
  const pic = `/api/agents/threads/${threadId}/messages/${msg}/attachments/0`
  const own = await req(pic, { sid: sids[1], held: '1' })
  check('cache: the owner’s agent attachment is served', own.status === 200 && (await own.text()) === 'account-1-bytes')
  check('cache: and is never stored by the browser (private, no-store)', own.headers.get('cache-control') === 'private, no-store')
  check('cache: account 2 can’t fetch it (404)', (await req(pic, { sid: sids[2], held: '2' })).status === 404)
  check('cache: nor without a session (401)', (await req(pic)).status === 401)
  // Source invariant: no auth-gated handler may let the browser reuse a response without asking.
  const SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url))
  const allowed = new Set(['shares.ts']) // token-addressed public share page, not account-scoped
  const leaks = readdirSync(SERVER_DIR).filter((f) => f.endsWith('.ts') && !allowed.has(f)).filter((f) => /private,\s*max-age/.test(readFileSync(SERVER_DIR + f, 'utf8')))
  check(`cache: no server file sets "private, max-age" (${leaks.join(', ') || 'none'})`, leaks.length === 0)
  // The account id cookie: set for the session's account, cleared without a valid session.
  const setCookies = (r: Response) => r.headers.getSetCookie().join('\n')
  let r = await req('/api/me', { sid: sids[1] })
  check('server: /api/me sets mvlos_uid for a session from before the cookie', /mvlos_uid=1;/.test(setCookies(r)) && !/HttpOnly/.test(setCookies(r).split('\n').find((c) => c.startsWith('mvlos_uid'))!))
  r = await req('/api/me', { sid: sids[1], uid: '1' })
  check('server: and leaves it alone when it is right', !setCookies(r).includes('mvlos_uid'))
  r = await req('/api/me', { sid: expired, uid: '1' })
  check('server: a session that ran out clears it', /mvlos_uid=;.*Max-Age=0/.test(setCookies(r)) && ((await r.json()) as { user: unknown }).user === null)
  r = await req('/api/forges', { uid: '1', held: 'visitor', method: 'POST', json: {} })
  check('server: so does any request that finds no session (401)', r.status === 401 && /mvlos_uid=;.*Max-Age=0/.test(setCookies(r)))
  r = await req('/api/auth/logout', { sid: sids[1], uid: '1', held: '1', method: 'POST' })
  check('server: signing out clears it', /mvlos_uid=;.*Max-Age=0/.test(setCookies(r)))
  // Every change needs the header (a few exceptions), and so does the notification stream.
  check('server: any change without the header is refused (adding a code host)', (await req('/api/forges', { sid: sids[2], method: 'POST', json: {} })).status === 409)
  check('server: the notification stream without it is refused', (await req('/api/notifications/stream?page=x', { sid: sids[2] })).status === 409)
  check('server: reading the notification list without it is not', (await req('/api/notifications', { sid: sids[2] })).status === 200)
  check('server: the service worker renewing its push subscription (no header) is let through', (await req('/api/push/subscription', { sid: sids[2], method: 'POST', json: {} })).status === 400)

  // Admin follows GitHub's immutable id (ADMIN_GITHUB_IDS), never the login.
  const addUser = (id: number, githubId: number, login: string) => {
    database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, githubId, login, encrypt('none'), now, now)
    sids[id] = randomBytes(24).toString('hex')
    database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sids[id]), id, now, now + 86400_000)
  }
  addUser(3, 999999, 'configured-owner')
  addUser(4, 777, 'vleeuwenmenno')
  check('admin: a login named like the old default owner, with another github id, is refused (403)', (await req('/api/admin/stats', { sid: sids[4], held: '4' })).status === 403)
  check('admin: the configured github id is admin', (await req('/api/admin/stats', { sid: sids[3], held: '3' })).status === 200)
  database().prepare("UPDATE users SET login = 'renamed-owner' WHERE id = 3").run()
  check('admin: and stays admin after its login is renamed', (await req('/api/admin/stats', { sid: sids[3], held: '3' })).status === 200)
  database().prepare("UPDATE users SET login = 'vleeuwenmenno' WHERE id = 3").run()
  database().prepare("UPDATE users SET login = 'someone-new' WHERE id = 4").run()
  check('admin: a login rename never changes who is admin', (await req('/api/admin/stats', { sid: sids[4], held: '4' })).status === 403)

  // Sign-in scopes: a link can't pick them; the signed-in account's POST is used once, by that account.
  const login = (opts: { sid?: string; cookie?: string; query?: string } = {}) =>
    realFetch(`${server.origin}/api/auth/github/login${opts.query ?? ''}`, { redirect: 'manual', headers: { Cookie: [opts.sid ? `mvlos_sid=${opts.sid}` : '', opts.cookie ?? ''].filter(Boolean).join('; ') } })
  const scopeOf = (r: Response) => new URL(r.headers.get('location')!).searchParams.get('scope')
  let l = await login({ query: '?repo=1' })
  check('scope: an anonymous login?repo=1 asks for read:user only', scopeOf(l) === 'read:user')
  check('scope: and leaves no repo cookie behind', !l.headers.getSetCookie().some((c) => /mvlos_gh_(repo|scope)=[^;]/.test(c)))
  l = await login({ sid: sids[2], query: '?repo=1' })
  check('scope: even a signed-in login?repo=1 is ignored', scopeOf(l) === 'read:user')
  const post = (sid: string, held: string, json: unknown = { repo: true }) => req('/api/auth/github/scope', { sid, held, method: 'POST', json })
  check('scope: the POST needs the account header (409)', (await req('/api/auth/github/scope', { sid: sids[2], method: 'POST', json: { repo: true } })).status === 409)
  check('scope: and a session (401)', (await req('/api/auth/github/scope', { held: 'visitor', method: 'POST', json: { repo: true } })).status === 401)
  check('scope: and a boolean (400)', (await post(sids[2], '2', { repo: 'yes' })).status === 400)
  const chosen = await post(sids[2], '2')
  const scopeCookie = chosen.headers.getSetCookie().find((c) => c.startsWith('mvlos_gh_scope='))!
  check('scope: the POST sets a short-lived HttpOnly cookie', chosen.status === 200 && /HttpOnly/.test(scopeCookie) && /Max-Age=600\b/.test(scopeCookie) && /Path=\/api\/auth/.test(scopeCookie))
  const pair = scopeCookie.split(';')[0]
  l = await login({ sid: sids[2], cookie: pair })
  check('scope: the same account’s next login asks for repo', scopeOf(l)?.includes('repo') === true)
  check('scope: and clears the cookie (one time)', l.headers.getSetCookie().some((c) => /^mvlos_gh_scope=;.*Max-Age=0/.test(c)))
  l = await login({ sid: sids[1], cookie: pair })
  check('scope: another account can’t inherit it', scopeOf(l) === 'read:user' && l.headers.getSetCookie().some((c) => /^mvlos_gh_scope=;.*Max-Age=0/.test(c)))
  l = await login({ cookie: pair })
  check('scope: nor a visitor', scopeOf(l) === 'read:user')
  l = await login({ sid: sids[2], cookie: 'mvlos_gh_repo=1' })
  check('scope: the old sticky cookie is ignored and cleared', scopeOf(l) === 'read:user' && l.headers.getSetCookie().some((c) => /^mvlos_gh_repo=;.*Max-Age=0/.test(c)))

  // Push: a subscription belongs to the session that sent it.
  const { liveSubscriptions } = await import('../server/webpush.ts')
  const subscription = (n: number) => ({
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/check-${n}`, keys: { p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') } },
    device: 'check',
  })
  const subscribe = (sid: string, held: string, n: number) => req('/api/push/subscription', { sid, held, method: 'POST', json: subscription(n) })
  const live = (id: number) => liveSubscriptions(id).map((r: { endpoint: string }) => r.endpoint.split('-').pop())
  const s1b = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(s1b), now, now + 86400_000)
  const s1c = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(s1c), now, now + 86400_000)
  check('push: two devices of account 1 subscribe', (await subscribe(s1b, '1', 1)).status === 200 && (await subscribe(s1c, '1', 2)).status === 200 && live(1).sort().join() === '1,2')
  check('push: each is tied to its session', (database().prepare('SELECT session_id FROM push_subscriptions WHERE endpoint LIKE ?').get('%check-1') as { session_id: string }).session_id === sha256(s1b))
  await req('/api/auth/logout', { sid: s1b, held: '1', method: 'POST' })
  check('push: signing out removes that device’s subscription', live(1).join() === '2' && !database().prepare('SELECT 1 FROM push_subscriptions WHERE endpoint LIKE ?').get('%check-1'))
  database().prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now - 1, sha256(s1c))
  check('push: a session that ran out gets nothing, and its subscription goes', live(1).length === 0 && !database().prepare('SELECT 1 FROM push_subscriptions WHERE endpoint LIKE ?').get('%check-2'))
  // Account 2 signs in on a device account 1 subscribed: the subscription is account 2's now.
  const s1d = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(s1d), now, now + 86400_000)
  await subscribe(s1d, '1', 3)
  await subscribe(sids[2], '2', 3)
  check('push: another account sending the same subscription takes it over', live(1).length === 0 && live(2).join() === '3')
  database().prepare('INSERT INTO push_subscriptions (user_id, endpoint, keys, device, created_at) VALUES (1, ?, ?, NULL, ?)').run('https://fcm.googleapis.com/fcm/send/check-4', 'x', now)
  check('push: a subscription from before sessions (none tied) gets nothing', !live(1).includes('4'))
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sids[1]), now, now + 86400_000)

  // Empires: a kept token only brings back a player of the same account.
  const ws = (sid: string | null) =>
    new Promise<{ send: (m: unknown) => void; next: (t: string[]) => Promise<Record<string, unknown>>; close: () => void }>((resolve) => {
      const sock = new WebSocket(server.url, { headers: { Origin: server.origin, ...(sid ? { Cookie: `mvlos_sid=${sid}` } : {}) } } as never)
      const inbox: Record<string, unknown>[] = []
      const waiting: (() => void)[] = []
      sock.onmessage = (e) => (inbox.push(JSON.parse(String(e.data))), waiting.splice(0).forEach((f) => f()))
      sock.onopen = () =>
        resolve({
          send: (m) => sock.send(JSON.stringify(m)),
          next: async (types) => {
            for (let i = 0; i < 100; i++) {
              const at = inbox.findIndex((m) => types.includes(m.t as string))
              if (at >= 0) return inbox.splice(at, 1)[0]
              await new Promise<void>((r) => (waiting.push(r), setTimeout(r, 50)))
            }
            throw new Error(`no ${types.join('/')}`)
          },
          close: () => sock.close(),
        })
    })
  const { PROTOCOL } = await import('../src/apps/games/empires/protocol.ts')
  const a1 = await ws(sids[1])
  a1.send({ t: 'hello', v: PROTOCOL })
  await a1.next(['ready'])
  a1.send({ t: 'claim', name: 'Acctone' })
  const token = (await a1.next(['welcome'])).token as string
  a1.close()
  await sleep(300)
  const b2 = await ws(sids[2])
  b2.send({ t: 'hello', v: PROTOCOL, token, stored: true })
  const asB = await b2.next(['ready', 'welcome'])
  check('empires: account 2 can’t take account 1’s player with the token this browser kept', asB.t === 'ready')
  b2.close()
  const guest = await ws(null)
  guest.send({ t: 'hello', v: PROTOCOL, token, stored: true })
  check('empires: nor can a guest', (await guest.next(['ready', 'welcome'])).t === 'ready')
  guest.close()
  const away = async (sid: string, held: string) => ((await (await req('/api/empires/away', { sid, held, method: 'POST', json: { token } })).json()) as { battle: boolean }).battle
  check('empires: "a battle waits" isn’t answered for another account’s token', (await away(sids[2], '2')) === false)
  const a1again = await ws(sids[1])
  a1again.send({ t: 'hello', v: PROTOCOL, token, stored: true })
  const back = await a1again.next(['ready', 'welcome'])
  check('empires: account 1 gets its player back with it', back.t === 'welcome' && back.resumed === true)
  a1again.close()
  await sleep(300)
  // Login recycling: account 1 renames, another account takes the old login. Ownership follows the id.
  database().prepare('UPDATE users SET login = ? WHERE id = 1').run('acct-1-renamed')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (5, 5, ?, ?, ?, ?)').run('acct-1', encrypt('none'), now, now)
  sids[5] = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 5, ?, ?)').run(sha256(sids[5]), now, now + 86400_000)
  const c3 = await ws(sids[5])
  c3.send({ t: 'hello', v: PROTOCOL })
  check('empires: a new account on the login account 1 had can’t reclaim its paused player', (await c3.next(['ready', 'welcome'])).t === 'ready')
  c3.close()
  const c3t = await ws(sids[5])
  c3t.send({ t: 'hello', v: PROTOCOL, token })
  check('empires: nor with its token', (await c3t.next(['ready', 'welcome'])).t === 'ready')
  c3t.close()
  check('empires: "a battle waits" follows the account, not the login', (await away(sids[5], '5')) === false)
  const a1renamed = await ws(sids[1])
  a1renamed.send({ t: 'hello', v: PROTOCOL })
  const resumed = await a1renamed.next(['ready', 'welcome'])
  check('empires: account 1 resumes its player after the rename, without a token', resumed.t === 'welcome' && resumed.resumed === true && resumed.token === token)
  a1renamed.close()

  const auth = readFileSync(new URL('../server/auth.ts', import.meta.url), 'utf8')
  check('server: signing in sets it, readable, like the login cookie', /setCookie\(req, UID_COOKIE, String\(id\), \{ maxAge: SESSION_DAYS \* 86400, readable: true \}\)/.test(auth))
  await server.dispose()
}

// --- 2. the stand-in browser ----------------------------------------------------------------------

type Listener = (e: { key: string | null; newValue: string | null }) => void
class Win {
  listeners = new Map<string, Set<Listener>>()
  innerWidth = 1400
  innerHeight = 900
  addEventListener(type: string, l: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(l)
  }
  removeEventListener(type: string, l: Listener) {
    this.listeners.get(type)?.delete(l)
  }
  dispatchEvent(e: Event) {
    this.listeners.get(e.type)?.forEach((l) => (l as unknown as (e: Event) => void)(e))
    return true
  }
}
const g = globalThis as Record<string, unknown>
const wins: Win[] = []
function as<T>(w: Win, f: () => T): T {
  const was = g.window
  g.window = w
  try {
    return f()
  } finally {
    g.window = was
  }
}
async function within<T>(w: Win, f: () => Promise<T>): Promise<T> {
  const was = g.window
  g.window = w
  try {
    return await f()
  } finally {
    g.window = was
  }
}
const storage = new Map<string, string>()
let held = false
const queue: (() => void)[] = []
let blocked = false
const unwritable = new Set<string>()
const announce = (key: string, newValue: string | null) => {
  const from = g.window
  for (const w of wins)
    if (w !== from) {
      const deliver = () => as(w, () => w.listeners.get('storage')?.forEach((l) => l({ key, newValue })))
      if (held) queue.push(deliver)
      else deliver()
    }
}
const flush = () => {
  held = false
  while (queue.length) queue.shift()!()
}
const guard = () => {
  if (blocked) throw new Error('SecurityError: storage is blocked')
}
g.localStorage = {
  getItem: (k: string) => (guard(), storage.get(k) ?? null),
  setItem: (k: string, v: string) => {
    guard()
    if (unwritable.has(k) || [...unwritable].some((u) => u.endsWith('*') && k.startsWith(u.slice(0, -1)))) throw new Error('QuotaExceededError')
    storage.set(k, String(v))
    announce(k, String(v))
  },
  removeItem: (k: string) => {
    guard()
    storage.delete(k)
    announce(k, null)
  },
  key: (i: number) => (guard(), [...storage.keys()][i] ?? null),
  get length() {
    guard()
    return storage.size
  },
}
// Object.keys(localStorage) in the app lists the stored keys.
g.localStorage = new Proxy(g.localStorage as object, {
  ownKeys: (t) => (guard(), [...storage.keys(), ...Reflect.ownKeys(t)]),
  getOwnPropertyDescriptor: (t, k) => (typeof k === 'string' && storage.has(k) ? { value: storage.get(k), enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(t, k)),
})

const tabStore = new Map<string, string>()
g.sessionStorage = {
  getItem: (k: string) => tabStore.get(k) ?? null,
  setItem: (k: string, v: string) => void tabStore.set(k, String(v)),
  removeItem: (k: string) => void tabStore.delete(k),
  key: (i: number) => [...tabStore.keys()][i] ?? null,
  get length() {
    return tabStore.size
  },
}

/** The browser's cookies: who it is signed in as (the session) and the readable account id. */
const jar = { session: 0 as number, uid: '' as string, valid: true }
g.document = {
  get cookie() {
    return [jar.session && jar.valid ? 'mvlos_login=check' : '', jar.uid ? `mvlos_uid=${jar.uid}` : ''].filter(Boolean).join('; ')
  },
  set cookie(_: string) {},
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
  title: '',
}
let reloads = 0
Object.defineProperty(globalThis, 'location', { value: { pathname: '/', protocol: 'http:', origin: 'http://localhost', href: 'http://localhost/', reload: () => reloads++, assign() {} }, configurable: true })
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: undefined }, configurable: true })
g.window = new Win()

/** Signs the browser in as `id` (0: out), as the server's answer to signing in does. */
function signIn(id: number) {
  jar.session = id
  jar.valid = true
  jar.uid = id ? String(id) : ''
}

// The stand-in server: one state per account, and the rules of server/api.ts and server/auth.ts.
const state = new Map<number, Map<string, { value: unknown; updatedAt: number }>>()
const stateOf = (id: number) => state.get(id) ?? state.set(id, new Map()).get(id)!
const requests: { path: string; method: string; user: number; held: string | null; refused: boolean }[] = []
let meDelay = 0
let clock = 1000
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
g.fetch = async (input: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
  const path = String(input)
  const method = init.method ?? 'GET'
  const user = jar.valid ? jar.session : 0
  const heldBy = init.headers?.['X-MvL-Account'] ?? null
  if (path === '/api/me') {
    if (meDelay) await sleep(meDelay)
    // The answer puts the account id cookie right.
    const now = jar.valid ? jar.session : 0
    jar.uid = now ? String(now) : ''
    return json({ authEnabled: true, user: now ? { id: now, login: 'check', name: null, avatar: null, admin: false, githubScopes: [] } : null, forges: [] })
  }
  const required = path.startsWith('/api/state') || (path === '/api/notifications' && method !== 'GET')
  const refused = heldBy === null ? required : heldBy !== (user ? String(user) : 'visitor')
  requests.push({ path, method, user, held: heldBy, refused })
  if (refused) return json({ error: 'Signed in as another account', accountChanged: true }, 409)
  if (!user) return json({ error: 'Sign in first' }, 401)
  if (path === '/api/notifications') return json({ ok: true })
  if (path === '/api/state') return json(Object.fromEntries(stateOf(user)))
  const key = decodeURIComponent(path.replace('/api/state/', ''))
  const { value, base } = JSON.parse(init.body!) as { value: unknown; base: number }
  const cur = stateOf(user).get(key)
  if (cur && cur.updatedAt > base) return json({ ...cur, conflict: true })
  const entry = { value, updatedAt: ++clock }
  stateOf(user).set(key, entry)
  return json(entry)
}

type Mods = {
  space: typeof import('../src/os/accountSpace.ts')
  sync: typeof import('../src/os/synced.ts')
  account: typeof import('../src/os/account.ts')
}
type Tab = Mods & { win: Win; notes: ReturnType<Mods['sync']['synced']> }
let tabCount = 0
/** A page loading now: its own copies of the modules, a store of notes; `load` checks the account (/api/me). */
async function openTab(opts: { load?: boolean } = {}): Promise<Tab> {
  const win = new Win()
  wins.push(win)
  const n = ++tabCount
  const mods = await within(win, async () => ({
    space: await import(`../src/os/accountSpace.ts?tab=${n}`),
    sync: await import(`../src/os/synced.ts?tab=${n}`),
    account: await import(`../src/os/account.ts?tab=${n}`),
  }))
  const notes = as(win, () => mods.sync.synced<string[]>('notes', []))
  as(win, () => mods.sync.startSync())
  if (opts.load !== false) await within(win, () => mods.account.loadAccount())
  await sleep(10)
  return { ...(mods as Mods), win, notes }
}
const other = () => {
  const w = new Win()
  wins.push(w)
  return w
}
function reset() {
  storage.clear()
  state.clear()
  requests.length = 0
  queue.length = 0
  held = false
  blocked = false
  unwritable.clear()
  wins.length = 0
  meDelay = 0
  signIn(1)
}
const space = (id: number | null) => [...storage.entries()].filter(([k]) => k.startsWith(id ? `mvlos.u.${id}.` : 'mvlos.visitor.'))
const spaceText = (id: number | null) => JSON.stringify(space(id))
const sentTo = (id: number) => requests.filter((q) => q.user === id && !q.refused)

// --- 3. the release before account spaces: a tab of it writes A's notes after B signed in ------------
{
  reset()
  signIn(2)
  const B = await openTab()
  as(B.win, () => B.notes.set(['account-2-own']))
  // A tab still running the old release, holding account 1: it writes its plain keys (no space,
  // no tag), and its pushes say nothing about whose they are.
  as(other(), () => localStorage.setItem('mvlos.sync.notes', JSON.stringify({ value: ['account-1-private'], base: 0, dirty: true })))
  check('old tab: account 2’s page doesn’t take in what an old tab of account 1 wrote', B.notes.get().join() === 'account-2-own')
  const B2 = await openTab()
  check('old tab: nor does a page of account 2 loading after it', B2.notes.get().join() === 'account-2-own' && !spaceText(2).includes('account-1'))
  await sleep(1200)
  check('old tab: nothing of account 1 reached account 2', !JSON.stringify([...stateOf(2)]).includes('account-1'))
  // Missing marker, visitor: a visitor's page doesn't take the old keys of an account either.
  storage.set('mvlos.account', '1')
  signIn(0)
  const V = await openTab()
  check('old tab: a visitor’s page doesn’t take in an account’s old keys', V.notes.get().length === 0 && storage.has('mvlos.sync.notes'))
}

// --- 4. a page loading while the browser is someone else's: nothing of A shows -----------------------
{
  reset()
  // Account 1's page left notes (unsynced) in its space; the browser is signed in as 2 now.
  storage.set('mvlos.u.1.moved', '1')
  storage.set('mvlos.u.1.sync.notes', JSON.stringify({ value: ['account-1-private'], base: 0, dirty: true }))
  signIn(2)
  meDelay = 3000 // a slow /api/me
  const t = await openTab({ load: false })
  check('startup: a page of account 2 shows none of account 1’s notes before /api/me answers', t.notes.get().length === 0)
  const loading = within(t.win, () => t.account.loadAccount())
  await sleep(200)
  check('startup: nor while it is loading', t.notes.get().length === 0)
  await loading
  meDelay = 0
  check('startup: account 1’s unsynced notes are still kept in its own space', spaceText(1).includes('account-1-private'))
}

// --- 5. round 1: a pending push when another tab switches account -------------------------------------
{
  reset()
  const A = await openTab()
  as(A.win, () => A.notes.set(['account-1-private']))
  held = true
  signIn(2) // another tab: signed out and in as 2 (same cookie jar)
  await sleep(1200) // A's push comes due
  check('pending push: nothing of account 1 reaches account 2', !JSON.stringify([...stateOf(2)]).includes('account-1') && sentTo(2).length === 0)
  check('pending push: the tab stopped and reloads', A.space.accountFrozen() && reloads > 0)
  flush()
}

// --- 6. round 4 #1: the account changes while a tab is starting ----------------------------------------
{
  reset()
  storage.set('mvlos.u.1.moved', '1')
  storage.set('mvlos.u.1.sync.notes', JSON.stringify({ value: ['account-1-private'], base: 0, dirty: true }))
  const C = await openTab({ load: false })
  check('starting: the tab shows account 1’s notes (the browser is account 1’s)', C.notes.get().join() === 'account-1-private')
  signIn(2)
  await within(C.win, () => C.account.loadAccount())
  await sleep(1200)
  check('starting: nothing of account 1 reaches account 2', sentTo(2).length === 0 && !JSON.stringify([...stateOf(2)]).includes('account-1'))
  check('starting: the tab stopped', C.space.accountFrozen())
}

// --- 7. round 4 #2: a stale tab saves after the switch ------------------------------------------------
{
  reset()
  const A = await openTab()
  signIn(2)
  const B = await openTab()
  as(B.win, () => B.notes.set(['account-2-own']))
  as(A.win, () => A.notes.set(['account-1-later']))
  check('stale save: nothing written into account 2’s space', spaceText(2).includes('account-2-own') && !spaceText(2).includes('account-1'))
  check('stale save: nor into account 1’s (the tab stopped first)', !spaceText(1).includes('account-1-later') && A.space.accountFrozen())
  await sleep(1200)
  check('stale save: nothing of account 1 reached account 2', !JSON.stringify([...stateOf(2)]).includes('account-1'))
}

// --- 8. finding 4: terminal history and a notification from a stale tab --------------------------------
{
  reset()
  const A = await openTab()
  as(A.win, () => A.space.accountStorage.set('mvlos.history', JSON.stringify(['echo account-1-private'])))
  signIn(2)
  const B = await openTab()
  check('terminal: account 2’s page has none of account 1’s history', B.space.accountStorage.get('mvlos.history') === null)
  // Account 1's terminal, after a clear, writes its whole history back.
  as(A.win, () => A.space.accountStorage.set('mvlos.history', JSON.stringify(['echo account-1-private', 'clear'])))
  check('terminal: the stale terminal writes nothing anywhere', !JSON.stringify([...storage]).includes('"clear"'))
  const B2 = await openTab()
  check('terminal: a page of account 2 still has none of it', B2.space.accountStorage.get('mvlos.history') === null)
  // Account 1's upload finishes after the switch: its notification isn't sent.
  requests.length = 0
  await within(A.win, () => A.account.api('/api/notifications', { method: 'POST', json: { source: 'calendar.reminder', title: 'secret.pdf uploaded' } }).catch(() => null))
  check('notification: a stale tab’s notification is not sent', requests.length === 0)
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  check('terminal, agents, notifications, drafts, Files, push: kept in the account space', [
    ['../src/apps/Terminal.tsx', 'accountStorage.set(HISTORY_KEY'],
    ['../src/terminal/agents/editor.ts', 'accountStorage.set(HISTORY_KEY'],
    ['../src/os/notify.ts', 'accountStorage.set(HISTORY_KEY'],
    ['../src/data/agentDrafts.ts', 'accountStorage.set(KEY'],
    ['../src/data/appPrefs.ts', "'mvlos.files.v1'"],
    ['../src/os/push.ts', 'accountStorage.set(FLAG'],
  ].every(([f, s]) => src(f).includes(s)) && /jsonPref<FilesPrefs>\([^\n]*\{ account: true \}\)/.test(src('../src/data/appPrefs.ts')))
}

// --- 9. finding 5: the session ran out; the account's unsynced notes stay ---------------------------------
{
  reset()
  const A = await openTab()
  unwritable.add('mvlos.account') // the old marker can't be written either: nothing depends on it
  as(A.win, () => A.notes.set(['account-1-unsynced']))
  jar.valid = false // the session ran out (the cookies are still there until the server answers)
  const r0 = reloads
  const A2 = await openTab() // a reload: still account 1's space, until /api/me answers
  check('session out: the page reloads as a visitor once the server says so', A2.space.accountFrozen() && reloads === r0 + 1 && jar.uid === '')
  check('session out: account 1’s unsynced notes are kept', spaceText(1).includes('account-1-unsynced'))
  const V = await openTab()
  check('session out: the visitor’s page has none of them', V.notes.get().length === 0 && !V.space.accountFrozen())
  signIn(1)
  const A3 = await openTab()
  check('session out: signing in again brings them back', A3.notes.get().join() === 'account-1-unsynced')
  await sleep(1200)
  check('session out: and sends them to account 1', JSON.stringify([...stateOf(1)]).includes('account-1-unsynced'))
  check('session out: no reload loop', reloads === r0 + 1)
}

// --- 10. storage full, and blocked ---------------------------------------------------------------------
{
  reset()
  unwritable.add('mvlos.*')
  const r0 = reloads
  const D = await openTab()
  as(D.win, () => D.notes.set(['kept-in-memory']))
  await sleep(1200)
  check('storage full: the note is there and reaches the account', D.notes.get().join() === 'kept-in-memory' && JSON.stringify([...stateOf(1)]).includes('kept-in-memory'))
  check('storage full: no stop, no reload', !D.space.accountFrozen() && reloads === r0)
  reset()
  blocked = true
  const E = await openTab()
  as(E.win, () => E.notes.set(['blocked-in-memory']))
  await sleep(1200)
  check('storage blocked: works in memory and syncs', JSON.stringify([...stateOf(1)]).includes('blocked-in-memory') && !E.space.accountFrozen() && reloads === r0)
  signIn(2)
  as(E.win, () => E.notes.set(['later']))
  await sleep(1200)
  check('storage blocked: after a switch nothing reaches account 2, the tab stops', !JSON.stringify([...stateOf(2)]).includes('later') && E.space.accountFrozen())
}

// --- 11. moving in the release's plain keys, once, and only the account's own ----------------------------
{
  reset()
  storage.set('mvlos.account', '1')
  storage.set('mvlos.sync.notes', JSON.stringify({ value: ['old-release-note'], base: 5, dirty: true }))
  storage.set('mvlos.history', JSON.stringify(['ls']))
  storage.set('mvlos.theme', '{"mode":"dark"}')
  signIn(2)
  const B = await openTab()
  check('moving in: account 2 doesn’t take account 1’s plain keys', B.notes.get().length === 0 && storage.has('mvlos.sync.notes'))
  signIn(1)
  const A = await openTab()
  check('moving in: account 1 takes its own', A.notes.get().join() === 'old-release-note' && A.space.accountStorage.get('mvlos.history') === '["ls"]')
  check('moving in: ordinary plain keys move, ownership marker and browser preferences remain', !storage.has('mvlos.sync.notes') && !storage.has('mvlos.history') && storage.get('mvlos.account') === '1' && storage.has('mvlos.theme'))
  // An old tab writes the plain key again later: never read.
  storage.set('mvlos.sync.notes', JSON.stringify({ value: ['written-by-old-tab'], base: 0, dirty: true }))
  const A2 = await openTab()
  check('moving in: once only (an old tab’s later writes are not read)', A2.notes.get().join() === 'old-release-note')
}

// --- 12. a visitor signing in brings their notes along, once ------------------------------------------------
{
  reset()
  signIn(0)
  const V = await openTab()
  as(V.win, () => V.notes.set(['as-a-visitor']))
  check('visitor: kept in the visitor space', spaceText(null).includes('as-a-visitor'))
  signIn(1)
  check('visitor: the visitor’s page stops when the browser signs in', !as(V.win, () => V.space.accountGuard()) && V.space.accountFrozen())
  const A = await openTab()
  check('visitor: the account’s new space starts with the visitor’s notes', A.notes.get().join() === 'as-a-visitor')
  await sleep(1200)
  check('visitor: and they reach the account', JSON.stringify([...stateOf(1)]).includes('as-a-visitor'))
}

// --- 13. game saves: another account's page doesn't sweep them; a direct link's game keeps its own ---
{
  reset()
  tabStore.clear()
  const A = await openTab()
  const gameA = await within(A.win, async () => (await import(`../src/apps/games/session.ts?tab=${tabCount}`)) as typeof import('../src/apps/games/session.ts'))
  // Account 1's Empires window keeps its campaign under the window's session (in its layout).
  as(A.win, () => gameA.sessionPut('s-a', 'empires.campaign', ['A-campaign', true]))
  storage.set('mvlos.u.1.sync.windows:desktop', JSON.stringify({ value: [{ app: 'games', props: { game: 'empires', session: 's-a' } }], base: 0, dirty: false }))
  signIn(2)
  const B = await openTab()
  await within(B.win, async () => await import(`../src/apps/games/session.ts?tab=${tabCount}`)) // B's page sweeps its own windows' games
  check('games: account 2’s page doesn’t sweep account 1’s game saves', JSON.stringify(storage.get('mvlos.u.1.gamewin.s-a.empires.campaign')) === JSON.stringify(JSON.stringify(['A-campaign', true])))
  check('games: and can’t read them', as(B.win, () => B.space.accountStorage.get('mvlos.gamewin.s-a.empires.campaign')) === null)
  // A direct link's game (/play/<id>) keeps its own for the tab.
  const play = as(B.win, () => gameA.playSession('empires'))
  as(B.win, () => gameA.sessionPut(play, 'empires.battle', { n: 1 }))
  check('games: a direct link’s game finds what it kept', JSON.stringify(as(B.win, () => gameA.sessionGet(play, 'empires.battle'))) === '{"n":1}')
  // The release before kept them in plain keys: they move into the account's space.
  reset()
  storage.set('mvlos.account', '1')
  storage.set('mvlos.gamewin.s-old.empires.campaign', '["old"]')
  storage.set('mvlos.highscores.v1', '{"snake":[1]}')
  storage.set('mvlos.gladiator.v1', '{"careers":[]}')
  storage.set('mvlos.empires.mp.last', 'tok')
  await openTab()
  check('games: old game saves, high scores, Gladiator careers and the Empires player move in', ['gamewin.s-old.empires.campaign', 'highscores.v1', 'gladiator.v1', 'empires.mp.last'].every((k) => storage.has(`mvlos.u.1.${k}`) && !storage.has(`mvlos.${k}`)))
}

finish()
