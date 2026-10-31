// Descriptor presentation vocabulary (SDK 1.3, additive): validation limits, and every built-in
// package building and rendering the mock input with the new nodes. No account or host data.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-wasmfile-release-sync'
import { buildPackage, descriptor, ICONS, LIMITS, WIDGET_KINDS, type Descriptor, type Files } from '../src/widgets/platform/package.ts'
import { invokeVM } from '../src/widgets/platform/vm.ts'
import { MOCK_INPUT } from '../src/widgets/platform/mocks.ts'

const qjs = await newQuickJSWASMModuleFromVariant(variant)
const folder = (id: string): Files => {
  const files: Files = {}
  const walk = (root: string, relative = '') => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(root, entry.name), `${relative}${entry.name}/`)
      else files[relative + entry.name] = readFileSync(join(root, entry.name), 'utf8')
    }
  }
  walk(`src/widgets/packages/${id}`)
  return files
}
let checks = 0
async function check(name: string, run: () => unknown) { await run(); checks++; console.log('PASS', name) }
const ok = (node: unknown) => descriptor(node)
const bad = (node: unknown, message: RegExp) => assert.throws(() => descriptor(node), message)
const text = { type: 'text', text: 'x' }

await check('valid presentation fields are kept', () => {
  const view = ok({ type: 'column', gap: 'md', align: 'stretch', children: [
    { type: 'text', text: 'big', size: 'display', weight: 'bold', align: 'end', clamp: 2, tone: 'muted' },
    { type: 'row', gap: 'xs', wrap: false, justify: 'between', align: 'center', children: [{ type: 'badge', text: 'Online', tone: 'success', size: 'xs' }, { type: 'spacer' }, { type: 'icon', name: 'sun', tone: 'warning', size: 'lg' }] },
    { type: 'progress', value: 0.4, tone: 'accent' }, { type: 'divider', span: 'all' },
    { type: 'grid', columns: ['auto', '1fr', '2fr', '3fr', 'min'], gap: 'sm', children: [{ type: 'row', children: [text] }, { ...text, span: 3 }] },
    { type: 'box', tone: 'danger', pad: 'lg', children: [text] },
  ] })
  const grid = view.children![4]
  assert.deepEqual(grid.columns, ['auto', '1fr', '2fr', '3fr', 'min'])
  assert.equal(view.children![0].clamp, 2)
  assert.equal(view.children![2].value, 0.4)
  assert.equal(grid.children![1].span, 3)
})
await check('every closed icon name validates and unknown names fail', () => {
  for (const name of ICONS) assert.equal(ok({ type: 'icon', name }).name, name)
  bad({ type: 'icon', name: 'skull' }, /icon name/)
  bad({ type: 'icon' }, /icon name/)
})
await check('invalid values and fields on the wrong node fail', () => {
  bad({ ...text, size: 'huge' }, /size/)
  bad({ ...text, weight: 'black' }, /weight/)
  bad({ ...text, align: 'baseline' }, /align/)
  bad({ ...text, clamp: 4 }, /clamp/)
  bad({ ...text, clamp: '1' }, /clamp/)
  bad({ type: 'column', gap: 'huge', children: [] }, /gap/)
  bad({ type: 'column', justify: 'around', children: [] }, /justify/)
  bad({ type: 'row', wrap: 'no', children: [] }, /wrap/)
  bad({ type: 'column', wrap: false, children: [] }, /wrap/)
  bad({ type: 'row', pad: 'sm', children: [] }, /pad/)
  bad({ type: 'box', pad: 'xl', children: [] }, /pad/)
  bad({ type: 'button', text: 'b', size: 'lg' }, /size/)
  bad({ ...text, span: 9 }, /span/)
  bad({ ...text, value: 0.5 }, /value/)
  bad({ ...text, name: 'sun' }, /name/)
  bad({ ...text, columns: ['1fr'] }, /columns/)
  bad({ ...text, color: 'red' }, /Unknown field/)
  bad({ ...text, style: 'x' }, /Unknown field/)
})
await check('grid columns: required, 1 to 8, from the closed track set', () => {
  bad({ type: 'grid', children: [] }, /columns/)
  bad({ type: 'grid', columns: [], children: [] }, /columns/)
  bad({ type: 'grid', columns: Array(9).fill('1fr'), children: [] }, /columns/)
  bad({ type: 'grid', columns: ['10px'], children: [] }, /columns/)
  bad({ type: 'grid', columns: ['1fr', 4], children: [] }, /columns/)
  assert.equal(ok({ type: 'grid', columns: Array(8).fill('1fr'), children: [] }).columns!.length, 8)
})
await check('progress value: a finite number from 0 to 1', () => {
  assert.equal(ok({ type: 'progress', value: 0 }).value, 0)
  assert.equal(ok({ type: 'progress', value: 1 }).value, 1)
  for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5', undefined]) bad({ type: 'progress', value }, /progress value/)
})
await check('badge text is bounded and children only on containers', () => {
  assert.equal(ok({ type: 'badge', text: 'x'.repeat(64) }).text!.length, 64)
  bad({ type: 'badge', text: 'x'.repeat(65) }, /badge/)
  bad({ type: 'badge' }, /badge/)
  bad({ type: 'badge', text: 'a', children: [] }, /children/)
  bad({ type: 'icon', name: 'sun', children: [] }, /children/)
  ok({ type: 'grid', columns: ['1fr'], children: [{ type: 'box', children: [] }] })
})
await check('node, depth and byte limits still bound the new nodes', () => {
  bad({ type: 'column', children: Array.from({ length: LIMITS.nodes }, () => ({ type: 'divider' })) }, /limit/)
  assert.equal(ok({ type: 'column', children: Array.from({ length: LIMITS.nodes - 1 }, () => ({ type: 'divider' })) }).children!.length, LIMITS.nodes - 1)
  let deep: unknown = text
  for (let i = 0; i < LIMITS.depth + 1; i++) deep = { type: 'box', children: [deep] }
  bad(deep, /limit/)
  bad({ type: 'column', children: [{ type: 'text', text: 'x'.repeat(LIMITS.outputBytes) }] }, /limit|text/i)
})
await check('older descriptors validate and serialise unchanged', () => {
  const old = { type: 'column', children: [{ type: 'text', text: 'a', tone: 'muted' }, { type: 'row', children: [{ type: 'button', text: 'b', event: 'go' }] }] }
  assert.deepEqual(ok(old), old)
})

