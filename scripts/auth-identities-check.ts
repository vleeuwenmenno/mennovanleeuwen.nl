// Checks sign-in identities (server/auth.ts, server/googleSignIn.ts, server/oidc.ts, server/db.ts)
// through the real site server, against stand-ins for GitHub and Google that sign real RS256 ID
// tokens:
//
//   - an install from before (users.github_id NOT NULL) is migrated in place: same account ids,
//     rows, sessions and admin; GitHub identities copied in; foreign keys still on,
//   - GitHub sign-in finds the same account; admin stays tied to the GitHub numeric id,
//   - Google sign-in makes a new account (never an admin, even with a `sub` equal to an admin's
//     GitHub id), and never joins an account because the email matches (a calendar or GitHub one),
//   - ID tokens are refused for a bad signature, unknown key, alg none, wrong issuer, audience or
//     nonce, expiry; PKCE's verifier reaches the token endpoint,
//   - states work once (replays refused before any token exchange), and expire,
//   - linking: only from the signed-in account's own page (same-origin, its account header), only
//     finished by the same account and session; an identity of another account is refused (no
//     merge); one per provider; GitHub linked to a Google account brings no admin unless it is the
//     admin's id; unlinking never removes the last sign-in,
//   - bans and the registration limits hold for every sign-in,
//   - removing GitHub from an admin ends admin rights and signs the account out everywhere,
//   - one address starting many sign-ins only pushes out its own pending ones, never another's
//     (addresses: IPv6 by /64, forwarded only from trusted proxies).
//
//   node scripts/auth-identities-check.ts
//
// No real accounts. Exits 1 on any failure.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { Server, check, finish, sleep } from './empires-harness.ts'

// ---- Stand-ins for GitHub and Google ----

const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const good = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'kid-1'

type GoogleCode = { claims: Record<string, unknown>; challenge: string; key?: KeyObject; kid?: string; alg?: string }
const googleCodes = new Map<string, GoogleCode>()
const githubUsers = new Map<string, { id: number; login: string; name: string | null }>()
const log: string[] = []

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(c: GoogleCode) {
  const head = b64({ alg: c.alg ?? 'RS256', kid: c.kid ?? KID, typ: 'JWT' })
  const body = b64(c.claims)
  if (c.alg === 'none') return `${head}.${body}.`
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), c.key ?? good.privateKey).toString('base64url')}`
}
const read = async (req: IncomingMessage) => {
  let s = ''
  for await (const c of req) s += c
  return s
}
const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))

const mock = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  log.push(`${req.method} ${url.pathname}`)
  if (url.pathname === '/certs') return send(res, 200, { keys: [{ ...good.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] })
  if (url.pathname === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(await read(req))
    const c = googleCodes.get(form.get('code') ?? '')
    googleCodes.delete(form.get('code') ?? '')
    if (!c || form.get('client_id') !== CLIENT_ID || form.get('grant_type') !== 'authorization_code') return send(res, 400, { error: 'invalid_grant' })
    // PKCE: the verifier has to match the challenge the authorization request carried.
    if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return send(res, 400, { error: 'invalid_grant', pkce: true })
    return send(res, 200, { access_token: 'ignored', id_token: idToken(c), expires_in: 3600 })
  }
  if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
    const body = JSON.parse(await read(req)) as { code: string }
    return githubUsers.has(body.code) ? send(res, 200, { access_token: `gh-${body.code}`, scope: 'read:user' }) : send(res, 200, { error: 'bad_verification_code' })
  }
  if (url.pathname === '/user') {
    const code = /^Bearer gh-(.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const u = code && githubUsers.get(code)
    return u ? send(res, 200, { ...u, avatar_url: null }) : send(res, 401, {})
  }
  send(res, 404, {})
})
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()))
const MOCK = `http://127.0.0.1:${(mock.address() as { port: number }).port}`

// ---- An install from before Google sign-in ----

