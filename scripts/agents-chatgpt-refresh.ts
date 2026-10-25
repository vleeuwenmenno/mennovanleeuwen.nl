// Checks that a ChatGPT token refresh cannot outlive the sign-in it started from
// (server/agentOpenAI.ts), against a stand-in for auth.openai.com that holds refreshes until released:
//   - disconnect while a refresh is held: the result is not stored and not returned;
//   - disconnect + sign in as another account while it is held: the old result does not replace
//     the new account's tokens, and a later refresh uses the new account's refresh token;
//   - the account removed while it is held: nothing is stored.
//
//   node scripts/agents-chatgpt-refresh.ts
//
// Exits 1 on any failure.

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'mvlos-refresh-'))
process.env.DATA_DIR = DATA
let failed = false
const check = (what: string, test: boolean) => {
  console.log(test ? 'PASS' : 'FAIL', what)
  if (!test) failed = true
}

const jwt = (c: object) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.y`
const held: { form: URLSearchParams; release: () => void }[] = []
const grants: string[] = []
const fake = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const form = new URLSearchParams(body)
    const answer = (access: string, refresh: string, email: string) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: access, refresh_token: refresh, id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: `acct-${email}` } }), expires_in: 3600 }))
    grants.push(`${form.get('grant_type')}:${form.get('refresh_token') ?? form.get('code')}`)
    if (form.get('grant_type') === 'authorization_code') return answer('access-B', 'refresh-B', 'b@example.test')
    // A refresh of account A: answered only when the check lets it go.
    held.push({ form, release: () => answer('access-A2', 'refresh-A2', 'a@example.test') })
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
process.env.OPENAI_AUTH_URL = `http://127.0.0.1:${(fake.address() as { port: number }).port}`

const { database, encrypt, decrypt, userGone } = await import('../server/db.ts')
const { openaiChatAccess, chatgptSignInForTest: ops } = await import('../server/agentOpenAI.ts')
const now = Date.now()
const user = { id: 1, githubId: 1, login: 'refresh-check', name: null, avatar: null, githubToken: 'none', githubScopes: [], admin: false }
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(user.login, encrypt('none'), now, now)

const seedA = () =>
  database().prepare("INSERT OR REPLACE INTO integrations (user_id, name, secret, created_at) VALUES (1, 'openai-chatgpt', ?, ?)").run(encrypt(JSON.stringify({ access: 'access-A', refresh: 'refresh-A', accountId: 'acct-a', email: 'a@example.test', plan: 'plus', expires: Date.now() - 1000 })), Date.now())
const stored = () => {
  const row = database().prepare("SELECT secret FROM integrations WHERE user_id = 1 AND name = 'openai-chatgpt'").get() as { secret: string } | undefined
  return row ? (JSON.parse(decrypt(row.secret)) as { access: string; refresh: string; email: string }) : null
}
const settled = async (p: Promise<unknown>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }))
const waitHeld = async (n: number) => {
  for (let i = 0; i < 200 && held.length < n; i++) await new Promise((r) => setTimeout(r, 10))
}
const relink = async () => {
  const url = new URL(ops.startSignIn(user, { acceptedRisk: true }).url)
  await ops.finishSignIn(user, { callback: `?code=code-B&state=${url.searchParams.get('state')}` })
}

// 1. Disconnect only.
seedA()
let refresh = settled(openaiChatAccess.freshTokens(user, true))
await waitHeld(1)
ops.signOut(user)
held[0].release()
let r = await refresh
check('disconnect while refreshing: the held refresh is refused', r.value === null && r.error !== null)
check('disconnect while refreshing: nothing is stored', stored() === null)
check('disconnect while refreshing: later use needs a new sign-in', await settled(openaiChatAccess.freshTokens(user)).then((x) => x.error !== null))

// 2. Disconnect, then another account signs in, then the old refresh answers.
held.length = 0
seedA()
refresh = settled(openaiChatAccess.freshTokens(user, true))
await waitHeld(1)
ops.signOut(user)
await relink()
check('relinked account B is stored', stored()?.email === 'b@example.test')
held[0].release()
r = await refresh
check('stale refresh after relink: refused, no tokens returned', r.value === null && r.error !== null)
check('stale refresh after relink: B is not overwritten', stored()?.email === 'b@example.test' && stored()?.refresh === 'refresh-B' && stored()?.access === 'access-B')
check('chat after relink uses B', (await openaiChatAccess.freshTokens(user)).access === 'access-B')

// 3. A refresh started after the relink uses B's refresh token, not a shared stale job.
held.length = 0
grants.length = 0
database().prepare("UPDATE integrations SET secret = ? WHERE user_id = 1 AND name = 'openai-chatgpt'").run(encrypt(JSON.stringify({ ...stored(), expires: Date.now() - 1000 })))
const fresh = settled(openaiChatAccess.freshTokens(user, true))
await waitHeld(1)
check('new refresh sends the current refresh token', held[0].form.get('refresh_token') === 'refresh-B')
held[0].release()
await fresh

// 4. Account removed while refreshing.
held.length = 0
seedA()
refresh = settled(openaiChatAccess.freshTokens(user, true))
await waitHeld(1)
database().prepare("DELETE FROM integrations WHERE user_id = 1 AND name = 'openai-chatgpt'").run()
userGone(1)
held[0].release()
r = await refresh
check('account removed while refreshing: refused and nothing stored', r.value === null && r.error !== null && stored() === null)

fake.close()
rmSync(DATA, { recursive: true, force: true })
console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
