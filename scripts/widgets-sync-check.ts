// Checks the synced desktop widgets (src/os/widgetPlaces.ts), how notes merge between tabs and
// devices (src/data/notes.ts), and the parts of synced() (src/os/synced.ts) they lean on, in memory: browser tabs are stand-in windows sharing one
// stand-in localStorage (a write in one tab is a `storage` event in the others), and the server is
// a stand-in for /api/state with the real conflict rule (a save on top of an older version is
// refused with the newer copy). No browser, no real server.
//
//   node scripts/widgets-sync-check.ts
//
// Exits 1 on any failure.

import { existsSync } from 'node:fs'
import { widgetStorageFixture } from './widget-storage-fixture.ts'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { check, finish, sleep } from './empires-harness.ts'

// The app's own modules import each other without extensions (Vite finds them): so does this.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?(\?.*)?$/.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

// --- the stand-in browser -----------------------------------------------------------------------

type Listener = (e: { key: string | null; newValue: string | null }) => void
class Tab {
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
const tabs: Tab[] = []
const g = globalThis as Record<string, unknown>
/** Runs `f` as tab `t`: stores made in it listen on that tab, its writes go to the other tabs. */
function as<T>(t: Tab, f: () => T): T {
  const was = g.window
  g.window = t
  try {
    return f()
  } finally {
    g.window = was
  }
}
const storage = new Map<string, string>()
/** Storage events waiting to be delivered (when `held`), as in a browser where tabs run apart. */
let held = false
const queue: (() => void)[] = []
const announce = (key: string, newValue: string | null) => {
  const from = g.window
  for (const t of tabs)
    if (t !== from) {
      const deliver = () => as(t, () => t.listeners.get('storage')?.forEach((l) => l({ key, newValue })))
      if (held) queue.push(deliver)
      else deliver()
    }
}
const flush = () => {
  held = false
  while (queue.length) queue.shift()!()
}
/** Keys whose writes fail (storage full), while reading still works. */
const unwritable = new Set<string>()
/** Writes to storage, as they happen. */
let writes = 0
g.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (unwritable.has(k)) throw new Error('QuotaExceededError')
    writes++
    storage.set(k, String(v))
    announce(k, String(v))
  },
  removeItem: (k: string) => {
    storage.delete(k)
    announce(k, null)
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size
  },
}
const main = new Tab()
tabs.push(main)
g.window = main
g.indexedDB = widgetStorageFixture(() => { const owner = g.window as Tab; return callback => as(owner, callback) })
g.document = { cookie: 'mvlos_login=check; mvlos_uid=1', visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, title: '' }
/** How often a page asked to start again. */
let reloads = 0
Object.defineProperty(globalThis, 'location', { value: { pathname: '/', protocol: 'http:', origin: 'http://localhost', reload: () => reloads++, assign() {} }, configurable: true })

// --- the stand-in server ------------------------------------------------------------------------

const server = new Map<string, { value: unknown; updatedAt: number }>()
/** The keys saved to the stand-in server, in order. */
const puts: string[] = []
let clock = 1000
/** Every request made, by path. */
const requests: string[] = []
/** Who the browser's cookie signs in as (another tab can switch it). */
let cookieUser = 1
/** Another device's save, made right before each of this one's (section 10). */
let storming: (() => void) | null = null
/** Saves of these keys take `ms` to answer, and the next `fail` of them fail (section 10). */
const slowPut = new Map<string, { ms: number; fail: number }>()
/** Every save as sent (key, then body), before the stand-in server answers it. */
const sentBodies: string[] = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
g.fetch = async (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
  if (path === '/api/me') return json({ authEnabled: true, user: { id: cookieUser, login: 'check', name: null, avatar: null, admin: false, githubScopes: [] }, forges: [] })
  requests.push(path)
  // As server/api.ts: a tab holding another account's state is refused.
  const holds = init.headers?.['X-MvL-Account']
  if (path.startsWith('/api/state') && holds !== undefined && holds !== String(cookieUser)) return json({ error: 'Signed in as another account', accountChanged: true }, 409)
  if (path === '/api/state') return json(Object.fromEntries(server))
  const key = decodeURIComponent(path.replace('/api/state/', ''))
  if (init.method === 'PUT') {
    if (key === 'loop:storm') storming?.()
    sentBodies.push(`${key} ${init.body}`)
    const slow = slowPut.get(key)
    if (slow) {
      await sleep(slow.ms)
      if (slow.fail > 0) {
        slow.fail--
        puts.push(`${key}!failed`)
        return json({ error: 'stand-in failure' }, 500)
      }
    }
    puts.push(key)
    const { value, base } = JSON.parse(init.body!) as { value: unknown; base: number }
    const cur = server.get(key)
    if (cur && cur.updatedAt > base) return json({ ...cur, conflict: true })
    const entry = { value, updatedAt: ++clock }
    server.set(key, entry)
    return json(entry)
  }
  return json(server.get(key) ?? null)
}

const { synced, startSync, pullAll, getSyncStatus } = await import('../src/os/synced.ts')
const { loadAccount, getAccount } = await import('../src/os/account.ts')
const wp = await import('../src/os/widgetPlaces.ts')
startSync()
await loadAccount()
check('signed in (stand-in account)', getAccount().status === 'user')
await pullAll()

