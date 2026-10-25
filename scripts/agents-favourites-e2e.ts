// End-to-end check for the Agents model picker's starred models (src/data/agentFavourites.ts):
// they follow the account, merged model by model. Real headless Chromium against a Vite dev
// server with a scratch DATA_DIR and a test account (no GitHub). Two "devices" (each its own
// Chromium and profile) and two tabs in one of them, sound muted.
//
//   pnpm check:agents-favourites            (PORT=5293 by default)
//
// Covers: a star reaching the other device and tab, two devices starring at once, a star while the
// other device changes another agents setting, an unstar racing a star, two tabs at the same
// moment, a tab on an older release saving the settings without the old list, reload, and moving
// the old `favoriteModels` list over without bringing back a star taken off since.

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5293)
const data = mkdtempSync('/tmp/mvlos-favourites-e2e-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

// --- accounts: one for the sync checks, one that still has the old list -------------------------
const now = Date.now()
const users: { id: number; login: string; sid: string; apiSid: string }[] = []
for (const [id, login] of [
  [1, 'favourites-check'],
  [2, 'favourites-migrate'],
] as const) {
  const sid = randomBytes(24).toString('hex')
  const apiSid = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, login, encrypt('none'), now, now)
  for (const s of [sid, apiSid]) database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(s), id, now, now + 86400_000)
  users.push({ id, login, sid, apiSid })
}
const [U1, U2] = users
// The second account's settings as an older release saved them: stars in the settings.
database().prepare('INSERT INTO state (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(U2.id, 'agents', JSON.stringify({ mode: 'quick', favoriteModels: ['old-a', 'old-b', 'old-c'] }), now)

// --- dev server ---------------------------------------------------------------------------------
const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready'); i++) await sleep(200)
if (!log.includes('ready')) throw new Error(`vite did not start:\n${log}`)

const api = (u: typeof U1, p: string, init: { method?: string; json?: unknown } = {}) =>
  fetch(origin + p, { method: init.method ?? 'GET', headers: { Cookie: `mvlos_sid=${u.apiSid}`, Origin: origin, 'Content-Type': 'application/json', 'X-MvL-Account': String(u.id) }, body: init.json === undefined ? undefined : JSON.stringify(init.json) }).then((r) => r.json())

// --- browsers -----------------------------------------------------------------------------------
type B = Awaited<ReturnType<typeof launch>>
type P = Awaited<ReturnType<typeof newPage>>
const browsers: B[] = []
async function device(): Promise<B> {
  const b = await launch(1400, 900)
  browsers.push(b)
  return b
}
async function tab(b: B, user: typeof U1): Promise<P> {
  const page = await newPage(b, 1400, 900, '')
  for (const [name, value] of [['mvlos_sid', user.sid], ['mvlos_login', user.login], ['mvlos_uid', String(user.id)]]) await page.send('Network.setCookie', { name, value, url: origin })
  await page.send('Page.navigate', { url: origin + '/' })
  await ready(page)
  return page
}
async function ready(page: P) {
  await page.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('[class^="boot"], [class*=" boot"]')`, 90_000)
  // Sign-in answered and the first pull done.
  await sleep(2500)
}
const MOD = '/src/data/agentFavourites.ts'
const favs = (p: P) => p.eval<string[]>(`import('${MOD}').then(m => m.favouriteNames())`)
const toggle = (p: P, n: string) => p.eval(`import('${MOD}').then(m => (m.toggleFavourite(${JSON.stringify(n)}), 1))`)
const pull = (p: P) => p.eval(`import('/src/os/synced.ts').then(m => m.pullAll()).then(() => 1)`)
const setMode = (p: P, mode: string) => p.eval(`import('/src/data/agents.ts').then(m => (m.setAgentSettings({ mode: '${mode}' }), 1))`)
/** Saves go out (800 ms), conflicts come back and are merged and saved again, and everyone pulls. */
async function settle(...pages: P[]) {
  await sleep(3500)
  for (const p of pages) await pull(p)
  await sleep(2000)
  for (const p of pages) await pull(p)
}
const has = (list: string[], ...names: string[]) => names.every((n) => list.includes(n))
const lacks = (list: string[], ...names: string[]) => names.every((n) => !list.includes(n))

try {
  const dA = await device()
  const dB = await device()
  const A = await tab(dA, U1)
  const A2 = await tab(dA, U1)
  const B = await tab(dB, U1)

  // --- the merge rules, as the browser runs them ------------------------------------------------
  const unit = await A.eval<Record<string, boolean>>(`import('${MOD}').then(m => {
    const a = { models: { x: { on: true, at: 5 }, y: { on: false, at: 9 } } }
    const b = { models: { x: { on: false, at: 6 }, y: { on: true, at: 8 }, z: { on: true, at: 1 } } }
    const ab = m.mergeFavourites(a, b), ba = m.mergeFavourites(b, a)
    const tie = m.mergeFavourites({ models: { t: { on: true, at: 3 } } }, { models: { t: { on: false, at: 3 } } })
    const legacy = m.withLegacy({ models: { gone: { on: false, at: 50 } } }, ['gone', 'p', 'q'])
    const t = m.toggled({ models: { s: { on: true, at: 9e15 } } }, 's', 1)
    return {
      'merge: newer entry wins per model': !ab.models.x.on && !ab.models.y.on && ab.models.z.on,
      'merge: same result both ways': JSON.stringify(ab) === JSON.stringify(m.mergeFavourites(ba, ab)) && JSON.stringify(m.starred(ab)) === JSON.stringify(m.starred(ba)),
      'merge: a tie goes to the unstar': !tie.models.t.on,
      'legacy: an unstarred model is not brought back': !legacy.models.gone.on,
      'legacy: new ones come in, in their order': JSON.stringify(m.starred(legacy)) === '["p","q"]',
      'toggle: counts on past a clock that runs ahead': !t.models.s.on && t.models.s.at === 9e15 + 1,
      'normalize: junk reads as empty': JSON.stringify(m.normalizeFavourites([1])) === '{"models":{}}' && JSON.stringify(m.normalizeFavourites({ models: { ok: { on: true, at: 1 }, bad: { on: true } } })) === '{"models":{"ok":{"on":true,"at":1}}}',
    }
  })`)
  for (const [what, ok] of Object.entries(unit)) check(what, ok)

  // 1. A star reaches the other device (on its next pull) and the other tab (right away).
  await toggle(A, 'm-x')
  await sleep(2000)
  await pull(B)
  check('star on device A shows on device B', has(await favs(B), 'm-x'), await favs(B))
  check('star in one tab shows in the other tab', has(await favs(A2), 'm-x'), await favs(A2))

  // 2. Both devices star before either has seen the other's.
  await toggle(A, 'm-y')
  await toggle(B, 'm-z')
  await settle(A, B)
  check('two devices starring at once: both stars kept (A)', has(await favs(A), 'm-y', 'm-z'), await favs(A))
  check('two devices starring at once: both stars kept (B)', has(await favs(B), 'm-y', 'm-z'), await favs(B))

  // 3. A star while the other device changes another agents setting.
  await toggle(A, 'm-w')
  await setMode(B, 'deep')
  await settle(A, B)
  check('star kept while another device changes a setting', has(await favs(A), 'm-w') && has(await favs(B), 'm-w'), { A: await favs(A), B: await favs(B) })

  // 4. An unstar on one device while the other stars something else.
  await toggle(A, 'm-x')
  await toggle(B, 'm-v')
  await settle(A, B)
  check('unstar sticks on both devices', lacks(await favs(A), 'm-x') && lacks(await favs(B), 'm-x'), { A: await favs(A), B: await favs(B) })
  check('star made meanwhile on the other device kept', has(await favs(A), 'm-v') && has(await favs(B), 'm-v'), { A: await favs(A), B: await favs(B) })

  // 5. Two tabs of one browser starring at the same moment.
  await Promise.all([toggle(A, 'm-t1'), toggle(A2, 'm-t2')])
  await settle(A, A2, B)
  check('two tabs starring at once: both kept', has(await favs(A), 'm-t1', 'm-t2') && has(await favs(A2), 'm-t1', 'm-t2') && has(await favs(B), 'm-t1', 'm-t2'), { A: await favs(A), A2: await favs(A2), B: await favs(B) })

  // 6. A tab still on an older release saves the agents settings without the old list.
  const expected = await favs(A)
  const cur = (await api(U1, '/api/state')).agents
  const { favoriteModels: _old, ...older } = cur.value
  await api(U1, '/api/state/agents', { method: 'PUT', json: { value: { ...older, mode: 'quick' }, base: cur.updatedAt } })
  await settle(A, B)
  check('an older release saving the settings keeps the stars', JSON.stringify(await favs(A)) === JSON.stringify(expected) && JSON.stringify(await favs(B)) === JSON.stringify(expected), { expected, A: await favs(A), B: await favs(B) })

  // 7. Reload: the same stars, in the same order.
  await B.send('Page.reload', {})
  await ready(B)
  check('stars the same after reload', JSON.stringify(await favs(B)) === JSON.stringify(expected), { expected, B: await favs(B) })
  check('order is the order starred', JSON.stringify(expected.filter((n) => ['m-y', 'm-z', 'm-w', 'm-v'].includes(n))) === '["m-y","m-z","m-w","m-v"]', expected)

  // --- moving the old list over -----------------------------------------------------------------
  const dM = await device()
  const M = await tab(dM, U2)
  check('old list moved over, in its order', JSON.stringify(await favs(M)) === '["old-a","old-b","old-c"]', await favs(M))
  await sleep(1500)
  const moved = (await api(U2, '/api/state'))['agents:favourites']?.value
  check('moved list saved to the account', !!moved && ['old-a', 'old-b', 'old-c'].every((n) => moved.models[n]?.on), moved)
  await toggle(M, 'old-b')
  await sleep(1500)
  // The old list turns up again (a tab still on an older release saves it): no star comes back.
  const st = (await api(U2, '/api/state')).agents
  await api(U2, '/api/state/agents', { method: 'PUT', json: { value: { ...st.value, favoriteModels: ['old-a', 'old-b', 'old-c', 'old-d'] }, base: st.updatedAt } })
  await settle(M)
  check('old list again: unstarred stays off, a new one comes in', JSON.stringify(await favs(M)) === '["old-a","old-c","old-d"]', await favs(M))
  await M.send('Page.reload', {})
  await ready(M)
  check('moved stars the same after reload', JSON.stringify(await favs(M)) === '["old-a","old-c","old-d"]', await favs(M))
} catch (e) {
  failed++
  console.log('FAIL (threw)', (e as Error).message)
} finally {
  for (const b of browsers) await b.close()
  vite.kill()
  await sleep(300)
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `FAILED: ${failed}` : 'all passed')
process.exit(failed ? 1 : 0)
