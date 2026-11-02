// Native Android push, server side, with a FAKE Google (no network, no real key): `node scripts/native-push-check.ts`.
// The two-step registration, the capability and revocation key, what leaves for Google, the one-time
// content, session / ban cascades, UNREGISTERED handling, rate limits and the deep-link table.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'native-push-check-'))
Object.assign(process.env, { DATA_DIR: dir, NOTIFY_WATCH: 'off', MC_WATCH: 'off' })
delete process.env.FCM_SERVICE_ACCOUNT_FILE

const { database } = await import('../server/db.ts')
const { setFcmTransport, fcmProject } = await import('../server/fcm.ts')
const np = await import('../server/nativepush.ts')

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}
const throwsStatus = async (what: string, status: number, fn: () => unknown) => {
  try {
    await fn()
    check(what, false, 'did not throw')
  } catch (e) {
    check(what, (e as { status?: number }).status === status, { status: (e as { status?: number }).status, message: (e as Error).message })
  }
}

const db = database()
const now = Date.now()
const addUser = (id: number, login: string) => db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, login, 'x', now, now)
const addSession = (id: string, user: number) => db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(id, user, now, now + 86_400_000)
addUser(1, 'alice')
addUser(2, 'bob')
addSession('s-alice-1', 1)
addSession('s-alice-2', 1)
addSession('s-bob-1', 2)
const alice = { id: 1, login: 'alice' } as never
const bob = { id: 2, login: 'bob' } as never

let ipN = 0
const req = (headers: Record<string, string> = {}, ip = `203.0.113.${++ipN % 250}`) => ({ headers: { 'x-mvl-app-push': '1', ...headers }, socket: { remoteAddress: ip } }) as never
const bearer = (secret: string, extra: Record<string, string> = {}) => req({ authorization: `Bearer ${secret}`, ...extra })
const install = (n: number) => `install-${String(n).padStart(20, '0')}-abc`.slice(0, 40)
const TOKEN = (n: number) => `tok-${String(n).padStart(24, '0')}:APA91b-fake_token`

// 1. Off without a sending identity.
check('no key file: not enabled', fcmProject() === null && np.nativeConfig(alice).enabled === false)
await throwsStatus('no key file: prepare is refused', 503, () => np.prepare(req(), alice, 's-alice-1', { installId: install(1) }))

