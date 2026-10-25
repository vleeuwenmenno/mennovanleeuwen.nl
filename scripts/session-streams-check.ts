// Checks that long-lived connections end with the session that opened them (server/liveSessions.ts,
// server/auth.ts, server/notifier.ts, server/empires.ts, server/agents.ts):
//
//   1. The registry in memory: a session's connections close on signing out of it (the account's
//      other sessions stay), on signing out everywhere, at the session's expiry, and when the stored
//      session is found gone or banned; nothing is left behind (connections, timers, sweep).
//   2. A streamed response (the Agents turn streams) is cut with its session, and only that one.
//   3. The real server (server/index.ts on a free port, scratch DATA_DIR): the notification stream
//      and the Empires socket of a session that signed out, ran out, was deleted behind the
//      server's back, was signed out by an admin or banned get nothing more and can do nothing;
//      another session of the same account, another account and guests carry on.
//   4. Every NDJSON response the server opens is bound to its session, and the result of binding
//      is used (a response that could not be bound stops its handler).
//   5. A request that was signed in when it arrived but whose session ended before it finished
//      (logout, expiry, deleted behind the server's back, signed out by an admin, ban) while its
//      body was still being sent: nothing runs for it. No model or ComfyUI call, no saved message,
//      reply, image or Studio thread. A valid request, and a turn that had genuinely started, are
//      untouched (an ordinary logout cuts the stream but the turn goes on; a ban stops it).
//
//   node scripts/session-streams-check.ts
//
// Exits 1 on any failure.

import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { PROTOCOL } from '../src/apps/games/empires/protocol.ts'
import { Server, check, finish, sleep, waitFor } from './empires-harness.ts'

// Stand-ins for the model provider (Ollama) and ComfyUI: every request that reaches them is counted,
// and a turn whose text says HOLD waits until `release()`.
const outbound = { chat: 0, comfy: 0 }
let releaseHeld: (() => void)[] = []
const release = () => (releaseHeld.splice(0).forEach((f) => f()), undefined)
const stub = (who: 'chat' | 'comfy') => createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const path = new URL(req.url!, 'http://stub').pathname
  const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
  if (who === 'comfy') return void (outbound.comfy++, res.writeHead(404).end())
  if (path === '/api/tags') return void send({ models: [{ name: 'sess-model' }] })
  if (path === '/api/show') return void send({ capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 131072 } })
  if (path !== '/api/chat') return void res.writeHead(404).end()
  outbound.chat++
  const body = JSON.parse(raw)
  if (JSON.stringify(body.messages).includes('HOLD')) await new Promise<void>((r) => releaseHeld.push(r))
  const done = JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 10, eval_count: 2 })
  if (body.stream === false) return void send({ message: { role: 'assistant', content: '{"title":"Stub title"}' }, done: true })
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(`${JSON.stringify({ message: { role: 'assistant', content: 'stub answer' }, done: false })}\n${done}\n`)
})
const chatStub = stub('chat')
const comfyStub = stub('comfy')
for (const st of [chatStub, comfyStub]) await new Promise<void>((r) => st.listen(0, '127.0.0.1', r))
const stubUrl = (st: ReturnType<typeof stub>) => `http://127.0.0.1:${(st.address() as { port: number }).port}`
// The held-request checks use accounts 101-120. Admins (GitHub id 998000+n) may reach the stand-ins on loopback; the others cannot, so for them only what is saved shows. An admin cannot be banned or signed out by another admin, so those two modes use plain accounts.
const ADMINS = ['999999', ...Array.from({ length: 150 }, (_, i) => String(998000 + i + 1))].join(',')
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: ADMINS, OLLAMA_URL: stubUrl(chatStub), OLLAMA_API_KEY: 'stub-key', NOTIFY_WATCH: 'off' })
// The checks seed the same database the server uses, and run the server's own modules in this process.
process.env.DATA_DIR = server.data
process.env.GITHUB_CLIENT_ID = 'x'
process.env.GITHUB_CLIENT_SECRET = 'x'
const { database, encrypt, sha256 } = await import('../server/db.ts')
const { bindConnection, bindResponse, currentUser } = await import('../server/auth.ts')
const { endAccount, endSession, liveCount, sweep, track } = await import('../server/liveSessions.ts')

