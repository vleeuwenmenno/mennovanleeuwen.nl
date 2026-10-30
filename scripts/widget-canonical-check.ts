// Pure merge/migration fixtures plus the real canonical facade and synced hydration/CAS paths.
// No real accounts, browser, source packages, or network. Run with pnpm exec node <this file>.
import assert from 'node:assert/strict'
import { widgetStorageFixture } from './widget-storage-fixture.ts'
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
const replayLog = model.appendPending(model.emptyPending(), 'same-operation', 1, model.configDelta({}, { agenda: { days: 1 } }))
const consumedOnce = model.applyPending(emptyWidgetState(), replayLog, false)
const laterEdit = withConfigs(consumedOnce, { agenda: { days: 7 } })
assert.deepEqual(model.applyPending(laterEdit, replayLog, true), laterEdit, 'replaying a consumed operation is a strict no-op even after a later edit')
const overOnePass: model.PendingWidgets = { operations: Object.fromEntries(Array.from({ length: model.JOURNAL_LIMITS.operations + 1 }, (_, i) => ['burst:' + (i + 1), { writer: 'burst', sequence: i + 1, at: i + 1, delta: { ...model.emptyDelta(), configs: { burst: { at: i + 1, patch: { value: i + 1 }, unset: [] } } } }])) }
const firstPass = model.applyPending(emptyWidgetState(), overOnePass, false)
assert.equal(firstPass.consumed!.burst, model.JOURNAL_LIMITS.operations)
assert.equal(Object.keys(model.unconsumed(overOnePass, firstPass).operations).length, 1)
assert.equal(model.applyPending(firstPass, overOnePass, true).consumed!.burst, model.JOURNAL_LIMITS.operations + 1, 'bounded replay retains and drains the remainder')
// A remotely tombstoned original key is remapped once per writer. Every following gesture
// addresses that same identity, including later replay passes and a JSON/reload round trip.
const remapBase = { ...emptyWidgetState(), placements: { places: {}, removed: 'remap-note' } }
const remapAdd = { ...model.emptyDelta(), placements: { places: { 'remap-note': entry('remap-note') }, removed: '' }, added: ['remap-note'] }
const remapMove = { ...model.emptyDelta(), placements: { places: { 'remap-note': entry('remap-note', { x: 123, y: 456, at: 72 }) }, removed: '' } }
const remapRemove = { ...model.emptyDelta(), placements: { places: {}, removed: 'remap-note' } }
let remapLog = model.appendPending(model.emptyPending(), 'remap-writer', 1, remapAdd)
const addedRemap = model.applyPending(remapBase, remapLog, true)
const remappedKey = addedRemap.remaps!['remap-writer']['remap-note']
assert.ok(remappedKey.startsWith('remap-note~pending-'))
remapLog = model.appendPending(remapLog, 'remap-writer', 2, remapMove)
const movedRemap = model.applyPending(normalizeWidgetState(JSON.parse(JSON.stringify(addedRemap)))!, remapLog, true)
assert.equal(Object.keys(movedRemap.placements.places).length, 1)
assert.equal(movedRemap.placements.places[remappedKey].x, 123)
remapLog = model.appendPending(remapLog, 'remap-writer', 3, remapRemove)
const removedRemap = model.applyPending(normalizeWidgetState(JSON.parse(JSON.stringify(movedRemap)))!, remapLog, true)
assert.equal(Object.keys(removedRemap.placements.places).length, 0)
assert.ok(sets.removedKeys(removedRemap.placements).has(remappedKey))
assert.deepEqual(model.applyPending(remapBase, remapLog, true), removedRemap, 'one pass and reloaded multi-pass replay agree')
assert.equal(Object.keys(merge(removedRemap, movedRemap).placements.places).length, 0, 'late geometry cannot resurrect remapped tombstone')
const splitRemap: model.PendingWidgets = { operations: { ...remapLog.operations } }
delete splitRemap.operations['remap-writer:3']
for (let n = 3; n <= model.JOURNAL_LIMITS.operations; n++) splitRemap.operations['remap-writer:' + n] = { writer: 'remap-writer', sequence: n, at: n, delta: model.emptyDelta() }
splitRemap.operations['remap-writer:1025'] = { writer: 'remap-writer', sequence: 1025, at: 1025, delta: remapRemove }
const boundary = model.applyPending(remapBase, splitRemap, true)
assert.equal(boundary.placements.places[remappedKey].x, 123)
assert.equal(Object.keys(model.applyPending(normalizeWidgetState(JSON.parse(JSON.stringify(boundary)))!, splitRemap, true).placements.places).length, 0)
assert.throws(() => merge(addedRemap, { ...addedRemap, remaps: { 'remap-writer': { 'remap-note': 'other-target' } } }), /Conflicting widget placement identity/)
assert.equal(normalizeWidgetState({ ...remapBase, remaps: { 'remap-writer': Object.fromEntries(Array.from({ length: model.JOURNAL_LIMITS.remaps + 1 }, (_, n) => ['key' + n, 'target' + n])) } }), null)
console.log('pure canonical migration/config/placement/installation merge fixtures passed')

