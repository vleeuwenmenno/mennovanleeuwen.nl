// Custom widgets: manifest/capability rules, the starter package in the real bounded VM, the state limit,
// installation record normalize/merge/tombstones/limits. Pure logic: no browser, account or network.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-wasmfile-release-sync'
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
const pkg = await import('../src/widgets/platform/package.ts')
const records = await import('../src/widgets/platform/records.ts')
const model = await import('../src/widgets/platform/canonicalModel.ts')
const { invokeVM } = await import('../src/widgets/platform/vm.ts')
const { buildPackage, customState, manifestOf, mutation, supportsCapabilities, descriptor, LIMITS, KIND_CAPABILITIES } = pkg
let checks = 0
const check = async (name: string, run: () => unknown) => { await run(); checks++; console.log('PASS', name) }
const qjs = await newQuickJSWASMModuleFromVariant(variant)
const folder = (root: string) => {
  const files: Record<string, string> = {}
  const walk = (dir: string, prefix = '') => { for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : files[prefix + e.name] = readFileSync(join(dir, e.name), 'utf8') }
  walk(root)
  return files
}
const template = folder('src/widgets/packages/custom-template')
const manifest = JSON.parse(template['manifest.json'])

await check('manifest: custom.state is the only custom capability; builtins cannot hold it', () => {
  assert.deepEqual(KIND_CAPABILITIES.custom, ['custom.state'])
  assert.equal(supportsCapabilities('custom', ['custom.state']), true)
  assert.equal(supportsCapabilities('custom', []), true)
  assert.equal(supportsCapabilities('custom', ['note.read']), false)
  assert.equal(supportsCapabilities('custom', ['weather.read']), false)
  for (const kind of ['sticky', 'weather', 'agenda', 'inbox', 'status', 'minecraft'] as const) assert.equal(supportsCapabilities(kind, ['custom.state']), false, kind)
  assert.equal(pkg.isInstanceKind('custom'), true)
  assert.equal(pkg.isWidgetKind('custom'), false, 'the built-in kinds stay closed')
  assert.equal(pkg.isInstanceKind('other'), false)
})
await check('manifest: strict exact fields', () => {
  assert.deepEqual(manifestOf(manifest).capabilities, ['custom.state'])
  assert.throws(() => manifestOf({ ...manifest, extra: 1 }), /Unknown field/)
  assert.throws(() => manifestOf({ ...manifest, capabilities: ['custom.state', 'custom.state'] }), /Unknown capability/)
  assert.throws(() => manifestOf({ ...manifest, capabilities: ['custom.write'] }), /Unknown capability/)
  assert.throws(() => manifestOf({ ...manifest, id: 'Bad Id' }), /Unsupported/)
  assert.throws(() => manifestOf({ ...manifest, sizing: { width: 10, height: 160 } }), /sizing/)
  assert.doesNotThrow(() => manifestOf({ ...manifest, capabilities: [] }))
})
const built = await buildPackage(template)
await check('starter template builds with a stable digest', async () => {
  assert.equal(built.manifest.id, 'daily-tally')
  assert.equal((await buildPackage(template)).digest, built.digest)
  assert.equal((await buildPackage({ ...template, 'src/main.js': template['src/main.js'] + '\n// edit' })).digest !== built.digest, true)
})
const input = (state: unknown, today = '2026-10-30') => ({ custom: { now: 0, today, state, revision: records.customRevision(state) } })
await check('starter renders and its events return validated custom.replace effects', () => {
  const text = (v: unknown): string => JSON.stringify(descriptor(v))
  const fresh = text(invokeVM(qjs, built, input(null)))
  assert.match(fresh, /Daily tally/); assert.match(fresh, /0 all time · 2026-10-30/)
  const saved = { day: '2026-10-30', count: 2, total: 7 }
  assert.match(text(invokeVM(qjs, built, input(saved))), /7 all time/)
  const inc = mutation(invokeVM(qjs, built, input(saved), 'inc'))
  assert.deepEqual(inc, { type: 'custom.replace', state: { day: '2026-10-30', count: 3, total: 8 }, expectedRevision: records.customRevision(saved) })
  const rolled = mutation(invokeVM(qjs, built, input(saved, '2026-10-31'), 'inc'))
  assert.deepEqual((rolled as { state: unknown }).state, { day: '2026-10-31', count: 1, total: 8 }, 'a new day starts at zero')
  assert.deepEqual((mutation(invokeVM(qjs, built, input(saved), 'reset')) as { state: unknown }).state, { day: '2026-10-30', count: 0, total: 5 })
  assert.equal(mutation(invokeVM(qjs, built, input(null), 'dec')), null, 'nothing to take away')
  assert.equal(mutation(invokeVM(qjs, built, input(saved), 'unknown')), null)
})
await check('SDK.md documents the same starter files', () => {
  const sdk = readFileSync('src/widgets/platform/SDK.md', 'utf8')
  assert.ok(sdk.includes(template['src/main.js'].trimEnd()), 'main.js example is out of date')
  assert.ok(sdk.includes(template['manifest.json']), 'manifest example is out of date')
})
await check('state limit: 4 KiB of JSON exactly, never more', () => {
  const sized = (bytes: number) => ({ s: 'x'.repeat(bytes - 8) })
  assert.equal(JSON.stringify(sized(LIMITS.customStateBytes)).length, LIMITS.customStateBytes)
  assert.doesNotThrow(() => customState(sized(LIMITS.customStateBytes)))
  assert.throws(() => customState(sized(LIMITS.customStateBytes + 1)), /exceeds/)
  assert.throws(() => customState({ s: '€'.repeat(1400) }), /exceeds/, 'limit counts UTF-8 bytes')
  assert.equal(customState(undefined), null)
  assert.deepEqual(customState({ a: [1, 'b', null] }), { a: [1, 'b', null] })
  assert.deepEqual(mutation({ type: 'custom.replace', state: 3, expectedRevision: 'r' }), { type: 'custom.replace', state: 3, expectedRevision: 'r' })
  assert.throws(() => mutation({ type: 'custom.replace', state: sized(5000), expectedRevision: 'r' }), /exceeds/)
  assert.throws(() => mutation({ type: 'custom.replace', state: 1, expectedRevision: 'r', text: 'x' }), /Unknown field/)
  assert.throws(() => mutation({ type: 'custom.replace', state: 1 }), /Invalid/)
  assert.throws(() => mutation({ type: 'custom.replace', state: 1, expectedRevision: 'x'.repeat(101) }), /Invalid/)
})
await check('input: clock always, state and revision only with custom.state', () => {
  const withState = records.customInput({ a: 1 }, true, Date.UTC(2026, 9, 30, 12))
  assert.match(withState.today, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(withState.state, { a: 1 })
  assert.equal(withState.revision, records.customRevision({ a: 1 }))
  const bare = records.customInput({ a: 1 }, false, 0)
  assert.deepEqual(Object.keys(bare).sort(), ['now', 'today'])
  assert.equal(records.customInput(undefined, true, 0).state, null)
  assert.notEqual(records.customRevision({ a: 1 }), records.customRevision({ a: 2 }))
  assert.equal(records.customRevision(undefined), records.customRevision(null))
})
const source = { kind: 'browser', account: 1, storeUUID: '11111111-1111-4111-8111-111111111111', path: '/w/tally' }
const live = (id: string, generation = 1, extra = {}) => ({ schema: 1, instance: id, kind: 'custom', generation, active: { source, snapshot: built }, ...extra })
await check('records: live custom records normalize; corrupt or unknown ones never enter the typed view', () => {
  const view = records.normalizeInstallations({
    'custom-a': live('custom-a'), 'custom-b': live('custom-b', 2, { previous: { source, snapshot: built } }),
    bad1: { ...live('bad1'), schema: 2 }, bad2: live('other'), bad3: { ...live('bad3'), kind: 'plugin' }, bad4: { ...live('bad4'), generation: 0 },
    bad5: { ...live('bad5'), active: null }, 'bad id': live('bad id'), gone: records.tombstone('gone', 3),
  })
  assert.deepEqual(Object.keys(view).sort(), ['custom-a', 'custom-b'])
  assert.equal(records.customInstallations(view).length, 2)
  assert.equal(Object.keys(records.normalizeInstallations(null)).length, 0)
  assert.equal(Object.keys(records.normalizeInstallations([live('x')])).length, 0)
})
await check('records: tombstones are exact and win by generation, both merge orders, in both merge layers', () => {
  const tomb = records.tombstone('custom-a', 3)
  assert.equal(records.isTombstone(tomb), true)
  assert.equal(records.isTombstone({ ...tomb, extra: 1 }), false)
  assert.equal(records.isTombstone({ ...tomb, kind: 'sticky' }), false)
  assert.equal(records.isTombstone({ ...tomb, generation: 0 }), false)
  assert.equal(records.isTombstone(live('custom-a')), false)
  const old = live('custom-a', 2), newer = live('custom-a', 4)
  for (const merge of [records.mergeInstallations, model.mergeInstallationRecords]) {
    assert.deepEqual(merge({ 'custom-a': tomb }, { 'custom-a': old }), { 'custom-a': tomb })
    assert.deepEqual(merge({ 'custom-a': old }, { 'custom-a': tomb }), { 'custom-a': tomb })
    assert.deepEqual(merge({ 'custom-a': newer }, { 'custom-a': tomb }), { 'custom-a': newer }, 'a later edit beats an older removal')
    assert.deepEqual(Object.keys(merge({ 'custom-a': tomb }, { 'custom-b': live('custom-b') })).sort(), ['custom-a', 'custom-b'])
  }
  assert.notEqual(model.installationToken(tomb), model.installationToken(old))
  assert.equal(model.installationToken(tomb), model.installationToken(records.tombstone('custom-a', 3)))
})
await check('records: 12 live records, tombstones do not count, 64 hard cap, existing ids always updatable', () => {
  const all: Record<string, unknown> = {}
  for (let i = 0; i < 12; i++) all[`custom-${i}`] = live(`custom-${i}`)
  assert.match(records.admission(all, 'custom-new'), /limit reached/)
  assert.equal(records.admission(all, 'custom-3'), '', 'updating an existing widget is allowed at the limit')
  const freed = { ...all, 'custom-0': records.tombstone('custom-0', 2) }
  assert.equal(records.admission(freed, 'custom-new'), '')
  const crowded: Record<string, unknown> = {}
  for (let i = 0; i < 64; i++) crowded[`t-${i}`] = records.tombstone(`t-${i}`, 2)
  assert.match(records.admission(crowded, 'custom-new'), /Too many removed/)
  assert.equal(records.INSTALLATION_LIMIT, 12)
})
await check('canonical envelope keeps custom and tombstone records whole and merges them', () => {
  const tomb = records.tombstone('custom-a', 3)
  const state = { ...model.emptyWidgetState(), installations: { 'custom-a': live('custom-a', 2), 'custom-b': live('custom-b') } }
  const normalized = model.normalizeWidgetState(state)
  assert.deepEqual(normalized?.installations, state.installations)
  const merged = model.mergeWidgetStates(state, { ...state, installations: { 'custom-a': tomb } })
  assert.deepEqual(merged?.installations['custom-a'], tomb)
  assert.deepEqual(merged?.installations['custom-b'], live('custom-b'))
})
console.log(`${checks} widget custom checks passed`)