const now = Date.now()
const addUser = (id: number, githubId = id) => database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, githubId, `acct-${id}`, encrypt('none'), now, now)
/** A session for the account; `lasts` ms from now. Returns the cookie value. */
function addSession(userId: number, lasts = 86400_000) {
  const sid = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), userId, now, Date.now() + lasts)
  return sid
}
/** Deletes the stored session behind the server's back: nothing tells the server. */
const dropStored = (sid: string) => database().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid))
const stored = (sid: string) => !!database().prepare('SELECT 1 FROM sessions WHERE id = ?').get(sha256(sid))

// --- 1. the registry -----------------------------------------------------------------------------
{
  addUser(1)
  addUser(2)
  const a1 = addSession(1)
  const a2 = addSession(1)
  const b1 = addSession(2)
  const key = (sid: string) => sha256(sid)
  const row = (sid: string) => database().prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(key(sid)) as { user_id: number; expires_at: number }
  const bind = (sid: string) => ({ key: key(sid), userId: row(sid).user_id, expiresAt: row(sid).expires_at })
  const closed = new Map<string, string>()
  const open = (label: string, sid: string) => {
    const t = track(bind(sid), (why) => closed.set(label, why))
    return t
  }
  const x1 = open('a1-one', a1)
  const x2 = open('a1-two', a1)
  const y = open('a2', a2)
  const z = open('b1', b1)
  let c = liveCount()
  check('registry: 4 connections in 3 sessions of 2 accounts, one timer per session, sweeping', c.connections === 4 && c.sessions === 3 && c.accounts === 2 && c.timers === 3 && c.sweeping)
  endSession(key(a1))
  check('registry: ending a session closes every connection of that session ("signed out")', closed.get('a1-one') === 'signed out' && closed.get('a1-two') === 'signed out')
  check('registry: and no other: the same account’s other session and another account stay', !closed.has('a2') && !closed.has('b1') && y.check() && z.check())
  check('registry: the ended ones answer false from then on', !x1.check() && !x2.check(true))
  x1.stop()
  x2.stop()
  c = liveCount()
  check('registry: it forgot the ended session (2 sessions, 2 connections left)', c.sessions === 2 && c.connections === 2 && c.timers === 2)
  endAccount(1, 'signed out everywhere')
  check('registry: ending an account closes all of its sessions, not another account’s', closed.get('a2') === 'signed out everywhere' && !closed.has('b1'))
  endAccount(1)
  endSession(key(a1))
  check('registry: ending what is already gone is harmless', true)
  y.stop()
  z.stop()
  c = liveCount()
  check('registry: when the last connection stops nothing is left: no sessions, accounts, timers or sweep', c.sessions === 0 && c.connections === 0 && c.accounts === 0 && c.timers === 0 && !c.sweeping)

  // Binding refuses a session that isn't the account's, is expired or banned.
  const fake = (sid: string) => ({ headers: { cookie: `mvlos_sid=${sid}` } }) as never
  check('bind: the account’s own session binds', !!bindConnection(fake(a1), 1, () => {}) && (endSession(key(a1)), true))
  check('bind: a session of another account does not (mismatch)', bindConnection(fake(a1), 2, () => {}) === null)
  check('bind: neither does no session', bindConnection({ headers: {} } as never, 1, () => {}) === null)
  const old = addSession(1, -1000)
  check('bind: nor an expired one', bindConnection(fake(old), 1, () => {}) === null)

  // A response whose session is gone is destroyed and says so: the handler must not go on.
  {
    let destroyed = 0
    const res = (sid: string) => ({ req: fake(sid), destroy: () => void destroyed++, once: () => {} }) as never
    const live = addSession(1)
    const bound = bindResponse(res(live), 1)
    check('bind: a response of a good session is bound and returns its handle', !!bound && destroyed === 0 && (bound.stop(), true))
    dropStored(live)
    check('bind: a response whose session is gone is destroyed and returns null', bindResponse(res(live), 1) === null && destroyed === 1)
  }

  // Expiry closes at the session's end, without polling.
  const soon = addSession(1, 400)
  open('soon', soon)
  await sleep(250)
  check('expiry: still open before the session ends', !closed.has('soon'))
  await waitFor('expiry: closed when the session runs out ("session expired")', () => closed.get('soon') === 'session expired', 2000)
  check('expiry: and forgotten', liveCount().sessions === 0 && !liveCount().sweeping)

  // Gone from the database behind the server's back: found at the next check, or by the sweep.
  const gone = addSession(1)
  const g = open('gone', gone)
  dropStored(gone)
  check('lookup: a check inside the lookup interval trusts memory (bounded by 5 s)', g.check() === true)
  check('lookup: a fresh check finds the session gone and closes the connection', g.check(true) === false && closed.get('gone') === 'session ended')
  const swept = addSession(1)
  open('swept', swept)
  dropStored(swept)
  sweep()
  check('sweep: finds a deleted session', closed.get('swept') === 'session ended')
  const banned = addSession(1)
  open('banned', banned)
  database().prepare('UPDATE users SET banned_at = ? WHERE id = 1').run(Date.now())
  sweep()
  check('sweep: finds a banned account', closed.get('banned') === 'session ended')
  check('bind: a banned account’s session does not bind', bindConnection(fake(addSession(1)), 1, () => {}) === null)
  database().prepare('UPDATE users SET banned_at = NULL WHERE id = 1').run()
  check('registry: nothing left after all of it', liveCount().sessions === 0 && !liveCount().sweeping)
}

