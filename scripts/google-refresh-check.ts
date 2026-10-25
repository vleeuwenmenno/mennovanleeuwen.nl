// Checks that Google Calendar credentials cannot outlive the link they came from (server/google.ts),
// in-process against a stand-in for Google's token endpoint that holds requests until released and a
// scratch DATA_DIR. No real account is used.
//
//   - a refresh held for account A cannot overwrite or be returned after A is replaced by B,
//   - a disconnect drops a held refresh before it is stored or returned,
//   - deleting the user drops a held refresh,
//   - a consent exchange held at Google cannot store anything once its session is signed out
//     (or the link changed meanwhile),
//   - a delayed calendar body, or an aggregate read that was half done, after a relink, disconnect or
//     removal returns nothing of the old link; a stale failure leaves the new link's pending read alone;
//   - concurrent refreshes of one link still share a single request, and a finished stale job
//     does not remove a newer link's job.
//
//   node scripts/google-refresh-check.ts
//
// Exits 1 on any failure.

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const DATA = mkdtempSync(join(tmpdir(), 'mvlos-google-refresh-'))
process.env.DATA_DIR = DATA
let failed = false
const check = (what: string, test: boolean) => {
  console.log(test ? 'PASS' : 'FAIL', what)
  if (!test) failed = true
}

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x`
const held: { grant: string; value: string; release: () => void }[] = []
let tokenCalls = 0
/** Calendar API holds, by `<access token>|<list or calendar id>`: 'full' answers only when released, 'body' sends the headers and half the body at once. */
const gates = new Map<string, 'full' | 'body'>()
const apiHeld: { key: string; release: () => void }[] = []
const apiCalls: string[] = []
function api(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const token = String(req.headers.authorization ?? '').replace('Bearer ', '')
  const path = new URL(req.url!, 'http://x').pathname
  const calendar = /^\/api\/calendars\/([^/]+)\/events/.exec(path)?.[1]
  const key = `${token}|${calendar ?? 'list'}`
  apiCalls.push(key)
  const text = JSON.stringify(
    calendar
      ? { items: [{ id: `event-${token}-${calendar}`, summary: `private ${token} ${calendar}`, start: { dateTime: '2030-01-01T10:00:00Z' }, end: { dateTime: '2030-01-01T11:00:00Z' } }] }
      : { items: ['cal1', 'cal2'].map((id) => ({ id, summary: `${id} of ${token}`, accessRole: 'owner' })) },
  )
  const mode = gates.get(key)
  const head = { 'Content-Type': 'application/json' }
  if (!mode) return res.writeHead(200, head).end(text)
  if (mode === 'full') return void apiHeld.push({ key, release: () => res.writeHead(200, head).end(text) })
  res.writeHead(200, head)
  res.write(text.slice(0, 10))
  apiHeld.push({ key, release: () => res.end(text.slice(10)) })
}
const fake = createServer((req, res) => {
  if (req.url!.startsWith('/api/')) return api(req, res)
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    tokenCalls++
    const form = new URLSearchParams(body)
    const answer = (access: string, refresh: string | null, email: string) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: access, ...(refresh ? { refresh_token: refresh } : {}), expires_in: 3600, scope: 'openid email', id_token: idToken(email) }))
    const grant = form.get('grant_type')!
    const value = form.get('refresh_token') ?? form.get('code')!
    if (grant === 'refresh_token') return void held.push({ grant, value, release: () => answer(`access-from-${value}`, null, '') })
    if (value === 'code-held') return void held.push({ grant, value, release: () => answer('access-consent', 'refresh-consent', 'consent@example.test') })
    answer(`access-${value}`, `refresh-${value}`, `${value}@example.test`)
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${(fake.address() as { port: number }).port}`
Object.assign(process.env, { GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_TOKEN_URL: `${origin}/token`, GOOGLE_API_URL: `${origin}/api`, PUBLIC_URL: 'http://localhost' })

const { database, encrypt, decrypt, sha256, userGone } = await import('../server/db.ts')
const { googleForTest, startGoogle, finishGoogle, disconnectGoogle, listCalendars, listEvents } = await import('../server/google.ts')
const { currentUser } = await import('../server/auth.ts')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run('google-check', encrypt('none'), now, now)
const user = { id: 1, githubId: 1, login: 'google-check', name: null, avatar: null, githubToken: 'none', githubScopes: [], admin: false }

const row = () => database().prepare('SELECT email, refresh_token, access_token FROM google WHERE user_id = 1').get() as { email: string; refresh_token: string; access_token: string } | undefined
const state = () => {
  const r = row()
  return r ? { email: r.email, refresh: decrypt(r.refresh_token), access: decrypt(r.access_token) } : null
}
const link = (email: string, refresh: string, expiresIn = -1000) => {
  database().prepare('DELETE FROM google WHERE user_id = 1').run()
  database().prepare("INSERT INTO google (user_id, email, refresh_token, access_token, expires_at, scopes, created_at) VALUES (1, ?, ?, ?, ?, '', ?)").run(email, encrypt(refresh), encrypt(`old-access-${refresh}`), Date.now() + expiresIn, Date.now())
}
const settled = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null as T | null, error }))
const waitHeld = async (n: number) => {
  for (let i = 0; i < 300 && held.length < n; i++) await new Promise((r) => setTimeout(r, 10))
}