const meta = (key: string) => JSON.parse(storage.get(`mvlos.u.1.sync.${key}`) ?? 'null') as { value: any; base: number; dirty: boolean } | null
type WidgetSet = import('../src/os/widgetPlaces.ts').WidgetSet
const live = (set: WidgetSet) => Object.keys(set.places).sort().join()

// --- 1. a fresh tab only takes the account's layout as its first layout ---------------------------
{
  const gate = wp.layoutGate(true)
  check('gate: another tab’s opening windows (never synced) are not the first layout', gate(false, true) === false)
  check('gate: the account’s layout then still replaces unsaved opening windows', gate(true, true) === true)
  check('gate: after that, unsaved changes here keep a newer layout out', gate(true, true) === false)
  check('gate: and no unsaved changes take it', gate(true, false) === true)

  // The same with real stores: tab 1 saves its opening windows, tab 2 hears of it, then the pull.
  server.set('windows:t1', { value: ['account-terminal'], updatedAt: 200 })
  const t1 = new Tab()
  const t2 = new Tab()
  tabs.push(t1, t2)
  const opts = { merge: (l: string[]) => l, yieldWhenNew: true }
  const s1 = as(t1, () => synced<string[] | null>('windows:t1', null, opts))
  const s2 = as(t2, () => synced<string[] | null>('windows:t1', null, opts))
  const gate2 = wp.layoutGate(!s2.everSynced())
  const taken: string[][] = []
  // Tab 2 has fitted its opening windows: unsaved changes, all along.
  s2.onRemote((v) => gate2(s2.everSynced(), true) && taken.push(v ?? []))
  s2.onSynced(gate2.consume)
  as(t1, () => s1.set(['welcome']))
  check('two fresh tabs: tab 1’s opening windows reach tab 2 as not synced', s2.get()?.join() === 'welcome' && !s2.everSynced() && taken.length === 0)
  // Real storage events arrive in later tasks, never reentrantly inside adopt().
  held = true
  await pullAll()
  flush()
  check('two fresh tabs: tab 2 takes the account’s layout from the pull', taken.length === 1 && taken[0].join() === 'account-terminal', taken)
  check('two fresh tabs: the account’s layout is not overwritten', JSON.stringify(server.get('windows:t1')!.value) === '["account-terminal"]')
  tabs.splice(tabs.indexOf(t1), 2)
}

// A successful first push consumes the gate even without a remote value callback.
{
  const s = synced<string[]>('windows:first-push', [])
  const gate = wp.layoutGate(true)
  let accepted = 0
  s.onRemote(() => { if (gate(s.everSynced(), true)) accepted++ })
  s.onSynced(gate.consume)
  s.set(['my-terminal'])
  await sleep(1200)
  check('gate: first local layout reached the account', s.everSynced())
  server.set(s.key, { value: ['remote-notebook'], updatedAt: ++clock })
  await pullAll()
  check('gate: after first push, incoming layout cannot replace unsaved windows', accepted === 0)
}

// Metadata-only storage events count, without pretending the value changed.
{
  const tab = new Tab()
  tabs.push(tab)
  const s = as(tab, () => synced<string[]>('windows:metadata', ['same']))
  const gate = wp.layoutGate(true)
  let accepted = 0
  s.onRemote(() => { if (gate(s.everSynced(), true)) accepted++ })
  s.onSynced(gate.consume)
  localStorage.setItem('mvlos.u.1.sync.windows:metadata', JSON.stringify({ value: ['same'], base: 500, dirty: false }))
  localStorage.setItem('mvlos.u.1.sync.windows:metadata', JSON.stringify({ value: ['new'], base: 600, dirty: false }))
  check('gate: metadata-only account copy consumes first-layout exception', accepted === 0)
  tabs.splice(tabs.indexOf(tab), 1)
}

// --- 2. legacy layouts arriving after canonical cutover are no longer migration inputs -----------
{
  const key = 'windows:t2'
  storage.set(`mvlos.u.1.sync.${key}`, JSON.stringify({ value: [{ app: 'terminal', props: {} }], base: 100, dirty: true }))
  server.set(key, { value: [{ app: 'terminal', props: {} }, { app: 'widget', x: 900, y: 80, w: 280, h: 220, props: { kind: 'status', id: 'onlyhere' } }], updatedAt: 300 })
  let shown = 0
  const off = wp.onImport(() => shown++)
  const layout = synced<unknown[] | null>(key, null, { merge: (l) => l, yieldWhenNew: true, onIncoming: wp.importLayoutWidgets })
  await pullAll()
  off()
  check('legacy: the layout merge kept the local layout (without the widget)', JSON.stringify(layout.get()).includes('onlyhere') === false)
  check('legacy after cutover: no widget imported from the later layout', !wp.widgetPlaces.get().places.onlyhere)
  check('legacy after cutover: no legacy set is written', !meta('widgets:placed'))
  check('legacy after cutover: no import callback reaches the window manager', shown === 0)
  await sleep(1200)
  await pullAll()
  check('legacy after cutover: no legacy set is pushed', !server.has('widgets:placed'))
  check('legacy: even though the layout on the server lost it', !JSON.stringify(server.get(key)!.value).includes('onlyhere'))
}

