// Review regressions: deterministic fake clocks, no account/network data and no wall-clock waits.
import assert from 'node:assert/strict'
import { FairScheduler, RuntimeFailure } from '../src/widgets/platform/scheduler.ts'
import { FORECAST_REFRESH_MS, startForecastRefresh } from '../src/widgets/platform/forecastRefresh.ts'
import { allowNativeText, applyPackageEdit, projectNote } from '../src/widgets/platform/noteTransactions.ts'
import { buildPackage, descriptor, mutation, LIMITS, type Descriptor } from '../src/widgets/platform/package.ts'
import { noteRevision } from '../src/widgets/platform/editor.ts'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-wasmfile-release-sync'
import { invokeVM } from '../src/widgets/platform/vm.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
class Clock {
  time = 0; sequence = 0; timers = new Map<number, { at: number; run: () => void }>()
  now = () => this.time
  set = (run: () => void, ms: number) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + ms, run }); return id }
  clear = (id: unknown) => { this.timers.delete(id as number) }
  async advance(ms: number) {
    const target = this.time + ms
    for (;;) {
      await flush()
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > target) break
      this.time = next[1].at; this.timers.delete(next[0]); next[1].run()
    }
    this.time = target; await flush()
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
let checks = 0
const check = async (name: string, test: () => unknown) => { await test(); checks++; console.log('PASS', name) }
const clock = new Clock()
await check('10 simultaneous widgets all finish under 8-worker cap', async () => {
  const scheduler = new FairScheduler(clock)
  let active = 0, peak = 0, finished = 0
  const jobs = Array.from({ length: 10 }, (_, index) => scheduler.submit(String(index), () => new Promise<void>(resolve => {
    peak = Math.max(peak, ++active)
    clock.set(() => { active--; finished++; resolve() }, 10)
  })))
  assert.equal(scheduler.counts.pending, 2)
  await clock.advance(30); await Promise.all(jobs)
  assert.equal(finished, 10); assert.equal(peak, 8)
  assert.deepEqual(scheduler.counts, { active: 0, pending: 0, timer: false })
})
await check('rate saturation waits and fair owners cannot starve behind hot owner', async () => {
  const clock = new Clock(), scheduler = new FairScheduler(clock, 1, 2)
  const order: string[] = []
  const work = (owner: string) => scheduler.submit(owner, async () => { order.push(owner) })
  const jobs = [work('running'), work('hot'), work('hot'), work('other'), work('last')]
  await flush(); assert.deepEqual(order, ['running', 'hot'])
  await clock.advance(2000); await Promise.all(jobs)
  assert.deepEqual(order, ['running', 'hot', 'other', 'last', 'hot'])
  assert.equal(clock.timers.size, 0)
})
await check('queued/active cancellation clears rate timers without starting extra workers', async () => {
  const clock = new Clock(), scheduler = new FairScheduler(clock, 1, 1)
  let starts = 0, aborts = 0
  const jobs = Array.from({ length: 12 }, (_, index) => scheduler.submit(String(index), signal => {
    starts++; signal.addEventListener('abort', () => aborts++)
    return new Promise(() => {})
  }).catch(error => { assert.equal(error.code, 'cancelled') }))
  scheduler.cancelAll(); await Promise.all(jobs)
  await clock.advance(5000)
  assert.equal(starts, 1); assert.equal(aborts, 1)
  assert.deepEqual(scheduler.counts, { active: 0, pending: 0, timer: false })
  const rateClock = new Clock(), rateQueue = new FairScheduler(rateClock, 8, 1)
  let rateStarts = 0
  const rateJobs = Array.from({length:10},(_,i)=>rateQueue.submit(String(i),async()=>{rateStarts++}).catch(error=>assert.equal(error.code,'cancelled')))
  await flush(); assert.equal(rateClock.timers.size,1)
  rateQueue.cancelAll(); await Promise.all(rateJobs); await rateClock.advance(2000)
  assert.equal(rateStarts,1); assert.equal(rateClock.timers.size,0)
})
await check('hidden queued jobs never start and constructor failures release capacity', async () => {
  const scheduler = new FairScheduler(new Clock(), 1)
  let release: () => void = () => {}, eligible = true, started = false
  const running = scheduler.submit('active', () => new Promise<void>(resolve => { release = resolve }))
  const queued = scheduler.submit('hidden', async () => { started = true }, undefined, () => eligible).catch(error => assert.equal(error.code, 'cancelled'))
  eligible = false; release(); await Promise.all([running, queued]); assert.equal(started, false)
  await assert.rejects(scheduler.submit('broken', () => { throw new Error('constructor failed') }))
  await scheduler.submit('healthy', async () => 1)
  assert.equal(scheduler.counts.active, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(scheduler.submit('aborted', async () => 1, controller.signal), { code: 'cancelled' })
  const failure = new RuntimeFailure('input', 'invalid payload'); assert.notEqual(failure.code, 'capacity')
})
const qjs = await newQuickJSWASMModuleFromVariant(variant)
const files: Record<string, string> = {}
function walk(root: string, prefix = '') {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(root, entry.name), `${prefix}${entry.name}/`)
    else files[prefix + entry.name] = readFileSync(join(root, entry.name), 'utf8')
  }
}
walk('src/widgets/packages/sticky')
const snapshot = await buildPackage(files)
const nodes = (view: Descriptor): Descriptor[] => [view, ...(view.children ?? []).flatMap(nodes)]
await check('254+ checklist items page under descriptor cap with an editor on every page', () => {
  for (const count of [254, 255, 1000]) {
    const note = { text: Array.from({ length: count }, (_, index) => `- [ ] Item ${index}`).join('\n'), updated: 1 }
    let start = 0, tasks: string[] = []
    for (;;) {
      const projection = projectNote(note, start)
      const view = descriptor(invokeVM(qjs, snapshot, { note: projection }))
      const all = nodes(view)
      assert(all.length < LIMITS.nodes); assert(all.some(node => node.type === 'editor'))
      tasks.push(...all.filter(node => node.type === 'button').map(node => node.text!))
      if (projection.next === undefined) break
      start = projection.next
    }
    assert.equal(new Set(tasks).size, count); assert.equal(tasks.length, count)
  }
})
await check('descriptor A never transforms X after prepend, including same-length/counter ties', () => {
  const note = { text: '- [ ] A\n- [ ] B', updated: 1 }
  const projection = projectNote(note), bound = { text: note.text, revision: noteRevision(note) }
  const effect = mutation(invokeVM(qjs, snapshot, { note: projection }, 'toggle:0'))!
  assert.equal(applyPackageEdit({ ...note, text: '- [ ] X\n' + note.text, updated: 2 }, bound, projection, effect), null)
  assert.equal(applyPackageEdit({ ...note, text: '- [ ] X\n- [ ] B' }, bound, projection, effect), null)
  assert.equal(applyPackageEdit(note, bound, projection, effect), '- [x] A\n- [ ] B')
})
await check('33 KiB multibyte and oversized legacy notes use bounded edits without truncation', () => {
  for (const suffix of ['界'.repeat(11000), '😀'.repeat(100000)]) {
    const note = { text: '- [ ] Start\n' + suffix, updated: 2 }
    const projection = projectNote(note), bound = { text: note.text, revision: noteRevision(note) }
    assert(new TextEncoder().encode(JSON.stringify({ note: projection })).length < LIMITS.outputBytes)
    const edit = mutation(invokeVM(qjs, snapshot, { note: projection }, 'toggle:0'))!
    assert.equal(applyPackageEdit(note, bound, projection, edit), '- [x] Start\n' + suffix)
    assert.equal(applyPackageEdit(note, bound, projection, { type: 'note.replace', text: 'cut', expectedRevision: bound.revision }), null)
    assert(allowNativeText(note.text, note.text + '界'))
    assert.equal(note.text, '- [ ] Start\n' + suffix)
  }
  assert.throws(() => mutation({ type: 'note.edit', start: -1, end: 2, text: 'x', expectedRevision: '1' }))
  assert.throws(() => mutation({ type: 'note.edit', start: 1, end: 2, text: '界'.repeat(11000), expectedRevision: '1' }))
})
await check('UTF-16 page boundaries preserve surrogate pairs and offset edits stay in the granted window', () => {
  const note = { text: '😀'.repeat(20000) + '\n- [ ] Last', updated: 1 }
  let start = 0, joined = ''
  for (;;) {
    const projection = projectNote(note, start)
    joined += projection.text
    assert(!/[\uD800-\uDBFF]$/.test(projection.text))
    if (projection.next === undefined) {
      const effect = mutation(invokeVM(qjs, snapshot, { note: projection }, `toggle:${projection.text.split('\n').length - 1}`))!
      const bound = { text: note.text, revision: noteRevision(note) }
      assert.equal(applyPackageEdit(note, bound, projection, effect), note.text.replace('[ ] Last', '[x] Last'))
      assert.equal(applyPackageEdit(note, bound, projection, { type: 'note.edit', start: 0, end: 1, text: 'x', expectedRevision: bound.revision }), null)
      break
    }
    start = projection.next
  }
  assert.equal(joined, note.text)
  assert.equal(projectNote(note, 1).offset, 0)
  const splitLine = projectNote({text:'x'.repeat(8192)+'- [ ] Not a line\n- [ ] Real',updated:1},8192)
  const splitView = descriptor(invokeVM(qjs,snapshot,{note:splitLine}))
  assert.deepEqual(nodes(splitView).filter(n=>n.type==='button').map(n=>n.text),['☐ Real'])
  const escaped = projectNote({text:'\u0000'.repeat(20000),updated:1})
  assert(new TextEncoder().encode(JSON.stringify({note:escaped})).length < LIMITS.outputBytes)
})
await check('15-minute refresh respects cache age, hides, aborts, errors and resume with fake time', async () => {
  const clock = new Clock(); let loads = 0, eligible = true, aborted = 0
  clock.time = 5 * 60_000
  let stop = startForecastRefresh(async signal => { loads++; signal.addEventListener('abort', () => aborted++); return { at: loads === 1 ? 0 : clock.now() } }, () => eligible, clock)
  await flush(); await clock.advance(10 * 60_000 - 1); assert.equal(loads, 1)
  await clock.advance(1); assert.equal(loads, 2)
  eligible = false; stop(); assert.equal(aborted, 2); assert.equal(clock.timers.size, 0)
  await clock.advance(FORECAST_REFRESH_MS * 4); assert.equal(loads, 2)
  eligible = true
  stop = startForecastRefresh(async () => { loads++; throw new Error('offline') }, () => eligible, clock)
  await flush(); assert.equal(loads, 3)
  await clock.advance(FORECAST_REFRESH_MS); assert.equal(loads, 4)
  stop(); assert.equal(clock.timers.size, 0)
  let pendingAborted = false
  stop = startForecastRefresh(signal => { signal.addEventListener('abort', () => pendingAborted = true); return new Promise(() => {}) }, () => true, clock)
  stop(); assert.equal(pendingAborted, true)
  let resolve: (value: {at:number}) => void = () => {}
  stop = startForecastRefresh(() => new Promise(done => {resolve=done}), () => true, clock)
  stop(); resolve({at:clock.now()}); await flush(); assert.equal(clock.timers.size,0)
  let hiddenCalls=0
  stop=startForecastRefresh(async()=>{hiddenCalls++;return {at:clock.now()}},()=>false,clock)
  await flush();assert.equal(hiddenCalls,0);stop()
})
console.log(`${checks} widget lifecycle regressions passed`)
