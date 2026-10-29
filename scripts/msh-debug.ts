// Real msh parser/interpreter/debugger regressions with separate stdout, stderr and status.
import { createServer } from 'vite'

let failures = 0
const check = (ok: boolean, what: string, detail = '') => {
  if (ok) console.log('PASS', what)
  else {
    failures++
    console.log('FAIL', what, detail)
  }
}
const eq = (got: unknown, want: unknown, what: string) => check(JSON.stringify(got) === JSON.stringify(want), what, `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)

// The modules touch the browser at load; this is as much of one as they need.
const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 }
g.localStorage = fakeStorage
g.sessionStorage = fakeStorage
g.window = Object.assign(globalThis, { location: new URL('http://localhost/'), addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) })
g.document = { addEventListener() {}, documentElement: { dataset: {}, style: {} }, createElement: () => ({ style: {} }), cookie: '' }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', language: 'en', clipboard: {} }, configurable: true })
// No server: the account settles as "signed out", which is what the startup file waits for.
g.fetch = () => Promise.reject(new Error('offline'))

const vite = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', define: { __APP_VERSION__: '"0.0.0"', __APP_COMMIT__: '"test"', __BUILD_TIME__: '"2026-01-01T00:00:00.000Z"' }, optimizeDeps: { noDiscovery: true, include: [] } })
try {
  const { runLine } = await vite.ssrLoadModule('/src/terminal/commands.ts')
  const { runCapturedStreams, runCaptured, launchDebug } = await vite.ssrLoadModule('/src/terminal/msh/interp.ts')
  const { DebugSession, debugSessions } = await vite.ssrLoadModule('/src/terminal/msh/debug.ts')
  const { analyzeMsh } = await vite.ssrLoadModule('/src/terminal/msh/analysis.ts')
  const { parse, lex } = await vite.ssrLoadModule('/src/terminal/msh/parse.ts')
  const base = (signal = new AbortController().signal) => ({
    cwd: '/tmp', setCwd() {}, env: { HOME: '/home/menno', USER: 'menno' }, history: [], windows: [],
    openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent: () => true,
    print() {}, live() {}, size: { cols: 80, rows: 24 }, onKey() {}, signal,
  })
  const run = (src: string, filename = '-c') => runCapturedStreams(src, base(), filename)
  eq(await run('printf "%s\\n" "a b" \'c d\''), { stdout: 'a b\nc d\n', stderr: '', status: 0 }, 'quoting preserves words')
  eq(await run('printf "b\\na\\n" | sort'), { stdout: 'a\nb\n', stderr: '', status: 0 }, 'pipeline uses real commands')
  eq(await run('echo file > /tmp/xed-regression; cat < /tmp/xed-regression'), { stdout: 'file', stderr: '', status: 0 }, 'redirected bytes (existing text filesystem trims final newline)')
  eq((await run('x=outer; (x=inner); echo "$x"; f() { local x=local; echo "$x"; }; f; echo "$x"')).stdout, 'outer\nlocal\nouter\n', 'subshell and local scopes')
  const fail = await run('echo before; no_such_xed_command', 'broken.msh')
  eq(fail.stdout, 'before\n', 'failure keeps stdout separate')
  check(fail.status !== 0 && fail.stderr.includes('broken.msh:1:14:') && fail.stderr.includes('no_such_xed_command'), 'failure has source location and expression', fail.stderr)
  const trace = await run('set -x; echo hi')
  eq(trace.stdout, 'hi\n', 'trace does not contaminate stdout')
  check(trace.stderr.includes('+ echo hi'), 'trace goes to stderr')
  const syntax = analyzeMsh('echo ok\nthen', 'lint.msh')
  eq([syntax.diagnostics[0].line, syntax.diagnostics[0].column], [2, 1], 'lint uses parser location')
  check(analyzeMsh('cat <<EOF\nhello | world\nEOF', 'heredoc.msh').diagnostics.length === 0, 'real heredoc grammar')
  check(analyzeMsh('echo "unterminated', 'quote.msh').diagnostics[0].column === 6, 'lexer identifies open quote')
  const source = 'echo same\n  echo same'
  const nodes = parse(source, 'spans.msh').items
  eq([nodes[0].node.span.start, nodes[1].node.span.start, nodes[1].node.span.column], [0, 12, 3], 'repeated commands retain distinct source spans')
  check(lex('echo "a b" | cat').some((t: { k: string; start: number; end: number }) => t.k === 'op' && t.start === 11 && t.end === 12), 'highlight tokens use real lexer offsets')
  const aborted = new AbortController(); aborted.abort()
  eq((await runCapturedStreams('echo never', base(aborted.signal))).status, 130, 'pre-cancelled execution')
  eq(await runCaptured('echo legacy; false', base()), { output: 'legacy', status: 1 }, 'legacy combined-output API remains compatible')
  const wait = async (test: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (test()) return; await new Promise(r => setTimeout(r, 5)) }
    throw new Error('debug checkpoint timeout')
  }
  const debug = new DebugSession('test.msh')
  const execution = runCapturedStreams('x=one\necho "$x"\nx=two\necho "$x"', { ...base(), debug }, 'test.msh')
  await wait(() => debug.current.state === 'paused')
  eq(debug.current.location.line, 1, 'initial pause before execution')
  eq(debug.current.variables.x, undefined, 'assignment has not executed while paused')
  let finished = false; void execution.then(() => { finished = true })
  await new Promise(r => setTimeout(r, 20)); eq(finished, false, 'pause genuinely suspends execution')
  debug.step(); await wait(() => debug.current.state === 'paused')
  eq([debug.current.location.line, debug.current.variables.x], [2, 'one'], 'step advances once and shows variables')
  debug.breakpoint('test.msh', 4); debug.continue()
  await wait(() => debug.current.state === 'paused')
  eq([debug.current.location.line, debug.current.variables.x], [4, 'two'], 'continue stops at breakpoint')
  debug.continue(); const result = await execution; debug.finish(result.status)
  eq([result.stdout, debug.current.state], ['one\ntwo\n', 'completed'], 'continue completes with correct output')
  debug.step(); eq(debug.current.state, 'completed', 'finished session cannot restart')
  const cancel = new DebugSession('cancel')
  const cancelled = runCapturedStreams('echo never', { ...base(), debug: cancel })
  await wait(() => cancel.current.state === 'paused'); cancel.cancel()
  eq([(await cancelled).status, cancel.current.state], [130, 'cancelled'], 'stop releases pending checkpoint')
  await runLine("echo 'echo launched' > /tmp/xed-launch.msh", base())
  const launched = launchDebug('msh /tmp/xed-launch.msh', base(), '/tmp/xed-launch.msh')
  await wait(() => launched.session.current.state === 'paused'); launched.session.continue(); await launched.done
  eq(launched.session.current.state, 'completed', 'saved script launch uses normal msh command route')
  const denied = launchDebug('msh /missing/xed.msh', base())
  await wait(() => denied.session.current.state === 'paused'); denied.session.continue(); await denied.done
  eq(denied.session.current.state, 'failed', 'missing file cannot bypass file checks')
  await runLine('chmod 000 /tmp/xed-launch.msh', base())
  const unreadable = launchDebug('msh /tmp/xed-launch.msh', base())
  await wait(() => unreadable.session.current.state === 'paused'); unreadable.session.continue()
  const refused = await unreadable.done
  check(refused.some((r: { output: string }) => r.output.includes('Permission denied')), 'debug launch preserves file read permissions')
  eq(unreadable.session.current.state, 'failed', 'unreadable script fails')
  const pause = new DebugSession('pause request')
  const pausing = runCapturedStreams('sleep 0.05; echo after', { ...base(), debug: pause })
  await wait(() => pause.current.state === 'paused'); pause.continue()
  await new Promise(r => setTimeout(r, 5)); pause.pause()
  await wait(() => pause.current.state === 'paused')
  eq(pause.current.location.expression, 'echo after', 'pause request stops at next checkpoint after running command')
  pause.cancel(); eq((await pausing).status, 130, 'cancel after pause request')
  for (let i = 0; i < 30; i++) { const s = new DebugSession('bounded'); s.finish(0) }
  eq(debugSessions().length, 16, 'registry remains bounded')
} finally { await vite.close() }
process.exit(failures ? 1 : 0)