// --- 3. two tabs adding at once both keep theirs; a clear in one tab isn't written back ---------------
{
  const t1 = new Tab()
  const t2 = new Tab()
  tabs.push(t1, t2)
  const opts = { normalize: wp.normalizeSet, merge: wp.mergeSets, mergeTabs: true }
  const empty: WidgetSet = { places: {}, removed: '' }
  const a = as(t1, () => synced<WidgetSet>('t3places', empty, opts))
  const b = as(t2, () => synced<WidgetSet>('t3places', empty, opts))
  const place = (id: string, at: number) => ({ id, kind: 'status', x: 0, y: 0, w: 1, h: 1, vw: 1400, vh: 900, at })
  held = true
  as(t1, () => a.set((c) => wp.changeSet(c, { X: place('X', 1) })))
  as(t2, () => b.set((c) => wp.changeSet(c, { Y: place('Y', 2) })))
  flush()
  check('tabs: tab 1 has both widgets', live(a.get()) === 'X,Y', a.get())
  check('tabs: tab 2 has both widgets', live(b.get()) === 'X,Y', b.get())
  check('tabs: the stored copy has both', live(meta('t3places')!.value) === 'X,Y' && meta('t3places')!.dirty)
  // A removal in one tab reaches the other (and stays removed).
  as(t1, () => a.set((c) => wp.changeSet(c, {}, ['X'])))
  check('tabs: a removal in tab 1 reaches tab 2', live(b.get()) === 'Y')

  // Without mergeTabs (every store but the widget set and notes), another tab's save is taken as it is.
  const c = as(t1, () => synced<string[]>('t3plain', [], { merge: (l, r) => [...new Set([...l, ...r])] }))
  const d = as(t2, () => synced<string[]>('t3plain', []))
  held = true
  as(t1, () => c.set(['one']))
  as(t2, () => d.set(['two']))
  flush()
  check('tabs: a store without mergeTabs still takes the other tab’s save', c.get().join() === 'two' && d.get().join() === 'two')
  // The account's state being cleared in one tab is not written back by another.
  as(t1, () => localStorage.removeItem('mvlos.u.1.sync.t3places'))
  check('tabs: a cleared store is not merged back into storage', !storage.has('mvlos.u.1.sync.t3places') && live(b.get()) === '')

  // The same, with the events late: tab 1 saves a change and then clears the key, and tab 2 only
  // hears of both afterwards (reading storage when the key is already gone).
  as(t1, () => a.set(() => wp.changeSet(empty, { W: place('W', 5) })))
  check('late clear: both tabs have W', live(a.get()) === 'W' && live(b.get()) === 'W')
  held = true
  as(t1, () => a.set((c) => wp.changeSet(c, { W: place('W', 6) })))
  as(t1, () => localStorage.removeItem('mvlos.u.1.sync.t3places'))
  flush()
  check('late clear: the cleared key stays cleared', !storage.has('mvlos.u.1.sync.t3places'), storage.get('mvlos.u.1.sync.t3places'))
  check('late clear: tab 2 takes the clear', live(b.get()) === '')
  tabs.splice(tabs.indexOf(t1), 2)
}

// --- 4. clock skew and ties ---------------------------------------------------------------------
{
  const ahead = { id: 'W', kind: 'status', x: 5, y: 5, w: 1, h: 1, vw: 1400, vh: 900, at: Date.now() + 3600_000 }
  const set = (p: typeof ahead) => ({ places: { W: p }, removed: '' })
  // Another device, whose clock is an hour behind, moves it again after that.
  const moved = { ...ahead, x: 50, at: wp.nextAt(ahead) }
  check('clock: a change counts on past the entry it changes', moved.at > ahead.at)
  check('clock: the later move wins, either way round', wp.mergeSets(set(moved), set(ahead)).places.W.x === 50 && wp.mergeSets(set(ahead), set(moved)).places.W.x === 50)
  // And a removal wins over any move, whatever its counter.
  const removed = { places: {}, removed: 'W' }
  check('clock: taken off beats a move from a clock far ahead, either way round', !wp.mergeSets(removed, set(ahead)).places.W && !wp.mergeSets(set(ahead), removed).places.W)
  const p1 = { ...ahead, at: 5000, x: 1 }
  const p2 = { ...ahead, at: 5000, x: 2 }
  check('tie: two moves pick the same winner on both sides', wp.mergeSets(set(p1), set(p2)).places.W.x === wp.mergeSets(set(p2), set(p1)).places.W.x)
}

// Legacy coordinates are screen-unknown, and desktop migrations win equal counters.
{
  const mobile = { id: 'migration-tie', kind: 'status', x: 9, y: 90, w: 280, h: 220, vw: 390, vh: 800, screenUnknown: true, at: 0 }
  const desktop = { ...mobile, x: 1100, vw: 1400, vh: 900 }
  const set = (p: typeof mobile) => ({ places: { [p.id]: p }, removed: '' })
  for (const [a, b] of [[mobile, desktop], [desktop, mobile]])
    check('migration: desktop position wins in either merge order', wp.mergeSets(set(a), set(b)).places[mobile.id].x === 1100)
  check('migration: larger desktop wins before coordinates', wp.wins({ ...desktop, vw: 1800, x: 1 }, desktop))
  check('migration after cutover: phone import is ignored', !wp.importWidgets([mobile]))
  check('migration after cutover: desktop import is ignored', !wp.importWidgets([desktop]))
  check('migration: normalization keeps unknown-screen marker', wp.normalizeSet(set(desktop)).places[mobile.id].screenUnknown === true)
  check('migration: a genuine later phone change still wins', wp.wins({ ...mobile, at: 1 }, desktop))
}