const flat = (view: Descriptor): Descriptor[] => [view, ...(view.children ?? []).flatMap(flat)]
const used: Record<string, Set<string>> = {}
for (const kind of WIDGET_KINDS) {
  await check(`${kind}: builtin package builds and renders MOCK_INPUT with presentation nodes`, async () => {
    const built = await buildPackage(folder(kind))
    const view = descriptor(invokeVM(qjs, built, MOCK_INPUT))
    const nodes = flat(view)
    used[kind] = new Set(nodes.map(n => n.type))
    assert.ok(nodes.some(n => n.size || n.weight || n.gap || n.columns || n.name || ['badge', 'divider', 'progress', 'box', 'icon', 'grid'].includes(n.type)), 'uses the new vocabulary')
    assert.ok(nodes.length > 3, 'substantive')
  })
}
await check('the six built-ins together use grid, icon, badge, box, progress and divider', () => {
  const all = new Set(Object.values(used).flatMap(s => [...s]))
  for (const type of ['grid', 'icon', 'badge', 'box', 'progress', 'divider']) assert.ok(all.has(type), type)
})
await check('legacy weather input (strings only) still renders', async () => {
  const built = await buildPackage(folder('weather'))
  const view = descriptor(invokeVM(qjs, built, { weather: { place: 'Old', units: 'c', summary: 'Sunny 18°', hours: ['12:00 18°'], days: ['Tomorrow 20°'] } }))
  assert.match(JSON.stringify(view), /Sunny 18/)
})
await check('SDK options object is optional: column(a,b) and column({gap},a) both work', async () => {
  const built = await buildPackage({ ...folder('sticky'), 'src/main.js': "import {column,row,text,grid,link} from '@mvlos/widget';export function render(){return column(text('a'),row({gap:'sm'},text('b')),grid(['1fr'],{gap:'xs'},link('', '', {fallback:'row', children:[text('c')]})))}" })
  const view = descriptor(invokeVM(qjs, built, {}))
  assert.equal(view.children![0].type, 'text')
  assert.equal(view.children![1].gap, 'sm')
  assert.equal(view.children![2].children![0].type, 'row')
})
console.log(`${checks} checks passed`)