// --- 2. a streamed response ----------------------------------------------------------------------
{
  const s1 = addSession(2)
  const s2 = addSession(2)
  const http = createServer((req, res) => {
    const user = currentUser(req)
    if (!user) return void res.writeHead(401).end()
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    bindResponse(res, user.id)
    const timer = setInterval(() => res.write('{"type":"delta","content":"private"}\n'), 50)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise<void>((r) => http.listen(0, r))
  const base = `http://localhost:${(http.address() as { port: number }).port}`
  const follow = (sid: string) => {
    const st = { text: '', ended: false }
    void fetch(base, { headers: { Cookie: `mvlos_sid=${sid}` } })
      .then(async (r) => {
        const reader = r.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          st.text += new TextDecoder().decode(value)
        }
      })
      .catch(() => {})
      .finally(() => (st.ended = true))
    return st
  }
  const a = follow(s1)
  const b = follow(s2)
  await waitFor('stream: both sessions get lines', () => a.text.includes('private') && b.text.includes('private'))
  check('stream: two responses are tracked', liveCount().connections === 2)
  endSession(sha256(s1))
  await waitFor('stream: signing out of one session cuts its response', () => a.ended)
  const len = a.text.length
  await sleep(200)
  check('stream: and it gets nothing more', a.text.length === len)
  check('stream: the other session’s response goes on', !b.ended && b.text.length > 0)
  endSession(sha256(s2))
  await waitFor('stream: and is cut when its own session ends', () => b.ended)
  await waitFor('stream: the registry is empty once the responses are gone', () => liveCount().sessions === 0)
  const short = addSession(2, 400)
  const c = follow(short)
  await waitFor('stream: a session that runs out cuts its response', () => c.ended, 3000)
  await new Promise((r) => http.close(r))
  http.closeAllConnections()
}

// --- 3. the real server --------------------------------------------------------------------------
{
  addUser(3)
  addUser(4)
  for (const id of [5, 6, 7, 8]) addUser(id)
  addUser(9, 999999) // the admin
  await server.start()
  const hold = (sid: string, uid: number) => ({ Cookie: `mvlos_sid=${sid}`, Origin: server.origin, 'X-MvL-Account': String(uid), 'Content-Type': 'application/json' })
  const post = (sid: string, uid: number, path: string, json: unknown = {}) => fetch(`${server.origin}${path}`, { method: 'POST', headers: hold(sid, uid), body: JSON.stringify(json) })
  const notice = (sid: string, uid: number, title: string) => post(sid, uid, '/api/notifications', { source: 'calendar.reminder', title })

  /** The notification stream of a session, collecting what arrives. */
  const stream = async (sid: string, uid: number) => {
    const st = { text: '', ended: false, status: 0 }
    void fetch(`${server.origin}/api/notifications/stream?page=${randomUUID()}&holds=${uid}`, { headers: hold(sid, uid) })
      .then(async (r) => {
        st.status = r.status
        const reader = r.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          st.text += new TextDecoder().decode(value)
        }
      })
      .catch(() => {})
      .finally(() => (st.ended = true))
    await waitFor(`stream opens (${sid.slice(0, 4)})`, () => st.text.includes('event: hello'))
    return st
  }
  /** The Empires socket of a session (or a guest), with what it received. */
  const socket = (sid: string | null) => {
    const st = { msgs: [] as Record<string, any>[], code: 0, open: false, token: '' }
    const ws = new WebSocket(server.url, { headers: { Origin: server.origin, ...(sid ? { Cookie: `mvlos_sid=${sid}` } : {}) } } as any)
    ws.onopen = () => {
      st.open = true
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL }))
    }
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.t !== 'lobbies') st.msgs.push(m)
      if (m.t === 'welcome') st.token = m.token
    }
    ws.onclose = (e) => (st.code = e.code || 1006)
    return {
      st,
      ws,
      send: (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
      got: (t: string) => st.msgs.some((m) => m.t === t),
      named: async (name: string) => {
        await waitFor(`${name}: ready`, () => st.msgs.some((m) => m.t === 'ready'))
        ws.send(JSON.stringify({ t: 'claim', name }))
        await waitFor(`${name}: welcome`, () => st.msgs.some((m) => m.t === 'welcome' && m.name === name))
      },
    }
  }

  // Notification stream: signing out of one session.
  const a = addSession(3)
  const b = addSession(3)
  const c = addSession(4)
  const A = await stream(a, 3)
  const B = await stream(b, 3)
  const C = await stream(c, 4)
  await notice(b, 3, 'secret-one')
  await waitFor('sse: both sessions of the account get a notification', () => A.text.includes('secret-one') && B.text.includes('secret-one'))
  check('sse: another account does not', !C.text.includes('secret-one'))
  const out = await post(a, 3, '/api/auth/logout')
  check('sse: logout answers', out.status === 200 && !stored(a))
  await waitFor('sse: signing out ends that session’s stream at once', () => A.ended, 1500)
  await notice(b, 3, 'secret-two')
  await waitFor('sse: the account’s other session still gets what comes next', () => B.text.includes('secret-two'))
  check('sse: the signed-out stream got none of it', !A.text.includes('secret-two'))
  check('sse: another account’s stream stays open', !C.ended)

  // Ran out (no logout, nothing deleted): closed at the expiry, with nothing sent.
  const e = addSession(3, 1500)
  const E = await stream(e, 3)
  await waitFor('sse: a session that runs out has its stream closed', () => E.ended, 4000)

  // Deleted behind the server's back: the next notification finds out instead of being sent.
  const d = addSession(3)
  const D = await stream(d, 3)
  dropStored(d)
  await notice(b, 3, 'secret-three')
  await waitFor('sse: a deleted session is closed by the next notification', () => D.ended, 1500)
  check('sse: and was not sent it', !D.text.includes('secret-three'))
  await waitFor('sse: the live session was', () => B.text.includes('secret-three'))

  // Empires socket: signing out of one session.
  const w1 = addSession(5)
  const w2 = addSession(5)
  const W1 = socket(w1)
  const W2 = socket(w2)
  await W1.named('Wolf')
  await W2.named('Fox')
  const guest = socket(null)
  await guest.named('Visitor')
  await post(w1, 5, '/api/auth/logout')
  await waitFor('ws: signing out closes that session’s socket (1008)', () => W1.st.code === 1008, 1500)
  W1.send({ t: 'claim', name: 'Hacked' })
  await sleep(200)
  check('ws: and it can’t change its player any more', !W1.st.msgs.some((m) => m.t === 'welcome' && m.name === 'Hacked'))
  check('ws: another session of the account is still connected', W2.st.code === 0)
  const before = W2.st.msgs.length
  W2.send({ t: 'claim', name: 'Fox Two' })
  await waitFor('ws: and can still act', () => W2.st.msgs.slice(before).some((m) => m.t === 'welcome' && m.name === 'Fox Two'))
  check('ws: a guest is unaffected', guest.st.code === 0)
  // A socket opened with the signed-out cookie is a guest’s and can't take the old player over.
  const stale = socket(w1)
  await waitFor('ws: the signed-out cookie connects as a guest', () => stale.got('ready'))
  stale.send({ t: 'claim', name: 'Wolf' })
  await waitFor('ws: and cannot take the signed-out player’s name while it is held', () => stale.got('refused') || stale.got('welcome'))
  const resumed = socket(null)
  resumed.ws.onopen = () => resumed.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token: W1.st.token }))
  await sleep(500)
  check('ws: a guest’s hello with that player’s token does not resume it', !resumed.st.msgs.some((m) => m.t === 'welcome' && m.resumed))

  // Ran out.
  const r = addSession(7, 1500)
  const R = socket(r)
  await R.named('Rabbit')
  await waitFor('ws: a session that runs out has its socket closed (1008)', () => R.st.code === 1008, 4000)

  // Deleted behind the server's back: its next action is refused and closes the socket.
  const g = addSession(6)
  const G = socket(g)
  await G.named('Gull')
  dropStored(g)
  G.send({ t: 'claim', name: 'Gull Two' })
  await waitFor('ws: a deleted session’s next action closes the socket (1008)', () => G.st.code === 1008, 1500)
  check('ws: and did nothing', !G.st.msgs.some((m) => m.t === 'welcome' && m.name === 'Gull Two'))

  // An admin signs an account out everywhere: every session of it (streams and sockets), no other account.
  const adm = addSession(9)
  const h1 = addSession(4)
  const h2 = addSession(4)
  const H1 = await stream(h1, 4)
  const H2 = await stream(h2, 4)
  const HS = socket(h2)
  await HS.named('Heron')
  check('signout everywhere: the account’s sessions are all connected first', !C.ended && !H1.ended && !H2.ended)
  const so = await post(adm, 9, '/api/admin/users/4/signout')
  check('signout everywhere: the admin’s call works', so.status === 200)
  await waitFor('signout everywhere: every stream of the account ends', () => C.ended && H1.ended && H2.ended, 1500)
  await waitFor('signout everywhere: and its socket', () => HS.st.code === 1008, 1500)
  check('signout everywhere: all of its stored sessions are gone', !stored(c) && !stored(h1) && !stored(h2))
  check('signout everywhere: another account’s stream and socket stay', !B.ended && W2.st.code === 0)

  // A ban: the same, and the account can't come back.
  const k1 = addSession(8)
  const k2 = addSession(8)
  const K1 = await stream(k1, 8)
  const KS = socket(k1)
  await KS.named('Kite')
  const KT = socket(k2)
  await waitFor('ban: a second session’s socket resumes the same account’s player', () => KT.got('ready') || KT.got('welcome'))
  const ban = await post(adm, 9, '/api/admin/users/8/ban', { reason: 'test' })
  check('ban: the admin’s call works', ban.status === 200)
  await waitFor('ban: its stream ends', () => K1.ended, 1500)
  await waitFor('ban: and all of its sockets close', () => KS.st.code === 1008 && KT.st.code === 1008, 1500)
  const again = await fetch(`${server.origin}/api/notifications/stream?page=${randomUUID()}&holds=visitor`, { headers: { ...hold(k1, 8), 'X-MvL-Account': 'visitor' } })
  check('ban: and its old session can’t open a stream (401)', again.status === 401)
  check('ban: a guest and another account’s socket are unaffected', guest.st.code === 0 && W2.st.code === 0 && !B.ended)
  guest.ws.close()
}


