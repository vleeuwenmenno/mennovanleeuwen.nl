// The agents' `widget` command without a browser: `pnpm check:widget-agent`.
//
// Synthetic model tool calls go through the real runInFolder (the function both the Agents app and the agents
// command run a `terminal` call with), the real policy, msh, and the real build/verify code. The folder is an
// in-memory tree under /work (the work folder). What a browser provides is replaced by a stand-in host: the
// bounded VM (the same QuickJS build, run in this process), an installation store with activate's rules, and the
// user's answer to the approval dialog (the real dialog and the real installation records are in the browser
// check, `pnpm check:widget-agent-ui`).
//
//   - docs, list, validate (a good package, each limit with its file and reason), test (mock render, events, tests/*.json,
//     a failing case, a runtime error, a runaway loop), abort during a test, permission refusal outside the work folder.
//   - activation: denied or no dialog changes nothing, a cancelled call changes nothing (before and after the answer),
//     approved installs with generation 1, a retry of the same call changes nothing, a stale generation and a change
//     while the user decides are conflicts, edited source after approval is refused.
//
// Exits 1 on any failure.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-wasmfile-release-sync'

let failures = 0
const check = (ok: boolean, what: string, detail = '') => {
  if (ok) console.log('PASS', what)
  else {
    failures++
    console.log('FAIL', what, detail)
  }
}
const eq = (got: unknown, want: unknown, what: string) => check(JSON.stringify(got) === JSON.stringify(want), what, `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)

const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 }
g.localStorage = fakeStorage
g.sessionStorage = fakeStorage
g.window = Object.assign(globalThis, { location: new URL('http://localhost/'), addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) })
g.document = { addEventListener() {}, documentElement: { dataset: {}, style: {} }, createElement: () => ({ style: {} }), cookie: '' }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', language: 'en', clipboard: {} }, configurable: true })
g.fetch = () => Promise.reject(new Error('offline'))

const vite = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', define: { __APP_VERSION__: '"0.0.0"', __APP_COMMIT__: '"test"', __BUILD_TIME__: '"2026-01-01T00:00:00.000Z"' }, optimizeDeps: { noDiscovery: true, include: [] } })
const load = <T>(path: string) => vite.ssrLoadModule(path) as Promise<T>
try {
  await load('/src/terminal/commands.ts')
  const widget = await load<typeof import('../src/terminal/widget.ts')>('/src/terminal/widget.ts')
  const vfs = await load<typeof import('../src/terminal/vfs.ts')>('/src/terminal/vfs.ts')
  const { runInFolder } = await load<typeof import('../src/terminal/agents/exec.ts')>('/src/terminal/agents/exec.ts')
  const { fileOperands } = await load<typeof import('../src/terminal/policy.ts')>('/src/terminal/policy.ts')
  const { buildPackage, LIMITS } = await load<typeof import('../src/widgets/platform/package.ts')>('/src/widgets/platform/package.ts')
  const { invokeVM } = await load<typeof import('../src/widgets/platform/vm.ts')>('/src/widgets/platform/vm.ts')
  const qjs = await newQuickJSWASMModuleFromVariant(variant)

  // --- the folder: an in-memory tree that the terminal's real reads see ---------------------------------------
  type Node = import('../src/terminal/vfs.ts').Node
  const texts = new Map<string, string>()
  const dirAt = (abs: string): { type: 'dir'; name: string; children: Map<string, Node> } => {
    let node = vfs.root as unknown as { children: Map<string, Node> }
    for (const part of abs.split('/').filter(Boolean)) {
      let next = node.children.get(part)
      if (!next) node.children.set(part, (next = { type: 'dir', name: part, children: new Map() }))
      node = next as never
    }
    return node as never
  }
  // `sf` marks it as a work-folder file (the terminal refuses site files to agents); its text is the map's.
  const write = (abs: string, text: string) => {
    texts.set(abs, text)
    const at = abs.lastIndexOf('/')
    const name = abs.slice(at + 1)
    const dir = dirAt(abs.slice(0, at))
    if (!dir.children.has(name)) dir.children.set(name, { type: 'file', name, sf: `seafile://fake${abs}`, content: () => texts.get(abs) ?? '' })
  }
  const put = (dir: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) write(`${dir}/${path}`, text)
  }
  const folder = (root: string) => {
    const files: Record<string, string> = {}
    const walk = (dir: string, prefix = '') => {
      for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : (files[prefix + e.name] = readFileSync(join(dir, e.name), 'utf8'))
    }
    walk(root)
    return files
  }
  const template = folder('src/widgets/packages/custom-template')
  check(existsSync('src/widgets/packages/custom-template/manifest.json'), 'the starter template is on disk')
  const readBack = (dir: string) => Object.fromEntries([...texts].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, t]) => [p.slice(dir.length + 1), t]))
  const incTest = JSON.stringify({ schema: 1, description: 'adds one', input: { custom: { today: '2026-10-31', state: { day: '2026-10-31', count: 1, total: 4 }, revision: 'r1' } }, event: 'inc', expect: { text: ['4 all time'], absent: ['unknown'], mutation: { type: 'custom.replace', state: { day: '2026-10-31', count: 2, total: 5 }, expectedRevision: 'r1' } } })
  put('/work/good', { ...template, 'tests/inc.json': incTest })
  put('/work/failcase', { ...template, 'tests/nope.json': JSON.stringify({ schema: 1, description: 'wants text that is not there', expect: { text: ['nope'] } }) })
  put('/work/boom', { ...template, 'src/main.js': "export function render() { throw new Error('boom from render') }" })
  put('/work/loop', { ...template, 'src/main.js': 'export function render() { while (true) {} }' })
  put('/work/secret/pkg', template)
  put('/work2/pkg', template)
  const manifest = JSON.parse(template['manifest.json'])
  put('/work/bad-big', { ...template, 'src/big.js': `// ${'x'.repeat(LIMITS.fileBytes)}` })
  put('/work/bad-many', { ...template, ...Object.fromEntries(Array.from({ length: LIMITS.files }, (_, i) => [`assets/n${i}.txt`, 'x'])) })
  put('/work/bad-total', { ...template, ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/p${i}.js`, `// ${'y'.repeat(30_000)}`])) })
  put('/work/bad-kind', { ...template, 'run.sh': 'echo hi' })
  put('/work/bad-json', { ...template, 'manifest.json': '{not json' })
  put('/work/bad-cap', { ...template, 'manifest.json': JSON.stringify({ ...manifest, capabilities: ['custom.write'] }) })
  put('/work/bad-readme', Object.fromEntries(Object.entries(template).filter(([p]) => p !== 'README.md')))
  put('/work/bad-name', { ...template, 'src/has space.js': '//' })

  // --- the stand-in host ------------------------------------------------------------------------------------------------
  type Revision = { source: unknown; snapshot: Awaited<ReturnType<typeof buildPackage>> }
  const records = new Map<string, { kind: string; generation: number; active: Revision }>()
  const version = (instance: string) => {
    const r = records.get(instance)
    return { generation: r?.generation ?? 0, identity: JSON.stringify([r?.generation ?? 0, r?.active.snapshot.digest, r?.active.source]) }
  }
  const log = { approvals: [] as { name: string; digest: string; instance: string; isNew: boolean; capabilities: { id: string; text: string }[]; dir: string; generation: number }[], placed: [] as string[], previews: [] as string[], allowed: [] as string[], writes: 0 }
  let answer: 'allow' | 'deny' | 'hang' | 'allow-late' = 'allow'
  let during: (() => void) | null = null
  let hold = false
  let sawAbort = false
  let noDialog = false
  const host = {
    run: async (snapshot: Revision['snapshot'], input: unknown, event: string | undefined, signal: AbortSignal) => {
      signal.throwIfAborted()
      if (hold) return new Promise((_, reject) => signal.addEventListener('abort', () => { sawAbort = true; reject(Object.assign(new Error('Widget transaction cancelled'), { code: 'cancelled' })) }, { once: true }))
      try {
        return invokeVM(qjs, snapshot, input as never, event)
      } catch (e) {
        throw Object.assign(new Error((e as Error).message || 'Widget watchdog terminated worker'), { code: 'execution' })
      }
    },
    installed: () => [...records].map(([instance, r]) => ({ instance, kind: r.kind, name: r.active.snapshot.manifest.name, digest: r.active.snapshot.digest, generation: r.generation })),
    current: (instance: string) => {
      const r = records.get(instance)
      return { exists: !!r, kind: r?.kind as never, ...version(instance), digest: r?.active.snapshot.digest, source: r?.active.source as never }
    },
    identity: async (path: string) => ({ kind: 'seafile' as const, account: 1, repo: 'repo', path }),
    readSource: async (identity: { path: string }) => readBack(identity.path),
    signedIn: () => true,
    activate: async (instance: string, kind: string, revision: Revision, expected: number, expectedIdentity: string) => {
      const current = records.get(instance)
      if (current?.active.snapshot.digest === revision.snapshot.digest && JSON.stringify(current.active.source) === JSON.stringify(revision.source)) return
      const now = version(instance)
      if (now.generation !== expected || now.identity !== expectedIdentity) throw new Error('Installation changed; reload before activating')
      log.writes++
      records.set(instance, { kind, generation: expected + 1, active: revision })
    },
    allow: (instance: string) => void log.allowed.push(instance),
    approve: undefined as unknown,
    preview: (path: string) => void log.previews.push(path),
    placed: (_kind: string, instance: string, fresh: boolean) => void (fresh && log.placed.push(instance)),
  }
  const approve = async (request: (typeof log.approvals)[number], signal: AbortSignal) => {
    log.approvals.push(request)
    during?.()
    if (answer === 'hang') return new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }))
    if (answer === 'allow-late') return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30))
    return answer === 'allow'
  }
  const setup = () => {
    host.approve = noDialog ? undefined : approve
    widget.setWidgetHost(host as never)
  }
  setup()

  // --- calls -------------------------------------------------------------------------------------------------------------------------
  const grant = (g: Partial<{ mode: string; write: boolean }> = {}) => ({ mode: 'acceptEdits', write: true, delete: false, network: false, steering: false, ...g })
  const call = (command: string, signal = new AbortController().signal, g = grant()) =>
    runInFolder({ name: 'terminal', arguments: { command }, folder: { path: '/work', label: '/work' }, fallbackDir: '/work', grant: g, signal }).then((a) => a.result!)
  const ok = (r: { exit_code: number }) => r.exit_code === 0

  // docs and capabilities
  const docs = await call('widget docs')
  check(ok(docs) && /widget validate/.test(docs.stdout) && /custom\.state/.test(docs.stdout) && docs.stdout.includes("export function render(input)") && /Limits: 48 files/.test(docs.stdout) && /activation requires approval/.test(docs.stdout), 'widget docs: workflow, capabilities, limits and the custom example', docs.stdout.slice(0, 300))
  check(docs.stdout.length < 30_000, `widget docs is compact (${docs.stdout.length} chars)`)
  const template_ = await call('widget docs template')
  check(ok(template_) && /=== manifest\.json ===/.test(template_.stdout) && /=== styles\/tokens\.json ===/.test(template_.stdout) && /=== src\/main\.js ===/.test(template_.stdout), 'widget docs template prints every starter file')
  const caps = JSON.parse((await runInFolder({ name: 'terminal_capabilities', arguments: { command: 'widget' }, folder: { path: '/work', label: '/work' }, fallbackDir: '/work', grant: grant(), signal: new AbortController().signal })).capabilities!)
  check(caps.commands[0]?.name === 'widget' && caps.commands[0].group === 'Agents' && caps.commands[0].available && caps.commands[0].effect === 'read' && /activate/.test(caps.commands[0].usage), 'terminal_capabilities lists widget (Agents group, usage names activate)')
  const overview = JSON.parse((await runInFolder({ name: 'terminal_capabilities', arguments: {}, folder: { path: '/work', label: '/work' }, fallbackDir: '/work', grant: grant(), signal: new AbortController().signal })).capabilities!)
  check(overview.commands.some((c: { name: string; available: boolean }) => c.name === 'widget' && c.available), 'the capability overview names widget')
  const ro = await call('widget docs', undefined, grant({ mode: 'default', write: false }))
  check(ok(ro), 'a read-only call can read the docs')
  eq(fileOperands('widget', ['activate', 'pkg', '--instance', 'custom-1', '--generation', '2']), ['pkg'], 'only the folder of a widget call is a path (an instance id is not)')
  eq(fileOperands('widget', ['list']), [], 'widget list has no path operands')

  // validate
  const goodBuild = await buildPackage({ ...template, 'tests/inc.json': incTest })
  const valid = await call('widget validate good')
  check(ok(valid) && valid.stdout.includes(goodBuild.digest) && /"Daily tally" \(daily-tally\)/.test(valid.stdout) && /capabilities custom\.state/.test(valid.stdout), 'validate: a good package prints its manifest summary and the digest the UI computes', valid.stdout + valid.stderr)
  const bad = async (dir: string, pattern: RegExp, what: string) => {
    const r = await call(`widget validate ${dir}`)
    check(r.exit_code === 1 && pattern.test(r.stderr) && !r.stdout.includes('digest'), `validate: ${what}`, r.stderr)
  }
  await bad('bad-big', /src\/big\.js: \d+ bytes is over the 32768 byte/, 'a file over the limit names the file and the limit')
  await bad('bad-many', /more than 48 files/, 'too many files')
  await bad('bad-total', /the package source goes over 131072 bytes/, 'too much source in all')
  await bad('bad-kind', /Unsupported file: run\.sh/, 'an unsupported file type names the file')
  await bad('bad-json', /not valid JSON/, 'invalid JSON')
  await bad('bad-cap', /Unknown capability/, 'an unknown capability')
  await bad('bad-readme', /Missing README\.md/, 'a missing required file')
  await bad('bad-name', /src\/has space\.js: not a valid package path/, 'a bad file name names the file')
  const missing = await call('widget validate nowhere')
  check(missing.exit_code === 1 && /No such file or directory/.test(missing.stderr), 'validate: a missing folder')

  // permissions: the folder is read through the call's policy
  const outside = await call('widget validate /work2/pkg')
  check(outside.exit_code !== 0 && /outside|backing filesystem/.test(outside.stderr) && !outside.stdout, 'a folder outside the work folder is refused', JSON.stringify(outside))
  const dotdot = await call('widget test ../work2/pkg')
  check(dotdot.exit_code !== 0 && /outside|backing filesystem/.test(dotdot.stderr), '.. cannot get out of the work folder', JSON.stringify(dotdot))
  const home = await call(`widget validate ${vfs.HOME}`)
  check(home.exit_code !== 0 && /outside|backing filesystem|unavailable/.test(home.stderr), 'the home folder is refused', JSON.stringify(home))
  const listed = await call('widget list')
  check(ok(listed) && /installed widgets/.test(listed.stdout) && /good {2}Daily tally \(daily-tally\)/.test(listed.stdout) && /boom/.test(listed.stdout) && !/work2/.test(listed.stdout), 'widget list shows source folders inside the work folder only', listed.stdout)

  // test
  const tested = await call('widget test good')
  check(ok(tested) && /PASS mock render/.test(tested.stdout) && /PASS event inc/.test(tested.stdout) && /PASS event dec/.test(tested.stdout) && /PASS tests\/inc\.json/.test(tested.stdout) && /PASS tests\/render\.json/.test(tested.stdout) && /text "Daily tally" \[accent\]/.test(tested.stdout) && /button "\+1" -> inc/.test(tested.stdout) && /0 failed/.test(tested.stdout), 'test: mock render, every button, every tests/*.json case, and the outline', tested.stdout)
  const failing = await call('widget test failcase')
  check(failing.exit_code === 1 && /FAIL tests\/nope\.json.*output lacks "nope"/.test(failing.stdout) && /1 failed/.test(failing.stdout), 'test: a failing case is reported and exits 1', failing.stdout)
  const boom = await call('widget test boom')
  check(boom.exit_code === 1 && /FAIL mock render: .*Widget execution failed.*boom from render/.test(boom.stdout), 'test: a runtime error is reported with its message', boom.stdout)
  const loop = await call('widget test loop')
  check(loop.exit_code === 1 && /FAIL mock render/.test(loop.stdout) && /interrupted/i.test(loop.stdout), 'test: a runaway loop hits the VM limit and fails', loop.stdout)
  const none = await call('widget test bad-cap')
  check(none.exit_code === 1 && /Unknown capability/.test(none.stderr), 'test: a package that does not build fails before running')

  // abort during a test stops the VM
  hold = true
  const stop = new AbortController()
  const running = call('widget test good', stop.signal)
  setTimeout(() => stop.abort(), 60)
  const aborted = await running
  check(aborted.terminated === 'cancelled' && aborted.exit_code === 130 && sawAbort, 'aborting during widget test cancels the call and the VM run', JSON.stringify(aborted))
  hold = false

  // preview
  const previewed = await call('widget preview good')
  check(ok(previewed) && /preview: opened/.test(previewed.stdout) && log.previews.length === 1 && log.previews[0] === '/work/good' && /PASS mock render/.test(previewed.stdout), 'preview: runs the tests and opens the preview window once', previewed.stdout)
  check(records.size === 0 && log.writes === 0, 'validate, test and preview wrote no installation state')
  const previewBad = await call('widget preview boom')
  check(previewBad.exit_code === 1 && records.size === 0, 'preview of a broken package fails and still writes nothing')

  // activation: no state changes unless the user allows
  const activate = (dir: string, tail = '--new') => `widget activate ${dir} ${tail}`
  answer = 'deny'
  const denied = await call(activate('good'))
  check(denied.exit_code === 1 && /activation requires approval/.test(denied.stderr) && records.size === 0 && log.writes === 0 && log.allowed.length === 0 && log.placed.length === 0, 'activate: Deny exits 1 "activation requires approval" and changes nothing', denied.stderr)
  const request = log.approvals[0]
  check(request?.name === 'Daily tally' && request.digest === goodBuild.digest && request.isNew && /^custom-[0-9a-f]{8}$/.test(request.instance) && request.capabilities.length === 1 && request.capabilities[0].id === 'custom.state' && /saved state/.test(request.capabilities[0].text) && request.dir === '/work/good', 'the approval shows package name, digest, instance and the capabilities being granted', JSON.stringify(request))
  noDialog = true
  setup()
  const nobody = await call(activate('good'))
  check(nobody.exit_code === 1 && /activation requires approval/.test(nobody.stderr) && records.size === 0, 'activate: with no dialog to ask in it fails and changes nothing')
  noDialog = false
  setup()
  const planned = await call(activate('good'), undefined, grant({ mode: 'plan', write: false }))
  check(planned.exit_code === 1 && /plan mode/.test(planned.stderr) && records.size === 0, 'activate: plan mode may not activate')
  const neither = await call('widget activate good')
  check(neither.exit_code === 1 && /--new/.test(neither.stderr) && /--instance/.test(neither.stderr), 'activate: --new or --instance must be said')
  const both = await call('widget activate good --new --instance custom-abcd0123')
  check(both.exit_code === 1 && records.size === 0, 'activate: not both --new and --instance')

  // a call cancelled while the question is open, and one cancelled right after the answer, change nothing
  answer = 'hang'
  const closing = new AbortController()
  const waiting = call(activate('good'), closing.signal)
  setTimeout(() => closing.abort(), 40)
  const cancelledAsking = await waiting
  check(cancelledAsking.terminated === 'cancelled' && records.size === 0 && log.writes === 0, 'a thread closed while the dialog is open changes nothing')
  answer = 'allow-late'
  const late = new AbortController()
  const lateCall = call(activate('good'), late.signal)
  setTimeout(() => late.abort(), 10)
  const cancelledAnswered = await lateCall
  await new Promise((r) => setTimeout(r, 80))
  check(cancelledAnswered.terminated === 'cancelled' && records.size === 0 && log.writes === 0 && log.allowed.length === 0, 'a call cancelled before the user answers writes nothing even when the answer is Allow')

  // approved
  answer = 'allow'
  const approved = await call(activate('good'))
  const [id] = [...records.keys()]
  check(ok(approved) && records.size === 1 && /^custom-[0-9a-f]{8}$/.test(id) && records.get(id)!.generation === 1 && records.get(id)!.kind === 'custom' && records.get(id)!.active.snapshot.digest === goodBuild.digest, 'activate --new, approved: one custom installation at generation 1 with the digest that was approved', approved.stdout + approved.stderr)
  check(log.placed.join() === id && log.allowed.join() === id && /activated/.test(approved.stdout), 'activate: the widget is granted and placed once')
  const approvals = log.approvals.length
  const retry = await call(activate('good'))
  check(ok(retry) && /already active/.test(retry.stdout) && records.size === 1 && records.get(id)!.generation === 1 && log.writes === 1 && log.approvals.length === approvals && log.placed.length === 1, 'lost-result retry: the same call again is a no-op (no second instance, no generation bump, no new prompt)', retry.stdout + retry.stderr)

  // update an installed widget
  write('/work/good/src/main.js', `${texts.get('/work/good/src/main.js')}\n// v2`)
  const v2 = await buildPackage(readBack('/work/good'))
  const stale = await call(activate('good', `--instance ${id} --generation 5`))
  check(stale.exit_code === 1 && /conflict/.test(stale.stderr) && /generation 1, not 5/.test(stale.stderr) && records.get(id)!.generation === 1 && log.approvals.length === approvals, 'a stale expected generation is a clear conflict before any prompt, nothing written', stale.stderr)
  const unknown = await call(activate('good', '--instance custom-00000000'))
  check(unknown.exit_code === 1 && /not an installed widget/.test(unknown.stderr), 'an unknown instance is refused')
  during = () => {
    const r = records.get(id)!
    records.set(id, { ...r, generation: r.generation + 1 })
  }
  const raced = await call(activate('good', `--instance ${id}`))
  during = null
  check(raced.exit_code === 1 && /conflict/.test(raced.stderr) && records.get(id)!.generation === 2 && log.writes === 1, 'an installation that changes while the user decides is a conflict, nothing written', raced.stderr)
  during = () => write('/work/good/src/main.js', `${texts.get('/work/good/src/main.js')}\n// sneaky`)
  const changed = await call(activate('good', `--instance ${id}`))
  during = null
  check(changed.exit_code === 1 && /changed after it was approved/.test(changed.stderr) && log.writes === 1, 'source edited after the user approved is refused', changed.stderr)
  write('/work/good/src/main.js', `${texts.get('/work/good/src/main.js')!.replace('\n// sneaky', '')}`)
  const updated = await call(activate('good', `--instance ${id}`))
  const final = records.get(id)!
  check(ok(updated) && final.generation === 3 && final.active.snapshot.digest === v2.digest && log.placed.length === 1, 'activate --instance: the installed widget moves to the approved revision (generation +1, not placed again)', updated.stdout + updated.stderr)
  const again = await call(activate('good', `--instance ${id}`))
  check(ok(again) && /already active/.test(again.stdout) && records.get(id)!.generation === 3, 'the same update again is a no-op')
  const edited = await call(activate('good', '--new'))
  check(ok(edited) && records.size === 2, 'an edited folder with --new is a different widget (the id comes from folder and digest)')

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
} finally {
  await vite.close()
}
process.exit(failures ? 1 : 0)