/** Consent through the real start and finish handlers, with fake request and response objects. */
const fakeRes = () => {
  const r = { status: 0, headers: {} as Record<string, string | string[]>, writeHead(s: number, h: Record<string, string | string[]>) { r.status = s; r.headers = h; return r }, end() {} }
  return r
}
const sid = randomBytes(24).toString('hex')
const addSession = () => database().prepare('INSERT OR REPLACE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), Date.now(), Date.now() + 86400_000)
const request = (cookie: string) => ({ headers: { host: 'localhost', cookie } }) as never
async function consent(code: string, hold: boolean) {
  addSession()
  const start = fakeRes()
  startGoogle(request(`mvlos_sid=${sid}`), start as never)
  const authUrl = new URL(start.headers.Location as string)
  const sealed = /mvlos_google=([^;]*)/.exec(String(start.headers['Set-Cookie']))![1]
  const cookie = `mvlos_sid=${sid}; mvlos_google=${sealed}`
  const req = request(cookie)
  const res = fakeRes()
  const url = new URL(`http://localhost/api/google/callback?code=${hold ? 'code-held' : code}&state=${authUrl.searchParams.get('state')}`)
  const done = finishGoogle(req, res as never, url, currentUser(req)).then(() => res.headers.Location as string)
  return { done }
}

// 1. A refresh is held, then A is replaced by B (a relink), then A's refresh is released.
link('a@example.test', 'refresh-A')
let refresh = settled(googleForTest.accessToken(user))
await waitHeld(1)
let c = await consent('B', false)
check('relink to B completes', (await c.done) === '/?google=ok' && state()?.email === 'B@example.test')
held[0].release()
let r = await refresh
check('held A refresh after relink: refused, no token returned', r.value === null && r.error !== null)
check('...B keeps its own refresh token and access token', state()?.refresh === 'refresh-B' && state()?.access === 'access-B')
held.length = 0

// 2. Disconnect while a refresh is held.
link('a@example.test', 'refresh-A')
refresh = settled(googleForTest.accessToken(user))
await waitHeld(1)
await disconnectGoogle(user)
held[0].release()
r = await refresh
check('disconnect while refreshing: refused, nothing stored or returned', r.value === null && r.error !== null && row() === undefined)
held.length = 0

// 3. The user is deleted while a refresh is held.
link('a@example.test', 'refresh-A')
refresh = settled(googleForTest.accessToken(user))
await waitHeld(1)
userGone(1)
database().prepare('DELETE FROM google WHERE user_id = 1').run()
held[0].release()
r = await refresh
check('user deleted while refreshing: refused and nothing stored', r.value === null && r.error !== null && row() === undefined)
held.length = 0

// 4. A held refresh, then a relink back to rows that look alike: the stored refresh token still decides.
link('a@example.test', 'refresh-A')
refresh = settled(googleForTest.accessToken(user))
await waitHeld(1)
database().prepare('UPDATE google SET refresh_token = ?, email = ? WHERE user_id = 1').run(encrypt('refresh-other'), 'other@example.test') // a change that no bump saw
held[0].release()
r = await refresh
check('row changed without a bump: the compare-and-swap still refuses the stale result', r.value === null && r.error !== null && state()?.refresh === 'refresh-other' && state()?.access === 'old-access-refresh-A')
held.length = 0

// 5. A consent exchange held at Google, then the session is signed out.
database().prepare('DELETE FROM google WHERE user_id = 1').run()
c = await consent('', true)
await waitHeld(1)
database().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid))
held[0].release()
check('consent held, then signed out: refused', (await c.done) === '/?google=signin')
check('...nothing was stored', row() === undefined)
held.length = 0

// 6. A consent exchange held at Google, then the same session completes another link first.
database().prepare('DELETE FROM google WHERE user_id = 1').run()
c = await consent('', true)
await waitHeld(1)
await disconnectGoogle(user) // the link changed meanwhile
held[0].release()
check('consent held, link changed meanwhile: refused and nothing stored', (await c.done) === '/?google=signin' && row() === undefined)
held.length = 0

// 7. Concurrent refreshes of one link share one request, and a later refresh after it works.
link('a@example.test', 'refresh-A')
tokenCalls = 0
const [p1, p2, p3] = [googleForTest.accessToken(user), googleForTest.accessToken(user), googleForTest.accessToken(user)]
await waitHeld(1)
await new Promise((r) => setTimeout(r, 100))
check('three concurrent refreshes make one token request', held.length === 1 && tokenCalls === 1)
held[0].release()
const got = await Promise.all([p1, p2, p3])
check('...and all get the same fresh token, stored', got.every((t) => t === 'access-from-refresh-A') && state()?.access === 'access-from-refresh-A')
held.length = 0