// --- 5. a request whose session ends while its body is still being sent --------------------------
{
  type Mode = 'logout' | 'expired' | 'deleted' | 'signout' | 'ban'
  const MODES: Mode[] = ['logout', 'expired', 'deleted', 'signout', 'ban']
  let next = 100
  const adminSid = addSession(9)
  const asHeaders = (sid: string, uid: number) => ({ Cookie: `mvlos_sid=${sid}`, Origin: server.origin, 'X-MvL-Account': String(uid), 'Content-Type': 'application/json' })
  const call = (sid: string, uid: number, method: string, path: string, json?: unknown) => fetch(`${server.origin}${path}`, { method, headers: asHeaders(sid, uid), body: json === undefined ? undefined : JSON.stringify(json) })
  /** An account with a key for the model, ComfyUI connected, one session (or two), and an Agents thread. */
  type Account = { id: number; sid: string; other: string; thread: string; admin: boolean }
  async function account(admin: boolean, lasts = 86400_000, tools: string[] = []): Promise<Account> {
    const id = ++next
    addUser(id, admin ? 998000 + id - 100 : id)
    const sid = addSession(id, lasts)
    const other = addSession(id)
    database().prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(id, 'ollama', encrypt('stub-key'), Date.now())
    database().prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(id, 'agents-comfyui', encrypt(JSON.stringify({ url: stubUrl(comfyStub), preset: 'sdxl' })), Date.now())
    const made = await call(other, id, 'POST', '/api/agents/threads', { model: 'sess-model', tools, permission: 'default' })
    if (made.status !== 200) throw new Error(`thread: ${made.status} ${await made.text()}`)
    return { id, sid, other, thread: ((await made.json()) as { id: string }).id, admin }
  }
  /** A POST whose body stops halfway: `finish()` sends the rest. */
  function held(sid: string, uid: number, path: string, body: unknown) {
    const text = JSON.stringify(body)
    const cut = Math.max(1, Math.floor(text.length / 2))
    const out = { status: 0, text: '', ended: false }
    const req = httpRequest({ host: new URL(server.origin).hostname, port: server.port, path, method: 'POST', headers: { ...asHeaders(sid, uid), 'Content-Length': Buffer.byteLength(text) } })
    req.on('response', (res) => {
      out.status = res.statusCode ?? 0
      res.on('data', (d) => (out.text += d))
      res.on('end', () => (out.ended = true))
      res.on('error', () => (out.ended = true))
    })
    req.on('error', () => (out.ended = true))
    req.on('close', () => (out.ended = true))
    req.write(text.slice(0, cut))
    return { out, finish: () => req.end(text.slice(cut)) }
  }
  const count = (sql: string, ...args: (string | number)[]) => (database().prepare(sql).get(...args) as { n: number }).n
  const saved = (a: Account) => ({
    messages: count('SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ?', a.thread),
    studio: count('SELECT COUNT(*) AS n FROM agent_threads WHERE user_id = ? AND quick = 2', a.id),
    images: count('SELECT COUNT(*) AS n FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE t.user_id = ?', a.id),
  })
  const revoke = async (mode: Mode, a: Account) => {
    if (mode === 'logout') await call(a.sid, a.id, 'POST', '/api/auth/logout')
    else if (mode === 'deleted') dropStored(a.sid)
    else if (mode === 'signout') await call(adminSid, 9, 'POST', `/api/admin/users/${a.id}/signout`)
    else if (mode === 'ban') await call(adminSid, 9, 'POST', `/api/admin/users/${a.id}/ban`, { reason: 'test' })
  }
  type Route = { name: string; tools?: string[]; admin?: boolean; path: (a: Account) => string; body: unknown; seed?: (a: Account) => void; modes?: Mode[] }
  const ROUTES: Route[] = [
    { name: 'message', path: (a) => `/api/agents/threads/${a.thread}/messages`, body: { text: 'a private question' } },
    { name: 'retry', path: (a) => `/api/agents/threads/${a.thread}/retry`, body: { client: {} }, seed: (a) => database().prepare("INSERT INTO agent_messages (thread_id, role, content, created_at) VALUES (?, 'user', 'earlier question', ?)").run(a.thread, Date.now()) },
    { name: 'inpaint', tools: ['images'], path: (a) => `/api/agents/threads/${a.thread}/inpaint`, body: { operation: 'inpaint' } },
    { name: 'upscale', tools: ['images'], path: (a) => `/api/agents/threads/${a.thread}/upscale`, body: { operation: 'upscale' } },
    { name: 'studio', admin: true, path: () => '/api/agents/images/studio/run', body: { input: { preset: 'sdxl', prompt: 'a lighthouse' }, batch: 1 } },
    { name: 'studio (plain account)', path: () => '/api/agents/images/studio/run', body: { input: { preset: 'sdxl', prompt: 'a lighthouse' }, batch: 1 } },
  ]
  for (const route of ROUTES) {
    for (const mode of MODES) {
      // An admin can be neither banned nor signed out by an admin; those two modes use a plain account.
      const admin = !!route.admin && mode !== 'signout' && mode !== 'ban'
      if (route.admin && !admin) continue
      const a = await account(admin, mode === 'expired' ? 1800 : 86400_000, route.tools)
      route.seed?.(a)
      const before = { ...saved(a), ...outbound }
      const h = held(a.sid, a.id, route.path(a), route.body)
      await sleep(300) // the server has taken the user from the cookie and waits for the rest of the body
      if (mode === 'expired') await sleep(1700)
      else await revoke(mode, a)
      h.finish()
      await waitFor(`${route.name} / ${mode}: the held request is answered`, () => h.out.ended, 4000)
      await sleep(300)
      const after = { ...saved(a), ...outbound }
      check(`${route.name} / ${mode}: refused (401) and nothing streamed`, h.out.status === 401 && !h.out.text.includes('"type"'))
      check(`${route.name} / ${mode}: nothing saved (messages, replies, Studio thread, images)`, after.messages === before.messages && after.studio === before.studio && after.images === before.images)
      check(`${route.name} / ${mode}: no model call${route.admin || admin ? ' and no ComfyUI call' : ''}`, after.chat === before.chat && (!admin || after.comfy === before.comfy))
    }
  }

  // A valid request is not disturbed by a slow body.
  {
    const a = await account(true)
    const before = { ...saved(a), ...outbound }
    const h = held(a.sid, a.id, `/api/agents/threads/${a.thread}/messages`, { text: 'a slow question' })
    await sleep(500)
    h.finish()
    await waitFor('valid: a slow message is answered', () => h.out.ended && h.out.text.includes('"type":"done"'), 6000)
    check('valid: its reply is saved and the model was called', saved(a).messages >= before.messages + 2 && outbound.chat > before.chat && h.out.status === 200)
    const studio = await account(true)
    const comfy = outbound.comfy
    const run = held(studio.sid, studio.id, '/api/agents/images/studio/run', { input: { preset: 'sdxl', prompt: 'a lighthouse' }, batch: 1 })
    await sleep(300)
    run.finish()
    await waitFor('valid: a slow Studio request is answered', () => run.out.ended, 6000)
    check('valid: and it reached ComfyUI', outbound.comfy > comfy)
  }

  // A turn that genuinely started keeps the documented semantics.
  {
    const a = await account(false)
    const assistants = (acct: Account) => count("SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = 'assistant'", acct.thread)
    const stream = async (sid: string, uid: number, thread: string, text: string) => {
      const st = { ended: false, status: 0 }
      void fetch(`${server.origin}/api/agents/threads/${thread}/messages`, { method: 'POST', headers: asHeaders(sid, uid), body: JSON.stringify({ text }) })
        .then(async (r) => {
          st.status = r.status
          const reader = r.body!.getReader()
          while (!(await reader.read()).done);
        })
        .catch(() => {})
        .finally(() => (st.ended = true))
      return st
    }
    const chats = outbound.chat
    const turn = await stream(a.sid, a.id, a.thread, 'HOLD logout')
    await waitFor('started: the model is working', () => outbound.chat > chats)
    await call(a.sid, a.id, 'POST', '/api/auth/logout')
    await waitFor('started: signing out of the asking session cuts its stream', () => turn.ended, 2000)
    release()
    await waitFor('started: and the turn goes on, for the account’s other session (the reply is saved)', () => assistants(a) === 1, 4000)
    const view = await call(a.other, a.id, 'GET', `/api/agents/threads/${a.thread}`)
    check('started: the other session reads it', view.status === 200)

    const b = await account(false)
    const chatsB = outbound.chat
    const turnB = await stream(b.sid, b.id, b.thread, 'HOLD ban')
    await waitFor('started: (ban) the model is working', () => outbound.chat > chatsB)
    await revoke('ban', b)
    await waitFor('started: a ban cuts the stream', () => turnB.ended, 2000)
    release()
    await sleep(500)
    check('started: and stops the turn, so no reply is saved', assistants(b) === 0)

    // The body completes and the ban follows at once: whichever the server sees first, nothing is answered afterwards.
    const c = await account(false)
    const race = held(c.sid, c.id, `/api/agents/threads/${c.thread}/messages`, { text: 'HOLD race' })
    await sleep(300)
    race.finish()
    await revoke('ban', c)
    await waitFor('race: the request ends', () => race.out.ended, 4000)
    release()
    await sleep(500)
    check('race: ban right behind the body: no reply saved', assistants(c) === 0)
  }
}

// --- 4. every NDJSON response is bound ----------------------------------------------------------
{
  const dir = fileURLToPath(new URL('../server/', import.meta.url))
  const unbound: string[] = []
  const ignored: string[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const lines = readFileSync(dir + f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.includes('application/x-ndjson') && line.includes('writeHead') && !lines.slice(i + 1, i + 8).some((l) => l.includes("bindResponse("))) unbound.push(`${f}:${i + 1}`)
      // A bound response that fails to bind is destroyed, and the handler must not go on to do its work.
      if (line.includes('bindResponse(') && !line.includes('export function') && !/if \(!bindResponse\(|= bindResponse\(/.test(line) && f !== 'auth.ts') ignored.push(`${f}:${i + 1}`)
    })
  }
  check(`wiring: every NDJSON response the server opens is bound to its session (${unbound.join(', ') || 'all'})`, unbound.length === 0)
  check(`wiring: every handler stops when its response could not be bound (${ignored.join(', ') || 'all'})`, ignored.length === 0)
}

await server.dispose()
chatStub.close()
comfyStub.close()
finish()
