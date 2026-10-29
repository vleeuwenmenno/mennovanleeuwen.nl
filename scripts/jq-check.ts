import { createServer } from 'vite'
import assert from 'node:assert/strict'
import { jq, JqError, parseJqArgs } from '../src/terminal/jq.ts'
import { stripMarkup } from '../src/terminal/markup.ts'

let checks = 0
function output(filter: string, input: unknown, expected: unknown, args?: Record<string, unknown>) {
  assert.deepEqual(JSON.parse(jq(filter, JSON.stringify(input), { compact: true, args })), expected, filter)
  checks++
}
function fail(filter: string, input: string, message: RegExp) {
  assert.throws(() => jq(filter, input), (e: unknown) => e instanceof JqError && message.test(e.message), filter)
  checks++
}
function cli(argv: string[], input = '') {
  const { filter, opts } = parseJqArgs(argv)
  return jq(filter, input, opts)
}
output('.user.name', { user: { name: 'Ada' } }, 'Ada')
output('.["odd.key"]', { 'odd.key': 42 }, 42)
output('.[-1]', [1, 2, 3], 3)
output('.[1:3]', [0, 1, 2, 3], [1, 2])
output('[.[] | .name?]', [{ name: 'Ada' }, 3, {}], ['Ada', null])
output('map(select(.active and .score >= 2) | {name, score})',
  [{ name: 'Ada', active: true, score: 3 }, { name: 'Bob', active: false, score: 4 }], [{ name: 'Ada', score: 3 }])
output('[{choice: (1,2)}]', null, [{ choice: 1 }, { choice: 2 }])
output('{($key): $value}', null, { 'odd.key': ['hello'] }, { key: 'odd.key', value: ['hello'] })
output('{$value}', null, { value: false }, { value: false })
output('{$value: 7}', null, { chosen: 7 }, { value: 'chosen' })
assert.throws(() => cli(['-nc', '--argjson', 'key', 'false', '{$key: 7}']), /Object keys must be strings/)
output('[.[] | . as $x | {value: $x}]', [1, 2], [{ value: 1 }, { value: 2 }])
output('[$x, (2 as $x | $x), $x]', null, [1, 2, 1], { x: 1 })
output('"hello \\($x)"', null, 'hello Ada', { x: 'Ada' })
output('"\\r\\b\\f\\u263a"', null, '\r\b\f☺')
output('fromjson', '{"a":1}', { a: 1 })
output('.missing // "fallback"', {}, 'fallback')
output('[.__proto__, .constructor, .toString, getpath(["__proto__"])]', {}, [null, null, null, null])
const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":7,"prototype":8}')
output('.', hostile, hostile)
output('{"__proto__": {polluted: true}, constructor: 7, prototype: 8}', null, hostile)
output('to_entries | from_entries', hostile, hostile)
output('with_entries(.)', hostile, hostile)
output('getpath(["__proto__", "polluted"])', hostile, true)
output('contains({"__proto__": {polluted: true}})', {}, false)
assert.equal(({} as Record<string, unknown>).polluted, undefined)
assert.equal(cli(['-nc', '--arg', '__proto__', 'safe', '{$__proto__}']), '{"__proto__":"safe"}')
assert.equal(cli(['-nc', '--arg', 'constructor', 'safe', '$constructor']), '"safe"')
const text = 'quotes " backslash \\ newline\n $(code) {"injected":true}'
assert.deepEqual(JSON.parse(cli(['-nc', '--arg', 'text', text, '--argjson', 'data', '{"ok":[true,null,2]}', '{text: $text, data: $data}'])), { text, data: { ok: [true, null, 2] } })
assert.equal(cli(['-nc', '--arg', 'x', '', '$x']), '""')
assert.equal(cli(['-nc', '--argjson', 'x', 'false', '$x']), 'false')
assert.equal(cli(['-sc', '.'], '1\n{"a":2}\n[3]'), '[1,{"a":2},[3]]')
assert.equal(cli(['-r', '.name'], '{"name":"Ada"}'), 'Ada')
assert.equal(cli(['-nc', '--', '-1']), '-1')
assert.equal(parseJqArgs(['-M', '.', 'data.json']).opts.color, false)
assert.equal(parseJqArgs(['.', 'data.json']).file, 'data.json')
assert.equal(jq('.', ''), '')
assert.equal(jq('.', '', { slurp: true }), '[]')
for (const color of [true, false]) for (const compact of [true, false]) {
  const data = { '{c:red}key{/}': ['{c:red}red{/}', '{anim:spin}{/}', '{link:example}link{/}', '{fg:red}{bg:blue}x{/}', text] }
  const encoded = stripMarkup(jq('.', JSON.stringify(data), { color, compact }))
  assert.deepEqual(JSON.parse(encoded), data)
  assert.deepEqual(JSON.parse(stripMarkup(jq('.', encoded, { color, compact }))), data)
  output('tojson | fromjson', data, data)
}
for (const [argv, pattern] of [
  [['--arg'], /requires NAME and VALUE/],
  [['--arg', 'x'], /requires NAME and VALUE/],
  [['--arg', 'bad-name', 'v'], /invalid variable name/],
  [['--argjson', 'x', '{"bad":}'], /--argjson x: invalid JSON/],
  [['--argjson', 'x', '1 2'], /invalid JSON/],
  [['--unsupported', '.'], /Unknown option/],
  [['.', 'one', 'two'], /at most one input file/],
] as const) {
  assert.throws(() => parseJqArgs([...argv]), (e: unknown) => e instanceof JqError && pattern.test(e.message))
  checks++
}
fail('.', '{"bad":}', /parse error/)
fail('.', '1\n[2,]', /parse error/)
fail('fromjson', '"bad"', /fromjson: invalid JSON/)
fail('fromjson', '3', /fromjson/)
fail('fromjson // null', '"bad"', /fromjson: invalid JSON/)
fail('.name', '3', /Cannot index number/)
fail('.[]', 'null', /Cannot iterate/)
fail('getpath(1)', '{}', /Cannot use as a path/)
fail('{', 'null', /expected object key/)
fail('{a:', 'null', /unexpected end/)
fail('{(1): 2}', 'null', /Object keys must be strings/)
fail('{$missing}', 'null', /not defined/)
fail('$constructor', 'null', /not defined/)
fail('$__proto__', 'null', /not defined/)
fail('$x', 'null', /not defined/)
fail('map', '[]', /expected 1 arguments/)
fail('select', '[]', /expected 1 arguments/)
fail('fromjson(1)', 'null', /expected 0 arguments/)
fail('"\\q"', 'null', /invalid string escape/)
fail('"\\uZZZZ"', 'null', /invalid string escape/)
fail('"unterminated', 'null', /unterminated/)
fail('.a = 1', '{}', /syntax error/)
console.log(`jq: ${checks} filter/error checks and CLI/markup round-trip assertions passed`)

