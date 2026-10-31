// Clock widget and the manifest `phone` flag: strict validation, digest, the `bare` appearance, the clock
// package in the real bounded VM, 12/24-hour formatting and the tick maths. Pure logic: no browser.
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
const clock = await import('../src/widgets/platform/clock.ts')
const { invokeVM } = await import('../src/widgets/platform/vm.ts')
const { MOCK_INPUT } = await import('../src/widgets/platform/mocks.ts')
const { buildPackage, manifestOf, descriptor, sourceFiles, sourceIdentityOf, supportsCapabilities, WIDGET_KINDS, KIND_CAPABILITIES } = pkg
let checks = 0
const check = async (name: string, run: () => unknown) => { await run(); checks++; console.log('PASS', name) }
const qjs = await newQuickJSWASMModuleFromVariant(variant)
const folder = (root: string) => {
  const files: Record<string, string> = {}
  const walk = (dir: string, prefix = '') => { for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : files[prefix + e.name] = readFileSync(join(dir, e.name), 'utf8') }
  walk(root)
  return files
}
const base = { schema: 1, sdk: 1, id: 'demo', name: 'Demo', entry: 'src/main.js', settings: { appearance: 'panel' }, sizing: { width: 200, height: 150 }, capabilities: [] }

await check('manifest phone: absent means hidden on a phone (undefined), true and false are kept', () => {
  assert.equal(manifestOf(base).phone, undefined)
  assert.equal(manifestOf({ ...base, phone: true }).phone, true)
  assert.equal(manifestOf({ ...base, phone: false }).phone, false)
})
await check('manifest phone: only a real boolean is accepted', () => {
  for (const bad of ['yes', 'true', 1, 0, null, {}, []]) assert.throws(() => manifestOf({ ...base, phone: bad }), /phone/, JSON.stringify(bad))
  assert.throws(() => manifestOf({ ...base, mobile: true }), /Unknown field/)
})
await check('appearance: panel, sticky and bare are valid, anything else is not', () => {
  for (const appearance of ['panel', 'sticky', 'bare']) assert.equal(manifestOf({ ...base, settings: { appearance } }).settings.appearance, appearance)
  for (const appearance of ['transparent', 'Bare', '', 1, undefined]) assert.throws(() => manifestOf({ ...base, settings: { appearance } }), /Invalid settings/, String(appearance))
})
await check('the digest covers phone: flipping it changes the build identity', async () => {
  const files = folder('src/widgets/packages/custom-template')
  const manifest = JSON.parse(files['manifest.json'])
  const a = await buildPackage({ ...files, 'manifest.json': JSON.stringify({ ...manifest, phone: true }) })
  const b = await buildPackage({ ...files, 'manifest.json': JSON.stringify({ ...manifest, phone: false }) })
  const c = await buildPackage({ ...files, 'manifest.json': JSON.stringify((({ phone, ...rest }) => rest)(manifest)) })
  assert.equal(new Set([a.digest, b.digest, c.digest]).size, 3)
  assert.equal(a.manifest.phone, true)
})

await check('the clock is a built-in kind with no capabilities, and its system source is allowed', () => {
  assert(WIDGET_KINDS.includes('clock'))
  assert.deepEqual(KIND_CAPABILITIES.clock, [])
  assert.equal(supportsCapabilities('clock', []), true)
  assert.equal(supportsCapabilities('clock', ['note.read']), false)
  assert.deepEqual(sourceIdentityOf({ kind: 'system', path: '/usr/share/mvlos/widgets/clock' }), { kind: 'system', path: '/usr/share/mvlos/widgets/clock' })
  assert.throws(() => sourceIdentityOf({ kind: 'system', path: '/usr/share/mvlos/widgets/clocks' }))
})
const files = folder('src/widgets/packages/clock')
const snapshot = await buildPackage(files)
await check('the clock package builds: bare, phone, no capabilities, 420x160', () => {
  assert.doesNotThrow(() => sourceFiles(files))
  const m = snapshot.manifest
  assert.equal(m.id, 'clock'); assert.equal(m.settings.appearance, 'bare'); assert.equal(m.phone, true)
  assert.deepEqual(m.capabilities, []); assert.deepEqual(m.sizing, { width: 420, height: 160 })
})
const texts = (view: any): any[] => [view, ...(view.children ?? []).flatMap(texts)].filter(n => n.type === 'text')
await check('the clock renders the mock input: a display time over a muted headline date', () => {
  const t = texts(descriptor(invokeVM(qjs, snapshot, MOCK_INPUT)))
  assert.deepEqual(t.map(n => [n.text, n.size, n.tone]), [['14:32', 'display', 'normal'], ['Friday, 30 October 2026', 'headline', 'muted']])
})
await check('show short/none and the accent tone change the layout', () => {
  const render = (patch: object) => texts(descriptor(invokeVM(qjs, snapshot, { clock: { ...MOCK_INPUT.clock!, ...patch } })))
  assert.equal(render({ show: 'short' })[1].text, 'Fri 30 Oct')
  assert.equal(render({ show: 'none' }).length, 1)
  assert.equal(render({ tone: 'accent' })[0].tone, 'accent')
  assert.equal(render({ period: 'PM', time: '2:32', hour12: true })[0].text, '2:32 PM')
  assert.equal(texts(descriptor(invokeVM(qjs, snapshot, {})))[0].text, 'Clock', 'no clock input still renders something')
})
await check('descriptor size is closed to display and headline, and only on text', () => {
  assert.deepEqual(descriptor({ type: 'text', text: 'x', size: 'display' }).size, 'display')
  assert.throws(() => descriptor({ type: 'text', text: 'x', size: 'huge' }), /Invalid size/)
  assert.throws(() => descriptor({ type: 'column', size: 'display', children: [] }), /Invalid size/)
})