// 8. A stale job finishing does not clear a newer link's job.
link('a@example.test', 'refresh-A')
const oldJob = settled(googleForTest.accessToken(user))
await waitHeld(1)
await disconnectGoogle(user)
link('b@example.test', 'refresh-B')
const newJob = settled(googleForTest.accessToken(user))
await waitHeld(2)
held[0].release() // the old one ends first
await oldJob
const joined = settled(googleForTest.accessToken(user)) // must join the new job, not start a third
await new Promise((r) => setTimeout(r, 100))
check('after the stale job ended, the new link still has exactly one pending request', held.length === 2)
held[1].release()
const [n, j] = await Promise.all([newJob, joined])
check('...and the new link gets its own token, shared', n.value === 'access-from-refresh-B' && j.value === 'access-from-refresh-B')

// --- Reads of the calendar API itself -------------------------------------------------------------
const waitApi = async (n: number) => {
  for (let i = 0; i < 300 && apiHeld.length < n; i++) await new Promise((r) => setTimeout(r, 10))
}
const range = { from: new Date('2029-12-31T00:00:00Z'), to: new Date('2030-01-03T00:00:00Z') }
const events = () => listEvents(user, null, range, (r) => JSON.stringify(r))
const fresh = (email: string, refresh: string) => link(email, refresh, 3600_000)
const reset = () => {
  userGone(1) // drops the cached reads and moves the generation, as a removal does
  gates.clear()
  apiHeld.length = 0
  apiCalls.length = 0
}
const tokenA = 'old-access-refresh-A'
const tokenB = 'old-access-refresh-B'
const leaks = (value: unknown) => JSON.stringify(value ?? null).includes(tokenA)

// 9. Normal reads of one link work, and share their requests.
reset()
fresh('a@example.test', 'refresh-A')
let list = await settled(listCalendars(user))
check('a normal read lists the calendars', list.error === null && list.value?.length === 2)
let ev = await settled(events())
check('a normal aggregate returns every calendar\'s events', ev.error === null && ev.value?.length === 2 && ev.value.every((e) => e.title.includes(tokenA)))

// 10. A delayed body of A's answer after a relink, a disconnect, a removal: nothing comes back.
for (const how of ['relink to B', 'disconnect', 'removal']) {
  reset()
  fresh('a@example.test', 'refresh-A')
  database().prepare('DELETE FROM sessions').run()
  gates.set(`${tokenA}|list`, 'body')
  const slow = settled(listCalendars(user))
  await waitApi(1)
  if (how === 'relink to B') check('relink completes', (await (await consent('B', false)).done) === '/?google=ok')
  else if (how === 'disconnect') await disconnectGoogle(user)
  else (userGone(1), database().prepare('DELETE FROM google WHERE user_id = 1').run())
  apiHeld[0].release()
  const out = await slow
  check(`delayed body after ${how}: refused, nothing of A returned`, out.value === null && out.error !== null && !leaks(out.value))
}

// 11. An aggregate whose first calendar answered under A and second is still waiting when B links.
reset()
fresh('a@example.test', 'refresh-A')
gates.set(`${tokenA}|cal2`, 'full')
const agg = settled(events())
await waitApi(1)
check('the first calendar (A) answered, the second waits', apiCalls.includes(`${tokenA}|cal1`) && apiHeld[0].key === `${tokenA}|cal2`)
await (await consent('B', false)).done
apiHeld[0].release()
const aggOut = await agg
check('aggregate after relink: nothing of A returned, no partial result', aggOut.value === null && aggOut.error !== null && !leaks(aggOut.value))
const bEvents = await settled(events())
check('B then reads only B\'s own events', bEvents.error === null && bEvents.value?.length === 2 && bEvents.value.every((e) => e.title.includes('access-B')))

// 12. A's stale failure does not evict B's pending cache job, and B's requests stay shared.
reset()
fresh('a@example.test', 'refresh-A')
gates.set(`${tokenA}|list`, 'full')
const aList = settled(listCalendars(user))
await waitApi(1)
await disconnectGoogle(user)
fresh('b@example.test', 'refresh-B')
gates.set(`${tokenB}|list`, 'full')
const b1 = settled(listCalendars(user))
await waitApi(2)
apiHeld[0].release() // A answers: stale, fails
const aOut = await aList
const b2 = settled(listCalendars(user))
await new Promise((r) => setTimeout(r, 100))
check('A\'s stale read failed', aOut.value === null && aOut.error !== null)
check('B\'s second request joined the pending one (one request to Google for B)', apiCalls.filter((k) => k === `${tokenB}|list`).length === 1)
apiHeld[1].release()
const [r1, r2] = await Promise.all([b1, b2])
check('...and both get B\'s calendars', r1.value?.[0]?.name.includes(tokenB) === true && r2.value?.[0]?.name.includes(tokenB) === true)

fake.close()
rmSync(DATA, { recursive: true, force: true })
console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
