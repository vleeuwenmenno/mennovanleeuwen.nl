// Checks that synced state (src/os/synced.ts) never crosses accounts when tabs of one browser
// sign out, in or as someone else, in memory: each tab is its own copy of synced.ts and
// account.ts in a stand-in window, the tabs share a stand-in localStorage (a write in one tab is a
// `storage` event in the others, delivered at once or held back to model a tab that hasn't heard
// yet) and one sign-in cookie, and the server is a stand-in for /api/me and /api/state with one
// state per account and the real rule for X-MvL-Account (server/api.ts). No browser, no server.
//
//   node scripts/sync-accounts-check.ts
//
// Exits 1 on any failure.

import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { check, finish, sleep } from './empires-harness.ts'

// The app's modules import each other without extensions (Vite finds them): so does this. A
// module loaded for a tab (`?tab=N`) gets that tab's copies of what it imports too.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?(\?.*)?$/.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      const tab = /[?&]tab=\d+/.exec(context.parentURL)?.[0].slice(1)
      if (tab && /\/src\/os\/(account|synced)\.ts$/.test(url.pathname)) url.search = `?${tab}`
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

// --- the stand-in browser -----------------------------------------------------------------------

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
  dispatchEvent() {
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
/** Like `as`, for the whole of something async (only that tab acts meanwhile). */
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
/** Whether storage works at all (a browser blocking it throws on every call). */
let blocked = false
/** Keys whose writes fail (storage full) while reading works. */
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
    if (unwritable.has(k)) throw new Error('QuotaExceededError')
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
/** Who the browser's cookie signs in as (0: nobody). */
let cookieUser = 1
const home = new Win()
g.window = home
// The login cookie follows the sign-in cookie, as the server sets both (src/os/identity.ts).
g.document = {
  get cookie() {
    return cookieUser ? 'mvlos_login=check' : ''
  },
  set cookie(_: string) {},
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
  title: '',
}
let reloads = 0
Object.defineProperty(globalThis, 'location', { value: { pathname: '/', protocol: 'http:', origin: 'http://localhost', reload: () => reloads++, assign() {} }, configurable: true })

// --- the stand-in server ------------------------------------------------------------------------

/** Each account's synced state. */
const server = new Map<number, Map<string, { value: unknown; updatedAt: number }>>()
const stateOf = (user: number) => server.get(user) ?? server.set(user, new Map()).get(user)!
/** Requests to /api/state, with the account they reached. */
const requests: { path: string; method: string; user: number; refused: boolean }[] = []
/** Called while a request is out, before the server answers (to switch accounts meanwhile). */
let midFlight: (() => void) | null = null
let clock = 1000
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
g.fetch = async (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
  if (path === '/api/me') return json({ authEnabled: true, user: cookieUser ? { id: cookieUser, login: 'check', name: null, avatar: null, admin: false, githubScopes: [] } : null, forges: [] })
  const user = cookieUser
  const method = init.method ?? 'GET'
  // As server/api.ts: a tab that holds another account's state is refused.
  const holds = init.headers?.['X-MvL-Account']
  const refused = holds !== undefined && holds !== String(user)
  requests.push({ path, method, user, refused })
  if (!user) return json({ error: 'Sign in first' }, 401)
  if (refused) return json({ error: 'Signed in as another account', accountChanged: true }, 409)
  let answer: Response
  if (path === '/api/state') answer = json(Object.fromEntries(stateOf(user)))
  else {
    const key = decodeURIComponent(path.replace('/api/state/', ''))
    const { value, base } = JSON.parse(init.body!) as { value: unknown; base: number }
    const cur = stateOf(user).get(key)
    if (cur && cur.updatedAt > base) answer = json({ ...cur, conflict: true })
    else {
      const entry = { value, updatedAt: ++clock }
      stateOf(user).set(key, entry)
      answer = json(entry)
    }
  }
  const f = midFlight
  midFlight = null
  f?.()
  await sleep(5)
  return answer
}

// --- tabs ---------------------------------------------------------------------------------------

type Synced = typeof import('../src/os/synced.ts')
type AccountMod = typeof import('../src/os/account.ts')
type Tab = { win: Win; sync: Synced; account: AccountMod; notes: ReturnType<Synced['synced']> }
let tabs = 0
/** A tab starting now: its own synced.ts and account.ts, a store of notes, signed in (or not) as the cookie says. */
async function openTab(opts: { load?: boolean } = {}): Promise<Tab> {
  const win = new Win()
  wins.push(win)
  const n = ++tabs
  const was = g.window
  g.window = win
  let sync: Synced, account: AccountMod
  try {
    sync = (await import(`../src/os/synced.ts?tab=${n}`)) as Synced
    account = (await import(`../src/os/account.ts?tab=${n}`)) as AccountMod
  } finally {
    g.window = was
  }
  const notes = as(win, () => sync.synced<string[]>('notes', []))
  as(win, () => sync.startSync())
  if (opts.load !== false) await within(win, () => account.loadAccount())
  await sleep(20)
  return { win, sync, account, notes }
}
const close = (t: Tab) => wins.splice(wins.indexOf(t.win), 1)
/** Another tab signing out, then in as `user`: what account.ts and the server do to this browser. */
function switchAccount(by: Win, user: number, theirNotes: string[]) {
  as(by, () => {
    for (const k of [...storage.keys()]) if (k.startsWith('mvlos.sync.')) localStorage.removeItem(k)
    localStorage.removeItem('mvlos.account')
    cookieUser = user
    localStorage.setItem('mvlos.account', String(user))
    localStorage.setItem('mvlos.sync.notes', JSON.stringify({ value: theirNotes, base: 0, dirty: true, owner: `u:${user}` }))
  })
}
const storedNotes = () => storage.get('mvlos.sync.notes') ?? ''
const serverNotes = (user: number) => JSON.stringify(stateOf(user).get('notes')?.value ?? null)
function reset() {
  storage.clear()
  server.clear()
  requests.length = 0
  queue.length = 0
  held = false
  blocked = false
  unwritable.clear()
  wins.length = 0
  cookieUser = 1
}

// --- 1. a pending save, another tab switches account before this tab hears of it ---------------------
{
  reset()
  storage.set('mvlos.account', '1')
  const A = await openTab()
  check('A: signed in as account 1, and saved', A.account.getAccount().user?.id === 1)
  as(A.win, () => A.notes.set(['account-1-private']))
  const other = new Win()
  wins.push(other)
  held = true
  switchAccount(other, 2, ['account-2-private'])
  await sleep(1200) // A's save comes due
  check('pending save: nothing of account 1 reaches account 2 on the server', !serverNotes(2).includes('account-1'))
  check('pending save: no request from A reached account 2', !requests.some((r) => r.user === 2 && !r.refused))
  check('pending save: A stopped, and starts again', A.sync.syncStopped() && reloads > 0)
  flush()
  check('pending save: the browser holds only account 2’s notes', storedNotes().includes('account-2-private') && !storedNotes().includes('account-1'))
}

// --- 2. the round-1 case: the cookie switched, the marker didn't say so (yet): the server refuses --
{
  reset()
  storage.set('mvlos.account', '1')
  const A = await openTab()
  as(A.win, () => A.notes.set(['account-1-private']))
  // Account 2 signed in elsewhere with the same cookie; this browser's marker hasn't changed.
  cookieUser = 2
  await sleep(1200)
  check('cookie switched: account 2’s state on the server has nothing of account 1', !serverNotes(2).includes('account-1'))
  check('cookie switched: the push was refused (X-MvL-Account)', requests.some((r) => r.method === 'PUT' && r.refused))
  check('cookie switched: A stopped', A.sync.syncStopped())
}

// --- 3. the account changes while a push is out: its answer is dropped ------------------------------
{
  reset()
  storage.set('mvlos.account', '1')
  const A = await openTab()
  const other = new Win()
  wins.push(other)
  as(A.win, () => A.notes.set(['account-1-private']))
  midFlight = () => {
    held = true
    switchAccount(other, 2, ['account-2-private'])
  }
  await sleep(1200)
  // The answer (account 1's version) must not be written over account 2's notes in this browser.
  check('in flight: account 1’s push landed in account 1', serverNotes(1).includes('account-1-private'))
  check('in flight: its answer isn’t taken in after the switch', storedNotes().includes('account-2-private') && !storedNotes().includes('account-1'))
  check('in flight: A stopped', A.sync.syncStopped())
  flush()
}

// --- 4. round 4 #1: the account changes while a tab is still starting -----------------------------
{
  reset()
  storage.set('mvlos.account', '1')
  storage.set('mvlos.sync.notes', JSON.stringify({ value: ['account-1-private'], base: 0, dirty: true }))
  const C = await openTab({ load: false }) // took account 1's notes, account not checked yet
  check('starting: the tab holds account 1’s notes', C.notes.get().join() === 'account-1-private')
  const other = new Win()
  wins.push(other)
  held = true
  switchAccount(other, 2, ['account-2-private'])
  await within(C.win, () => C.account.loadAccount()) // finds account 2 (the marker says 2 as well)
  await sleep(1200)
  check('starting: nothing of account 1 reaches account 2', !serverNotes(2).includes('account-1') && !requests.some((r) => r.user === 2 && r.method === 'PUT' && !r.refused))
  check('starting: the tab stopped', C.sync.syncStopped())
  flush()
  check('starting: the browser holds only account 2’s notes', !storedNotes().includes('account-1'))
}

// --- 5. round 4 #2: a stale tab saves after the switch; a tab starting as account 2 -----------------
{
  reset()
  storage.set('mvlos.account', '1')
  const A = await openTab()
  const other = new Win()
  wins.push(other)
  held = true
  switchAccount(other, 2, ['account-2-private'])
  as(A.win, () => A.notes.set(['account-1-later']))
  check('stale save: account 2’s notes in this browser are not overwritten', storedNotes().includes('account-2-private') && !storedNotes().includes('account-1'))
  check('stale save: A stopped', A.sync.syncStopped())
  flush()
  // A value of account 1's left here anyway (by a release without this fix): a tab starting as
  // account 2 doesn't take it in, and it goes.
  storage.set('mvlos.sync.notes', JSON.stringify({ value: ['account-1-leftover'], base: 3, dirty: true, owner: 'u:1' }))
  const B = await openTab()
  check('leftover: a tab starting as account 2 doesn’t take in account 1’s notes', B.notes.get().length === 0)
  check('leftover: and they are gone from the browser', !storedNotes().includes('account-1'))
  await sleep(1200)
  check('leftover: nothing of account 1 reached account 2', !serverNotes(2).includes('account-1'))
  as(B.win, () => B.notes.set(['account-2-own']))
  check('leftover: account 2’s tab saves its own, tagged as its own', storedNotes().includes('"owner":"u:2"') && !B.sync.syncStopped())
}

// --- 6. storage full: the marker can't be written; that is not a switch (no reload loop) -------------
{
  reset()
  await sleep(1500) // tabs of the sections before have stopped by now
  unwritable.add('mvlos.account')
  const r0 = reloads
  const D = await openTab() // no marker: a visitor's tab, signing in as account 1
  check('storage full: signed in, the marker not written', D.account.getAccount().user?.id === 1 && !storage.has('mvlos.account'))
  as(D.win, () => D.notes.set(['account-1-note']))
  await sleep(1200)
  await as(D.win, () => D.sync.pullAll())
  check('storage full: saves and pulls go ahead', serverNotes(1).includes('account-1-note') && D.sync.getSyncStatus().state === 'synced')
  check('storage full: the tab didn’t stop or reload', !D.sync.syncStopped() && reloads === r0)
}

// --- 7. storage blocked: everything still works, in memory ------------------------------------------
{
  reset()
  await sleep(1500)
  blocked = true
  const r0 = reloads
  const E = await openTab()
  as(E.win, () => E.notes.set(['kept-in-memory']))
  check('blocked: the value is there', E.notes.get().join() === 'kept-in-memory')
  await sleep(1200)
  check('blocked: and reaches the account', serverNotes(1).includes('kept-in-memory'))
  check('blocked: the tab didn’t stop or reload', !E.sync.syncStopped() && reloads === r0)
  // The cookie changes under it (another tab, which can't tell it through storage): refused.
  cookieUser = 2
  as(E.win, () => E.notes.set(['later']))
  await sleep(1200)
  check('blocked: a push after the cookie switched is refused, nothing reaches account 2', !serverNotes(2).includes('later') && E.sync.syncStopped())
}

// --- 8. a visitor signing in brings their notes along, once --------------------------------------------
{
  reset()
  cookieUser = 0
  const V = await openTab() // a visitor
  as(V.win, () => V.notes.set(['as-a-visitor']))
  check('visitor: kept in this browser, tagged as a visitor’s', storedNotes().includes('"owner":"visitor"'))
  cookieUser = 1
  await within(V.win, () => V.account.loadAccount()) // signs in (here: in this tab)
  await sleep(1200)
  check('visitor: signing in brings the notes along to the account', serverNotes(1).includes('as-a-visitor') && !V.sync.syncStopped())
  as(V.win, () => V.notes.set(['as-a-visitor', 'signed-in']))
  check('visitor: saved from then on as the account’s', storedNotes().includes('"owner":"u:1"'))
  // Another visitor's tab of this browser hears of the sign-in: it starts again as the account.
  reset()
  cookieUser = 0
  const V2 = await openTab()
  const other = new Win()
  wins.push(other)
  as(other, () => localStorage.setItem('mvlos.account', '1'))
  check('visitor: another tab signing in makes a visitor’s tab start again', V2.sync.syncStopped())
}

finish()