// Each page imports its own real modules; storage and the fake account server are shared.
type Remote = { value: unknown; updatedAt: number }
type Listener = (event: any) => void
const g = globalThis as any
const nativeTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
const storage = new Map<string, string>()
const servers = new Map<string, Map<string, Remote>>()
const pages: Page[] = []
let active: Page
let holdStorage = false
const storageEvents: (() => void)[] = []
let afterWrite: ((key: string) => void) | undefined
let tick = 2000
let timerId = 0
const timers = new Map<number, { page: Page; callback: () => void }>()
const writes: string[] = []
const puts: { account: string; key: string; value: unknown }[] = []
const savedGlobals = Object.fromEntries(['window', 'document', 'location', 'localStorage', 'indexedDB', 'fetch', 'setTimeout', 'clearTimeout'].map(key => [key, g[key]]))
class Page {
  id = pages.length + 1
  innerWidth = 1400
  innerHeight = 900
  listeners = new Map<string, Listener[]>()
  cookie: string
  failPull = false
  failAccount = false
  authEnabled = true
  blocked = false
  rejectCanonicalWrite = false
  closed = false
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
    await this.canonical.canonicalConfigs.flush?.()
    for (const [id, timer] of [...timers]) if (timer.page === this) { timers.delete(id); timer.callback() }
    await new Promise(resolve => nativeTimeout(resolve, 2))
  }
  seed(key: string, value: unknown, base = 0, dirty = false) { storage.set(this.storageKey(`mvlos.sync.${key}`), JSON.stringify({ value, base, dirty })) }
  meta(key: string) { return JSON.parse(storage.get(this.storageKey(`mvlos.sync.${key}`)) ?? 'null') }
}
g.localStorage = {
  get length() { return [...storage.keys()].filter(key => key.startsWith(active.device + '/')).length },
  key(index: number) { return [...storage.keys()].filter(key => key.startsWith(active.device + '/'))[index]?.slice(active.device.length + 1) ?? null },
  getItem(key: string) { if (active.blocked) throw new Error('blocked'); return storage.get(`${active.device}/${key}`) ?? null },
  setItem(key: string, value: string) {
    if (active.blocked || active.rejectCanonicalWrite && key.endsWith('sync.widgets:state:v2')) throw new Error('blocked')
    const from = active
    storage.set(`${from.device}/${key}`, value)
    writes.push(`${from.device}/${key}`)
    for (const page of pages) if (page !== from && page.device === from.device && !page.closed) {
      const deliver = () => page.run(() => page.listeners.get('storage')?.forEach(l => l({ key, newValue: value })))
      if (holdStorage) storageEvents.push(deliver)
      else deliver()
    }
    afterWrite?.(key)
  },
  removeItem(key: string) { if (active.blocked) throw new Error('blocked'); storage.delete(`${active.device}/${key}`) },
}
g.indexedDB = widgetStorageFixture(() => { const owner = active; return callback => owner.run(callback) })
g.setTimeout = (callback: () => void, delay: number) => {
  if (delay === 5000) return nativeTimeout(callback, delay)
  const id = ++timerId; timers.set(id, { page: active, callback }); return id
}
g.clearTimeout = (id: any) => typeof id === 'number' ? timers.delete(id) : nativeClearTimeout(id)
g.fetch = async (path: string, init: RequestInit = {}) => {
  const page = active
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
  if (path === '/api/me') return page.failAccount ? json({ error: 'offline fixture' }, 503) : json({ authEnabled: page.authEnabled, user: page.accountId === 'visitor' ? null : { id: Number(page.accountId), login: 'fixture' }, forges: [] })
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
  await guest.canonical.canonicalConfigs.flush?.()
  assert.ok(guest.meta(KEY).value.placements.places.guest)
  assert.equal(guest.meta(KEY).value.configs.guest.value.tilt, -2)
  const authDisabled = new Page('visitor', 'auth-disabled')
  authDisabled.authEnabled = false
  await authDisabled.init()
  authDisabled.config.setWidgetConfig('local', { tilt: 3 })
  assert.equal(authDisabled.meta(KEY), null)
  await authDisabled.login()
  assert.equal(authDisabled.account.getAccount().status, 'off')
  await authDisabled.canonical.canonicalConfigs.flush?.()
  assert.equal(authDisabled.meta(KEY).value.configs.local.value.tilt, 3, 'confirmed auth-disabled guest cuts over locally')
  const denied = new Page('visitor', 'denied')
  denied.blocked = true
  await denied.init()
  denied.config.setWidgetConfig('temp', { tilt: 1 })
  await denied.login()
  assert.equal(denied.canonical.canonicalConfigs.get().temp.tilt, 1)
  denied.wp.widgetPlaces.set(cur => denied.wp.changeSet(cur, { temp: entry('temp') }))
  assert.ok(denied.wp.widgetPlaces.get().places.temp)

  // A late tab retains a consumed journal; receipts must survive new edits, removals and reloads.
  const lagA = new Page('27', 'lag-shared'); await lagA.init()
  lagA.run(() => lagA.config.setWidgetConfig('agenda', { days: 1 }))
  const lagB = new Page('27', 'lag-shared'); await lagB.init()
  await lagA.login(); await lagA.pull()
  lagA.run(() => lagA.config.setWidgetConfig('agenda', { days: 7 }))
  await lagA.flush()
  await lagB.login(); await lagB.pull()
  assert.equal(lagB.canonical.canonicalConfigs.get().agenda.days, 7, 'retained consumed config never gets a fresh counter')
  const lagReload = new Page('27', 'lag-shared'); await lagReload.init(); await lagReload.login(); await lagReload.pull()
  assert.equal(lagReload.canonical.canonicalConfigs.get().agenda.days, 7)
  const tombA = new Page('28', 'tomb-shared'); await tombA.init()
  tombA.run(() => tombA.wp.widgetPlaces.set(cur => tombA.wp.changeSet(cur, { fresh: entry('fresh') })))
  const tombB = new Page('28', 'tomb-shared'); await tombB.init()
  await tombA.login(); await tombA.pull()
  tombA.run(() => tombA.wp.widgetPlaces.set(cur => tombA.wp.changeSet(cur, {}, ['fresh'])))
  await tombA.flush(); await tombB.login(); await tombB.pull()
  assert.equal(tombB.wp.entriesOf(tombB.wp.widgetPlaces.get(), 'fresh').length, 0, 'consumed add cannot become a new pending variant after removal')
  const tombReload = new Page('28', 'tomb-shared'); await tombReload.init(); await tombReload.login(); await tombReload.pull()
  assert.equal(tombReload.wp.entriesOf(tombReload.wp.widgetPlaces.get(), 'fresh').length, 0)

  // Storage events can lag. Every admission re-reads durable receipts, not just event state.
  holdStorage = true
  const heldA = new Page('29', 'held'); await heldA.init()
  heldA.run(() => heldA.config.setWidgetConfig('agenda', { days: 1 }))
  const heldB = new Page('29', 'held'); await heldB.init()
  await heldA.login(); await heldA.pull()
  heldA.run(() => heldA.config.setWidgetConfig('agenda', { days: 7 }))
  heldB.run(() => heldB.config.setWidgetConfig('agenda', { units: 'f' }))
  await heldA.flush(); await heldB.login(); await heldB.pull()
  assert.deepEqual(heldB.canonical.canonicalConfigs.get().agenda, { days: 7, units: 'f' }, 'new unique patch does not replay its retained old view')
  holdStorage = false
  while (storageEvents.length) storageEvents.shift()!()

  // A unique writer appends during another tab's canonical write, then crashes. No consumer
  // owns/deletes that other writer's log; reload must recover the operation exactly once.
  const raceA = new Page('30', 'race'); await raceA.init()
  raceA.run(() => raceA.config.setWidgetConfig('agenda', { days: 1 }))
  const raceB = new Page('30', 'race'); await raceB.init()
  afterWrite = key => {
    if (!key.endsWith('sync.widgets:state:v2')) return
    afterWrite = undefined
    raceB.run(() => raceB.config.setWidgetConfig('agenda', { units: 'f' }))
    raceB.closed = true
  }
  await raceA.login(); await raceA.pull(); await raceA.flush()
  const raceReload = new Page('30', 'race'); await raceReload.init(); await raceReload.login(); await raceReload.pull()
  assert.deepEqual(raceReload.canonical.canonicalConfigs.get().agenda, { days: 1, units: 'f' })
  raceReload.run(() => raceReload.config.setWidgetConfig('agenda', { days: 7 }))
  await raceReload.flush()
  const raceAgain = new Page('30', 'race'); await raceAgain.init(); await raceAgain.login(); await raceAgain.pull()
  assert.deepEqual(raceAgain.canonical.canonicalConfigs.get().agenda, { days: 7, units: 'f' }, 'unclosed old journal remains harmless after subsequent reloads')
  assert.ok(Object.keys(raceAgain.meta(KEY).value.consumed).length <= model.JOURNAL_LIMITS.writers)

  // JSON values with invalid generations are unavailable records, not absence. Repairs rank
  // above every invalid generation and same-generation ties converge despite key order.
  for (const value of [null, 7, {}, { generation: 0 }, { generation: -1 }, { generation: '99' }, { generation: Number.MAX_SAFE_INTEGER + 1 }]) {
    const normalized = normalizeWidgetState({ ...emptyWidgetState(), installations: { broken: value } })!
    assert.ok(Object.hasOwn(normalized.installations, 'broken'))
    assert.deepEqual(mergeInstallationRecords(normalized.installations, { broken: revision(1) }).broken, revision(1))
    assert.deepEqual(mergeInstallationRecords({ broken: revision(1) }, normalized.installations).broken, revision(1))
  }
  assert.deepEqual(mergeInstallationRecords({ broken: { a: 1, b: 2 } }, { broken: { b: 2, a: 1 } }), mergeInstallationRecords({ broken: { b: 2, a: 1 } }, { broken: { a: 1, b: 2 } }))
  const full = { ...emptyWidgetState(), consumed: Object.fromEntries(Array.from({ length: model.JOURNAL_LIMITS.writers }, (_, i) => ['writer-' + i, 1])) }
  const extra = model.appendPending(model.emptyPending(), 'extra-writer', 1, model.configDelta({}, { extra: { days: 7 } }))
  assert.throws(() => model.applyPending(full, extra, true), /writer limit/)
  assert.equal(Object.keys(full.consumed).length, model.JOURNAL_LIMITS.writers, 'capacity never evicts durable receipts')
  assert.equal(Object.keys(extra.operations).length, 1, 'capacity retains the unapplied operation')
  assert.equal(normalizeWidgetState({ ...full, consumed: { ...full.consumed, 'over-limit': 1 } }), null)
  const quota = new Page('32', 'quota'); await quota.init()
  quota.run(() => quota.config.setWidgetConfig('quota-note', { days: 1 }))
  quota.rejectCanonicalWrite = true
  await quota.login(); await quota.pull()
  assert.equal(quota.meta(KEY), null)
  assert.ok([...storage.keys()].some(key => key.startsWith('quota/mvlos.u.32.widgets.pending:v2:')), 'failed canonical save cannot delete a durably queued journal')
  const quotaReload = new Page('32', 'quota'); await quotaReload.init(); await quotaReload.login(); await quotaReload.pull()
  assert.equal(quotaReload.canonical.canonicalConfigs.get()['quota-note'].days, 1)
  quotaReload.run(() => quotaReload.config.setWidgetConfig('quota-note', { days: 7 })); await quotaReload.flush()
  await quota.pull()
  assert.equal(quota.canonical.canonicalConfigs.get()['quota-note'].days, 7, 'recovered durable journal cannot replay over a newer edit')
  const guarded = new Page('31', 'guarded'); await guarded.init(); guarded.activate()
  const sharedClocks = Object.fromEntries(Array.from({ length: model.JOURNAL_LIMITS.writers - 1 }, (_, i) => ['writer-' + i, 1]))
  const left = { ...emptyWidgetState(), consumed: { ...sharedClocks, 'left-writer': 1 } }
  const right = { ...emptyWidgetState(), consumed: { ...sharedClocks, 'right-writer': 1 } }
  const mergeGuard = guarded.sync.synced('journal-merge-guard', left, { normalize: normalizeWidgetState, merge: mergeWidgetStates, mergeTabs: true, preserveOnMergeError: true })
  guarded.seed('journal-merge-guard', right, 10)
  const beforeGuard = guarded.meta('journal-merge-guard')
  assert.throws(() => mergeGuard.set(withConfigs(left, { new: { days: 7 } })), /writer limit/)
  assert.deepEqual(guarded.meta('journal-merge-guard'), beforeGuard, 'failed receipt merge never overwrites the durable copy')
  assert.deepEqual(mergeGuard.get(), left, 'failed merge restores in-memory state for retry')
  console.log('review: consumed journals, delayed events, append-during-consume/crash/reloads, unique patches, bounds and malformed generations passed')
  console.log('real facade/hydration/offline/old-client/CAS/guest/storage-denied fixtures passed')
} finally {
  Object.assign(g, savedGlobals)
}