// --- 5. removed stays removed for good, in little room -----------------------------------------------
{
  wp.widgetPlaces.set((c) => wp.changeSet(c, { oldone: { id: 'oldone', kind: 'status', x: 1, y: 1, w: 280, h: 220, vw: 1400, vh: 900, at: 1 } }))
  wp.widgetPlaces.set((c) => wp.changeSet(c, {}, ['oldone']))
  const back = wp.importLayoutWidgets([{ app: 'widget', x: 1, y: 1, w: 280, h: 220, props: { kind: 'status', id: 'oldone' } }])
  check('removed: an old layout can’t bring back a removed widget', !back && !wp.widgetPlaces.get().places.oldone)
  const again = await import('../src/os/widgetPlaces.ts?reload')
  check('removed: still removed when read back from storage', again.removedKeys(again.widgetPlaces.get()).has('oldone'))
  // Putting a sticky back after taking it off: a new entry, which the old removal doesn't touch.
  const key = wp.newKey(wp.widgetPlaces.get(), 'oldone')
  check('removed: putting it back gets a key of its own', key !== 'oldone' && key.startsWith('oldone~'))
  const firstFormat = wp.normalizeSet({ a1: { id: 'a1', kind: 'weather', x: 1, y: 2, w: 3, h: 4, vw: 1400, vh: 900, at: 7 }, b2: { id: 'b2', kind: 'status', x: 0, y: 0, w: 0, h: 0, vw: 0, vh: 0, at: 9, removed: true } })
  check('removed: the first format still reads (entries, and tombstones as removed keys)', live(firstFormat) === 'a1' && firstFormat.removed === 'b2')
  // 20,000 widgets taken off: the saved set stays well under the server's 524,288-byte limit.
  let big: WidgetSet = { places: {}, removed: '' }
  const ids = Array.from({ length: 20_000 }, () => crypto.randomUUID().slice(0, 8))
  big = wp.changeSet(big, Object.fromEntries(ids.slice(0, 3).map((id) => [id, { id, kind: 'weather', x: 0, y: 0, w: 280, h: 260, vw: 1400, vh: 900, at: 1 }])))
  big = wp.changeSet(big, {}, ids)
  const bytes = JSON.stringify({ value: big, base: 1 }).length
  check(`removed: 20,000 removals are ${bytes.toLocaleString('en')} bytes saved (limit 524,288)`, bytes < 200_000)
}

