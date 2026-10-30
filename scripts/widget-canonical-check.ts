// Pure merge/migration fixtures plus the real canonical facade and synced hydration/CAS paths.
// No real accounts, browser, source packages, or network. Run with pnpm exec node <this file>.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
      const url = new URL(/\.[cm]?[jt]sx?$/.test(specifier) ? specifier : `${specifier}.ts`, context.parentURL)
      url.search = new URL(context.parentURL).search
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})
const model = await import('../src/widgets/platform/canonicalModel.ts')
const sets = await import('../src/widgets/platform/placementSet.ts')
const { emptyWidgetState, configsOf, importLegacy, mergeWidgetStates, mergeInstallationRecords, normalizeWidgetState, stableJSON, withConfigs } = model
const KEY = 'widgets:state:v2'
const entry = (id: string, extra = {}) => ({ id, kind: 'sticky', x: 991, y: 521, w: 317, h: 189, vw: 1600, vh: 900, phone: false, stack: 3, minimized: true, screenUnknown: true, at: 71, ...extra })
const revision = (generation: number, digest = 'sha256:fixture') => ({ schema: 1, instance: 'note', kind: 'sticky', generation, active: { source: { kind: 'system', path: '/usr/share/mvlos/widgets/sticky' }, snapshot: { digest, files: { 'src/main.js': 'immutable fixture' } } }, previous: { snapshot: { digest: 'previous' } } })

// Imported identity/geometry is a byte-for-byte projection; no overlap repair or resize policy.
const legacy = importLegacy({ note: { tilt: 4.5, appearance: 'paper' }, weather: { units: 'c' } }, { places: { note: entry('note'), overlap: entry('overlap') }, removed: 'gone' }, { note: revision(3) })
assert.deepEqual(legacy.placements.places.note, entry('note'))
assert.deepEqual(legacy.placements.places.overlap, entry('overlap'))
assert.equal(legacy.placements.removed, 'gone')
assert.deepEqual(legacy.installations.note, revision(3))
assert.deepEqual(normalizeWidgetState(legacy), legacy)
assert.equal(normalizeWidgetState({ schema: 2 }), null)
assert.deepEqual(sets.normalizeSet({ places: null }), { places: {}, removed: '' })
const variant = { places: { 'note~variant': entry('note') }, removed: '' }
assert.equal(sets.importPlaces(variant, [entry('note')]), variant, 'layout import cannot duplicate note identity under its original key')
assert.equal(sets.importPlaces(legacy.placements, [entry('gone')]), legacy.placements, 'layout import cannot resurrect a tombstone')

const a = withConfigs(legacy, { ...configsOf(legacy), note: { tilt: -2 } }, 100)
const b = withConfigs(legacy, { ...configsOf(legacy), weather: { units: 'f' } }, 101)
const merge = (a: model.WidgetState, b: model.WidgetState) => mergeWidgetStates(a, b)!
assert.deepEqual(configsOf(merge(a, b)), { note: { tilt: -2 }, weather: { units: 'f' } })
const tied = withConfigs(legacy, { ...configsOf(legacy), note: { tilt: 2 } }, 100)
assert.equal(stableJSON(merge(a, tied)), stableJSON(merge(tied, a)))
const ahead = withConfigs(legacy, { ...configsOf(legacy), note: { tilt: 9 } }, 1e15)
assert.equal(withConfigs(ahead, { ...configsOf(ahead), note: { tilt: 1 } }, 2).configs.note.at, 1e15 + 1)
const deleted = withConfigs(a, { weather: { units: 'c' } }, 102)
assert.equal(configsOf(merge(deleted, a)).note, undefined)
const readded = withConfigs(deleted, { ...configsOf(deleted), note: { tilt: 0 } }, 1)
assert.deepEqual(configsOf(merge(readded, deleted)).note, { tilt: 0 })
const revA = { note: revision(3, 'a') }, revB = { note: revision(3, 'b') }
assert.deepEqual(mergeInstallationRecords(revA, revB), mergeInstallationRecords(revB, revA))
assert.deepEqual(mergeInstallationRecords({ note: revision(4) }, revB).note, revision(4))
assert.deepEqual(sets.mergeSets({ places: { gone: entry('gone', { at: 1e15 }) }, removed: '' }, legacy.placements).removed, 'gone')
console.log('pure canonical migration/config/placement/installation merge fixtures passed')