// A fake Google and a fake service-account file (a throwaway key made right here).
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
writeFileSync(join(dir, 'sa.json'), JSON.stringify({ type: 'service_account', project_id: 'fake-project-1', client_email: 'sender@fake-project-1.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }))
process.env.FCM_SERVICE_ACCOUNT_FILE = join(dir, 'sa.json')
type Sent = { project: string; accessToken: string; message: any }
const sent: Sent[] = []
let tokenCalls = 0
let reply: (m: any) => { status: number; body: unknown; retryAfter?: number } = () => ({ status: 200, body: { name: 'ok' } })
setFcmTransport({
  async token(assertion) {
    tokenCalls++
    const [h, p, s] = assertion.split('.')
    assert(h && p && s, 'a signed JWT')
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token')
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging')
    return { status: 200, body: { access_token: 'fake-access-token', expires_in: 3600 } }
  },
  async send(project, accessToken, message) {
    sent.push({ project, accessToken, message })
    return reply(message)
  },
})
check('with a key file: enabled for its project', fcmProject() === 'fake-project-1' && np.nativeConfig(alice).projectId === 'fake-project-1')

// 2. Two-step registration.
await throwsStatus('prepare without the app header is refused', 400, () => np.prepare({ headers: {}, socket: { remoteAddress: '203.0.113.1' } } as never, alice, 's-alice-1', { installId: install(1) }))
await throwsStatus('prepare with a bad installation id is refused', 400, () => np.prepare(req(), alice, 's-alice-1', { installId: 'short' }))
const p1 = np.prepare(req(), alice, 's-alice-1', { installId: install(1), device: 'Pixel\u0000 7' })
check('prepare is inert: no active registration, nothing changed', np.nativeConfig(alice).devices.length === 0 && p1.replaces === null && p1.login === 'alice')
await throwsStatus('activate by another account is refused', 410, () => np.activate(req(), bob, 's-bob-1', { prep: p1.prep }))
await throwsStatus('activate from another session is refused', 410, () => np.activate(req(), alice, 's-alice-2', { prep: p1.prep }))
const a1 = np.activate(req(), alice, 's-alice-1', { prep: p1.prep })
check('activate hands out a capability and a revocation key for the registration', a1.cap.startsWith(`${p1.prep}.`) && a1.rev.startsWith(`${p1.prep}.`) && a1.cap !== a1.rev)
await throwsStatus('a preparation works once', 410, () => np.activate(req(), alice, 's-alice-1', { prep: p1.prep }))
const stored = JSON.stringify(db.prepare('SELECT * FROM native_push_regs').all())
check('secrets are kept as hashes only', !stored.includes(a1.cap.split('.')[1]) && !stored.includes(a1.rev.split('.')[1]))
check('the device name is cleaned', np.nativeConfig(alice).devices[0]?.name === 'Pixel 7')

// Replacement is a compare-and-swap: a stalled older preparation cannot clobber a newer registration.
const pOld = np.prepare(req(), alice, 's-alice-1', { installId: install(1) })
const pNew = np.prepare(req(), alice, 's-alice-1', { installId: install(1) })
check('a new preparation names the registration it would replace', pOld.replaces === p1.prep && pNew.replaces === p1.prep)
const a2 = np.activate(req(), alice, 's-alice-1', { prep: pNew.prep })
check('activating replaces the old registration (and only it)', np.nativeConfig(alice).devices.map((d) => d.rid).join() === pNew.prep)
await throwsStatus('the stalled older preparation no longer wins', 409, () => np.activate(req(), alice, 's-alice-1', { prep: pOld.prep }))
await throwsStatus('the replaced capability is dead', 401, () => np.setToken(bearer(a1.cap), Promise.resolve({ token: TOKEN(1) })))
const expired = np.prepare(req(), alice, 's-alice-1', { installId: install(9) })
db.prepare('UPDATE native_push_regs SET expires_at = ? WHERE rid = ?').run(Date.now() - 1, expired.prep)
await throwsStatus('an expired preparation is refused', 410, () => np.activate(req(), alice, 's-alice-1', { prep: expired.prep }))

// 3. The capability: token only; the revocation key can do nothing else.
await throwsStatus('a missing bearer is refused', 401, () => np.setToken(req(), Promise.resolve({ token: TOKEN(1) })))
await throwsStatus('a wrong secret is refused', 401, () => np.setToken(bearer(`${pNew.prep}.${'A'.repeat(43)}`), Promise.resolve({ token: TOKEN(1) })))
await throwsStatus('the revocation key cannot set a token', 401, () => np.setToken(bearer(a2.rev), Promise.resolve({ token: TOKEN(1) })))
await throwsStatus('a bad token is refused', 400, () => np.setToken(bearer(a2.cap), Promise.resolve({ token: 'no spaces allowed here!!' })))
await np.setToken(bearer(a2.cap), Promise.resolve({ token: TOKEN(1) }))
check('the token is stored sealed, with a digest', (db.prepare('SELECT token_enc, token_digest FROM native_push_regs WHERE rid = ?').get(pNew.prep) as { token_enc: string; token_digest: string }).token_enc !== TOKEN(1))
// A token belongs to one registration.
const bp = np.prepare(req(), bob, 's-bob-1', { installId: install(2) })
const b1 = np.activate(req(), bob, 's-bob-1', { prep: bp.prep })
await throwsStatus('another registration cannot take the same token', 409, () => np.setToken(bearer(b1.cap), Promise.resolve({ token: TOKEN(1) })))
await np.setToken(bearer(b1.cap), Promise.resolve({ token: TOKEN(2) }))
// A registration that ends while the body is on its way cannot set a token.
await throwsStatus('ended while the body arrived: refused', 401, () => np.setToken(bearer(a2.cap), (async () => { db.prepare('UPDATE native_push_regs SET state = ? WHERE rid = ?').run('revoked', pNew.prep); return { token: TOKEN(3) } })()))
db.prepare('UPDATE native_push_regs SET state = ? WHERE rid = ?').run('active', pNew.prep)

// 4. Sending: only ids go to Google.
let notice = { source: 'mail.new', title: 'Secret subject', body: 'Secret body text', action: { app: 'mail', props: { message: '<id@host>' } } }
let r = await np.pushNative(alice, notice)
check('a message was sent for the account\'s one phone', r.sent === 1 && r.failed === 0 && sent.length === 1, r)
const m = sent[0].message
check('the message is data only, ids only, high priority, short ttl', !('notification' in m) && m.token === TOKEN(1) && m.data.v === '1' && m.data.rid === pNew.prep && /^[A-Za-z0-9_-]{22}$/.test(m.data.nid) && m.data.k === 'mail' && Object.keys(m.data).sort().join() === 'k,nid,rid,v' && m.android.priority === 'HIGH' && m.android.ttl === '900s', m)
check('nothing the user reads leaves for Google', !JSON.stringify(sent[0]).includes('Secret'))
check('the access token came from the signed JWT, once', sent[0].accessToken === 'fake-access-token' && tokenCalls === 1)
const nid = m.data.nid as string

// 5. The content is handed out once, to its own registration, after the settings are asked again.
await throwsStatus('another registration cannot read it (and does not use it up)', 404, () => np.takeContent(bearer(b1.cap), nid))
await throwsStatus('the revocation key cannot read it', 401, () => np.takeContent(bearer(a2.rev), nid))
const got = np.takeContent(bearer(a2.cap), nid)
check('the owner gets the title, line and a safe address', got.title === 'Secret subject' && got.body === 'Secret body text' && got.path === '/?open=mail', got)
await throwsStatus('a second fetch is the same 404', 404, () => np.takeContent(bearer(a2.cap), nid))
await throwsStatus('an unknown id is the same 404', 404, () => np.takeContent(bearer(a2.cap), 'A'.repeat(22)))
await np.pushNative(alice, { source: 'agents.answer', title: 't', action: { app: 'agents', props: { thread: '0123abcd-0123-0123-0123-0123456789ab' } } })
const nid2 = sent[1].message.data.nid as string
db.prepare('UPDATE native_push_content SET expires_at = ? WHERE nid = ?').run(Date.now() - 1, nid2)
await throwsStatus('expired content is the same 404', 404, () => np.takeContent(bearer(a2.cap), nid2))
np.setNativePolicy(() => false)
await np.pushNative(alice, notice)
await throwsStatus('content for something switched off since is not released', 404, () => np.takeContent(bearer(a2.cap), sent[2].message.data.nid))
check('... and it was used up, not left around', (db.prepare('SELECT COUNT(*) AS n FROM native_push_content WHERE nid = ?').get(sent[2].message.data.nid) as { n: number }).n === 0)
np.setNativePolicy(() => true)

// 6. Deep-link table.
check('agents thread ids pass', np.nativePath({ app: 'agents', props: { thread: '0123abcd-0123-0123-0123-0123456789ab' } }) === '/?open=agents&thread=0123abcd-0123-0123-0123-0123456789ab')
check('anything but an id is dropped', np.nativePath({ app: 'agents', props: { thread: '../../evil', run: 'x'.repeat(36) } }) === '/?open=agents')
check('an unknown or hostile app opens the home', np.nativePath({ app: 'terminal', props: { cmd: 'rm -rf /' } }) === '/' && np.nativePath({ app: '__proto__' }) === '/' && np.nativePath({ app: 'https://evil.example' }) === '/' && np.nativePath(undefined) === '/')
check('mail messages are not deep-linked', np.nativePath({ app: 'mail', props: { message: 'abc' } }) === '/?open=mail')
check('the coarse kind', np.kindOf('mail.new') === 'mail' && np.kindOf('minecraft.join') === 'generic')

// 7. FCM errors: only UNREGISTERED removes a token, and only the one that was sent.
reply = () => ({ status: 400, body: { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } } })
r = await np.pushNative(alice, notice)
check('INVALID_ARGUMENT is a failure that keeps the token', r.failed === 1 && (db.prepare('SELECT token_digest FROM native_push_regs WHERE rid = ?').get(pNew.prep) as { token_digest: string | null }).token_digest !== null)
reply = () => ({ status: 404, body: { error: { status: 'NOT_FOUND', message: 'project not found' } } })
await np.pushNative(alice, notice)
check('a plain NOT_FOUND (wrong project) keeps the token', (db.prepare('SELECT token_digest FROM native_push_regs WHERE rid = ?').get(pNew.prep) as { token_digest: string | null }).token_digest !== null)
reply = () => ({ status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } })
await np.pushNative(alice, notice)
check('UNREGISTERED clears the token but keeps the registration', (db.prepare('SELECT token_digest, state FROM native_push_regs WHERE rid = ?').get(pNew.prep) as { token_digest: string | null; state: string }).token_digest === null && np.nativeConfig(alice).devices.length === 1)
check('failed sends leave no content behind', (db.prepare('SELECT COUNT(*) AS n FROM native_push_content').get() as { n: number }).n === 0)
reply = () => ({ status: 200, body: {} })
await np.setToken(bearer(a2.cap), Promise.resolve({ token: TOKEN(4) }))
// A token rotated while a send was in flight is not removed by the stale UNREGISTERED.
reply = () => {
  db.prepare('UPDATE native_push_regs SET token_digest = ? WHERE rid = ?').run('rotated', pNew.prep)
  return { status: 404, body: { error: { details: [{ errorCode: 'UNREGISTERED' }] } } }
}
await np.pushNative(alice, notice)
check('a stale UNREGISTERED does not remove a token that rotated meanwhile', (db.prepare('SELECT token_digest FROM native_push_regs WHERE rid = ?').get(pNew.prep) as { token_digest: string | null }).token_digest === 'rotated')
reply = () => ({ status: 200, body: {} })
await np.setToken(bearer(a2.cap), Promise.resolve({ token: TOKEN(5) }))
reply = () => ({ status: 429, body: {}, retryAfter: 60 })
const before = sent.length
await np.pushNative(alice, notice)
await np.pushNative(alice, notice)
check('a rate limit pauses sending instead of hammering', sent.length === before + 1)
setFcmTransport({ token: async () => ({ status: 200, body: { access_token: 'fake-access-token', expires_in: 3600 } }), send: async (project, accessToken, message) => (sent.push({ project, accessToken, message }), { status: 200, body: {} }) })

// 8. Revocation: the revocation key, the session cascade, a ban.
const p3 = np.prepare(req(), alice, 's-alice-2', { installId: install(3) })
const a3 = np.activate(req(), alice, 's-alice-2', { prep: p3.prep })
await np.setToken(bearer(a3.cap), Promise.resolve({ token: TOKEN(6) }))
np.revoke(bearer(a3.rev))
check('the revocation key ends its registration (and only that)', np.nativeConfig(alice).devices.length === 1)
await throwsStatus('the capability of a revoked registration is dead', 401, () => np.takeContent(bearer(a3.cap), 'A'.repeat(22)))
np.revoke(bearer(a3.rev))
check('revoking again is quiet', true)
const p4 = np.prepare(req(), alice, 's-alice-2', { installId: install(4) })
const a4 = np.activate(req(), alice, 's-alice-2', { prep: p4.prep })
await np.setToken(bearer(a4.cap), Promise.resolve({ token: TOKEN(7) }))
await np.pushNative(alice, notice)
db.prepare('DELETE FROM sessions WHERE id = ?').run('s-alice-2')
check('ending a session removes its registration and its waiting content', (db.prepare('SELECT COUNT(*) AS n FROM native_push_regs WHERE rid = ?').get(p4.prep) as { n: number }).n === 0 && (db.prepare('SELECT COUNT(*) AS n FROM native_push_content c LEFT JOIN native_push_regs r ON r.id = c.reg_id WHERE r.id IS NULL').get() as { n: number }).n === 0)
await throwsStatus('the capability of a session that ended is dead', 401, () => np.setToken(bearer(a4.cap), Promise.resolve({ token: TOKEN(8) })))
np.revoke(bearer(a4.rev))
check('revoking after the session ended is quiet', true)
// A session that ran out is not live even if its row is still there.
db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, 's-alice-1')
await throwsStatus('an expired session cannot use its capability (and the registration goes)', 401, () => np.takeContent(bearer(a2.cap), 'A'.repeat(22)))
check('an expired session is not counted as a device', np.nativeConfig(alice).devices.length === 0 && np.nativeDevices(1) === 0)
db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + 86_400_000, 's-alice-1')
// Ban: the registration cannot be used.
db.prepare('UPDATE users SET banned_at = ? WHERE id = 2').run(Date.now())
await throwsStatus('a banned account cannot use its capability', 401, () => np.setToken(bearer(b1.cap), Promise.resolve({ token: TOKEN(9) })))
// Deleting the account removes everything.
db.prepare('DELETE FROM users WHERE id = 2').run()
check('deleting the account removes its registrations', (db.prepare('SELECT COUNT(*) AS n FROM native_push_regs WHERE user_id = 2').get() as { n: number }).n === 0)