// --- 6. notes: two tabs, deletions, the same note edited twice, a cleared account ------------------
{
  const notes = await import('../src/data/notes.ts')
  type Note = import('../src/data/notes.ts').Note
  const t1 = new Tab()
  const t2 = new Tab()
  tabs.push(t1, t2)
  const opts = { normalize: notes.normalizeNotes, merge: notes.mergeNotes, mergeTabs: true }
  const a = as(t1, () => synced<Note[]>('t6notes', [], opts))
  const b = as(t2, () => synced<Note[]>('t6notes', [], opts))
  const T = Date.now()
  const note = (id: string, text: string, at: number, more: Partial<Note> = {}): Note => ({ id, text, color: 'yellow', tilt: 0, created: at, updated: at, ...more })
  const ids = (ns: Note[]) => ns.map((n) => n.id).join()
  const byId = (ns: Note[], id: string) => ns.find((n) => n.id === id)

  // Concurrent adds.
  held = true
  as(t1, () => a.set((ns) => [...ns, note('n1', 'one', T + 1000)]))
  as(t2, () => b.set((ns) => [...ns, note('n2', 'two', T + 1001)]))
  flush()
  check('notes: adds in two tabs at once, both tabs have both, once each', ids(a.get()) === 'n1,n2' && ids(b.get()) === 'n1,n2')
  check('notes: and so does the stored copy', ids(meta('t6notes')!.value) === 'n1,n2')

  // Deleted for good in tab 1 while tab 2 (not seeing it yet) edits it and adds another.
  held = true
  as(t1, () => a.set((ns) => ns.map((n) => (n.id === 'n1' ? { id: 'n1', text: '', color: n.color, tilt: 0, created: n.created, updated: T + 2000, deleted: T + 2000, purged: true } : n))))
  as(t2, () => b.set((ns) => [...ns.map((n) => (n.id === 'n1' ? { ...n, text: 'one, edited later', updated: T + 2500 } : n)), note('n3', 'three', T + 2400)]))
  flush()
  for (const [name, s] of [['tab 1', a], ['tab 2', b]] as const) {
    check(`notes: deleted for good stays deleted against a later edit (${name})`, byId(s.get(), 'n1')?.purged === true && byId(s.get(), 'n1')?.text === '')
    check(`notes: the other tab's new note is kept (${name})`, byId(s.get(), 'n3')?.text === 'three')
  }

  // Moved to the trash in tab 1 while tab 2 edits it: the edit's text, still in the trash.
  held = true
  as(t1, () => a.set((ns) => ns.map((n) => (n.id === 'n2' ? { ...n, deleted: T + 3000, updated: T + 3000 } : n))))
  as(t2, () => b.set((ns) => ns.map((n) => (n.id === 'n2' ? { ...n, text: 'two, edited', updated: T + 3100 } : n))))
  flush()
  for (const [name, s] of [['tab 1', a], ['tab 2', b]] as const) check(`notes: trashed in one tab, edited in the other: edited text, in the trash (${name})`, byId(s.get(), 'n2')?.text === 'two, edited' && byId(s.get(), 'n2')?.deleted === T + 3000)
  // Restored after that: an older trashing doesn't put it back.
  const restored = notes.mergeNotes([{ ...byId(a.get(), 'n2')!, deleted: undefined, restored: T + 3200, updated: T + 3200 }], [{ ...byId(a.get(), 'n2')!, text: 'old copy', updated: T + 3000, deleted: T + 3000 }])
  check('notes: restored after a trashing stays restored', !restored[0].deleted && restored[0].text === 'two, edited')

  // The same note edited in both tabs: the later edit wins, nothing doubled.
  held = true
  as(t1, () => a.set((ns) => ns.map((n) => (n.id === 'n3' ? { ...n, text: 'three, from tab 1', updated: T + 4000 } : n))))
  as(t2, () => b.set((ns) => ns.map((n) => (n.id === 'n3' ? { ...n, text: 'three, from tab 2', updated: T + 4100 } : n))))
  flush()
  check('notes: the same note edited in both tabs: the later edit, in both', byId(a.get(), 'n3')?.text === 'three, from tab 2' && byId(b.get(), 'n3')?.text === 'three, from tab 2')
  check('notes: no note doubled', ids(a.get()) === 'n1,n2,n3' && ids(b.get()) === 'n1,n2,n3')
  const tie1 = note('t', 'left', 10)
  const tie2 = note('t', 'right', 10)
  check('notes: a tie picks the same edit on both sides', notes.mergeNotes([tie1], [tie2])[0].text === notes.mergeNotes([tie2], [tie1])[0].text)

  // The account being cleared in tab 1 (sign-out, another account): tab 2 doesn't write its notes back.
  as(t1, () => localStorage.removeItem('mvlos.u.1.sync.t6notes'))
  check('notes: a cleared account is not merged back into storage', !storage.has('mvlos.u.1.sync.t6notes') && b.get().length === 0)
  // With the events late: an edit, then the clear, both heard afterwards.
  as(t1, () => a.set([note('n9', 'nine', Date.now())]))
  held = true
  as(t1, () => a.set((ns) => ns.map((n) => ({ ...n, text: 'nine, edited', updated: Date.now() + 1 }))))
  as(t1, () => localStorage.removeItem('mvlos.u.1.sync.t6notes'))
  flush()
  check('notes: a late clear stays cleared, and tab 2 takes it', !storage.has('mvlos.u.1.sync.t6notes') && b.get().length === 0)

  // Saved notes from earlier versions still load; tombstones are kept 90 days, so the list doesn't grow for ever.
  const recent = Date.now() - 30 * 864e5
  const old = notes.normalizeNotes([{ id: 'o1', text: 'hi', color: 'nope', tilt: 1, created: 1, updated: 1 }, { id: 'o2', text: '', color: 'pink', tilt: 0, created: 1, updated: recent, deleted: 1, purged: true }, { id: 'o3', text: '', color: 'pink', tilt: 0, created: 1, updated: 1, deleted: 1, purged: true }, null, { text: 'no id' }])
  check('notes: notes saved by earlier versions load (unknown colour made yellow, junk dropped)', old[0].id === 'o1' && old[0].color === 'yellow')
  check('notes: a recent tombstone is kept, one older than 90 days dropped', ids(old) === 'o1,o2' && old[1].purged === true)
  tabs.splice(tabs.indexOf(t1), 2)
}

