// Package verifier, bounded VM and immutable source regression tests. No account or host data.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-wasmfile-release-sync'
import { buildPackage, descriptor, mutation, sourceIdentityOf, verifySnapshot, type Files } from '../src/widgets/platform/package.ts'
import { invokeVM, modulePath } from '../src/widgets/platform/vm.ts'
import { continueList } from '../src/widgets/platform/editor.ts'
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
const input = { note: { text: '- [ ] hello', revision: 'revision:1' }, weather: { place: 'Sample city', summary: 'Sunny 18°', units: 'c', hours: ['12:00 18°'], days: ['Tomorrow 20°'] } }
const sticky = await buildPackage(folder('sticky'))
const weather = await buildPackage(folder('weather'))
const code = async (source: string) => buildPackage({ ...sticky.files, 'src/main.js': source })
await check('both real default folders render through same VM', () => {
  assert.equal(descriptor(invokeVM(qjs, sticky, input)).type, 'column')
  assert.match(JSON.stringify(descriptor(invokeVM(qjs, weather, input))), /Sample city/)
})
await check('package checklist transformation carries expected revision', () => {
  assert.deepEqual(mutation(invokeVM(qjs, sticky, input, 'toggle:0')), { type: 'note.replace', text: '- [x] hello', expectedRevision: 'revision:1' })
})
await check('editing source changes digest and behavior', async () => {
  const changed = await code("export function render(){return {type:'text',text:'Edited source'}}")
  assert.notEqual(sticky.digest, changed.digest)
  assert.equal(descriptor(invokeVM(qjs, changed, {})).text, 'Edited source')
  assert.equal(descriptor(invokeVM(qjs, sticky, input)).type, 'column')
})
await check('digest binds permissions, assets, styles and all source', async () => {
  for (const path of ['manifest.json', 'styles/tokens.json', 'assets/README.txt', 'tests/render.json']) {
    const files = { ...sticky.files }
    files[path] += ' '
    assert.notEqual((await buildPackage(files)).digest, sticky.digest)
  }
  const files = { ...sticky.files, 'manifest.json': sticky.files['manifest.json'].replace('"note.write"', '"weather.read"') }
  assert.notEqual((await buildPackage(files)).digest, sticky.digest)
})
await check('imported dist and build.json are ignored; snapshot tampering fails', async () => {
  assert.equal((await buildPackage({ ...sticky.files, 'dist/main.js': 'evil()', 'build.json': '{"digest":"trusted"}' })).digest, sticky.digest)
  await assert.rejects(verifySnapshot({ ...sticky, files: { ...sticky.files, 'src/main.js': 'evil()' } }))
})
await check('traversals, URL paths, oversized packages, unknown manifest fields refused', async () => {
  for (const path of ['../src/evil.js', '/evil.js', 'src//evil.js', 'https://evil/a.js', 'src/./evil.js']) await assert.rejects(buildPackage({ ...sticky.files, [path]: '' }))
  await assert.rejects(code('x'.repeat(32769)))
  await assert.rejects(buildPackage({ ...sticky.files, 'manifest.json': JSON.stringify({ ...sticky.manifest, hooks: { build: 'npm install' } }) }))
})
await check('module imports cannot escape src or resolve network/npm', async () => {
  for (const name of ['https://example.org/x.js', 'react', '../../outside.js', '/src/main.js']) assert.throws(() => modulePath('src/main.js', name))
  for (const source of ["import 'https://example.org/x.js'; export function render(){}", "import '../outside.js'; export function render(){}"] ) assert.throws(() => invokeVM(qjs, { ...sticky, files: { ...sticky.files, 'src/main.js': source } }, {}))
})
await check('no ambient browser or host prototype authority', async () => {
  const source = await code("export function render(){return {type:'text',text:[typeof fetch,typeof window,typeof document,typeof localStorage,typeof postMessage,typeof process].join(',')}}")
  assert.equal(descriptor(invokeVM(qjs, source, {})).text, Array(6).fill('undefined').join(','))
})
await check('CPU loop and heap exhaustion terminated; engine remains usable', async () => {
  for (const source of ["export function render(){while(true){}}", "export function render(){let a=[];while(true)a.push('x'.repeat(32768))}", "export function render(){function f(){f()}f()}"]) assert.throws(() => invokeVM(qjs, { ...sticky, files: { ...sticky.files, 'src/main.js': source } }, {}))
  assert.equal(descriptor(invokeVM(qjs, sticky, input)).type, 'column')
})
await check('promise job flood and async entrypoints rejected', async () => {
  for (const source of ["export async function render(){return {type:'text',text:'x'}}", "export function render(){const f=()=>Promise.resolve().then(f);f();return {type:'text',text:'x'}}"]) assert.throws(() => invokeVM(qjs, awaitable(source), {}))
  function awaitable(source: string) { return { ...sticky, files: { ...sticky.files, 'src/main.js': source } } }
})
await check('raw HTML, URL props, RPC effects and node floods fail closed', () => {
  for (const value of [{ type: 'iframe', src: 'https://evil' }, { type: 'text', text: 'hi', dangerouslySetInnerHTML: {} }, { type: 'button', text: 'go', href: 'https://evil' }, { type: 'column', children: Array(257).fill({ type: 'text', text: 'x' }) }]) assert.throws(() => descriptor(value))
  assert.throws(() => mutation({ type: 'fetch', url: 'https://evil' }))
  assert.throws(() => mutation({ type: 'note.replace', text: 'hi', expectedRevision: 'a', resource: 'another-note' }))
})
await check('canonical source identities require backing UUID/account/repository', () => {
  assert.equal(sourceIdentityOf({ kind: 'browser', account: 1, storeUUID: '12345678-1234-1234-1234-123456789abc', path: '/.local/share/mvlos/widgets/sticky' }).kind, 'browser')
  for (const identity of [{ kind: 'browser', account: 1, path: '/home/user' }, { kind: 'seafile', account: 1, repo: 'repo', path: '/a/../b' }, { kind: 'system', path: '/home/user' }]) assert.throws(() => sourceIdentityOf(identity))
})
await check('native list continuation respects selection, empty items and numbered lists', () => {
  assert.deepEqual(continueList('- [x] done', 10, 10), { start: 10, end: 10, text: '\n- [ ] ' })
  assert.deepEqual(continueList('2. second', 9, 9), { start: 9, end: 9, text: '\n3. ' })
  assert.deepEqual(continueList('- [ ] ', 6, 6), { start: 0, end: 6, text: '' })
  assert.equal(continueList('- [ ] hello', 2, 4), null)
})
console.log(`${checks} package security/runtime checks passed`)
