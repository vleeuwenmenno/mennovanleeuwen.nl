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
  const { runCapturedStreams, runCaptured, launchDebug, DEBUG_OUTPUT_LIMIT } = await vite.ssrLoadModule('/src/terminal/msh/interp.ts')
  const { DebugSession, debugSessions } = await vite.ssrLoadModule('/src/terminal/msh/debug.ts')
  const { analyzeMsh } = await vite.ssrLoadModule('/src/terminal/msh/analysis.ts')
  const { parse, lex } = await vite.ssrLoadModule('/src/terminal/msh/parse.ts')
  const base = (signal = new AbortController().signal) => ({
    cwd: '/tmp', setCwd() {}, env: { HOME: '/home/menno', USER: 'menno' }, history: [], windows: [],
    openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent: () => true,
    print() {}, live() {}, size: { cols: 80, rows: 24 }, onKey() {}, signal,
  })
  const { Budget, AGENT_LIMITS } = await vite.ssrLoadModule('/src/terminal/limits.ts')
  const { makePolicy } = await vite.ssrLoadModule('/src/terminal/policy.ts')
  const { lookup } = await vite.ssrLoadModule('/src/terminal/fs.ts')
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
  const symbols = await vite.ssrLoadModule('/src/terminal/msh/symbols.ts')
  const symbolMain = 'source ./lib.msh\nparcel=global\nouter(parcel) {\n local fuel=9\n echo "$parcel $fuel $global $1"\n inner() { echo "$parcel"; }\n}\ndeliver "Space Potato" 3'
  const symbolFiles = new Map([['/tmp/main.msh', symbolMain], ['/tmp/lib.msh', 'global=origin\ndeliver(parcel,cost) { echo "$parcel $cost"; }']])
  const reads: string[] = []
  const symbolProject = await symbols.indexProject('/tmp/main.msh', '/tmp', async (path: string) => { reads.push(path); return symbolFiles.get(path) ?? null }, new AbortController().signal)
  eq(reads, ['/tmp/main.msh', '/tmp/lib.msh'], 'static source indexing follows literal paths from launch cwd')
  const resolved = (at: number) => symbols.resolveSymbol(symbolProject, '/tmp/main.msh', at)
  eq([resolved(symbolMain.indexOf('$parcel')).reliable, resolved(symbolMain.indexOf('$parcel')).definitions[0].kind], [true, 'parameter'], 'parameter shadows global in shared parser-backed analysis')
  eq([resolved(symbolMain.indexOf('$fuel')).reliable, resolved(symbolMain.indexOf('$fuel')).definitions[0].kind], [true, 'local'], 'unconditional local declaration resolves in own function')
  const dynamicGlobal = resolved(symbolMain.indexOf('$global'))
  check(!dynamicGlobal.reliable && dynamicGlobal.note.includes('caller local') && dynamicGlobal.definitions[0].path === '/tmp/lib.msh', 'free function variable offers source assignment as candidate, not invented lexical binding')
  check(!resolved(symbolMain.lastIndexOf('$parcel')).reliable, 'nested function does not lexically capture outer parameter')
  const sourceFunction = resolved(symbolMain.indexOf('deliver "'))
  check(sourceFunction.reliable && sourceFunction.definitions[0].signature === 'deliver(parcel, cost)' && sourceFunction.definitions[0].path === '/tmp/lib.msh', 'function call resolves literal sourced definition with signature and origin')
  check(resolved(symbolMain.indexOf('$1')).note.includes('Positional argument'), 'static positional hint distinguishes caller arguments')
  const varsComplete = symbols.completeSymbols(symbolProject, '/tmp/main.msh', symbolMain.indexOf('$parcel') + 4, ['printf'])
  check(varsComplete.some((c: { name: string; detail: string }) => c.name === 'parcel' && c.detail.includes('parameter')) && !varsComplete.some((c: { name: string }) => c.name === 'printf'), 'variable completion respects local shadowing and excludes commands')
  const parcelCompletion = varsComplete.find((c: { name: string }) => c.name === 'parcel')
  eq([parcelCompletion.start, parcelCompletion.end, parcelCompletion.caret], [symbolMain.indexOf('$parcel') + 1, symbolMain.indexOf('$parcel') + 7, symbolMain.indexOf('$parcel') + 4], 'completion replaces the whole existing identifier, including text after the caret')
  const commandComplete = symbols.completeSymbols(symbolProject, '/tmp/main.msh', symbolMain.indexOf('deliver "') + 3, ['declare', 'printf'])
  check(commandComplete.some((c: { name: string; detail: string }) => c.name === 'deliver' && c.detail.includes('deliver(parcel, cost)')), 'command completion shows source function signature')
  const redefinitions = 'f() { :; }\nf() { :; }\nf'
  const redefined = { entry: '/tmp/redefined', cwd: '/tmp', files: new Map([['/tmp/redefined', symbols.indexMsh(redefinitions, '/tmp/redefined')]]), links: [], notes: [] }
  const ambiguous = symbols.resolveSymbol(redefined, '/tmp/redefined', redefinitions.length - 1)
  check(!ambiguous.reliable && ambiguous.definitions.length === 2, 'function redefinitions remain explicit candidates')
  const literalRefs = symbols.indexMsh(`echo '$fake' "\\$escaped" "$real" # $comment`, '/tmp/literal')
  eq(literalRefs.references.filter((r: { kind: string }) => r.kind === 'variable').map((r: { name: string }) => r.name), ['real'], 'reference extraction honors parser words, quoting, escapes and comments')
  const dynamicSources = 'source "$lib"\ncd /tmp/elsewhere\nsource ./relative\neval "$command"'
  const dynamicReads: string[] = []
  const dynamicIndex = await symbols.indexProject('/tmp/dynamic', '/tmp', async (path: string) => { dynamicReads.push(path); return dynamicSources }, new AbortController().signal)
  eq(dynamicReads, ['/tmp/dynamic'], 'dynamic source and cwd do not trigger guessed file reads')
  check(dynamicIndex.notes.some((n: string) => n.includes('dynamic source')) && dynamicIndex.files.get('/tmp/dynamic').uncertain, 'dynamic source/eval uncertainty is explicit')
  const initializer = 'x=global\nf() { local x="$x"; echo "$x"; }'
  const initializerProject = { entry: '/tmp/init', cwd: '/tmp', files: new Map([['/tmp/init', symbols.indexMsh(initializer, '/tmp/init')]]), links: [], notes: [] }
  check(!symbols.resolveSymbol(initializerProject, '/tmp/init', initializer.indexOf('$x')).reliable && symbols.resolveSymbol(initializerProject, '/tmp/init', initializer.lastIndexOf('$x')).definitions[0].kind === 'local', 'local initializer reads caller before declaration takes effect')
  const shadowedBuiltin = symbols.indexMsh('local() { :; }; f() { local x=1; echo "$x"; }', '/tmp/shadowed')
  check(shadowedBuiltin.uncertain && !shadowedBuiltin.definitions.some((d: { name: string }) => d.name === 'x'), 'function shadowing local builtin does not fabricate local declarations')
  eq(symbols.literalWord('"lib\\path"'), 'lib\\path', 'literal source decoding preserves ordinary backslash in double quotes')
  const cancelledIndex = new AbortController()
  let indexReads = 0
  await symbols.indexProject('/tmp/cancelled', '/tmp', async () => { indexReads++; cancelledIndex.abort(); return 'source next' }, cancelledIndex.signal)
  eq(indexReads, 1, 'cancelled source indexing starts no further reads')
  const cyclic = await symbols.indexProject('/tmp/cycle', '/tmp', async () => 'source ./cycle', new AbortController().signal)
  eq(cyclic.files.size, 1, 'source cycles terminate without executing')
  const aborted = new AbortController(); aborted.abort()
  eq((await runCapturedStreams('echo never', base(aborted.signal))).status, 130, 'pre-cancelled execution')
  eq(await runCaptured('echo legacy; false', base()), { output: 'legacy', status: 1 }, 'legacy combined-output API remains compatible')
  const wait = async (test: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (test()) return; await new Promise(r => setTimeout(r, 5)) }
    throw new Error('debug checkpoint timeout')
  }
  // Named parameters: parser, runtime, source diagnostics and frame cleanup share the real path.
  const potato = `deliver(parcel, cost) {
    printf 'Delivering %s for %s fuel\\n' "$parcel" "$cost"
}
deliver "Space Potato" 3`
  eq(await run(potato), { stdout: 'Delivering Space Potato for 3 fuel\n', stderr: '', status: 0 }, 'exact named-parameter potato example')
  for (const header of ['f()', 'function f()', 'function f']) {
    eq((await run(`${header} { printf '<%s:%s>\\n' "$#" "$1"; }; f; f a b`)).stdout, '<0:>\n<2:a>\n', `legacy argument handling: ${header}`)
  }
  for (const header of ['f(a,b)', 'function f(a, b)', 'f (\n a, # comment\n b\n)', 'f(a ,\n b)', 'f(a,\\\n b)']) {
    eq((await run(`${header}\n{ printf '<%s:%s>\\n' "$a" "$b"; }; f '' 'two words'`)).stdout, '<:two words>\n', `named header whitespace: ${header}`)
  }
  eq((await run(`f(a) { printf '%s\\n' "$a"; }; f '$(touch /tmp/parameter-eval) \`echo no\` $HOME " * ;'`)).stdout,
    '$(touch /tmp/parameter-eval) `echo no` $HOME " * ;\n', 'argument strings are never reparsed or expanded twice')
  check(!lookup('/tmp/parameter-eval'), 'substitution-looking literal parameter causes no mutation')
  eq((await run(`f(a,b) { printf '%s\\n' "$#" "$1" "$2" "$@"; shift; printf '%s\\n' "$a" "$b" "$#" "$1"; }; f 'one two' ''`)).stdout,
    '2\none two\n\none two\n\none two\n\n1\n\n', 'positionals preserved; shift does not change named snapshots')
  for (const options of ['', 'set -u;']) for (const args of ['', 'one', 'one two three']) {
    const r = await run(`${options} f(a,b) { touch /tmp/arity-body; };\nf ${args}`, '/tmp/arity.msh')
    check(r.status === 1 && r.stderr.includes('/tmp/arity.msh:2:1:') && r.stderr.includes(`f expects 2 arguments (a, b); received ${args ? args.split(' ').length : 0}`), `exact arity diagnostic: ${options} ${args}`, r.stderr)
  }
  check(!lookup('/tmp/arity-body'), 'arity failure never enters body')
  eq((await run('set -u; f(a) { printf "<%s>" "$a"; }; f ""')).stdout, '<>', 'empty supplied argument is set under nounset')
  eq((await run('set -u; f() { printf "<%s>" "$1"; }; f')).stdout, '<>', 'legacy missing positional remains empty under nounset')
  eq((await run('a=global; f(a) { local a=changed; g(a) { echo "$a"; }; g nested; echo "$a"; unset a; }; f first; echo "$a"')).stdout,
    'nested\nchanged\nglobal\n', 'parameter/local redeclaration preserves original value, nesting and unset restore')
  eq((await run('a=global; f(a) { g() { echo "$a"; }; g; }; f caller; echo "$a"')).stdout, 'caller\nglobal\n', 'parameter follows existing dynamic local scope')
  eq((await run('f(n) { echo "$n"; if [ "$n" -gt 0 ]; then f "$((n - 1))"; fi; echo "$n"; }; f 2')).stdout,
    '2\n1\n0\n0\n1\n2\n', 'recursive named bindings isolate frames')
  eq((await run('f(a) { echo "$a"; }; x=$(f "two words"); echo "$x"; (f sub)')).stdout, 'two words\nsub\n', 'substitution and subshell preserve function parameter definitions')
  eq((await run('f(a) { echo never; }; x=$(f); echo "status=$? value=$x"')).stdout, 'status=1 value=\n', 'wrong arity in substitution keeps status and skips body')
  const badParameters: [string, number, string][] = [
    ['f(a,a) { :; }', 5, 'duplicate'], ['f(a, a) { :; }', 6, 'duplicate'],
    ['f(1x) { :; }', 3, 'plain variable'], ['f(a-b) { :; }', 3, 'plain variable'],
    ['f(a=1) { :; }', 3, 'plain variable'], ['f(a: str) { :; }', 3, 'plain variable'],
    ['f([a]) { :; }', 3, 'plain variable'], ['f(a[]) { :; }', 3, 'plain variable'],
    ['f(...a) { :; }', 3, 'plain variable'], ['f("a") { :; }', 3, 'plain variable'],
    ['f($a) { :; }', 3, 'plain variable'], ['f(a b) { :; }', 5, 'comma'],
    ['f(,a) { :; }', 3, 'before comma'], ['f(a,) { :; }', 5, 'after comma'],
    ['f(a,,b) { :; }', 5, 'before comma'], ['f(RANDOM) { :; }', 3, 'computed'],
    ['f(readonly a) { :; }', 12, 'comma'], ['f("Space Potato", 3)', 3, 'plain variable'],
  ]
  for (const [code, column, message] of badParameters) {
    const a = analyzeMsh('# file\n' + code, '/tmp/params-invalid.msh')
    check(a.diagnostics.length === 1 && a.diagnostics[0].line === 2 && a.diagnostics[0].column === column && a.diagnostics[0].message.includes(message),
      `precise declaration diagnostic: ${code}`, JSON.stringify(a.diagnostics))
  }
  const analysis = analyzeMsh(potato, 'potato.msh')
  eq(analysis.tokens.filter((t: { role?: string }) => t.role === 'parameter').map((t: { v: string }) => t.v), ['parcel', 'cost'], 'shared Xed analysis identifies named parameters')
  eq([...analysis.commands], [2, 4], 'parameter declaration does not add debugger command stops')
  eq((await run('echo a,b readonly parcel cost')).stdout, 'a,b readonly parcel cost\n', 'ordinary command words and commas remain literal')
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
  await runLine(`printf %s ${q(potato)} > /tmp/named-source.msh`, base())
  eq((await run('source /tmp/named-source.msh')).stdout, 'Delivering Space Potato for 3 fuel\n', 'source uses shared named parser/runtime')
  eq((await run('msh -n /tmp/named-source.msh')).status, 0, 'syntax-only accepts named parameters without running')
  await runLine(`printf %s ${q('f(a,a) { :; }')} > /tmp/named-invalid.msh`, base())
  for (const cmd of ['source', 'msh -n']) {
    const r = await run(`${cmd} named-invalid.msh`)
    check(r.status === 2 && r.stderr.includes('/tmp/named-invalid.msh:1:5:') && r.stderr.includes('duplicate function parameter'), `${cmd} keeps canonical declaration diagnostics`, r.stderr)
  }
  for (const tail of ['return 7', 'set -e; false', 'set -u; echo "$missing"']) {
    const b = base()
    await runLine(`a=outer; f(a) { local own=inner; ${tail}; }; f inner`, b)
    eq([b.env['a'], Object.hasOwn(b.env, 'own')], ['outer', false], `cleanup after ${tail}`)
  }
  const proto = base()
  const originalPrototype = Object.getPrototypeOf(proto.env)
  await runLine('f(__proto__, constructor) { echo "$__proto__:$constructor"; local __proto__=local; }; f data ctor', proto)
  check(Object.getPrototypeOf(proto.env) === originalPrototype && !Object.hasOwn(proto.env, '__proto__') && !Object.hasOwn(proto.env, 'constructor'), 'prototype-like identifiers bind as data and restore absence')
  const namedCancelBase = base()
  await runLine('a=outer; f(a) { echo "$a"; }', namedCancelBase)
  const namedCancel = launchDebug('f inner', namedCancelBase)
  await wait(() => namedCancel.session.current.state === 'paused')
  namedCancel.session.stepInto()
  await wait(() => namedCancel.session.current.state === 'paused')
  eq([namedCancel.session.current.variables.a, namedCancel.session.current.args, namedCancel.session.current.params, namedCancel.session.current.locals], ['inner', ['inner'], ['a'], []], 'parameter visible before first function command with positionals intact')
  namedCancel.session.cancel(); await namedCancel.done
  eq(namedCancelBase.env['a'], 'outer', 'cancelled named invocation restores caller value')
  const bindingBudget = new Budget({ ...AGENT_LIMITS, maxVariable: 4 })
  const limitedBase = { ...base(), budget: bindingBudget }
  await runLine('a=old; f(a,b) { touch /tmp/named-budget-body; }; f new oversized', limitedBase)
  check(bindingBudget.stopped === 'memory' && limitedBase.env['a'] === 'old' && !Object.hasOwn(limitedBase.env, 'b') && !lookup('/tmp/named-budget-body'), 'partial parameter binding obeys variable budget and restores on exhaustion')
  const framesSource = 'value=global\nf(value) {\n  local attempt=1\n  if [ "$value" = outer ]; then f inner; fi\n  value=changed\n  unset attempt\n  echo "$value"\n}\nf outer\necho "$value"'
  const frameSession = new DebugSession('frame inspection', 'run')
  frameSession.breakpoint('/tmp/frames.msh', 5)
  const frameRun = runCapturedStreams(framesSource, { ...base(), debug: frameSession }, '/tmp/frames.msh')
  await wait(() => frameSession.current.state === 'paused')
  let frames = frameSession.current.frames
  const innerId = frames[0].id, outerId = frames[1].id
  check(innerId !== outerId && frames[0].name === 'f' && frames[1].name === 'f', 'recursive debugger frames have distinct stable identity')
  eq([frames[0].values.variables.value, frames[1].values.variables.value, frames[2].values.variables.value], ['inner', 'outer', 'global'], 'caller snapshots reconstruct each shadowed binding, not executing values')
  eq([frames[0].values.params, frames[0].values.locals, frames[1].values.args], [['value'], ['attempt'], ['outer']], 'parameters separated from locals and caller positional arguments retained')
  frameSession.stepOver(); await wait(() => frameSession.current.state === 'paused')
  eq([frameSession.current.frames[0].id, frameSession.current.changes.value, frameSession.current.variables.value], [innerId, 'inner', 'changed'], 'changed values compare same invocation and binding only')
  frameSession.stepOver(); await wait(() => frameSession.current.state === 'paused')
  eq([frameSession.current.unset, frameSession.current.changes.attempt], [['attempt'], '1'], 'unset local captured explicitly with prior value')
  frameSession.stepOut(); await wait(() => frameSession.current.state === 'paused')
  eq([frameSession.current.frames[0].id, frameSession.current.variables.value, frameSession.current.changes.value], [outerId, 'outer', undefined], 'return selects caller identity without comparing unrelated recursion')
  frameSession.breakpoint('/tmp/frames.msh', 5); frameSession.continue()
  await frameRun; frameSession.finish(0)
  eq([frameSession.current.frames, frameSession.current.variables, frameSession.current.changes], [[], {}, {}], 'completed debugger clears all current and prior inspection values')
  await runLine("echo 'echo child' > /tmp/review-child.sh", base())
  const relative = launchDebug('source review-child.sh', base())
  await wait(() => relative.session.current.state === 'paused')
  relative.session.step(); await wait(() => relative.session.current.state === 'paused')
  eq(relative.session.current.location.filename, '/tmp/review-child.sh', 'review: sourced relative file has canonical debugger identity')
  relative.session.cancel(); await relative.done
  await runLine("printf '#!/bin/msh\\necho \"$0\"\\necho done\\n' > /tmp/review-canonical.sh; chmod +x /tmp/review-canonical.sh", base())
  await runLine("echo 'source review-canonical.sh' > /tmp/review-wrapper.sh", base())
  await runLine("echo 'msh review-canonical.sh' > /tmp/review-nested-msh.sh", base())
  await runLine("echo './review-canonical.sh' > /tmp/review-nested-exec.sh", base())
  for (const [command, arg0] of [
    ['source review-canonical.sh', 'msh'],
    ['msh review-canonical.sh', 'review-canonical.sh'],
    ['./review-canonical.sh', './review-canonical.sh'],
    ['msh review-wrapper.sh', 'review-wrapper.sh'],
    ['msh review-nested-msh.sh', 'review-canonical.sh'],
    ['msh review-nested-exec.sh', './review-canonical.sh'],
    ['cd /; source tmp/review-canonical.sh', 'msh'],
    ['cd /; msh tmp/review-canonical.sh', 'tmp/review-canonical.sh'],
    ['cd /; ./tmp/review-canonical.sh', './tmp/review-canonical.sh'],
  ]) {
    const displayed: string[] = []
    const debugRun = launchDebug(command, { ...base(), print: (text: string) => displayed.push(text) }, 'display label')
    debugRun.session.breakpoint('/tmp/review-canonical.sh', 2)
    await wait(() => debugRun.session.current.state === 'paused')
    debugRun.session.continue()
    await wait(() => debugRun.session.current.state === 'paused' || debugRun.session.done)
    eq([debugRun.session.current.state, debugRun.session.current.location.filename, debugRun.session.current.location.line], ['paused', '/tmp/review-canonical.sh', 2], `canonical absolute breakpoint: ${command}`)
    eq(debugRun.session.current.label, 'display label', 'canonical source identity does not rewrite session display label')
    if (!debugRun.session.done) {
      // The compound file list can share line 2 with its first command. Step until line 3.
      for (let i = 0; i < 4 && debugRun.session.current.location.line !== 3; i++) {
        debugRun.session.step(); await wait(() => debugRun.session.current.state === 'paused' || debugRun.session.done)
      }
      eq([debugRun.session.current.location.filename, debugRun.session.current.location.line], ['/tmp/review-canonical.sh', 3], `step preserves canonical source identity: ${command}`)
      debugRun.session.breakpoint('/tmp/review-canonical.sh', 2)
      debugRun.session.continue()
    }
    await debugRun.done
    check(displayed.join('\n') === arg0 + '\ndone' && debugRun.session.current.state === 'completed', `script $0 remains invocation spelling: ${command}`, displayed.join('\n'))
  }
  await runLine("printf 'echo good\\nthen\\n' > /tmp/review-syntax.sh", base())
  const checkedFile = await run('msh -n review-syntax.sh')
  check(checkedFile.status === 2 && checkedFile.stderr.includes('/tmp/review-syntax.sh:2:1:') && checkedFile.stderr.includes('[then]'), 'round4: syntax-only file check uses canonical parser diagnostic', checkedFile.stderr)
  const snapshotBudget = new Budget({ ...AGENT_LIMITS, maxTotal: 10 })
  const snapshotRun = launchDebug('echo never', { ...base(), budget: snapshotBudget })
  await snapshotRun.done
  check(snapshotBudget.stopped === 'output' && snapshotRun.session.current.state === 'failed', 'debug variable snapshots charge shared memory/output accounting before pausing')
  const limited = new Budget({ ...AGENT_LIMITS, maxSteps: 30 })
  const guarded = launchDebug('for i in 1 2 3 4 5 6; do jq-safe -n 1; done; touch /tmp/debug-budget-after', { ...base(), budget: limited })
  await wait(() => guarded.session.current.state === 'paused'); guarded.session.continue(); await guarded.done
  check(limited.stopped === 'steps' && !lookup('/tmp/debug-budget-after'), 'debugger execution retains shared jq-safe accounting and stops later writes')
  const timedBudget = new Budget({ ...AGENT_LIMITS, timeoutMs: 25 })
  const timed = launchDebug('touch /tmp/debug-timeout-after', { ...base(), budget: timedBudget })
  await timed.done
  check(timedBudget.stopped === 'timeout' && !lookup('/tmp/debug-timeout-after'), 'debugger paused checkpoint observes deadline without resuming writes')
  const policy = makePolicy({ mode: 'plan', root: '/tmp', write: false, delete: false, network: false, steering: false })
  const guardedWrite = launchDebug('touch /tmp/debug-policy-after', { ...base(), policy })
  await wait(() => guardedWrite.session.current.state === 'paused'); guardedWrite.session.continue(); await guardedWrite.done
  check(guardedWrite.session.current.state === 'failed' && !lookup('/tmp/debug-policy-after'), 'debugger launch preserves actual-operation file policy')
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
  // Abort only after real output has arrived while the interpreter is running.
  const runningAbort = new AbortController()
  let runningPrints = 0, cancelledWhileRunning = false
  const running = launchDebug('while true; do echo running; done', {
    ...base(runningAbort.signal), print: () => {
      runningPrints++
      if (runningPrints === 8) {
        cancelledWhileRunning = running.session.current.state === 'running'
        runningAbort.abort()
      }
    },
  })
  await wait(() => running.session.current.state === 'paused'); running.session.continue()
  const runningResult = await Promise.race([running.done, new Promise<never>((_, reject) => {
    const timeout = setTimeout(() => { running.session.cancel(); reject(new Error('running output cancellation timed out')) }, 2000)
    void running.done.finally(() => clearTimeout(timeout))
  })])
  check(cancelledWhileRunning && runningPrints === 8, 'abort occurs during running loop after eight real output callbacks')
  eq([running.session.current.state, running.session.current.status, runningResult[0].ok], ['cancelled', 130, false], 'running output cancellation terminates execution with status 130')
  const printsAtEnd = runningPrints
  await new Promise(r => setTimeout(r, 20))
  eq(runningPrints, printsAtEnd, 'running loop emits no output after cancellation settles')
  // One top-level msh invocation streams far more than the UI cap, without newlines.
  // Both retained RunResult output and screen callback chunks must remain bounded.
  const chunk = 'x'.repeat(2048)
  const largeScript = `for i in ${Array.from({ length: 256 }, (_, i) => i).join(' ')}; do printf %s '${chunk}'; done; printf END`
  await runLine(`printf %s '${largeScript.replace(/'/g, "'\\''")}' > /tmp/xed-output.msh`, base())
  const fullOutput = chunk.repeat(256) + 'END'
  const ordinaryPrints: string[] = []
  const ordinary = await runLine('msh /tmp/xed-output.msh', { ...base(), print: (s: string) => ordinaryPrints.push(s) })
  check(ordinary[0].output === fullOutput, 'ordinary runLine still returns complete large output')
  check(ordinaryPrints.length === 1 && ordinaryPrints[0] === fullOutput, 'ordinary screen still flushes complete unterminated line')
  let maxPrinted = 0, printedLength = 0, printCalls = 0
  const bounded = launchDebug('msh /tmp/xed-output.msh', { ...base(), print: (s: string) => { maxPrinted = Math.max(maxPrinted, s.length); printedLength += s.length; printCalls++ } })
  await wait(() => bounded.session.current.state === 'paused'); bounded.session.continue()
  const boundedResults = await bounded.done
  eq(boundedResults[0].output.length, DEBUG_OUTPUT_LIMIT, 'debug capture stays at configured bound for large output')
  check(boundedResults[0].output === fullOutput.slice(-DEBUG_OUTPUT_LIMIT), 'debug capture retains correct output tail')
  check(maxPrinted <= DEBUG_OUTPUT_LIMIT && printedLength === fullOutput.length && printCalls > 1, 'debug screen streams bounded chunks without waiting for newline')
  const newlineScript = largeScript.replace('printf %s', "printf '%s\\n'")
  const newlineResults = await runLine(newlineScript, base(), { captureLimit: 1024 })
  check(newlineResults[0].output.length <= 1024, 'optional bound also applies to newline output')
  // --- step into / over / out across functions and sourced files, with frame depth ---------------
  const dbg = await vite.ssrLoadModule('/src/terminal/msh/debug.ts')
  const watch = await vite.ssrLoadModule('/src/terminal/msh/watch.ts')
  const lib = 'helper() {\n  echo "in helper $1"\n  inner=done\n}\nsub() {\n  echo from-sub\n}'
  const main = 'source /tmp/step-lib.sh\nouter() {\n  local depth=one\n  helper "$depth"\n  echo after-helper\n}\nouter\nx=$(sub)\ny=$(echo plain)\necho end'
  await runLine(`printf %s '${lib}' > /tmp/step-lib.sh; printf %s '${main}' > /tmp/step-main.sh`, base())
  const stops: string[] = []
  const stepped: string[] = []
  const stepRun = launchDebug('msh /tmp/step-main.sh', { ...base(), print: (t: string) => stepped.push(t) }, 'steps', { start: { entry: '/tmp/step-main.sh' } })
  const at = async (action: () => void) => {
    action()
    await wait(() => stepRun.session.current.state === 'paused' || stepRun.session.done)
    const c = stepRun.session.current
    const where = c.state === 'paused' ? `${c.location.filename.split('/').pop()}:${c.location.line}@${c.frames.length}` : c.state
    stops.push(where)
    return c
  }
  let snap = await at(() => {})
  eq([snap.reason, snap.location.filename, snap.location.line, snap.frames.map((f: { kind: string }) => f.kind)], ['entry', '/tmp/step-main.sh', 1, ['script', 'script']], 'entry stop: first command of the file, not the -c launch line')
  check(stepRun.session.sourceOf('/tmp/step-main.sh') === dbg.sourceHash(main), 'session records the parsed source identity (hash) of the file')
  snap = await at(() => stepRun.session.stepOver())
  eq([snap.location.line, snap.location.expression], [7, 'outer'], 'step over a source command skips the sourced file and function definitions')
  snap = await at(() => stepRun.session.stepInto())
  eq([snap.location.line, snap.frames[0].kind, snap.frames[0].name, snap.frames.length], [3, 'function', 'outer', 3], 'step into enters the function body, one frame deeper')
  snap = await at(() => stepRun.session.stepOver())
  eq([snap.location.line, snap.locals], [4, ['depth']], 'step over stays in the frame; locals of the frame are listed')
  snap = await at(() => stepRun.session.stepInto())
  eq([snap.location.filename, snap.location.line, snap.frames.map((f: { name: string }) => f.name).slice(0, 2), snap.args], ['/tmp/step-lib.sh', 2, ['helper', 'outer'], ['one']], 'step into a function from a sourced file: its own file, frame and $1')
  eq([snap.frames[1].filename, snap.frames[1].line], ['/tmp/step-main.sh', 4], 'call stack shows where the caller is')
  eq(stepped.join(''), '', 'nothing printed yet while stepping')
  snap = await at(() => stepRun.session.stepOut())
  eq([snap.location.filename, snap.location.line, snap.variables.inner, snap.frames.length], ['/tmp/step-main.sh', 5, 'done', 3], 'step out returns to the caller after the rest of the function ran')
  snap = await at(() => stepRun.session.stepOut())
  eq([snap.location.line, snap.frames.length], [8, 2], 'step out of outer() lands on the next command of the script')
  snap = await at(() => stepRun.session.stepInto())
  eq([snap.location.filename, snap.location.line, snap.frames[0].name, snap.frames[1].kind], ['/tmp/step-lib.sh', 6, 'sub', 'substitution'], 'step into $(sub) skips the sourceless -c text and enters the function')
  snap = await at(() => stepRun.session.stepOut())
  eq([snap.location.line, snap.variables.x], [9, 'from-sub'], 'step out of a substitution finishes the assignment')
  snap = await at(() => stepRun.session.stepInto())
  eq([snap.location.line, snap.location.filename], [10, '/tmp/step-main.sh'], 'step into $(echo …) has no source to show: it lands on the next line, never on -c')
  snap = await at(() => stepRun.session.stepOver())
  eq(snap.state, 'completed', 'step over the last command completes the session')
  eq([stepped.join('\n'), stepRun.session.current.frames, stepRun.session.current.state], ['in helper one\nafter-helper\nend', [], 'completed'], 'stepped program output and no live frames once done')
  // Line events: a breakpoint on a line of several commands stops once; a loop line stops again.
  await runLine(`printf %s 'a=1; b=2\nfor i in 1 2 3; do c=$i; done\necho tail' > /tmp/line-events.sh`, base())
  dbg.removeBreakpoints()
  check(dbg.toggleBreakpoint('/tmp//line-events.sh', 1) && dbg.toggleBreakpoint('/tmp/./line-events.sh', 2), 'editor breakpoints accept and canonicalise absolute paths')
  eq(dbg.editorBreakpoints().map((b: { path: string; line: number }) => `${b.path}:${b.line}`), ['/tmp/line-events.sh:1', '/tmp/line-events.sh:2'], 'canonical breakpoint list')
  check(!dbg.toggleBreakpoint('relative.sh', 1), 'relative breakpoint paths are refused')
  const plain = launchDebug('msh /tmp/line-events.sh', base(), 'no editor', { start: 'run' })
  await plain.done
  eq(plain.session.current.state, 'completed', 'editor breakpoints do not stop sessions that did not opt in')
  const lineRun = launchDebug('msh /tmp/line-events.sh', base(), 'editor', { start: 'run', editorBreakpoints: true })
  const lineStops: string[] = []
  for (let i = 0; i < 8; i++) {
    await wait(() => lineRun.session.current.state === 'paused' || lineRun.session.done)
    if (lineRun.session.done) break
    const c = lineRun.session.current
    lineStops.push(`${c.location.line}:${c.location.expression}:${c.variables.i ?? ''}:${c.reason}`)
    lineRun.session.continue()
  }
  await lineRun.done
  eq(lineStops, ['1:a=1:undefined:breakpoint'.replace('undefined', ''), '2:for i in 1 2 3; do c=$i; done::breakpoint', '2:c=$i:2:breakpoint', '2:c=$i:3:breakpoint'], 'line events: one stop per line entry, and again each time a loop jumps back')
  dbg.setBreakpointEnabled('/tmp/line-events.sh', 2, false)
  const disabledRun = launchDebug('msh /tmp/line-events.sh', base(), 'disabled', { start: 'run', editorBreakpoints: true })
  await wait(() => disabledRun.session.current.state === 'paused'); const firstStop = disabledRun.session.current.location.line; disabledRun.session.continue(); await disabledRun.done
  eq([firstStop, disabledRun.session.current.state], [1, 'completed'], 'a disabled breakpoint does not stop; enabled ones still do')
  dbg.removeBreakpoints(); dbg.toggleBreakpoint('/tmp/x.sh', 5); dbg.toggleBreakpoint('/tmp/x.sh', 2); dbg.toggleBreakpoint('/tmp/x.sh', 9)
  dbg.shiftBreakpoints('/tmp/x.sh', 3, 0, 2)
  eq(dbg.editorBreakpoints().map((b: { line: number }) => b.line), [2, 7, 11], 'inserted lines move later breakpoints with their text')
  dbg.shiftBreakpoints('/tmp/x.sh', 6, 3, 1)
  eq(dbg.editorBreakpoints().map((b: { line: number }) => b.line), [2, 9], 'a breakpoint on deleted lines goes; later ones move up')
  dbg.moveBreakpoints('/tmp', '/srv/tmp2')
  eq(dbg.editorBreakpoints().map((b: { path: string }) => b.path), ['/srv/tmp2/x.sh', '/srv/tmp2/x.sh'], 'breakpoints follow a renamed folder')
  dbg.removeBreakpoints()
  // A pause request lands inside a function; step out from there and over a whole loop.
  const pauseIn = launchDebug("f() { while true; do n=1; done; }; f", base(), 'pause in function', { start: 'run' })
  await new Promise(r => setTimeout(r, 30)); pauseIn.session.pause()
  await wait(() => pauseIn.session.current.state === 'paused')
  eq([pauseIn.session.current.reason, pauseIn.session.current.frames[0].kind], ['pause', 'function'], 'pause request stops inside the running function frame')
  pauseIn.session.cancel(); await pauseIn.done
  // Watches: read-only references against the snapshot, never shell evaluation.
  const ws = { variables: { x: 'hello', big: 'z'.repeat(5000), '?': '3' }, args: ['first', 'second'] }
  const ev = (e: string) => watch.evaluateWatch(e, ws)
  eq([ev('x'), ev('$x-${#x}'), ev('$1/$#'), ev('${2}'), ev('$?'), ev('"$x"')], [
    { ok: true, value: 'hello', truncated: false }, { ok: true, value: 'hello-5', truncated: false }, { ok: true, value: 'first/2', truncated: false },
    { ok: true, value: 'second', truncated: false }, { ok: true, value: '3', truncated: false }, { ok: true, value: '"hello"', truncated: false },
  ], 'watch references and plain text')
  for (const bad of ['$(rm -rf /tmp)', '`id`', '$((1+1))', '${x:-y}', '${x:=y}', '${!x}', '$(touch /tmp/watch-ran)']) check(!ev(bad).ok, `watch refuses ${bad}`, JSON.stringify(ev(bad)))
  check(!lookup('/tmp/watch-ran'), 'refused watch expressions never execute anything')
  eq([ev('nope').ok, ev('$9').ok, ev('x'.repeat(201)).ok], [false, false, false], 'unset variables, missing args and over-long expressions are errors')
  const truncated = ev('$big$big')
  check(truncated.ok && truncated.value.length === 4096 && truncated.truncated, 'watch values are bounded while built')
  eq([watch.watchError('$(id)') !== null, watch.watchError('$anything'), watch.evaluateWatch('$x', null)], [true, null, { ok: true, value: '', truncated: false }], 'syntax check without a snapshot')
  const src = 'name=1\necho "$name ${other} ${#len} $1"\nlocal kept\nfor item in a; do :; done\nplain word'
  const off = (needle: string, d = 0) => src.indexOf(needle) + d
  eq([watch.variableAt(src, 1), watch.variableAt(src, off('$name', 2)), watch.variableAt(src, off('$name')), watch.variableAt(src, off('${other}', 3)), watch.variableAt(src, off('${#len}', 4)), watch.variableAt(src, off('$1', 1)), watch.variableAt(src, off('kept', 1)), watch.variableAt(src, off('item', 1)), watch.variableAt(src, off('word', 1))], ['name', 'name', 'name', 'other', 'len', '$1', 'kept', 'item', null], 'hover finds variable references and assignments only')
  // Bounded snapshots keep real lengths and counts: ${#x} and $# are the script's, not the bound's.
  const args65 = Array.from({ length: 65 }, (_, i) => i + 1).join(' ')
  await runLine(`printf '%s\n' 'x=$(printf "%05000d" 0)' 'for i in $(seq 300); do export "v$i=1"; done' 'zlast=end' 'f() {' '  : "$#"' '}' 'f ${args65}' > /tmp/watch-bounds.sh`, base())
  const bounds = launchDebug('msh /tmp/watch-bounds.sh', base(), 'bounds', { start: 'run' })
  bounds.session.breakpoint('/tmp/watch-bounds.sh', 5)
  await wait(() => bounds.session.current.state === 'paused' || bounds.session.done)
  const bsnap = bounds.session.current
  eq([bsnap.state, bsnap.location?.line, bsnap.argCount, bsnap.args.length, bsnap.cut.variables.x, bsnap.variables.x?.length, bsnap.variableCount > 300], ['paused', 5, 65, 64, 5000, 4096, true], 'real pause: 5000-character x and 65 arguments are bounded with their real length and count kept')
  eq(watch.evaluateWatch('${#x}:$#', bsnap), { ok: true, value: '5000:65', truncated: false }, 'watch ${#x}:$# reports the real 5000:65, not the bounds')
  const cutX = watch.evaluateWatch('x', bsnap)
  check(cutX.ok && cutX.value.length === 4096 && cutX.truncated, 'a cut variable is marked truncated', JSON.stringify(cutX).slice(0, 120))
  const at65 = watch.evaluateWatch('${65}', bsnap), at66 = watch.evaluateWatch('${66}', bsnap), all = watch.evaluateWatch('$@', bsnap)
  check(!at65.ok && at65.error.includes('not captured') && !at66.ok && at66.error.includes('not set'), '${65} is "not captured" (past the bound), ${66} is "not set"', JSON.stringify([at65, at66]))
  check(all.ok && all.truncated, '$@ is marked truncated when arguments were left out')
  const late = watch.evaluateWatch('zlast', bsnap), never = watch.evaluateWatch('nosuchvar', bsnap)
  check(!late.ok && late.error.includes('not captured') && !never.ok && never.error.includes('not captured'), 'past 256 variables a missing name is "not captured", never claimed unset', JSON.stringify([late, never]))
  bounds.session.cancel(); await bounds.done
  const small = { variables: { y: 'ab' }, args: ['p'], cut: { variables: {}, args: {} }, argCount: 1, variableCount: 1 }
  eq([watch.evaluateWatch('nosuch', small), watch.evaluateWatch('$2', small)], [{ ok: false, error: 'nosuch is not set at this pause' }, { ok: false, error: '$2 is not set' }], 'with nothing left out, missing names and arguments are "not set"')
  // Positional parameters past $9 need braces: $10 is $1 then "0" (shell rules), ${10} the tenth.
  const tagged = Array.from({ length: 65 }, (_, i) => `arg-${i + 1}-x`).join(' ')
  await runLine(`printf '%s\n' 'g() {' '  : "$10 \${10} \${64} \${65}"' '}' 'g ${tagged}' > /tmp/watch-positional.sh`, base())
  const pos = launchDebug('msh /tmp/watch-positional.sh', base(), 'positional', { start: 'run' })
  pos.session.breakpoint('/tmp/watch-positional.sh', 2)
  await wait(() => pos.session.current.state === 'paused' || pos.session.done)
  const psnap = pos.session.current
  const pv = (e: string) => { const r = watch.evaluateWatch(e, psnap); return r.ok ? r.value : `ERR ${r.error}` }
  eq([pv('$1'), pv('$9'), pv('$10'), pv('${10}'), pv('${64}'), pv('$#')], ['arg-1-x', 'arg-9-x', 'arg-1-x0', 'arg-10-x', 'arg-64-x', '65'], 'real pause: $10 is $1 then 0, ${10} the tenth, ${64} the last kept')
  check(pv('${65}').includes('not captured') && pv('${66}').includes('not set'), '${65} past the bound is not captured, ${66} is not set', `${pv('${65}')} | ${pv('${66}')}`)
  pos.session.cancel(); await pos.done
  eq([watch.argRef(1), watch.argRef(9), watch.argRef(10), watch.argRef(64)], ['$1', '$9', '${10}', '${64}'], 'generated positional references use braces from 10 on')
  const ptext = ': "$10 ${10} $1x ${2} $"'
  const hoverAt = (needle: string, d = 0) => watch.variableAt(ptext, ptext.indexOf(needle) + d)
  eq([hoverAt('$10'), hoverAt('$10', 1), hoverAt('$10', 2), hoverAt('${10}'), hoverAt('${10}', 2), hoverAt('${10}', 3), hoverAt('$1x', 1), hoverAt('$1x', 2), hoverAt('${2}', 2), hoverAt(' $"', 1)], ['$1', '$1', null, '${10}', '${10}', '${10}', '$1', null, '$2', null], 'hover/caret: unbraced $10 is $1 (its 0 is text), braced ${10} is the tenth')
  for (let i = 0; i < 30; i++) { const s = new DebugSession('bounded'); s.finish(0) }
  eq(debugSessions().length, 16, 'registry remains bounded')
} finally { await vite.close() }
process.exit(failures ? 1 : 0)