// --- 7. notes: text and the trash merge apart; the server's writers count on like the browser ------
{
  const notes = await import('../src/data/notes.ts')
  const clock = await import('../src/data/noteClock.ts')
  type Note = import('../src/data/notes.ts').Note
  const base: Note = { id: 'm', text: 'original', color: 'yellow', tilt: 0, created: 1, updated: 100, edited: 100 }
  const one = (a: Note, b: Note) => notes.mergeNotes([a], [b])[0]
  // Tab A edits the text (200); tab B, still with the original text, moves it to the trash (300).
  const editA: Note = { ...base, text: 'edited in A', edited: 200, updated: 200 }
  const trashB: Note = { ...base, deleted: 300, updated: 300 }
  for (const [name, m] of [['A then B', one(editA, trashB)], ['B then A', one(trashB, editA)]] as const)
    check(`notes: a later trash keeps the other tab's earlier edit, in the trash (${name})`, m.text === 'edited in A' && m.deleted === 300, m)
  // Restored at 400; newer text at 500 that still carries the trashing from 300.
  const restored: Note = { ...base, restored: 400, updated: 400 }
  const newer: Note = { ...base, text: 'newer text', edited: 500, updated: 500, deleted: 300 }
  for (const [name, m] of [['restore then text', one(restored, newer)], ['text then restore', one(newer, restored)]] as const) {
    check(`notes: a restore holds against newer text that still has the old trashing (${name})`, !m.deleted && m.text === 'newer text' && m.restored === 400, m)
    check(`notes: and stays restored when merged with the old trashing again (${name})`, !one(m, trashB).deleted && !one(trashB, m).deleted)
  }
  // Trashed again after the restore: in the trash.
  const again = clock.trashedNote(one(restored, newer))
  check('notes: trashed again after a restore: in the trash', !!one(again, restored).deleted && !!one(restored, again).deleted)
  // Notes saved before `edited` and `restored` still merge: `updated` stands in for `edited`.
  const oldA = { id: 'o', text: 'old A', color: 'yellow' as const, tilt: 0, created: 1, updated: 10 }
  const oldB = { ...oldA, text: 'old B', updated: 20 }
  check('notes: notes from earlier versions merge by `updated`', one(oldA, oldB).text === 'old B' && one(oldB, oldA).text === 'old B')

  const legacyRestore = { ...oldA, updated: 300 }
  const legacyTrash = { ...oldA, updated: 200, deleted: 200 }
  for (const [a, b] of [[legacyRestore, legacyTrash], [legacyTrash, legacyRestore]]) {
    const m = one(a, b)
    check('notes: legacy restore survives stale trash in either order', !m.deleted && m.restored === 300)
    check('notes: inferred legacy restore survives a second merge', !one(m, legacyTrash).deleted && !one(legacyTrash, m).deleted)
  }
  check('notes: explicit restore and legacy updated take the maximum', one({ ...legacyRestore, restored: 400 }, legacyTrash).restored === 400 && one({ ...legacyRestore, restored: 100 }, legacyTrash).restored === 300)

  // The server's writers (agents' update_note and delete_note, links) count on past the note's
  // counters, so an agent's edit doesn't lose to older text from a browser whose counter ran ahead.
  const ahead: Note = { ...base, edited: Date.now() + 3600_000, updated: Date.now() + 3600_000 }
  const byAgent = clock.editedNote(ahead, { text: 'from the agent' })
  check('server: an edit counts on past a browser counter ahead of the clock', byAgent.edited! > ahead.edited! && one(ahead, byAgent).text === 'from the agent' && one(byAgent, ahead).text === 'from the agent')
  const trashedByAgent = clock.trashedNote(ahead)
  check('server: a trashing counts on past it too', trashedByAgent.deleted! > ahead.updated && !!one(ahead, trashedByAgent).deleted)
  const relinked = clock.relinkedNote({ ...ahead, eventsAt: Date.now() + 7200_000 }, { events: [] })
  check('server: a link change counts on past the last one, and leaves `updated`', relinked.eventsAt! > Date.now() + 7200_000 && relinked.updated === ahead.updated)
  const { readFileSync } = await import('node:fs')
  const agents = readFileSync(new URL('../server/agents.ts', import.meta.url), 'utf8')
  const links = readFileSync(new URL('../server/noteLinks.ts', import.meta.url), 'utf8')
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  check('server: update_note and delete_note use the shared counters', agents.includes('editedNote(n, { text: next })') && agents.includes('trashedNote(n)') && !/updated: Date\.now\(\) \} : n\)/.test(agents))
  check('server: noteLinks keeps the other fields (restored, edited, updated) and counts links on', links.includes('relinkedNote(n, { events })') && !links.includes('eventsAt: Date.now()'))
  check('server: the image copies noteClock.ts', /COPY [^\n]*src\/data\/noteClock\.ts/.test(docker))
}

// --- 8. a later old-client widget-set write is ignored after canonical cutover ---------------------
{
  // The set as this page has it (section 5 read it in again, which is now the one pulls go to).
  const wp = await import('../src/os/widgetPlaces.ts?reload')
  wp.widgetPlaces.set((c) => wp.changeSet(c, { mine: { id: 'mine', kind: 'status', x: 1, y: 1, w: 280, h: 220, vw: 1400, vh: 900, at: 5 } }))
  server.set('widgets:placed', { value: { theirs: { id: 'theirs', kind: 'weather', x: 0, y: 0, w: 280, h: 260, vw: 1400, vh: 900, at: 9 }, gone: { id: 'gone', kind: 'status', x: 0, y: 0, w: 0, h: 0, vw: 0, vh: 0, at: 9, removed: true } }, updatedAt: ++clock })
  await pullAll()
  const got = wp.widgetPlaces.get()
  check('first format from the server: the pull finishes without an error', getSyncStatus().state !== 'error', getSyncStatus())
  check('old-client write after cutover: ignored, retaining canonical edits', !got.places.theirs && !!got.places.mine && !wp.removedKeys(got).has('gone'))
}