// 2026-10-31 14:05:09 in Europe/Amsterdam (UTC+1 after the clocks went back) = 13:05:09Z
const at = Date.UTC(2026, 9, 31, 13, 5, 9)
const cfg = (patch: Partial<ReturnType<typeof clock.clockConfig>> = {}) => ({ ...clock.CLOCK_DEFAULTS, ...patch })
await check('24-hour formatting pads the hour and keeps seconds optional', () => {
  assert.equal(clock.clockInput(at, cfg({ hours: '24' }), 'en-GB', 'Europe/Amsterdam').time, '14:05')
  assert.equal(clock.clockInput(at, cfg({ hours: '24', seconds: true }), 'en-GB', 'Europe/Amsterdam').time, '14:05:09')
  assert.equal(clock.clockInput(Date.UTC(2026, 9, 31, 7, 5, 9), cfg({ hours: '24' }), 'en-GB', 'Europe/Amsterdam').time, '08:05')
  assert.equal(clock.clockInput(at, cfg({ hours: '24' }), 'en-GB', 'Europe/Amsterdam').period, '')
})
await check('12-hour formatting has no padded hour and a separate AM/PM period', () => {
  const pm = clock.clockInput(at, cfg({ hours: '12' }), 'en-US', 'Europe/Amsterdam')
  assert.equal(pm.time, '2:05'); assert.equal(pm.period, 'PM'); assert.equal(pm.hour12, true)
  const am = clock.clockInput(Date.UTC(2026, 9, 31, 7, 5, 9), cfg({ hours: '12', seconds: true }), 'en-US', 'Europe/Amsterdam')
  assert.equal(am.time, '8:05:09'); assert.equal(am.period, 'AM')
  const midnight = clock.clockInput(Date.UTC(2026, 9, 30, 23, 0, 0), cfg({ hours: '12' }), 'en-US', 'Europe/Amsterdam')
  assert.equal(midnight.time, '12:00'); assert.equal(midnight.period, 'AM')
})
await check('auto follows the language: en-US is 12-hour, en-GB 24-hour', () => {
  assert.equal(clock.clockInput(at, cfg(), 'en-US', 'Europe/Amsterdam').hour12, true)
  assert.equal(clock.clockInput(at, cfg(), 'en-GB', 'Europe/Amsterdam').hour12, false)
})
await check('date strings, the local day and the settings echo', () => {
  const c = clock.clockInput(at, cfg({ hours: '24', show: 'short', accent: true }), 'en-GB', 'Europe/Amsterdam')
  assert.equal(c.weekday, 'Saturday'); assert.equal(c.date, '31 October 2026'); assert.equal(c.weekdayShort, 'Sat'); assert.equal(c.dateShort, '31 Oct')
  assert.equal(c.today, '2026-10-31'); assert.equal(c.show, 'short'); assert.equal(c.tone, 'accent')
  assert.equal(clock.clockInput(Date.UTC(2026, 9, 31, 23, 30, 0), cfg(), 'en-GB', 'Europe/Amsterdam').today, '2026-11-01', 'the local day, not UTC')
  assert.doesNotThrow(() => descriptor(invokeVM(qjs, snapshot, { clock: c })))
})
await check('saved settings that are out of range fall back to the defaults', () => {
  assert.deepEqual(clock.clockConfig({}), clock.CLOCK_DEFAULTS)
  assert.deepEqual(clock.clockConfig({ hours: 'banana', seconds: 'yes', show: 7, accent: 1, tilt: NaN }), clock.CLOCK_DEFAULTS)
  assert.deepEqual(clock.clockConfig({ hours: '12', seconds: true, show: 'none', accent: true }), { hours: '12', seconds: true, show: 'none', accent: true, tilt: 0 })
})
await check('the tick lands just after the next minute, or second with seconds, and is never zero', () => {
  assert.equal(clock.clockDelay(60_000 * 10 + 15_000, false), 45_020)
  assert.equal(clock.clockDelay(60_000 * 10, false), 60_020)
  assert.equal(clock.clockDelay(1_500, true), 520)
  for (const now of [0, 999, 1000, 59_999, 123_456_789]) for (const s of [true, false]) assert(clock.clockDelay(now, s) > 0)
})
console.log(`${checks} checks passed`)