// Exercise the registered command through real shell pipelines and redirects.
// The modules touch the browser at load; this is as much of one as they need.
const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 }
g.localStorage = fakeStorage
g.sessionStorage = fakeStorage
g.window = Object.assign(globalThis, { location: new URL('http://localhost/'), addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) })
g.document = { addEventListener() {}, documentElement: { dataset: {}, style: {} }, createElement: () => ({ style: {} }), cookie: '' }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', language: 'en', clipboard: {} }, configurable: true })

const vite = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', define: { __APP_VERSION__: '"0.0.0"', __APP_COMMIT__: '"test"', __BUILD_TIME__: '"2026-01-01T00:00:00.000Z"' }, optimizeDeps: { noDiscovery: true, include: [] } })
try {
  const { runLine, strip, commands } = (await vite.ssrLoadModule('/src/terminal/commands.ts')) as typeof import('../src/terminal/commands.ts')
  const { HOME } = (await vite.ssrLoadModule('/src/terminal/vfs.ts')) as typeof import('../src/terminal/vfs.ts')
  let cwd = HOME
  const opened: string[] = []
  let openedProps: Record<string, string> | undefined
  const { dynamic } = (await vite.ssrLoadModule('/src/terminal/vfs.ts')) as typeof import('../src/terminal/vfs.ts')
  const run = async (text: string, root = false) => {
    const printed: string[] = []
    const base = {
      args: [],
      stdin: null,
      cwd,
      setCwd: (p: string) => void (cwd = p),
      env: { HOME, USER: 'menno' } as Record<string, string>,
      history: [],
      windows: [],
      openApp: (app: string) => void opened.push(app),
      openNewApp: (app: string, props?: Record<string, string>) => {
        opened.push(`new ${app}`)
        openedProps = props
      },
      root,
      closeWindow() {},
      clear() {},
      exit() {},
      setAccent: () => true,
      print: (t: string) => void printed.push(t),
      tty: false,
      live() {},
      size: { cols: 80, rows: 24 },
      signal: new AbortController().signal,
      onKey() {},
    }
    const results = await runLine(text, base as never)
    return { out: strip(results.map((r) => r.output).join('\n')), ok: results.every((r) => r.ok), printed: printed.join('\n') }
  }
  const out = async (line: string) => (await run(line)).out
  const kids = async (dir: string) => (await out(`ls -a ${dir} | cat`)).split('\n')

  const value = '{c:red}literal{/} {anim:spin}{/}'
  const constructed = await out("jq -nc --arg value '" + value + "' '{value: $value}' | jq -c .")
  assert.deepEqual(JSON.parse(constructed), { value })
  assert.equal((await run("jq -nc --argjson value bad '$value'")).ok, false)
  assert.equal((await run("jq -nc --arg value x '$value' extra extra")).ok, false)
  assert.equal((await run("jq -nc --arg value '" + value + "' '{value: $value}' > /tmp/jq-roundtrip.json")).ok, true)
  assert.deepEqual(JSON.parse(await out('jq -c . /tmp/jq-roundtrip.json')), { value })
  assert.equal(await out("jq -nc --argjson rows '[{\"ok\":true,\"name\":\"Ada\"},{\"ok\":false}]' '$rows | map(select(.ok) | {name})'"), '[{"name":"Ada"}]')
  const safe = await out("jq-safe -nc --arg value '" + value + "' '{value: $value}' | jq-safe -c .")
  assert.deepEqual(JSON.parse(safe), { value })
  const agentContext = { args: ['-n', '.'], stdin: '', signal: new AbortController().signal, policy: {}, budget: { step: () => null, write: () => null, stop() {} } }
  assert.throws(() => commands.jq.run(agentContext as never), /interactive-only/)
  assert.equal(await commands['jq-safe'].run(agentContext as never), 'null')
  await assert.rejects(Promise.resolve().then(() => commands['jq-safe'].run({ ...agentContext, budget: undefined } as never)), /budget required/)
  console.log('jq: registered command, pipes, redirects, file reads, and CLI errors passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await vite.close()
}
// Browser modules install background timers, as in check:terminal-cmds.
process.exit(process.exitCode ?? 0)