// --- 9. notes: trash and restore keep the text's time; links break ties the same everywhere ---------
{
  const notes = await import('../src/data/notes.ts')
  const clock2 = await import('../src/data/noteClock.ts')
  type Note = import('../src/data/notes.ts').Note
  const one = (a: Note, b: Note) => notes.mergeNotes([a], [b])[0]
  // Notes without `edited` (saved by earlier versions, or trashed by the server's delete_note).
  const plain: Note = { id: 'p', text: 'original', color: 'yellow', tilt: 0, created: 1, updated: 100 }
  const editA: Note = { ...plain, text: 'edited in A', updated: 200 }
  const trashB = clock2.trashedNote({ ...plain })
  check('notes: trashing keeps the text’s time in `edited`', trashB.edited === 100 && trashB.updated > 100)
  for (const [name, m] of [['A then B', one(editA, trashB)], ['B then A', one(trashB, editA)]] as const)
    check(`notes: an edit at 200 survives a later trash of a note without \`edited\` (${name})`, m.text === 'edited in A' && !!m.deleted && m.edited === 200)
  const restoreB = clock2.restoredNote({ ...plain, deleted: 50 })
  for (const [name, m] of [['A then B', one(editA, restoreB)], ['B then A', one(restoreB, editA)]] as const)
    check(`notes: and a later restore (${name})`, m.text === 'edited in A' && !m.deleted)
  const relinkB = clock2.relinkedNote({ ...plain }, { events: [] })
  check('notes: and a link change', one(editA, relinkB).text === 'edited in A' && one(relinkB, editA).text === 'edited in A')
  check('notes: a new note has `edited` from the start', /updated: now, edited: now/.test((await import('node:fs')).readFileSync(new URL('../src/data/notes.ts', import.meta.url), 'utf8')))
  // Links changed in two tabs with the same counter: the same pick on both sides.
  const ev = (uid: string) => [{ uid, title: uid, start: '2026-10-23T10:00:00Z' }] as unknown as Note['events']
  const l1: Note = { ...plain, events: ev('one'), eventsAt: 500 }
  const l2: Note = { ...plain, events: ev('two'), eventsAt: 500 }
  check('notes: equal link counters pick the same links on both sides', JSON.stringify(one(l1, l2).events) === JSON.stringify(one(l2, l1).events))
  // Two tabs exchanging those: settled at once, and hearing of each other writes nothing.
  const t1 = new Tab()
  const t2 = new Tab()
  tabs.push(t1, t2)
  const opts = { normalize: notes.normalizeNotes, merge: notes.mergeNotes, mergeTabs: true }
  const a = as(t1, () => synced<Note[]>('t9notes', [], opts))
  const b = as(t2, () => synced<Note[]>('t9notes', [], opts))
  held = true
  as(t1, () => a.set([l1]))
  as(t2, () => b.set([l2]))
  const before = writes
  flush()
  check('notes: two tabs with tied links agree', JSON.stringify(a.get()) === JSON.stringify(b.get()))
  check(`notes: and hearing of each other writes nothing (${writes - before} writes)`, writes === before)
  tabs.splice(tabs.indexOf(t1), 2)
}

