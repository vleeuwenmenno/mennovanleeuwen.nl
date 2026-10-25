// Checks that Google Calendar consent stays with the account and session that started it
// (server/google.ts), through the real site server against the Google stand-in
// (scripts/google-mock.ts):
//
//   - consent started as A and finished while B is signed in: refused, no token exchange, nothing stored,
//   - the same account and session: connected, stored under A,
//   - the same account in another session: refused,
//   - a tampered, expired or missing state cookie, or a state that does not match it: refused,
//   - every callback outcome clears the state cookie, and the state cannot be replayed.
//
//   node scripts/google-oauth-check.ts
//
// No real accounts. Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { startMockGoogle } from './google-mock.ts'

const google = await startMockGoogle()
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', NOTIFY_WATCH: 'off', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_API_URL: google.api, GOOGLE_TOKEN_URL: `${google.origin}/token` })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const now = Date.now()
const sessions = { a: randomBytes(24).toString('hex'), a2: randomBytes(24).toString('hex'), b: randomBytes(24).toString('hex') }
for (const [id, login] of [[1, 'oauth-a'], [2, 'oauth-b']] as const) database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, login, encrypt('none'), now, now)
for (const [sid, user] of [[sessions.a, 1], [sessions.a2, 1], [sessions.b, 2]] as const) database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), user, now, now + 86400_000)
await server.start()

const stored = () => database().prepare('SELECT user_id FROM google ORDER BY user_id').all().map((r) => (r as { user_id: number }).user_id)
const exchanges = () => google.log.filter((l) => l === 'POST /token').length
const get = (path: string, cookie: string) => fetch(`${server.origin}${path}`, { redirect: 'manual', headers: { Cookie: cookie } })
const stateCookie = (res: Response) => /mvlos_google=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? ''
/** Starts consent as a session; returns the sealed cookie value and the state Google was given. */
async function start(sid: string) {
  const res = await get('/api/google/connect', `mvlos_sid=${sid}`)
  const state = new URL(res.headers.get('location')!).searchParams.get('state')!
  return { cookie: decodeURIComponent(stateCookie(res)), state, res }
}
async function finishAs(sid: string, cookie: string, state: string) {
  const res = await get(`/api/google/callback?code=c&state=${encodeURIComponent(state)}`, `mvlos_sid=${sid}; mvlos_google=${encodeURIComponent(cookie)}`)
  return { location: res.headers.get('location') ?? '', cleared: /mvlos_google=;[^]*Max-Age=0/.test(res.headers.get('set-cookie') ?? '') }
}

const first = await start(sessions.a)
check('the state cookie is sealed (not the plain state), HttpOnly', first.cookie !== first.state && !first.cookie.includes(first.state) && /HttpOnly/.test(first.res.headers.get('set-cookie') ?? ''))

// A starts, B is signed in at the callback.
let r = await finishAs(sessions.b, first.cookie, first.state)
check('A starts, B finishes: refused', r.location === '/?google=error', r.location)
check('...with no token exchange and nothing stored', exchanges() === 0 && stored().length === 0)
check('...and the state cookie cleared', r.cleared)

// The same flow for the right account and session: succeeds once.
r = await finishAs(sessions.a, first.cookie, first.state)
check('the same account and session: connected', r.location === '/?google=ok', r.location)
check('...stored under A only', exchanges() === 1 && stored().join() === '1', stored().join())
check('...and the state cookie cleared', r.cleared)

// Same account, another session.
const second = await start(sessions.a)
r = await finishAs(sessions.a2, second.cookie, second.state)
check('same account, other session: refused, no exchange', r.location === '/?google=error' && exchanges() === 1)

// Tampered, mismatched, missing, expired.
const third = await start(sessions.a)
const flip = third.cookie.slice(0, -2) + (third.cookie.endsWith('AA') ? 'BB' : 'AA')
r = await finishAs(sessions.a, flip, third.state)
check('a tampered cookie: refused, no exchange', r.location === '/?google=error' && exchanges() === 1)
r = await finishAs(sessions.a, third.cookie, 'someotherstate')
check('a state that is not the sealed one: refused, no exchange', r.location === '/?google=error' && exchanges() === 1)
r = await finishAs(sessions.a, third.state, third.state)
check('the plain state as cookie (the old format): refused', r.location === '/?google=error' && exchanges() === 1)
r = await finishAs(sessions.a, '', third.state)
check('no state cookie: refused', r.location === '/?google=error' && exchanges() === 1)
check('...and cleared', r.cleared)

// Expired: seal a state that lapsed with the server's own key.
const { encrypt: seal } = await import('../server/db.ts')
const lapsed = seal(JSON.stringify({ n: 'old', u: 1, s: sha256(sessions.a), e: Date.now() - 1000 }))
r = await finishAs(sessions.a, lapsed, 'old')
check('an expired state: refused, no exchange', r.location === '/?google=error' && exchanges() === 1)
const live = seal(JSON.stringify({ n: 'fresh', u: 1, s: sha256(sessions.a), e: Date.now() + 60_000 }))
r = await finishAs(sessions.a, live, 'fresh')
check('the same seal unexpired: accepted (so expiry was the reason)', r.location === '/?google=ok' && exchanges() === 2)

// Signed out between start and callback.
const fourth = await start(sessions.a)
database().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sessions.a))
r = await finishAs(sessions.a, fourth.cookie, fourth.state)
check('signed out meanwhile: refused, no exchange', r.location === '/?google=signin' && exchanges() === 2)

// Not signed in at all cannot even start.
const anon = await get('/api/google/connect', '')
check('connect without a session does not set a state', !stateCookie(anon))

await server.dispose()
await google.close()
finish()