// 9. Owner removal in Settings, quotas, rate limits.
const p5 = np.prepare(req(), alice, 's-alice-1', { installId: install(5) })
const a5 = np.activate(req(), alice, 's-alice-1', { prep: p5.prep })
check('the owner sees it and can remove it', np.nativeConfig(alice).devices.some((d) => d.rid === p5.prep) && !np.removeOwned(alice, p5.prep).devices.some((d) => d.rid === p5.prep))
await throwsStatus('a removed registration is dead', 401, () => np.setToken(bearer(a5.cap), Promise.resolve({ token: TOKEN(10) })))
check('another account cannot remove it', (() => { const p = np.prepare(req(), alice, 's-alice-1', { installId: install(6) }); np.activate(req(), alice, 's-alice-1', { prep: p.prep }); const before = np.nativeConfig(alice).devices.length; np.removeOwned(bob, p.prep); return np.nativeConfig(alice).devices.length === before })())
const regsNow = np.nativeConfig(alice).devices.length
for (let i = 20; i < 40; i++) {
  try {
    const p = np.prepare(req({}, `198.51.100.${i}`), alice, 's-alice-1', { installId: install(i) })
    np.activate(req(), alice, 's-alice-1', { prep: p.prep })
  } catch (e) {
    if ((e as { status?: number }).status === 429) break
  }
}
check('devices per account are capped at 10', np.nativeConfig(alice).devices.length <= 10 && np.nativeConfig(alice).devices.length >= regsNow)
const attacker = '192.0.2.77'
let limited = false
for (let i = 0; i < 40; i++) {
  try {
    np.takeContent(req({ authorization: `Bearer ${'B'.repeat(22)}.${'C'.repeat(43)}` }, attacker), 'A'.repeat(22))
  } catch (e) {
    if ((e as { status?: number }).status === 429) limited = true
  }
}
check('many bad credentials from one address are rate limited', limited)
check('no secret, token or content appears in the sealed rows', !JSON.stringify(db.prepare('SELECT token_enc FROM native_push_regs').all()).includes('APA91b'))

rmSync(dir, { recursive: true, force: true })
if (failed) {
  console.log(`FAILED: ${failed}`)
  process.exit(1)
}
console.log('native push: all passed')
process.exit(0)