// Each page imports its own real modules; storage and the fake account server are shared.
type Remote = { value: unknown; updatedAt: number }
type Listener = (event: any) => void
const g = globalThis as any
const nativeTimeout = globalThis.setTimeout
const storage = new Map<string, string>()
const servers = new Map<string, Map<string, Remote>>()
const pages: Page[] = []
let active: Page
let tick = 2000
let timerId = 0
const timers = new Map<number, { page: Page; callback: () => void }>()
const writes: string[] = []
const puts: { account: string; key: string; value: unknown }[] = []
const savedGlobals = Object.fromEntries(['window', 'document', 'location', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout'].map(key => [key, g[key]]))
class Page {
  id = pages.length + 1
  innerWidth = 1400
  innerHeight = 900
  listeners = new Map<string, Listener[]>()
  cookie: string
  failPull = false
  failAccount = false
  blocked = false
  canonical!: typeof import('../src/widgets/platform/canonicalState.ts')
  wp!: typeof import('../src/os/widgetPlaces.ts')
  config!: typeof import('../src/widgets/config.ts')
  sync!: typeof import('../src/os/synced.ts')
  account!: typeof import('../src/os/account.ts')
  accountId: string
  device: string
  constructor(accountId: string, device = 'shared') {
    this.accountId = accountId
    this.device = device
    pages.push(this)
    this.cookie = accountId === 'visitor' ? '' : `mvlos_uid=${accountId}; mvlos_login=fixture`
    if (!servers.has(accountId)) servers.set(accountId, new Map())
  }
  storageKey(key: string) { return `${this.device}/${this.accountId === 'visitor' ? 'mvlos.visitor.' : `mvlos.u.${this.accountId}.`}${key.replace(/^mvlos\./, '')}` }
  addEventListener(type: string, l: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], l]) }
  removeEventListener(type: string, l: Listener) { this.listeners.set(type, this.listeners.get(type)?.filter(x => x !== l) ?? []) }
  dispatchEvent() { return true }
  activate() {
    active = this
    g.window = this
    g.document = { cookie: this.cookie, title: '', visibilityState: 'visible', addEventListener() {} }
    g.location = { pathname: '/', origin: 'http://fixture.invalid', reload() {}, assign() {} }
  }
  run<T>(f: () => T): T {
    const previous = active
    this.activate()
    try { return f() } finally { previous?.activate() }
  }
  async init() {
    this.activate()
    this.canonical = await import(`../src/widgets/platform/canonicalState.ts?tab=${this.id}`)
    this.wp = await import(`../src/os/widgetPlaces.ts?tab=${this.id}`)
    this.config = await import(`../src/widgets/config.ts?tab=${this.id}`)
    this.sync = await import(`../src/os/synced.ts?tab=${this.id}`)
    this.account = await import(`../src/os/account.ts?tab=${this.id}`)
  }
  async login() { this.activate(); await this.account.loadAccount() }
  async pull() { this.activate(); await this.sync.pullAll() }
  async flush() {
    this.activate()
    for (const [id, timer] of [...timers]) if (timer.page === this) { timers.delete(id); timer.callback() }
    await new Promise(resolve => nativeTimeout(resolve, 2))
  }
  seed(key: string, value: unknown, base = 0, dirty = false) { storage.set(this.storageKey(`mvlos.sync.${key}`), JSON.stringify({ value, base, dirty })) }
  meta(key: string) { return JSON.parse(storage.get(this.storageKey(`mvlos.sync.${key}`)) ?? 'null') }
}
g.localStorage = {
  getItem(key: string) { if (active.blocked) throw new Error('blocked'); return storage.get(`${active.device}/${key}`) ?? null },
  setItem(key: string, value: string) {
    if (active.blocked) throw new Error('blocked')
    const from = active
    storage.set(`${from.device}/${key}`, value)
    writes.push(`${from.device}/${key}`)
    for (const page of pages) if (page !== from && page.device === from.device) page.run(() => page.listeners.get('storage')?.forEach(l => l({ key, newValue: value })))
  },
  removeItem(key: string) { if (active.blocked) throw new Error('blocked'); storage.delete(`${active.device}/${key}`) },
}
g.setTimeout = (callback: () => void) => { const id = ++timerId; timers.set(id, { page: active, callback }); return id }
g.clearTimeout = (id: number) => timers.delete(id)
g.fetch = async (path: string, init: RequestInit = {}) => {
  const page = active
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
  if (path === '/api/me') return page.failAccount ? json({ error: 'offline fixture' }, 503) : json({ authEnabled: true, user: page.accountId === 'visitor' ? null : { id: Number(page.accountId), login: 'fixture' }, forges: [] })
  const server = servers.get(page.accountId)!
  if (path === '/api/state') return page.failPull ? json({ error: 'offline fixture' }, 503) : json(Object.fromEntries(server))
  if (path.startsWith('/api/state/') && init.method === 'PUT') {
    const key = decodeURIComponent(path.slice('/api/state/'.length))
    const { value, base } = JSON.parse(String(init.body))
    puts.push({ account: page.accountId, key, value })
    const current = server.get(key)
    if (current && current.updatedAt > base) return json({ ...current, conflict: true })
    const remote = { value, updatedAt: ++tick }
    server.set(key, remote)
    return json(remote)
  }
  throw new Error(`Unexpected network access: ${path}`)
}
try {
  // Account metadata alone, failed hydration and absent keys must be distinguishable.
  const first = new Page('11', 'first')
  first.seed('widgets', { note: { tilt: 4.5 }, local: { units: 'c' } })
  first.seed('widgets:placed', legacy.placements)
  first.seed('widgets:packages:v1', { note: revision(3) })
  first.seed('windows:desktop', [{ app: 'widget', props: { id: 'old-layout', kind: 'status' }, x: 700, y: 300, w: 333, h: 222, stack: 4, minimized: true }])
  servers.get('11')!.set('widgets', { value: { note: { tilt: -4.5, units: 'f' }, remote: { tilt: 2 } }, updatedAt: 500 })
  servers.get('11')!.set('widgets:placed', { value: { places: { other: entry('other') }, removed: 'gone' }, updatedAt: 500 })
  const legacyBefore = ['widgets', 'widgets:placed', 'widgets:packages:v1'].map(key => storage.get(first.storageKey(`mvlos.sync.${key}`)))
  await first.init()
  assert.equal(first.meta(KEY), null)
  first.config.setWidgetConfig('note', { tilt: 2 })
  first.wp.widgetPlaces.set(cur => first.wp.changeSet(cur, { mine: entry('mine', { at: 90 }) }))
  assert.equal(first.meta(KEY), null, 'queued writes do not establish canonical state')
  await first.login()
  await first.flush()
  assert.equal(puts.length, 0, 'no empty/new canonical value is pushed before hydration')
  first.failPull = true
  await first.pull()
  assert.equal(first.meta(KEY), null, 'failed pull is not hydration')
  first.failPull = false
  let remoteEvents = 0
  first.wp.widgetPlaces.onRemote(() => remoteEvents++)
  await first.pull()
  assert.equal(first.canonical.widgetsHydrated(), true)
  assert.deepEqual(first.config.getWidgetConfig('note', { tilt: 0, units: 'c' }), { tilt: 2, units: 'f' }, 'queued patch preserves unrelated hydrated fields and defaults')
  assert.deepEqual(first.wp.widgetPlaces.get().places.note, entry('note'))
  assert.ok(first.wp.widgetPlaces.get().places.mine && first.wp.widgetPlaces.get().places.other)
  assert.equal(first.wp.widgetPlaces.get().places['old-layout'].x, 700)
  assert.equal(first.wp.widgetPlaces.get().places['old-layout'].screenUnknown, true)
  assert.equal(remoteEvents, 1, 'WM sees one valid adoption after all keys, including missing installations')
  assert.deepEqual(first.meta(KEY).value.installations.note, revision(3))
  assert.deepEqual(['widgets', 'widgets:placed', 'widgets:packages:v1'].map(key => storage.get(first.storageKey(`mvlos.sync.${key}`))), legacyBefore, 'legacy local records remain unchanged')
  await first.flush()
  assert.ok(servers.get('11')!.has(KEY))
  assert.ok(puts.every(p => p.key === KEY), 'only the canonical envelope is written to account state')
  first.wp.widgetPlaces.set(cur => first.wp.changeSet(cur, { own: entry('own') }))
  await first.flush()
  const eventsBeforeQuietPull = remoteEvents
  await first.pull()
  assert.equal(remoteEvents, eventsBeforeQuietPull, 'quiet hydration does not misreport local edits as remote WM changes')

  // Old-client writes after cutover cannot import new ids, change config, or revive a tombstone.
  first.wp.widgetPlaces.set(cur => first.wp.changeSet(cur, {}, ['note', 'fresh']))
  first.config.dropWidgetConfig('note')
  const oldClient = new Page('11', 'first')
  await oldClient.init()
  await oldClient.login()
  await oldClient.pull()
  oldClient.run(() => {
    localStorage.setItem('mvlos.u.11.sync.widgets', JSON.stringify({ value: { note: { tilt: 99 } }, base: 0, dirty: true }))
    localStorage.setItem('mvlos.u.11.sync.widgets:placed', JSON.stringify({ value: { places: { note: entry('note', { at: 1e15 }) }, removed: '' }, base: 0, dirty: true }))
  })
  servers.get('11')!.set('widgets', { value: { note: { tilt: 99 } }, updatedAt: ++tick })
  servers.get('11')!.set('widgets:placed', { value: { places: { note: entry('note', { at: 1e15 }) }, removed: '' }, updatedAt: ++tick })
  await first.pull()
  assert.equal(first.wp.widgetPlaces.get().places.note, undefined)
  assert.deepEqual(first.config.getWidgetConfig('note', { tilt: 0 }), { tilt: 0 })
  assert.equal(first.wp.importLayoutWidgets([{ app: 'widget', props: { id: 'late-new-id', kind: 'status' } }]), false)
  await first.flush()

  // Another device with no v2 local copy queues edits before learning the canonical account.
  const second = new Page('11', 'second')
  second.seed('widgets', { note: { tilt: 99 } })
  second.seed('widgets:placed', { places: { note: entry('note') }, removed: '' })
  await second.init()
  second.config.setWidgetConfig('weather', { units: 'f' })
  assert.equal(second.wp.importLayoutWidgets([{ app: 'widget', props: { id: 'stale-layout', kind: 'status' } }]), true)
  second.wp.widgetPlaces.set(cur => second.wp.changeSet(cur, { newnote: entry('newnote') }))
  second.wp.widgetPlaces.set(cur => second.wp.changeSet(cur, { fresh: entry('fresh') }))
  await second.login()
  await second.pull()
  assert.equal(second.wp.widgetPlaces.get().places.note, undefined)
  assert.equal(second.wp.widgetPlaces.get().places['stale-layout'], undefined, 'queued layout migration is ignored when canonical already exists')
  assert.ok(second.wp.widgetPlaces.get().places.newnote, 'queued real add survives adoption')
  assert.equal(second.wp.widgetPlaces.get().places.fresh, undefined, 'old tombstone key is never reused')
  assert.equal(second.wp.entriesOf(second.wp.widgetPlaces.get(), 'fresh').length, 1, 'queued fresh add gets a new key when hydration reveals an old tombstone')
  assert.equal(second.canonical.canonicalConfigs.get().weather.units, 'f')
  await second.flush()
  await first.pull()
  assert.ok(first.wp.widgetPlaces.get().places.newnote)

  // Real conflict response merges independent config ids and whole installation revisions.
  first.activate()
  first.config.setWidgetConfig('local-one', { tilt: 1 })
  second.activate()
  second.config.setWidgetConfig('remote-two', { tilt: 2 })
  second.canonical.canonicalInstallations.set(all => ({ ...all, note: revision(4) }))
  await second.flush()
  await first.flush() // first PUT conflicts, merges, and schedules another PUT
  await first.flush()
  await second.pull()
  assert.equal(second.canonical.canonicalConfigs.get()['local-one'].tilt, 1)
  assert.equal(first.canonical.canonicalConfigs.get()['remote-two'].tilt, 2)
  assert.deepEqual(first.canonical.canonicalInstallations.get().note, revision(4))
  assert.equal(first.wp.widgetPlaces.get().places.note, undefined, 'installation recovery/source availability never restores placement')
  assert.equal(first.canonical.canonicalConfigs.get().note, undefined, 'installation changes never roll config back')

  // Every key missing is still a successful hydration; the envelope + marker are one write.
  const empty = new Page('12', 'empty')
  await empty.init()
  await empty.login()
  assert.equal(empty.meta(KEY), null)
  await empty.pull()
  assert.deepEqual(empty.meta(KEY).value, emptyWidgetState())
  assert.equal(empty.sync.getSyncedHydration()![KEY], undefined)
  await empty.flush()

  // Journal survives reload while offline, before any canonical marker may be written.
  const offline = new Page('13', 'offline')
  await offline.init()
  await offline.login()
  offline.config.setWidgetConfig('offline-note', { tilt: 3 })
  offline.failPull = true
  await offline.pull()
  assert.equal(offline.meta(KEY), null)
  const reload = new Page('13', 'offline')
  await reload.init()
  assert.equal(reload.canonical.canonicalConfigs.get()['offline-note'].tilt, 3)

  // Independent pre-hydration tabs share a mergeable journal across a reload.
  const queuedA = new Page('14', 'queued')
  await queuedA.init()
  const queuedB = new Page('14', 'queued')
  await queuedB.init()
  queuedA.run(() => queuedA.config.setWidgetConfig('a', { tilt: 1 }))
  queuedB.run(() => queuedB.config.setWidgetConfig('b', { tilt: 2 }))
  const queuedReload = new Page('14', 'queued')
  await queuedReload.init()
  await queuedReload.login()
  await queuedReload.pull()
  assert.equal(queuedReload.canonical.canonicalConfigs.get().a.tilt, 1)
  assert.equal(queuedReload.canonical.canonicalConfigs.get().b.tilt, 2)

  const unknownGuest = new Page('visitor', 'offline-guest')
  unknownGuest.failAccount = true
  await unknownGuest.init()
  await unknownGuest.login()
  assert.equal(unknownGuest.meta(KEY), null, 'failed account discovery is unknown, even without an account cookie')

  const unsupported = new Page('15', 'unsupported')
  servers.get('15')!.set(KEY, { value: { schema: 3, future: true }, updatedAt: ++tick })
  await unsupported.init()
  await unsupported.login()
  await unsupported.pull()
  assert.equal(unsupported.canonical.widgetsHydrated(), false, 'unsupported canonical format is not removal or permission to overwrite it')
  assert.equal(unsupported.meta(KEY).dirty, false)
  await reload.login()
  await reload.pull()
  assert.equal(reload.canonical.canonicalConfigs.get()['offline-note'].tilt, 3)

  // Guests cut over locally only after account identity is known. Storage denial stays usable.
  const guest = new Page('visitor', 'guest')
  guest.seed('widgets:placed', { places: { guest: entry('guest') }, removed: '' })
  await guest.init()
  guest.config.setWidgetConfig('guest', { tilt: -2 })
  assert.equal(guest.meta(KEY), null)
  await guest.login()
  assert.ok(guest.meta(KEY).value.placements.places.guest)
  assert.equal(guest.meta(KEY).value.configs.guest.value.tilt, -2)
  const denied = new Page('visitor', 'denied')
  denied.blocked = true
  await denied.init()
  denied.config.setWidgetConfig('temp', { tilt: 1 })
  await denied.login()
  assert.equal(denied.canonical.canonicalConfigs.get().temp.tilt, 1)
  denied.wp.widgetPlaces.set(cur => denied.wp.changeSet(cur, { temp: entry('temp') }))
  assert.ok(denied.wp.widgetPlaces.get().places.temp)

  console.log('real facade/hydration/offline/old-client/CAS/guest/storage-denied fixtures passed')
} finally {
  Object.assign(g, savedGlobals)
}