// --- 10. no save loops: a store saves what changed once, then stays quiet ---------------------------
{
  type Set = import('../src/os/widgetPlaces.ts').WidgetSet
  const opts = { normalize: wp.normalizeSet, merge: wp.mergeSets, mergeTabs: true }
  const entry = (id: string, at = 1) => ({ id, kind: 'status', x: 1, y: 1, w: 280, h: 220, vw: 1400, vh: 900, at })
  const savesOf = (key: string, from: number) => puts.slice(from).filter((k) => k === key).length

  // One tab (mergeTabs reads back its own earlier write, which says "unsaved").
  const t1 = new Tab()
  tabs.push(t1)
  const a = as(t1, () => synced<Set>('loop:one', { places: {}, removed: '' }, opts))
  let from = puts.length
  as(t1, () => a.set((c) => wp.changeSet(c, { x: entry('x') })))
  await sleep(4000)
  check(`loop: one tab saves a change once (${savesOf('loop:one', from)} saves)`, savesOf('loop:one', from) === 1)
  check('loop: and is clean after', meta('loop:one')?.dirty === false)

  // Two tabs of one browser, both changing it.
  const t2 = new Tab()
  tabs.push(t2)
  const b = as(t2, () => synced<Set>('loop:one', { places: {}, removed: '' }, opts))
  from = puts.length
  as(t2, () => b.set((c) => wp.changeSet(c, { y: entry('y') })))
  as(t1, () => a.set((c) => wp.changeSet(c, { z: entry('z') })))
  await sleep(5000)
  const two = savesOf('loop:one', from)
  check(`loop: two tabs save their changes and stop (${two} saves)`, two >= 1 && two <= 3)
  check('loop: both tabs and the server have all three', ['x', 'y', 'z'].every((k) => k in a.get().places && k in b.get().places && k in (server.get('loop:one')!.value as Set).places))
  from = puts.length
  await sleep(3000)
  check(`loop: then quiet (${savesOf('loop:one', from)} saves)`, savesOf('loop:one', from) === 0)

  // A change made again (the same value): nothing sent.
  from = puts.length
  as(t1, () => a.set((c) => ({ places: { ...c.places }, removed: c.removed })))
  await sleep(1500)
  check(`loop: setting the same value again sends nothing (${savesOf('loop:one', from)} saves)`, savesOf('loop:one', from) === 0)
  // A change undone before it was sent: nothing either (a plain store; in a set, an undo is a newer change).
  const plain = synced<string>('loop:plain', '')
  plain.set('first')
  await sleep(1500)
  from = puts.length
  plain.set('second')
  plain.set('first')
  await sleep(1500)
  check(`loop: a change undone before it was sent sends nothing (${savesOf('loop:plain', from)} saves)`, savesOf('loop:plain', from) === 0 && !meta('loop:plain')!.dirty)
  tabs.splice(tabs.indexOf(t1), 2)

  // Another device saving all the time: every save here conflicts and merges. Held back, not hammered.
  const c = synced<Set>('loop:storm', { places: {}, removed: '' }, opts)
  let n = 0
  server.set('loop:storm', { value: { places: {}, removed: '' }, updatedAt: ++clock })
  // Another save from there lands right before each of this tab's: each one conflicts.
  storming = () => server.set('loop:storm', { value: { places: { [`other${++n}`]: entry(`other${n}`, n) }, removed: '' }, updatedAt: ++clock })
  from = puts.length
  c.set((v) => wp.changeSet(v, { mine: entry('mine', 1e15) }))
  await sleep(8000)
  storming = null
  const stormy = savesOf('loop:storm', from)
  check(`loop: conflict after conflict is rate-limited (${stormy} saves in 8 s)`, stormy >= 2 && stormy <= 16)

  // A change made while a save is out, and that save fails: the change still goes out (after a wait).
  // A hidden tab: no pull comes along to save it instead.
  ;(g.document as { visibilityState: string }).visibilityState = 'hidden'
  slowPut.set('loop:flight', { ms: 1500, fail: 1 })
  const f = synced<string>('loop:flight', '')
  f.set('A')
  await sleep(1000) // A is out (sent at 800 ms, answered at 2300 ms)
  f.set('B') // its timer runs out at 1800 ms, while A is still out
  await sleep(6500)
  ;(g.document as { visibilityState: string }).visibilityState = 'visible'
  check('in flight: a change made meanwhile is saved after the save out fails', (server.get('loop:flight')?.value as string) === 'B' && !meta('loop:flight')!.dirty, { server: server.get('loop:flight'), puts: puts.filter((k) => k.startsWith('loop:flight')) })

  // The same, with the page closing while A is out: pagehide sends B, though its timer is gone.
  slowPut.set('loop:hide', { ms: 2000, fail: 0 })
  const h = synced<string>('loop:hide', '')
  h.set('A')
  await sleep(1000)
  h.set('B')
  await sleep(1200) // B's timer has run out and given way to A
  const hideFrom = sentBodies.length
  main.listeners.get('pagehide')?.forEach((l) => l({ key: null, newValue: null }))
  const hidden = sentBodies.slice(hideFrom)
  check('pagehide: a change waiting for a save still out is sent', hidden.some((b) => b.startsWith('loop:hide ') && JSON.parse(b.slice(9)).value === 'B'), hidden)
  await sleep(2500)

  // Undone while the save is out, then the page closes: the server's old value is sent anyway,
  // or the save out would be the one the server keeps.
  const u = synced<string>('loop:undo', '')
  u.set('X')
  await sleep(1500)
  slowPut.set('loop:undo', { ms: 2000, fail: 0 })
  u.set('A')
  await sleep(1000) // A is out
  u.set('X')
  const undoFrom = sentBodies.length
  main.listeners.get('pagehide')?.forEach((l) => l({ key: null, newValue: null }))
  const undone = sentBodies.slice(undoFrom)
  check('pagehide: a change undone while a save is out is still sent', undone.some((b) => b.startsWith('loop:undo ') && JSON.parse(b.slice(10)).value === 'X'), undone)
  await sleep(2500)

  // Closing cancels the timers; both saves fail; the page comes back from the back/forward cache:
  // what it hadn't saved is saved then.
  ;(g.document as { visibilityState: string }).visibilityState = 'hidden'
  slowPut.set('loop:bfcache', { ms: 1500, fail: 2 })
  const c2 = synced<string>('loop:bfcache', '')
  c2.set('A')
  await sleep(1000) // A is out (answered, failing, at 2300 ms)
  c2.set('B') // its timer would run out at 1800 ms
  await sleep(200)
  main.listeners.get('pagehide')?.forEach((l) => l({ key: null, newValue: null })) // B sent, and fails
  await sleep(2000)
  main.listeners.get('pageshow')?.forEach((l) => l({ persisted: true } as never))
  await sleep(6000)
  ;(g.document as { visibilityState: string }).visibilityState = 'visible'
  check('bfcache: after both saves failed, the page back from the cache saves its change', (server.get('loop:bfcache')?.value as string) === 'B' && !meta('loop:bfcache')!.dirty, { server: server.get('loop:bfcache'), puts: puts.filter((k) => k.startsWith('loop:bfcache')) })
  slowPut.clear()

  // The pacing over a long stretch, on a clock of its own: a store that saves again as soon as it
  // may (as after conflict on conflict) gets ever longer waits, and none after a quiet spell.
  const { syncPacing } = await import('../src/os/synced.ts')
  let t = 1e12
  let n90 = 0
  const sends: number[] = []
  while (t < 1e12 + 300_000) {
    const wait = syncPacing.backoff('pace:loop', t)
    if (wait > 0) t += wait
    syncPacing.counted('pace:loop', t)
    sends.push(t)
    if (t < 1e12 + 90_000) n90++
    t += 50
  }
  const gaps = sends.slice(1).map((s, i) => s - sends[i])
  check(`pacing: a store saving nonstop sends a burst, then ever fewer (${n90} saves in 90 s, ${sends.length} in 5 min)`, n90 <= 18 && sends.length <= 22, gaps)
  check('pacing: its waits double up to a minute', Math.max(...gaps) === 60_000 && gaps.slice(-3).every((g) => g === 60_000))
  check('pacing: quiet for long enough, it saves at once again', syncPacing.backoff('pace:loop', t + 130_000) === 0)
  // Saving at a person's pace (a change every 2 s) is never held back.
  let typing = 0
  for (let i = 0; i < 60; i++) typing += syncPacing.backoff('pace:typing', 2e12 + i * 2000) > 0 ? 1 : (syncPacing.counted('pace:typing', 2e12 + i * 2000), 0)
  check(`pacing: a change every 2 s is never held back (${typing} held)`, typing === 0)
  syncPacing.failed('pace:err')
  syncPacing.counted('pace:err', 3e12)
  check('pacing: a failed save is tried again after a wait', syncPacing.backoff('pace:err', 3e12) > 0)
}

// Accounts (whose state a tab holds, switching account in another tab): scripts/sync-accounts-check.ts.

finish()