const server = new Server({
  GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret', GITHUB_WEB_URL: MOCK, GITHUB_API_URL: MOCK,
  GOOGLE_SIGNIN: 'on', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'g-secret', GOOGLE_AUTH_URL: `${MOCK}/auth`, GOOGLE_TOKEN_URL: `${MOCK}/token`, GOOGLE_JWKS_URL: `${MOCK}/certs`,
  ADMIN_GITHUB_IDS: '1001', AUTH_STATE_TTL_MS: '4000', NOTIFY_WATCH: 'off',
})
{
  const old = new DatabaseSync(join(server.data, 'mvlos.db'))
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT, avatar TEXT, github_token TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
    ALTER TABLE users ADD COLUMN banned_at INTEGER;
    ALTER TABLE users ADD COLUMN ban_reason TEXT;
    ALTER TABLE users ADD COLUMN github_scopes TEXT;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE state (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, key));
    CREATE TABLE google (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL, refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `)
  const now = Date.now()
  // Ids with a gap, as after a deletion: they must stay exactly these.
  for (const [id, gh, login] of [[1, 1001, 'admin'], [5, 2002, 'bob'], [9, 3003, 'carol']] as const) old.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, gh, login, 'sealed-elsewhere', now, now)
  old.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('old-session', 5, now, now + 86400_000)
  for (const id of [1, 5, 9]) old.prepare('INSERT INTO state VALUES (?, ?, ?, ?)').run(id, 'notes', `notes of ${id}`, now)
  // The admin connected Google Calendar with alice@example.test: that address links nothing.
  old.prepare('INSERT INTO google (user_id, email, refresh_token, created_at) VALUES (?, ?, ?, ?)').run(1, 'alice@example.test', 'x', now)
  old.close()
}
process.env.DATA_DIR = server.data
const { database } = await import('../server/db.ts')
const db = database()
const col = (db.prepare('PRAGMA table_info(users)').all() as { name: string; notnull: number }[]).find((c) => c.name === 'github_id')
check('migration: users.github_id is nullable now', col?.notnull === 0)
check('migration: same account ids and GitHub ids', JSON.stringify(db.prepare('SELECT id, github_id, login FROM users ORDER BY id').all().map((r) => Object.values(r as object))) === JSON.stringify([[1, 1001, 'admin'], [5, 2002, 'bob'], [9, 3003, 'carol']]))
check('migration: synced state, sessions and calendar rows all kept', (db.prepare('SELECT COUNT(*) AS n FROM state').get() as { n: number }).n === 3 && (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n === 1 && (db.prepare('SELECT COUNT(*) AS n FROM google').get() as { n: number }).n === 1)
check('migration: GitHub identities copied in', JSON.stringify(db.prepare("SELECT subject, user_id FROM identities WHERE provider = 'github' ORDER BY user_id").all().map((r) => Object.values(r as object))) === JSON.stringify([['1001', 1], ['2002', 5], ['3003', 9]]))
check('migration: foreign keys on again, nothing dangling', (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1 && db.prepare('PRAGMA foreign_key_check').all().length === 0)
check('migration: no leftover table', !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'users_rebuilt'").get())

await server.start()
const ORIGIN = server.origin

// ---- Helpers: a browser with a cookie jar ----

class Browser {
  jar = new Map<string, string>()
  /** Sent with every request: X-Forwarded-For makes it another address (the stand-in proxy is local). */
  headers: Record<string, string> = {}
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)]
      if (/Max-Age=0/.test(c)) this.jar.delete(k)
      else this.jar.set(k, v)
    }
    return res
  }
  async get(path: string) {
    return this.take(await fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: { ...this.headers, Cookie: this.cookie } }))
  }
  async send(method: string, path: string, headers: Record<string, string> = {}) {
    return this.take(await fetch(`${ORIGIN}${path}`, { method, redirect: 'manual', headers: { Cookie: this.cookie, 'Content-Type': 'application/json', 'X-MvL-Account': this.jar.get('mvlos_uid') ?? 'visitor', ...headers }, body: method === 'DELETE' ? undefined : '{}' }))
  }
  async me() {
    return (await (await this.get('/api/me')).json()) as { user: { id: number; login: string; admin: boolean; github: boolean; identities: { provider: string; label: string }[] } | null; signIn: { github: boolean; google: boolean } }
  }
  clone() {
    const b = new Browser()
    b.jar = new Map(this.jar)
    b.headers = { ...this.headers }
    return b
  }
}

const loc = (res: Response) => res.headers.get('location') ?? ''
const tokenCalls = () => log.filter((l) => l === 'POST /token').length

/** Starts Google (sign-in, or a link from the page) and returns what Google was asked. */
async function googleStart(b: Browser, link = false) {
  const res = link ? await b.send('POST', '/api/auth/google/link') : await b.get('/api/auth/google/login')
  const to = link ? ((await res.json()) as { url?: string }).url ?? '' : loc(res)
  if (!to.startsWith(`${MOCK}/auth?`)) return { status: res.status, state: '', nonce: '', challenge: '', params: new URLSearchParams() }
  const params = new URL(to).searchParams
  return { status: res.status, state: params.get('state')!, nonce: params.get('nonce')!, challenge: params.get('code_challenge')!, params }
}
const now = () => Math.floor(Date.now() / 1000)
const claims = (sub: string, nonce: string, extra: Record<string, unknown> = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, email: `${sub}@example.test`, email_verified: true, name: sub, iat: now(), exp: now() + 600, nonce, ...extra })
async function googleFinish(b: Browser, s: { state: string; challenge: string }, c: Omit<GoogleCode, 'challenge'>) {
  const code = randomBytes(6).toString('hex')
  googleCodes.set(code, { ...c, challenge: s.challenge })
  return loc(await b.get(`/api/auth/google/callback?code=${code}&state=${encodeURIComponent(s.state)}`))
}
/** A whole Google sign-in for `sub` in browser `b`. */
async function googleSignIn(b: Browser, sub: string, extra: Record<string, unknown> = {}) {
  const s = await googleStart(b)
  return googleFinish(b, s, { claims: claims(sub, s.nonce, extra) })
}
async function githubStart(b: Browser, link = false) {
  const res = link ? await b.send('POST', '/api/auth/github/link') : await b.get('/api/auth/github/login')
  const to = link ? ((await res.json()) as { url?: string }).url ?? '' : loc(res)
  return { status: res.status, state: to ? new URL(to).searchParams.get('state') ?? '' : '' }
}
async function githubFinish(b: Browser, state: string, user: { id: number; login: string }) {
  const code = randomBytes(6).toString('hex')
  githubUsers.set(code, { ...user, name: null })
  return loc(await b.get(`/api/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`))
}
async function githubSignIn(b: Browser, user: { id: number; login: string }) {
  const s = await githubStart(b)
  return githubFinish(b, s.state, user)
}

// ---- GitHub sign-in keeps accounts and admin ----

const admin = new Browser()
let r = await githubSignIn(admin, { id: 1001, login: 'admin-renamed' })
let me = await admin.me()
check('GitHub sign-in after the migration: same account (id 1), admin', r === '/?auth=ok' && me.user?.id === 1 && me.user.admin && me.user.github)
check('/api/me lists GitHub and Google as available sign-ins', me.signIn.github && me.signIn.google)
{
  const b = new Browser()
  const s = await githubStart(b)
  const sealed = decodeURIComponent(b.jar.get('mvlos_oauth') ?? '')
  check('the GitHub state cookie is sealed (the state is not readable in it)', !!s.state && !!sealed && !sealed.includes(s.state))
}

// ---- Google sign-in: new accounts, never by email, never admin ----

const alice = new Browser()
const aliceStart = await googleStart(alice)
check('Google is asked for openid email profile only, with PKCE S256, a nonce and a state', aliceStart.params.get('scope') === 'openid email profile' && aliceStart.params.get('code_challenge_method') === 'S256' && aliceStart.nonce.length >= 16 && aliceStart.state.length >= 16 && !aliceStart.params.has('access_type'))
r = await googleFinish(alice, aliceStart, { claims: claims('g-alice', aliceStart.nonce, { email: 'alice@example.test' }) })
me = await alice.me()
check('Google sign-in with an address the admin uses for Calendar: a new, separate account', r === '/?auth=ok' && !!me.user && me.user.id !== 1 && !me.user.admin && !me.user.github)
check('...named from the address, with an underscore (never a GitHub login)', me.user?.login === 'alice_g')
check('...with Google as its only sign-in', JSON.stringify(me.user?.identities.map((i) => i.provider)) === '["google"]')
const aliceId = me.user!.id
const replay = tokenCalls()
r = await googleFinish(alice, aliceStart, { claims: claims('g-alice', aliceStart.nonce) })
check('replaying a used state is refused before any token exchange', r === '/?auth=error' && tokenCalls() === replay)

const sneaky = new Browser()
r = await googleSignIn(sneaky, '1001')
me = await sneaky.me()
check("a Google sub equal to the admin's GitHub id: not an admin, not the admin's account", r === '/?auth=ok' && !!me.user && me.user.id !== 1 && !me.user.admin)

// ID token checks: each refused, nothing signed in.
const refusals: [string, (nonce: string) => Omit<GoogleCode, 'challenge'>][] = [
  ['a bad signature', (n) => ({ claims: claims('g-x', n), key: rogue.privateKey })],
  ['an unknown key id', (n) => ({ claims: claims('g-x', n), kid: 'nope' })],
  ['alg none', (n) => ({ claims: claims('g-x', n), alg: 'none' })],
  ['the wrong issuer', (n) => ({ claims: claims('g-x', n, { iss: 'https://evil.example' }) })],
  ['the wrong audience', (n) => ({ claims: claims('g-x', n, { aud: 'someone-else' }) })],
  ['the wrong nonce', () => ({ claims: claims('g-x', 'not-the-nonce') })],
  ['an expired token', (n) => ({ claims: claims('g-x', n, { exp: now() - 3600, iat: now() - 7200 }) })],
  ['no subject', (n) => ({ claims: claims('', n) })],
]
for (const [what, make] of refusals) {
  const b = new Browser()
  const s = await googleStart(b)
  r = await googleFinish(b, s, make(s.nonce))
  check(`ID token with ${what}: refused`, r === '/?auth=error' && !(await b.me()).user)
}
{
  const b = new Browser()
  const s = await googleStart(b)
  const code = randomBytes(6).toString('hex')
  googleCodes.set(code, { claims: claims('g-x', s.nonce), challenge: 'not-the-challenge' })
  r = loc(await b.get(`/api/auth/google/callback?code=${code}&state=${encodeURIComponent(s.state)}`))
  check('a PKCE verifier that does not match: refused by the token endpoint, not signed in', r === '/?auth=error' && !(await b.me()).user)
}
{
  const b = new Browser()
  const s = await googleStart(b)
  b.jar.delete('mvlos_oidc')
  r = await googleFinish(b, s, { claims: claims('g-x', s.nonce) })
  check('a callback without the sealed cookie (another browser): refused', r === '/?auth=error' && !(await b.me()).user)
}
{
  const b = new Browser()
  const s = await googleStart(b)
  await sleep(4500)
  r = await googleFinish(b, s, { claims: claims('g-x', s.nonce) })
  check('an expired state: refused', r === '/?auth=error' && !(await b.me()).user)
}
check('no account was made by any refused sign-in', !db.prepare("SELECT 1 FROM identities WHERE subject = 'g-x'").get())

// ---- Linking ----

// The admin links Google, from their own page.
let link = await googleStart(admin, true)
check('link start: answered with Google, from the signed-in page', link.status === 200 && !!link.state)
{
  // Finished in another session of the same account: refused.
  const other = new Browser()
  await githubSignIn(other, { id: 1001, login: 'admin-renamed' })
  const mid = other.clone()
  mid.jar.set('mvlos_oidc', admin.jar.get('mvlos_oidc')!)
  r = await googleFinish(mid, link, { claims: claims('g-admin', link.nonce) })
  check('a link finished in another session of the same account: refused', r === '/?auth=error' && !db.prepare("SELECT 1 FROM identities WHERE subject = 'g-admin'").get())
}
link = await googleStart(admin, true)
{
  // Finished while another account is signed in (the sealed cookie carried over): refused.
  const thief = alice.clone()
  thief.jar.set('mvlos_oidc', admin.jar.get('mvlos_oidc')!)
  r = await googleFinish(thief, link, { claims: claims('g-admin', link.nonce) })
  check('a link finished while another account is signed in: refused', r === '/?auth=error' && !db.prepare("SELECT 1 FROM identities WHERE subject = 'g-admin'").get())
}
link = await googleStart(admin, true)
r = await googleFinish(admin, link, { claims: claims('g-admin', link.nonce) })
me = await admin.me()
check('the admin links Google: linked, still admin, same account', r === '/?auth=linked-google' && me.user?.id === 1 && me.user.admin && JSON.stringify(me.user.identities.map((i) => i.provider).sort()) === '["github","google"]')
check('linking twice is refused (one Google account per account)', (await googleStart(admin, true)).status === 409)
{
  const b = new Browser()
  r = await googleSignIn(b, 'g-admin')
  me = await b.me()
  check('Google sign-in with the linked account: the admin account, admin', r === '/?auth=ok' && me.user?.id === 1 && me.user.admin)
}

// Bob (GitHub) tries to link Alice's Google: no merge.
const bob = new Browser()
await githubSignIn(bob, { id: 2002, login: 'bob' })
link = await googleStart(bob, true)
r = await googleFinish(bob, link, { claims: claims('g-alice', link.nonce) })
check("linking a Google account that has its own account: refused, both stay as they were", r === '/?auth=link-taken' && (db.prepare("SELECT user_id FROM identities WHERE provider = 'google' AND subject = 'g-alice'").get() as { user_id: number }).user_id === aliceId)

// Alice tries to link the admin's GitHub: no merge, no admin.
let gh = await githubStart(alice, true)
r = await githubFinish(alice, gh.state, { id: 1001, login: 'admin-renamed' })
me = await alice.me()
check("linking the admin's GitHub to another account: refused, no admin", r === '/?auth=link-taken' && !me.user?.admin && !me.user?.github)
// Alice links a new GitHub account.
gh = await githubStart(alice, true)
r = await githubFinish(alice, gh.state, { id: 4004, login: 'alice-gh' })
me = await alice.me()
check('Alice links her own GitHub: linked, not admin, same account', r === '/?auth=linked-github' && me.user?.id === aliceId && me.user.github && !me.user.admin)
{
  const b = new Browser()
  await githubSignIn(b, { id: 4004, login: 'alice-gh' })
  check('GitHub sign-in with it: Alice\'s account', (await b.me()).user?.id === aliceId)
}
check('GitHub link replay refused', (await githubFinish(alice, gh.state, { id: 4004, login: 'alice-gh' })) === '/?auth=error')

// The page-side guards on starting a link.
check('link start from another site: refused', (await alice.send('POST', '/api/auth/google/link', { Origin: 'http://evil.example' })).status === 403)
check("link start from a page that doesn't say its account: refused", (await alice.send('POST', '/api/auth/google/link', { 'X-MvL-Account': '' })).status === 409)
check('link start signed out: refused', (await new Browser().send('POST', '/api/auth/google/link')).status === 401)

// Unlinking.
const carol = new Browser()
await githubSignIn(carol, { id: 3003, login: 'carol' })
check("unlinking the only sign-in: refused", (await carol.send('DELETE', '/api/auth/identities/github')).status === 409)
check('unlinking Google from the admin: ok', (await admin.send('DELETE', '/api/auth/identities/google')).status === 200)
{
  const b = new Browser()
  await googleSignIn(b, 'g-admin')
  me = await b.me()
  check('...and that Google account then signs up as a new account, not the admin', !!me.user && me.user.id !== 1 && !me.user.admin)
}
check("unlinking GitHub from Alice: ok, she keeps Google", (await alice.send('DELETE', '/api/auth/identities/github')).status === 200 && (await alice.me()).user?.github === false)
check('unlinking an unknown provider: 404', (await alice.send('DELETE', '/api/auth/identities/facebook')).status === 404)

// ---- Bans and registration ----

db.prepare("UPDATE users SET banned_at = ?, ban_reason = 'spam' WHERE id = ?").run(Date.now(), aliceId)
{
  const b = new Browser()
  r = await googleSignIn(b, 'g-alice')
  check('a banned account cannot sign in with Google', r.startsWith('/?auth=banned') && !(await b.me()).user)
  check("...and the ban signs out Alice's session too", !(await alice.me()).user)
}
db.prepare("INSERT INTO app_settings (key, value) VALUES ('registration', 'closed') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run()
{
  const b = new Browser()
  check('registration closed: a new Google account is turned away', (await googleSignIn(b, 'g-new')) === '/?auth=closed' && !(await b.me()).user)
  const c = new Browser()
  check('registration closed: an existing account still signs in', (await githubSignIn(c, { id: 2002, login: 'bob' })) === '/?auth=ok')
}
db.prepare("UPDATE app_settings SET value = 'open' WHERE key = 'registration'").run()
const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
db.prepare("INSERT INTO app_settings (key, value) VALUES ('max_users', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(count))
check('full: a new Google account is turned away', (await googleSignIn(new Browser(), 'g-new2')) === '/?auth=full')
check('full: a new GitHub account is turned away', (await githubSignIn(new Browser(), { id: 5005, login: 'dave' })) === '/?auth=full')
check('full: the admin still gets in', (await githubSignIn(new Browser(), { id: 1001, login: 'admin-renamed' })) === '/?auth=ok')

// ---- Removing GitHub from an admin ----

db.prepare("UPDATE app_settings SET value = '1000' WHERE key = 'max_users'").run()
link = await googleStart(admin, true)
r = await googleFinish(admin, link, { claims: claims('g-admin2', link.nonce) })
check('the admin links another Google account', r === '/?auth=linked-google' && (await admin.me()).user?.admin === true)
{
  const res = await admin.send('DELETE', '/api/auth/identities/github')
  const body = (await res.json()) as { signedOut?: boolean }
  check('removing GitHub from the admin: done, and says it signed the account out', res.status === 200 && body.signedOut === true)
  check('...every session of the account ended', !(await admin.me()).user && (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 1').get() as { n: number }).n === 0)
  const b = new Browser()
  await googleSignIn(b, 'g-admin2')
  me = await b.me()
  check('...and signing in with Google gives the same account, no longer an admin', me.user?.id === 1 && !me.user.admin && !me.user.github)
}

// ---- One address can't push out another's sign-ins ----

{
  // Two browsers behind the same address (one browser holds one round trip's cookie).
  const victim = new Browser()
  victim.headers = { 'X-Forwarded-For': '203.0.113.5' }
  const victim2 = victim.clone()
  const v = await googleStart(victim)
  const own = await googleStart(victim2)
  const flood = new Browser()
  flood.headers = { 'X-Forwarded-For': '198.51.100.7' }
  for (let i = 0; i < 60; i++) await flood.get('/api/auth/google/login')
  r = await googleFinish(victim, v, { claims: claims('g-victim', v.nonce) })
  check("another address starting 60 sign-ins doesn't push out this one's", r === '/?auth=ok')
  for (let i = 0; i < 25; i++) await victim.clone().get('/api/auth/google/login')
  r = await googleFinish(victim2, own, { claims: claims('g-victim', own.nonce) })
  check('the same address starting more than its share gives up its own oldest', r === '/?auth=error')
}

// ---- Client addresses for the per-address cap (server/egress.ts) ----

{
  const { clientIp } = await import('../server/egress.ts')
  const ip = (peer: string, xff?: string) => clientIp({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} } as never)
  check('IPv6 addresses of one /64 share a key however they are written', new Set([ip('2001:db8::1'), ip('2001:db8:0:0::2'), ip('2001:0db8:0000:0000:ffff::3')]).size === 1)
  check('a forwarded address is used only from a proxy, and only when it is an address', ip('127.0.0.1', '203.0.113.9') === '203.0.113.9' && ip('127.0.0.1', 'not-an-ip') === '127.0.0.1' && ip('8.8.8.8', '1.2.3.4') === '8.8.8.8')
  process.env.TRUSTED_PROXIES = '10.0.0.1'
  check('with TRUSTED_PROXIES, other private peers are not trusted', ip('10.0.0.2', '1.1.1.1') === '10.0.0.2' && ip('10.0.0.1', '1.1.1.1') === '1.1.1.1')
  delete process.env.TRUSTED_PROXIES
}

await server.dispose()
mock.close()
finish()
