// Checks the agents' terminal tool without a browser: `node scripts/agents-terminal-exec.ts`.
//
//   - Running: a fresh msh per call with nothing carried over but files, the same interpreter as the
//     terminal's, stdout and stderr apart, exit status, duration, an infinite loop and a cancelled run
//     stopped, huge output truncated (and the buffers in between bounded), no host shell.
//   - The first milestone, end to end: a script written, checked with `msh -n`, run, found wrong from its
//     actual stderr and exit code, fixed and run again, all inside the work folder's grant.
//   - Permissions at the resolved operation: redirects, eval, source, nested msh, a command named by a
//     variable, a glob, a script, file commands, find -exec/-delete: read-only calls write nothing,
//     nothing reads or writes outside the work folder, delete / network / steering files need an
//     approved line that names them, and a command with no entry in the policy table does not run.
//   - The second milestone: `help --json` and terminal_capabilities come from the registry `help` and `man`
//     use, name only options a usage line has, and describe this session (limits, grant, mounts).
//   - The two windows (Agents app, agents command) both run calls through the same function.
//
// The work folder here is /tmp (the one writable place without an account); everything else, the site's
// home and /etc, is "outside".
//
// Exits 1 on any failure.

import { readFileSync } from 'node:fs'
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
// No server: the account settles as "signed out".
g.fetch = () => Promise.reject(new Error('offline'))

const vite = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', define: { __APP_VERSION__: '"0.0.0"', __APP_COMMIT__: '"test"', __BUILD_TIME__: '"2026-01-01T00:00:00.000Z"' }, optimizeDeps: { noDiscovery: true, include: [] } })
const load = <T>(path: string) => vite.ssrLoadModule(path) as Promise<T>
try {
  const { commands, runLine, strip } = await load<typeof import('../src/terminal/commands.ts')>('/src/terminal/commands.ts')
  const { HOME } = await load<typeof import('../src/terminal/vfs.ts')>('/src/terminal/vfs.ts')
  const { execute, runInFolder } = await load<typeof import('../src/terminal/agents/exec.ts')>('/src/terminal/agents/exec.ts')
  const { AGENT_LIMITS, Budget } = await load<typeof import('../src/terminal/limits.ts')>('/src/terminal/limits.ts')
  const { EFFECTS } = await load<typeof import('../src/terminal/policy.ts')>('/src/terminal/policy.ts')
  const { SHELL_BUILTINS, MSH_VERSION } = await load<typeof import('../src/terminal/msh/interp.ts')>('/src/terminal/msh/interp.ts')
  const { optionsOf, HELP_GROUPS } = await load<typeof import('../src/terminal/capabilities.ts')>('/src/terminal/capabilities.ts')
  const { lookup } = await load<typeof import('../src/terminal/fs.ts')>('/src/terminal/fs.ts')
  const { terminalGrant, readOnlyCommand } = await load<typeof import('../server/workdir.ts')>('/server/workdir.ts')

  type Grant = Parameters<typeof execute>[2]
  const FOLDER = '/tmp'
  const grantOf = (g: Partial<Grant> = {}): Grant => ({ mode: 'acceptEdits', root: FOLDER, write: true, delete: false, network: false, steering: false, ...g })
  const READONLY = grantOf({ mode: 'default', write: false })
  const approved = (line: string) => ({ ...terminalGrant('default', line, 'approved', true), root: FOLDER })
  const EDITS = grantOf()
  const run = (command: string, grant: Grant = EDITS, limits = AGENT_LIMITS, signal = new AbortController().signal) => execute(command, FOLDER, grant, limits, signal)
  const result = async (command: string, grant?: Grant, limits?: typeof AGENT_LIMITS) => (await run(command, grant, limits)).result!
  const exists = (name: string) => !!lookup(`/tmp/${name}`)
  const text = (name: string) => {
    const n = lookup(`/tmp/${name}`)
    return n?.type === 'file' ? n.content() : null
  }
  const tool = (name: string, args: Record<string, unknown>, grant: Grant = EDITS) => runInFolder({ name, arguments: args, folder: { path: FOLDER, label: FOLDER }, fallbackDir: FOLDER, grant, signal: new AbortController().signal })
  const denied = (r: { stderr: string; exit_code: number }) => r.exit_code !== 0 && /^msh: |: /.test(r.stderr)

  // Combined branch regressions: actual agent entry point, shared limits, no operand I/O.
  const fetchBefore = globalThis.fetch
  const fetched: string[] = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    return new Response(JSON.stringify({ notes: { value: [{ id: 'n', text: 'saved' }] }, events: [], tasks: [] }))
  }
  try {
    eq((await result("jq-safe -nc --arg p /outside '$p'", READONLY)).stdout, '"/outside"', 'jq-safe data operands bypass file preparation under confinement')
    eq(fetched.length, 0, 'jq-safe data arguments cause no Seafile or app requests')
    const dataGrant = { ...READONLY, appDataRead: ['notes'] as const }
    eq((await result("mvl notes | jq-safe -c '.notes | map({text})'", dataGrant)).stdout, '[{"text":"saved"}]', 'agent mvl reads pipe through bounded jq-safe with a resource grant')
    eq(fetched, ['/api/state'], 'mvl fetches only its authenticated resource endpoint')
    const deniedResource = await result('mvl calendar 2026-01-01 2026-01-02', dataGrant)
    check(deniedResource.exit_code === 126 && fetched.length === 1, 'grant cannot read another resource')
    check((await result('mvl notes', { ...READONLY, network: true })).exit_code === 126 && fetched.length === 1, 'broad network permission does not authorize account data')
    check((await tool('terminal', { command: 'mvl notes', appDataRead: ['notes'] }, READONLY)).status === 126, 'tool arguments cannot forge resource grants')
    const info = JSON.parse((await tool('terminal_capabilities', {}, dataGrant)).capabilities!)
    check(info.permissions.appDataRead.includes('notes') && info.commands.find((c: { name: string }) => c.name === 'mvl').available, 'capabilities reflect granted resources')
    const steps = await result("echo '[1,2,3]' | jq-safe 'map(.)'; touch /tmp/jq-after", EDITS, { ...AGENT_LIMITS, maxSteps: 40 })
    check(steps.terminated === 'steps' && !exists('jq-after'), 'jq-safe charges the shared agent step budget and prevents later mutations')
    const output = await result("jq-safe -n --arg x abc '{value:$x}'", READONLY, { ...AGENT_LIMITS, maxTotal: 150 })
    check(output.terminated === 'output', 'jq-safe internal allocations charge shared output budget')
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 10)
    const cancelled = await run("jq-safe -n --argjson x '[" + Array(500).fill('1').join(',') + "]' '$x | map(.)'; touch /tmp/jq-cancel-after", EDITS, AGENT_LIMITS, ctl.signal)
    check(cancelled.result?.terminated === 'cancelled' && !exists('jq-cancel-after'), 'timer-driven cancellation interrupts actual agent jq-safe work')
  } finally { globalThis.fetch = fetchBefore }

  // Review regressions: real command entry points, not source-text assertions.
  const downloadFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('x'.repeat(20_000))
    const network = { ...EDITS, network: true }
    const small = { ...AGENT_LIMITS, maxBuffer: 1000, maxTotal: 10_000 }
    for (const command of ['curl -s', 'curl -s -o /tmp/review-budget-bypass', 'curl -s -o -', 'wget -q', 'wget -q -O-']) {
      const over = await result(`${command} https://example.com/review-download`, network, small)
      check(over.terminated === 'output' && !exists('review-budget-bypass') && !exists('review-download'), `review: bounded stdout/file response: ${command}`, JSON.stringify(over))
    }
    let cancelledBodies = 0
    const streamed = (chunks: Uint8Array[], status = 200) => new Response(new ReadableStream({
      pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close() },
      cancel() { cancelledBodies++ },
    }), { status })
    const bytes = new TextEncoder().encode('café 😀')
    for (const [command, file] of [['curl -s', ''], ['curl -s -o /tmp/review-unicode', 'review-unicode'], ['wget -q -O-', ''], ['wget -q', 'review-unicode-wget']]) {
      globalThis.fetch = async () => streamed([...bytes].map(n => new Uint8Array([n])))
      const r = await result(`${command} https://example.com/review-unicode-wget`, network)
      eq(file ? text(file) : r.stdout, 'café 😀', `split UTF-8 survives streamed ${command}`)
      eq(r.exit_code, 0, `successful download status: ${command}`)
    }
    globalThis.fetch = async () => streamed([new Uint8Array([0xe2]), new Uint8Array([0x28, 0xa1])])
    eq((await result('curl -s https://example.com/invalid-utf8', network)).stdout, '�(�', 'invalid UTF-8 keeps Response.text replacement behavior')
    globalThis.fetch = async () => streamed([new TextEncoder().encode('😀'.repeat(300))])
    check((await result('wget -q https://example.com/review-multibyte', network, small)).terminated === 'output' && !exists('review-multibyte'), 'byte buffer budget applies before UTF-8 decoding')
    globalThis.fetch = async () => streamed(Array.from({ length: 9 }, () => new TextEncoder().encode('x'.repeat(100))))
    check((await result('curl -s -o /tmp/review-total https://example.com/data', network, { ...small, maxTotal: 1200 })).terminated === 'output' && !exists('review-total'), 'decoded text and bytes charge total even when each buffer fits')
    for (const command of ['curl -s -f -o /tmp/review-http-error', 'wget -q']) {
      globalThis.fetch = async () => streamed([new TextEncoder().encode('x'.repeat(20_000))], 500)
      const before = cancelledBodies
      const r = await result(`${command} https://example.com/review-http-error`, network, small)
      check(r.exit_code !== 0 && !exists('review-http-error') && cancelledBodies > before, `HTTP failure discards body without persistence: ${command}`)
    }
    globalThis.fetch = async () => streamed([new TextEncoder().encode('x'.repeat(20_000))], 500)
    check((await result('curl -s -o /tmp/review-error-body https://example.com/data', network, small)).terminated === 'output' && !exists('review-error-body'), 'curl without --fail still bounds error response body')
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('partial')); c.error(new Error('broken stream')) } }))
    check((await result('curl -s -o /tmp/review-stream-error https://example.com/data', network)).exit_code !== 0 && !exists('review-stream-error'), 'stream errors never persist partial files')
    for (const command of ['curl -s -o /tmp/review-abort', 'wget -q']) {
      const ctl = new AbortController()
      globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes); setTimeout(() => ctl.abort(), 5) }, cancel() { cancelledBodies++ } }))
      const before = cancelledBodies
      const r = await run(`${command} https://example.com/review-abort`, network, AGENT_LIMITS, ctl.signal)
      await new Promise(r => setTimeout(r, 0))
      check(r.result?.terminated === 'cancelled' && !exists('review-abort') && cancelledBodies > before, `cancellation releases pending stream and suppresses persistence: ${command}`)
    }
    await result('echo original > /tmp/review-preserved')
    globalThis.fetch = async () => new Response('x'.repeat(20_000))
    await result('curl -s -o /tmp/review-preserved https://example.com/data', network, small)
    eq(text('review-preserved'), 'original', 'failed download preserves existing file content')
    const lateCtl = new AbortController()
    let releaseFetch!: () => void
    const beforeLate = cancelledBodies
    globalThis.fetch = () => new Promise<Response>(resolve => { releaseFetch = () => resolve(streamed([bytes])) })
    const late = run('curl -s -o /tmp/review-late https://example.com/data', network, AGENT_LIMITS, lateCtl.signal)
    while (!releaseFetch) await new Promise(r => setTimeout(r, 0))
    lateCtl.abort(); await late; releaseFetch()
    await new Promise(r => setTimeout(r, 0))
    check(!exists('review-late') && cancelledBodies > beforeLate, 'late fetch completion cancels body without persisting output')
  } finally { globalThis.fetch = downloadFetch }
  for (const [command, expected] of [['basename /outside/file.txt', 'file.txt'], ['dirname /outside/file.txt', '/outside'], ['calc 10 / 2', '5']]) {
    const r = await result(command, READONLY)
    check(r.exit_code === 0 && r.stdout.includes(expected), `review: string operand is not a path: ${command}`, JSON.stringify(r))
  }

  const { fileOperands } = await load<typeof import('../src/terminal/policy.ts')>('/src/terminal/policy.ts')
  for (const [name, args, want] of [
    ['head', ['-n', '2', '--', '/tmp/data'], ['/tmp/data']],
    ['tail', ['--bytes', '+2', '/tmp/data'], ['/tmp/data']],
    ['xxd', ['-pc', '4', '-s', '-2', '/tmp/data'], ['/tmp/data']],
    ['hexdump', ['-n', '4', '-s', '2', '/tmp/data'], ['/tmp/data']],
    ['od', ['-A', 'x', '-t', 'x1', '-N', '4', '/tmp/data'], ['/tmp/data']],
    ['du', ['-d', '2', '/tmp'], ['/tmp']],
    ['find', ['/tmp', '-name', '/outside/pattern'], ['/tmp']],
    ['cat', ['--literal', '-'], ['--literal']],
    ['sort', ['-n', '/tmp/data'], ['/tmp/data']],
    ['chmod', ['-R', '-x', '/tmp/data'], ['/tmp/data']],
  ] as [string, string[], string[]][]) eq(fileOperands(name, args), want, `actual operand semantics: ${name}`)
  for (const command of ['basename /outside/file.txt .txt', 'dirname /outside/file.txt', 'calc 10 / 2', 'units 10 / 2', 'bc 10 / 2', 'printf /outside/value', 'echo /outside/value | cowsay']) {
    const r = await result(command, READONLY)
    check(r.exit_code === 0, `data arguments reach actual command: ${command}`, JSON.stringify(r))
  }

  for (const command of ['du --/../../etc', 'ls --/../../etc', 'tree -/../../etc', 'cat -/../../etc']) {
    check((await result(command, READONLY)).exit_code !== 0, `dash-prefixed real path cannot escape: ${command}`)
  }
  // Cancellation still precedes the data-command preparation fast path.
  const { prepare, actorOf: preparationActor } = await load<typeof import('../src/terminal/fs.ts')>('/src/terminal/fs.ts')
  const stoppedSignal = AbortSignal.abort()
  const { makePolicy: preparationPolicy } = await load<typeof import('../src/terminal/policy.ts')>('/src/terminal/policy.ts')
  for (const command of ['basename', 'calc', 'curl', 'jq-safe', 'mvl']) {
    const actor = preparationActor({ root: false, policy: preparationPolicy(READONLY), budget: new Budget(AGENT_LIMITS), signal: stoppedSignal })
    check(await prepare('/tmp', command, ['/outside/data'], actor).then(() => false, () => true), `prepare checks cancellation before ${command} data early-return`)
  }

  // Round 4: response bodies must be charged even when projected fields are tiny.
  const round4Fetch = globalThis.fetch
  try {
    for (const command of ['whois example.com', 'git log --oneline']) {
      globalThis.fetch = async () => new Response(JSON.stringify(command.startsWith('git') ? [{ sha: 'abcd1234', commit: { message: 'real message', author: { name: 'Ada', date: '2026-01-01' } }, unused: 'x'.repeat(20_000) }] : { ldhName: 'EXAMPLE.COM', unused: 'x'.repeat(20_000) }), { headers: { 'content-type': 'application/json' } })
      const r = await result(command, { ...EDITS, network: true }, { ...AGENT_LIMITS, maxBuffer: 1000, maxTotal: 10_000 })
      check(r.terminated === 'output', `round4: unused network data is bounded before JSON.parse: ${command}`, JSON.stringify(r))
    }
  } finally { globalThis.fetch = round4Fetch }
  const smallBounds = { ...AGENT_LIMITS, maxBuffer: 4096, maxTotal: 10_000 }
  for (const command of ["find . -maxdepth 0 -printf '%500000000p'", 'tree .', 'du -s .', 'figlet -w 500000000 hello', 'pepper --version', 'changelog', 'releases', 'df', 'findmnt', 'lsblk', 'ls -R', 'cp -r a b', 'rm -r a', 'chmod -R +x a']) {
    const r = await result(command, { ...EDITS, network: true, delete: true }, smallBounds)
    check(r.exit_code === 126 && r.terminated === null, `round4: unsupported engine/mode refused before preparation: ${command}`, JSON.stringify(r))
  }
  const filters = ['cat', 'wc', 'grep -F x', 'sort', 'uniq', 'head -c 1', 'tail -c 1', 'xxd', 'hexdump -C', 'od -t x1', 'md5sum', 'sha1sum', 'sha256sum', 'sha384sum', 'sha512sum', 'lolcat', 'cowsay']
  const { writeTmp: seedTmp } = await load<typeof import('../src/terminal/commands.ts')>('/src/terminal/commands.ts')
  seedTmp('/tmp', 'audit-input', 'x'.repeat(200), false)
  for (const command of filters) {
    const file = command === 'cowsay' ? '' : ' /tmp/audit-input'
    const line = command === 'cowsay' ? `cowsay '${'x'.repeat(200)}'` : command + file
    const r = await result(line, EDITS, smallBounds)
    check(r.terminated === 'output', `round4: reserve synchronous text/byte/hash work before transformation: ${command}`, JSON.stringify(r))
  }
  for (const command of ['cat - -', 'wc /tmp/audit-input /tmp/audit-input', 'head -c 1 /tmp/audit-input /tmp/audit-input', 'sha256sum /tmp/audit-input /tmp/audit-input', 'lolcat /tmp/audit-input /tmp/audit-input']) {
    const r = await result(`echo x | ${command}`)
    check(r.exit_code === 126, `round4: repeated inputs cannot multiply arrays: ${command}`, JSON.stringify(r))
  }
  check((await result('seq 1 100000', EDITS, smallBounds)).terminated === 'output', 'round4: seq reserves each retained number')
  check((await result("printf 'abcdefgh' | od -t x1 -t o1 -t c -t d1 -t u1 -t x2 -t o2 -t d2", EDITS, smallBounds)).terminated === 'output', 'round4: od row by format expansion is reserved before formatting')
  const precisionBudget = { ...AGENT_LIMITS, maxBuffer: 100_000, maxTotal: 1500 }
  check((await result("printf '%.*d' nope 1; seq 1 1000", EDITS, precisionBudget)).terminated === 'output', 'round4: invalid printf precision cannot poison cumulative budget with NaN')
  check((await result("printf '%.90000d' 1", EDITS, precisionBudget)).terminated === 'output', 'round4: printf integer precision is charged before padStart')
  for (const command of ['echo ok', 'msh -n /tmp/audit-input', "eval 'echo x'", "alias f='echo x'; f"]) {
    const r = await result(command, EDITS, { ...AGENT_LIMITS, maxBuffer: 8, maxTotal: 1000 })
    check(r.terminated === 'output', `round4: parser/builtin allocations share small budget: ${command}`, JSON.stringify(r))
  }
  seedTmp('/tmp', 'audit-copy', 'copy', false)
  check((await result('cp /tmp/audit-copy /tmp/audit-copy2')).exit_code === 0 && text('audit-copy2') === 'copy', 'round4: bounded local copy remains useful')
  check((await result('mv /tmp/audit-copy /tmp/audit-copy3')).exit_code !== 0 && text('audit-copy') === 'copy' && !exists('audit-copy3'), 'round4: move without delete authority refuses before writing destination')
  check((await result('mv /tmp/audit-copy /tmp/audit-copy3', { ...EDITS, delete: true })).exit_code === 0 && !exists('audit-copy') && text('audit-copy3') === 'copy', 'round4: bounded local move with delete authority works')
  seedTmp('/tmp', 'audit-append', 'y'.repeat(5000), false)
  for (const command of ['echo x >> /tmp/audit-append', 'echo x | tee -a /tmp/audit-append', 'true < /tmp/audit-append', 'source /tmp/audit-append', 'msh /tmp/audit-append']) {
    const r = await result(command, EDITS, smallBounds)
    check(r.terminated === 'output' && text('audit-append')!.length === 5000, `round4: existing content is charged by redirects/scripts/append: ${command}`, JSON.stringify(r))
  }
  for (const [command, expected] of [["printf '00000000: 41\\n' | xxd -r", 'A'], ["echo 6869 | xxd -r -p", 'hi'], ["printf hi | xxd -p", '6869'], ["printf 'a\\nb\\n' | head -n 1", 'a'], ['seq -w 8 10', '08\n09\n10'], ["printf abc | md5sum", '900150983cd24fb0d6963f7d28e17f72  -'], ["printf abc | sha256sum", 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -']]) {
    eq((await result(command)).stdout, expected, `round4: bounded mode keeps real output: ${command}`)
  }
  try {
    for (const command of ['dig example.com', 'host example.com', 'nslookup example.com', 'ping -c 1 example.com']) {
      let requests = 0
      globalThis.fetch = async () => { requests++; return Response.json({ Status: 0, Answer: [], unused: 'x'.repeat(20_000) }) }
      const r = await result(command, { ...EDITS, network: true }, smallBounds)
      check(r.terminated === 'output' && requests <= 3, `round4: DNS helper counts unused JSON and stops fallback: ${command}`, JSON.stringify(r))
    }
    for (const [command, body, expected] of [
      ['whois example.com', { ldhName: 'EXAMPLE.COM' }, 'EXAMPLE.COM'],
      ['git log --oneline', [{ sha: 'abcd1234', commit: { message: 'real message', author: { name: 'Ada', date: '2026-01-01' } } }], 'real message'],
      ['dig +short example.com', { Status: 0, Answer: [{ name: 'example.com.', type: 1, TTL: 60, data: '192.0.2.1' }] }, '192.0.2.1'],
    ] as const) {
      globalThis.fetch = async () => Response.json(body)
      const r = await result(command, { ...EDITS, network: true })
      check(r.exit_code === 0 && r.stdout.includes(expected), `round4: bounded network mode keeps real output: ${command}`, JSON.stringify(r))
    }
    for (const command of ['whois example.com', 'git log --oneline', 'dig example.com']) {
      const ctl = new AbortController()
      let cancelled = false
      globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); setTimeout(() => ctl.abort(), 10) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } })
      const r = (await run(command, { ...EDITS, network: true }, AGENT_LIMITS, ctl.signal)).result!
      check(r.terminated === 'cancelled' && cancelled, `round4: cancellation interrupts JSON body read: ${command}`, JSON.stringify(r))
    }
    for (const status of [200, 500]) {
      globalThis.fetch = async () => new Response('invalid JSON ' + 'é'.repeat(20000), { status, headers: { 'content-type': 'application/json' } })
      const r = await result('dig example.com', { ...EDITS, network: true }, smallBounds)
      check(r.terminated === 'output', `round4: multibyte/malformed DNS response bounded before parsing, HTTP ${status}`)
    }
  } finally { globalThis.fetch = round4Fetch }
  let oversizedArray = false
  const originalPush = Array.prototype.push
  Array.prototype.push = function (...items) { if (this.length >= 1000) oversizedArray = true; return originalPush.apply(this, items) }
  try {
    const r = await result("printf '00100000: 41\\n' | xxd -r", EDITS, { ...AGENT_LIMITS, maxBuffer: 1000, maxTotal: 10_000 })
    check(!oversizedArray && (r.terminated !== null || r.exit_code === 126), 'round4: reverse xxd refuses expansion before allocating sparse offset', JSON.stringify({ oversizedArray, r }))
  } finally { Array.prototype.push = originalPush }
  // --- running ------------------------------------------------------------------------------------

  const out = await result('echo out; echo err >&2')
  eq([out.stdout, out.stderr, out.exit_code, out.terminated], ['out', 'err', 0, null], 'stdout and stderr come back apart, exit 0')
  check(out.duration_ms >= 0 && out.cwd === FOLDER, 'the result carries a duration and the folder it ran in')
  eq((await result('exit 3')).exit_code, 3, 'exit 3 is exit_code 3')
  eq((await result('false')).exit_code, 1, 'false is exit_code 1')
  const missing = await result('ls /tmp/nothing-here-at-all')
  check(missing.exit_code !== 0 && missing.stdout === '' && missing.stderr.includes('nothing-here-at-all'), 'a failing command: status, empty stdout, the error on stderr', JSON.stringify(missing))
  eq((await result('no-such-command-xyz')).exit_code, 127, 'an unknown command is command not found (127)')
  const none = await tool('terminal', { command: '   ' })
  check(none.status === 2, 'an empty command is an error, not a run')

  // Fresh shell each call; files are the only thing that persists.
  await result("x=5; f() { echo in-f; }; alias a=echo; export Y=1; echo kept > /tmp/iso-file.txt")
  const second = await result('echo "x=[$x] Y=[$Y]"; f; a hi; cat /tmp/iso-file.txt; pwd')
  check(second.stdout.includes('x=[] Y=[]') && second.stdout.includes('kept') && /command not found/.test(second.stderr) && second.stdout.endsWith('/tmp'), 'no variable, function, alias or export from the last call; the file it wrote is there', JSON.stringify(second))
  const cdAfter = await result('cd /tmp')
  eq(cdAfter.exit_code, 0, 'cd inside the folder works')

  // The same interpreter as the terminal's: the same script gives the same output.
  const scripts = ['for i in 1 2 3; do echo n$i; done', 'x=$((6*7)); echo "$x ${x}0 ${#x}"', 'case abc in a*) echo yes;; *) echo no;; esac', 'echo "a b" | wc -w', 'f() { echo "[$1]"; }; f one; f "two words"', 'printf "%5s|%-5s|%03d\\n" a b 7', 'if [ 3 -gt 2 ] && [ -z "" ]; then echo ok; fi', 'echo $(echo nested $(echo deep))']
  const terminal = async (line: string) => {
    const printed: string[] = []
    const base = { args: [], stdin: null, cwd: FOLDER, setCwd() {}, env: { HOME, USER: 'menno' } as Record<string, string>, history: [], windows: [], openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent: () => true, print: (t: string) => void printed.push(t), tty: false, live() {}, size: { cols: 80, rows: 24 }, signal: new AbortController().signal, onKey() {} }
    const results = await runLine(line, base as never)
    return strip(results.map((r) => r.output).join('\n')).replace(/^\n+/, '')
  }
  for (const s of scripts) eq((await result(s)).stdout, await terminal(s), `same output as the interactive terminal: ${s}`)

  // Limits.
  const t0 = Date.now()
  const loop = await result('while true; do :; done', EDITS, { ...AGENT_LIMITS, maxSteps: 2000 })
  check(loop.terminated === 'steps' && loop.exit_code === 125 && Date.now() - t0 < 5000, 'an infinite loop stops at the step limit (terminated: steps, 125)', JSON.stringify(loop))
  const slowLoop = await result('while true; do :; done', EDITS, { ...AGENT_LIMITS, timeoutMs: 700 })
  check(slowLoop.terminated === 'timeout' || slowLoop.terminated === 'steps', 'an infinite loop stops at the time limit', JSON.stringify(slowLoop))
  const sleeping = Date.now()
  const slept = await result('sleep 30; echo late', EDITS, { ...AGENT_LIMITS, timeoutMs: 600 })
  check(slept.terminated === 'timeout' && slept.exit_code === 124 && Date.now() - sleeping < 4000 && !slept.stdout.includes('late'), 'sleep 30 is cut at the timeout (terminated: timeout, 124), well before 30 s', JSON.stringify(slept))
  const timeoutArg = await tool('terminal', { command: 'sleep 30', timeout_seconds: 1 })
  check(timeoutArg.result?.terminated === 'timeout' && (timeoutArg.result?.duration_ms ?? 0) < 4000, 'timeout_seconds: 1 stops a 30 s sleep after about a second', JSON.stringify(timeoutArg.result))

  const big = await result('x=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; for i in $(seq 1 3000); do echo $x$x; done')
  check(big.stdout.length <= AGENT_LIMITS.maxOutput && big.truncated.stdout > 0 && big.truncated.stdout + big.stdout.length > 300_000 && big.terminated === null && big.exit_code === 0, 'huge output keeps the head, counts what was cut (truncated.stdout), and the run still ends 0', `${big.stdout.length} ${JSON.stringify(big.truncated)}`)
  const bigErr = await result('x=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; for i in $(seq 1 3000); do echo $x$x >&2; done')
  check(bigErr.stderr.length <= AGENT_LIMITS.maxOutput && bigErr.truncated.stderr > 0 && bigErr.stdout === '', 'stderr is bounded and counted on its own', JSON.stringify(bigErr.truncated))
  const grow = await result('x=aaaaaaaa; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28; do x="$x$x"; done; echo done')
  check(grow.terminated === 'memory' && !grow.stdout.includes('done'), 'a variable doubling every round stops at the variable limit (terminated: memory)', JSON.stringify(grow.terminated))
  const pipeSmall = await result('seq 1 5000 | wc -l', EDITS, { ...AGENT_LIMITS, maxBuffer: 2000 })
  check(pipeSmall.terminated === 'output', 'an intermediate pipe buffer over its limit stops the run', JSON.stringify(pipeSmall))
  const substSmall = await result('x=$(seq 1 5000); echo ${#x}', EDITS, { ...AGENT_LIMITS, maxBuffer: 2000 })
  check(substSmall.terminated === 'output', 'a $(…) buffer over its limit stops the run', JSON.stringify(substSmall))
  const totalSmall = await result('for i in $(seq 1 400); do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done', EDITS, { ...AGENT_LIMITS, maxTotal: 5000 })
  check(totalSmall.terminated === 'output', 'all the text a call writes is bounded too', JSON.stringify(totalSmall.terminated))
  const redirBig = await result('seq 1 5000 > /tmp/redir-big.txt', EDITS, { ...AGENT_LIMITS, maxBuffer: 2000 })
  check(redirBig.terminated === 'output' && !exists('redir-big.txt'), 'a file being redirected into is bounded, and nothing is written once the run is stopped', JSON.stringify(redirBig.terminated))
  const printfWide = await result('printf "%99999999999s" x | wc -c')
  check(printfWide.terminated === 'memory' || (printfWide.exit_code === 0 && Number(printfWide.stdout.trim()) <= 100_001), 'printf cannot ask for a gigabyte of padding', printfWide.stdout.slice(0, 40))
  const fnLoop = await result('f() { ( f ); }; f', EDITS, { ...AGENT_LIMITS, maxSteps: 5000 })
  check(fnLoop.terminated !== null, 'recursion through subshells is bounded by the same budget', JSON.stringify(fnLoop.terminated))

  // Cancellation stops execution, and nothing runs after it.
  const ctl = new AbortController()
  const started = Date.now()
  const cancelled = run('sleep 30; echo after > /tmp/cancel-after.txt', EDITS, AGENT_LIMITS, ctl.signal)
  setTimeout(() => ctl.abort(), 250)
  const c = (await cancelled).result!
  check(c.terminated === 'cancelled' && c.exit_code === 130 && Date.now() - started < 4000 && !exists('cancel-after.txt'), 'a cancelled call stops (terminated: cancelled, 130) and runs nothing after', JSON.stringify(c))
  const ctl2 = new AbortController()
  const c2 = run('while true; do :; done', EDITS, { ...AGENT_LIMITS, maxSteps: 10_000_000 }, ctl2.signal)
  setTimeout(() => ctl2.abort(), 100)
  const c2r = (await c2).result!
  check(c2r.terminated === 'cancelled', 'cancelling a busy loop stops it', JSON.stringify(c2r.terminated))

  // No host shell: every command is msh's own; the names of host tools are not found or refused.
  for (const host of ['bash -c "ls /"', 'python3 -c 1', 'node -e 1', 'sh -c "curl x"']) {
    const r = await result(host)
    check(r.exit_code !== 0 || r.stdout === '' || host.startsWith('bash') || host.startsWith('sh '), `no host shell: ${host} stays inside msh`, JSON.stringify(r))
  }
  eq((await result('python3 -c 1')).exit_code, 127, 'python3 is not a command here')
  check(!/child_process|execSync|spawn\(/.test(readFileSync(new URL('../src/terminal/agents/exec.ts', import.meta.url), 'utf8')), 'the executor has no way to start a host process')

  // --- milestone 1: a script written, checked, run, fixed ---------------------------------------------

  const buggy = ['#!/bin/msh', '# potato-flight-check.sh: is the potato ready for take-off?', 'fail=0', 'check() {', '  if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1: got $2, want $3" >&2; fail=1; fi', '}', 'check arithmetic "$((6 * 7))" 42', 'for part in wings engine; do', '  echo "checking $part"', 'check greeting "$(echo potato)" potato', 'exit $fail', ''].join('\n')
  // The agent's write_file tool wrote it; here the shell stands in for that.
  const put = (name: string, body: string) => run(`printf '%s' '${body.replace(/'/g, `'\\''`)}' > /tmp/${name}`)
  await put('potato-flight-check.sh', buggy)
  check(text('potato-flight-check.sh') === buggy.replace(/\n$/, '') + '\n' || text('potato-flight-check.sh')?.startsWith('#!/bin/msh'), 'the script is in the work folder')
  const syntax = await result('msh -n /tmp/potato-flight-check.sh')
  check(syntax.exit_code === 2 && /potato-flight-check\.sh/.test(syntax.stderr) && syntax.stdout === '', 'msh -n finds the missing `done`: status 2, the message on stderr naming the file', JSON.stringify(syntax))
  check(readOnlyCommand('msh -n /tmp/potato-flight-check.sh') && !readOnlyCommand('msh /tmp/potato-flight-check.sh') && !readOnlyCommand("msh -n -c 'echo x'"), 'the server treats msh -n file as read-only, and running a script as not')
  const fixed = buggy.replace('  echo "checking $part"\n', '  echo "checking $part"\ndone\n')
  await put('potato-flight-check.sh', fixed)
  const syntax2 = await result('msh -n /tmp/potato-flight-check.sh')
  eq([syntax2.exit_code, syntax2.stderr], [0, ''], 'after the fix msh -n is clean')
  const flight = await result('msh /tmp/potato-flight-check.sh')
  check(flight.exit_code === 0 && flight.stdout.includes('ok    arithmetic') && flight.stdout.includes('checking engine') && flight.stdout.includes('ok    greeting') && flight.stderr === '', 'the fixed script runs: its real output, nothing on stderr, exit 0', JSON.stringify(flight))
  const failing = await result('msh /tmp/potato-flight-check.sh', EDITS)
  eq(failing.exit_code, 0, 'a second fresh run gives the same answer')
  await put('potato-bad.sh', fixed.replace('"$((6 * 7))" 42', '"$((6 * 7))" 41'))
  const wrong = await result('msh /tmp/potato-bad.sh')
  check(wrong.exit_code === 1 && wrong.stderr.includes('FAIL  arithmetic: got 42, want 41') && wrong.stdout.includes('checking wings'), 'a failing check shows in the actual stderr and exit code, with the stdout before it', JSON.stringify(wrong))
  const viaPath = await result('chmod +x /tmp/potato-flight-check.sh && /tmp/potato-flight-check.sh')
  check(viaPath.exit_code === 0 && viaPath.stdout.includes('ok    greeting'), 'chmod +x then running it by path works inside the grant too', JSON.stringify(viaPath))
  const readOnlyRun = await result('msh /tmp/potato-flight-check.sh', READONLY)
  check(readOnlyRun.exit_code === 0, 'running a script that writes nothing needs no write grant', JSON.stringify(readOnlyRun))

  // --- permissions at the resolved operation ------------------------------------------------------------

  const before = text('ro.txt')
  for (const [what, line] of [
    ['a redirect', 'echo x > /tmp/ro.txt'],
    ['an append', 'echo x >> /tmp/ro.txt'],
    ['&> and >&', 'echo x &> /tmp/ro.txt'],
    ['a redirect on a group', '{ echo x; } > /tmp/ro.txt'],
    ['a redirect on a loop', 'for i in 1; do echo x; done > /tmp/ro.txt'],
    ['touch', 'touch /tmp/ro.txt'],
    ['tee', 'echo x | tee /tmp/ro.txt'],
    ['cp', 'cp /tmp/iso-file.txt /tmp/ro.txt'],
    ['mv', 'mv /tmp/iso-file.txt /tmp/ro.txt'],
    ['a command named by a variable', 'c=touch; $c /tmp/ro.txt'],
    ['a path built from a variable', 'd=/tmp; n=ro; echo x > $d/$n.txt'],
    ['a glob', 'echo x > /tmp/ro.t[x]t'],
    ['eval', "eval 'echo x > /tmp/ro.txt'"],
    ['eval of a built-up string', 'a=echo; b=x; c="> /tmp/ro.txt"; eval "$a $b $c"'],
    ['nested msh -c', "msh -c 'msh -c \"echo x > /tmp/ro.txt\"'"],
    ['sh and bash', "bash -c 'sh -c \"touch /tmp/ro.txt\"'"],
    ['command', 'command touch /tmp/ro.txt'],
    ['a function', 'f() { echo x > /tmp/ro.txt; }; f'],
    ['a subshell', '( echo x > /tmp/ro.txt )'],
    ['a command substitution', 'echo $(touch /tmp/ro.txt)'],
    ['a pipeline stage', 'echo x | { tee /tmp/ro.txt; }'],
    ['a heredoc into a file', 'cat > /tmp/ro.txt <<EOF\nx\nEOF'],
    ['chmod', 'chmod +x /tmp/iso-file.txt'],
    ['mkdir', 'mkdir /tmp/ro-dir'],
    ['rm', 'rm /tmp/iso-file.txt'],
  ] as const) {
    const r = await result(line, READONLY)
    check(!exists('ro.txt') && !exists('ro-dir') && exists('iso-file.txt') && text('ro.txt') === before && /may not change|steers|outside|not available/.test(r.stderr), `read-only call cannot write through ${what}`, JSON.stringify(r))
  }
  await put('inner-write.sh', 'echo from-script > /tmp/ro.txt\n')
  for (const [what, line] of [['source', 'source /tmp/inner-write.sh'], ['.', '. /tmp/inner-write.sh'], ['msh file', 'msh /tmp/inner-write.sh'], ['a script by path', 'chmod +x /tmp/inner-write.sh; /tmp/inner-write.sh'], ['eval of source', "eval 'source /tmp/inner-write.sh'"], ['a script that sources a script', "echo 'source /tmp/inner-write.sh' > /tmp/outer.sh; msh /tmp/outer.sh"]] as const) {
    const r = await result(line, READONLY)
    check(!exists('ro.txt'), `read-only call cannot write by running a script with ${what}`, JSON.stringify(r))
  }
  const allowed = await result('msh /tmp/inner-write.sh', EDITS)
  check(allowed.exit_code === 0 && text('ro.txt')?.includes('from-script'), 'with a write grant the same script does write, inside the folder', JSON.stringify(allowed))
  await result('rm /tmp/ro.txt', grantOf({ delete: true }))

  // Outside the work folder: neither reads nor writes, whatever the grant.
  for (const [what, line] of [
    ['a redirect into home', `echo x > ${HOME}/x.txt`],
    ['a redirect to ..', 'echo x > ../x.txt'],
    ['cp out', `cp /tmp/iso-file.txt ${HOME}/x.txt`],
    ['touch out', `touch ${HOME}/x.txt`],
    ['a path from a variable', `d=${HOME}; echo x > $d/x.txt`],
    ['eval to home', `eval 'echo x > ${HOME}/x.txt'`],
    ['nested msh to home', `msh -c "echo x > ${HOME}/x.txt"`],
  ] as const) {
    const r = await result(line, grantOf({ delete: true, network: true }))
    check(denied(r) && /outside/.test(r.stderr), `a write grant still cannot write outside the work folder: ${what}`, JSON.stringify(r))
  }
  for (const [what, line] of [
    ['cat a file', `cat ${HOME}/README.md`],
    ['cat /etc', 'cat /etc/fstab'],
    ['a glob over home', `cat ${HOME}/*.md`],
    ['ls /', 'ls /'],
    ['ls ..', 'ls ..'],
    ['ls home', `ls ${HOME}`],
    ['a redirect from a file', `cat < ${HOME}/README.md`],
    ['grep -r', `grep -r a ${HOME}`],
    ['find', 'find / -name x'],
    ['head', `head ${HOME}/README.md`],
    ['wc', 'wc -l /etc/fstab'],
    ['jq', 'jq . /etc/fstab'],
    ['test -f', 'test -f /etc/fstab'],
    ['[ -e ]', '[ -e /etc/fstab ]'],
    ['source', 'source /etc/fstab'],
    ['msh file', 'msh /etc/fstab'],
    ['msh -n file', 'msh -n /etc/fstab'],
    ['cd', 'cd /etc'],
    ['cd with nothing', 'cd'],
    ['cd ~', 'cd ~'],
    ['an absolute script', '/etc/fstab'],
    ['nested', `msh -c "cat ${HOME}/README.md"`],
    ['a variable path', `p=${HOME}; cat $p/README.md`],
    ['eval', `eval 'cat ${HOME}/README.md'`],
  ] as const) {
    const r = await result(line, grantOf({ delete: true, network: true }))
    check(r.exit_code !== 0 && !/Seafile|Welcome|# /.test(r.stdout) && r.stdout === '' && /outside|work folder|not available|unavailable/.test(r.stderr), `a call cannot read outside the work folder: ${what}`, JSON.stringify(r))
  }
  const listed = await result('echo /etc/* ../*; echo /*', EDITS)
  eq(listed.stdout, '/etc/* ../*\n/*', 'a glob outside the work folder expands to nothing: it cannot be used to list what is there')
  check((await result('cat /dev/null; echo ok')).stdout === 'ok', '/dev/null stays usable')
  check((await result('echo hidden > /dev/null; echo ok')).stdout === 'ok', 'writing to /dev/null stays usable')

  // The layers under the shell hold on their own: a command called directly (not through the shell's
  // resolved-command check) still cannot read or write outside the work folder or write without a grant.
  {
    const { makePolicy } = await load<typeof import('../src/terminal/policy.ts')>('/src/terminal/policy.ts')
    const ctx = (policy: ReturnType<typeof makePolicy>, args: string[]) => ({ args, stdin: null, cwd: FOLDER, setCwd() {}, env: {}, history: [], windows: [], openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent: () => true, print() {}, tty: false, live() {}, size: { cols: 80, rows: 24 }, signal: new AbortController().signal, onKey() {}, policy, budget: new Budget(AGENT_LIMITS) }) as never
    const cmds = commands as Record<string, { run: (c: never) => unknown }>
    const asRead = async (name: string, args: string[], policy = makePolicy(EDITS)) => {
      try {
        return String(await cmds[name].run(ctx(policy, args)))
      } catch (e) {
        return `ERR ${(e as Error).message}`
      }
    }
    check(/^ERR .*outside/.test(await asRead('cat', [`${HOME}/README.md`])), 'cat called directly still cannot read outside the work folder (the read funnel checks the policy)')
    check(/^ERR .*outside/.test(await asRead('grep', ['x', '/etc/fstab'])) && /^ERR .*outside/.test(await asRead('wc', ['/etc/fstab'])) && /^ERR .*interactive-only/.test(await asRead('jq', ['.', '/etc/fstab'])), 'grep, wc and jq called directly cannot either')
    for (const [name, args] of [['touch', [`${HOME}/direct.txt`]], ['mkdir', [`${HOME}/direct-dir`]], ['cp', ['/tmp/iso-file.txt', `${HOME}/direct.txt`]], ['mv', ['/tmp/iso-file.txt', `${HOME}/direct.txt`]], ['tee', [`${HOME}/direct.txt`]], ['rm', [`${HOME}/README.md`]], ['chmod', ['+x', `${HOME}/README.md`]]] as [string, string[]][]) {
      const r = await asRead(name, args, makePolicy(grantOf({ delete: true, network: true, steering: true })))
      check(/^ERR .*(outside|work folder)/.test(r) && exists('iso-file.txt'), `${name} called directly cannot write outside the work folder (fs.ts checks the policy)`, r)
    }
    check(/^ERR .*may not change files/.test(await asRead('touch', ['/tmp/direct-ro.txt'], makePolicy(READONLY))) && !exists('direct-ro.txt'), 'touch called directly with a read-only grant writes nothing')
    check(/^ERR .*deleting needs/.test(await asRead('rm', ['/tmp/iso-file.txt'], makePolicy(EDITS))) && exists('iso-file.txt'), 'rm called directly without a delete grant deletes nothing')
  }

  // Delete, network, steering files, anything not in the table.
  await run('echo x > /tmp/del.txt')
  const noDelete = await result('rm /tmp/del.txt', EDITS)
  check(noDelete.exit_code !== 0 && exists('del.txt') && /rm|delet/.test(noDelete.stderr), 'rm needs a grant that names it: refused under plain edits', JSON.stringify(noDelete))
  const viaScript = await result("msh -c 'rm /tmp/del.txt'", approved("msh -c 'rm /tmp/del.txt'"))
  check(exists('del.txt') && viaScript.exit_code !== 0, 'an approved line that only names msh does not give its script the right to rm', JSON.stringify(viaScript))
  const viaEval = await result("eval 'rm /tmp/del.txt'", EDITS)
  check(exists('del.txt') && viaEval.exit_code !== 0, 'eval cannot delete without the grant', JSON.stringify(viaEval))
  const yes = await result('rm /tmp/del.txt', approved('rm /tmp/del.txt'))
  check(yes.exit_code === 0 && !exists('del.txt'), 'an approved line that names rm deletes inside the folder', JSON.stringify(yes))
  const net = await result('curl -s http://example.invalid/')
  check(net.exit_code === 126 && /network/.test(net.stderr), 'the network needs an approved line naming the command', JSON.stringify(net))
  const netScript = await result("msh -c 'curl -s http://example.invalid/'", approved("msh -c 'curl -s http://example.invalid/'"))
  check(netScript.exit_code === 126 || netScript.stderr.includes('network'), 'a script run by an approved line does not get the network unless the line names it', JSON.stringify(netScript))
  eq(['curl', 'ping'].map((n) => terminalGrant('default', `${n} x`, 'approved').network), [true, true], 'an approved line naming curl or ping grants the network')
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.agents', '.claude']) {
    const r = await result(`echo x > /tmp/${name}`, EDITS)
    check(r.exit_code !== 0 && !exists(name) && /steers the agent/.test(r.stderr), `${name} cannot be written by a call that did not name it`, JSON.stringify(r))
  }
  const sneaky = await result('n=AGENT; echo x > /tmp/${n}S.md', approved('n=AGENT; echo x > /tmp/${n}S.md'))
  check(!exists('AGENTS.md') && sneaky.exit_code !== 0, 'a steering file name built from a variable is refused', JSON.stringify(sneaky))
  const named = await result('echo x > /tmp/AGENTS.md', approved('echo x > /tmp/AGENTS.md'))
  check(named.exit_code === 0 && exists('AGENTS.md'), 'an approved line that names AGENTS.md may write it', JSON.stringify(named))
  await run('rm /tmp/AGENTS.md', grantOf({ delete: true, steering: true }))
  for (const line of ['open photos', 'photos', 'nano /tmp/x', 'sudo ls', 'su', 'agents', 'mount', 'htop', 'games', 'watch ls', 'kill 1', 'theme dark', 'reboot', "find /tmp -exec echo {} ';'", 'find /tmp -delete', 'find /tmp -fprint /tmp/x', 'fd -x echo']) {
    const r = await result(line, grantOf({ delete: true, network: true, steering: true }))
    check(r.exit_code === 126 && r.stdout === '', `not for an agent: ${line}`, JSON.stringify(r))
  }
  eq(EFFECTS.sudo, undefined, 'sudo has no entry in the policy table')

  // The policy table covers the registry: a new command is shut out until someone decides.
  const registered = [...new Set([...Object.keys(commands), ...SHELL_BUILTINS])]
  const unlisted = registered.filter((n) => !(n in EFFECTS) && !/^(vtdemo|sudo|su|open|xdg-open|nano|vim|nvim|emacs|:q|ssh|agents|skills|mount|umount|fscrypt|htop|top|btop|cmatrix|watch|kill|killall|theme|settings|startx|logout|shutdown|poweroff|halt|reboot|games|tetris|pacman|snake|minesweeper|breakout|pool|sl|go|files|photos|mail|contacts|tasks|weather|cv|projects|contribs|contributions|recent|stars|heatmap|contact|visited|keys|shortcuts|nautilus)$/.test(n))
  eq(unlisted, [], 'every registered command is either in the policy table or on the list of commands an agent never runs')
  const stale = Object.keys(EFFECTS).filter((n) => !registered.includes(n))
  eq(stale, [], 'the policy table names no command that does not exist')

  // --- milestone 2: capabilities ------------------------------------------------------------------------

  const caps = async (line: string, grant?: Grant) => JSON.parse(strip((await result(line, grant)).stdout))
  const agentCaps = await caps('help --json', READONLY)
  check(agentCaps.shell.version === MSH_VERSION && (await result('msh --version')).stdout.includes(MSH_VERSION), 'the shell version in help --json is the one msh --version prints')
  eq(agentCaps.session.kind, 'agent', 'help --json inside an agent call says it is an agent session')
  eq(agentCaps.limits.timeoutSeconds, AGENT_LIMITS.timeoutMs / 1000, 'it reports the limits the call actually has')
  eq(agentCaps.limits.maxSteps, AGENT_LIMITS.maxSteps, '… the step limit')
  eq([agentCaps.permissions.write, agentCaps.permissions.delete, agentCaps.permissions.network, agentCaps.permissions.steering], [false, false, false, false], 'a read-only call reports that it can write nothing')
  check(/nowhere/.test(agentCaps.filesystem.agent.write) && agentCaps.filesystem.workFolder.path === FOLDER && agentCaps.filesystem.workFolder.writable === false, 'the filesystem section says where it may write (nowhere here) and where the work folder is', JSON.stringify(agentCaps.filesystem.agent))
  const editCaps = await caps('help --json', EDITS)
  check(/inside the work folder only/.test(editCaps.filesystem.agent.write) && editCaps.permissions.write === true, 'with edits allowed it says: inside the work folder only')
  const find = (c: { commands: { name: string }[] }, name: string) => c.commands.find((x) => x.name === name) as Record<string, unknown> & { options: { flag: string }[] }
  eq((find(agentCaps, 'sudo').available), false, 'sudo is reported as not available to this agent')
  eq((find(agentCaps, 'cat').available), true, 'cat is available')
  check(/name it/.test(String(find(agentCaps, 'rm').restriction ?? '')), 'rm is reported with its restriction (needs the approved line to name it)', JSON.stringify(find(agentCaps, 'rm')))
  check(agentCaps.commands.length >= registered.length, 'every command and builtin is listed', `${agentCaps.commands.length} < ${registered.length}`)
  eq(new Set(agentCaps.commands.map((c: { name: string }) => c.name)).size, agentCaps.commands.length, 'no command is listed twice')
  eq(find(agentCaps, 'ls').options.map((o) => o.flag), ['-a', '-l'], 'ls has the options its usage line has: -a and -l, nothing else')
  eq(find(agentCaps, 'grep').options.map((o) => o.flag), ['-i', '-n', '-v', '-c', '-r', '-q', '-w', '-F'], 'grep has exactly its documented options')
  check(!find(agentCaps, 'ls').options.some((o) => ['--color', '-h', '-R', '-t'].includes(o.flag)), 'no Linux flags are invented for ls')
  check(find(agentCaps, 'head').options.some((o) => o.flag === '-n' && (o as { takesValue?: boolean }).takesValue), 'head -n is reported as taking a value')
  eq(find(agentCaps, 'echo').usage, 'echo [text]', 'a command’s usage line is its registry entry')
  // Property: every flag reported is literally in that command's usage text.
  const strays: string[] = []
  for (const c of agentCaps.commands as { name: string; usage: string | null; options: { flag: string }[] }[])
    for (const o of c.options) {
      const letters = o.flag.startsWith('--') ? o.flag : o.flag.slice(1)
      if (!c.usage || !(o.flag.startsWith('--') ? c.usage.includes(letters) : new RegExp(`-[A-Za-z0-9|\\[\\]-]*${letters}`).test(c.usage))) strays.push(`${c.name} ${o.flag}`)
    }
  eq(strays, [], 'every reported option appears in that command’s usage line (none invented)')
  check((await result("printf '%1000s' a b c d e f", EDITS, { ...AGENT_LIMITS, maxBuffer: 5000 })).terminated === 'output', 'printf formatting itself stops before allocating the sixth field')
  eq(optionsOf('tar -t|-x [-vzkO] -f archive [-C dir] [member]...').options.map((o) => o.flag).sort(), ['-C', '-O', '-f', '-k', '-t', '-v', '-x', '-z'], 'a usage with clusters and alternatives gives each flag once')
  eq(optionsOf(undefined), { options: [], complete: false }, 'a command with no usage line lists no options and says so')
  // The human help comes from the same groups the machine view uses.
  const human = (await result('help', EDITS)).stdout
  const visible = Object.keys(commands).filter((n) => !(commands as Record<string, { hidden?: boolean }>)[n].hidden)
  check(visible.every((n) => new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(human)), 'help lists every visible command (the ones no group names go under More)', visible.filter((n) => !new RegExp(`(^|\\s)${n}(\\s|$)`, 'm').test(human)).join(','))
  const groupedInJson = new Map<string, string>(agentCaps.commands.map((c: { name: string; group: string }) => [c.name, c.group]))
  check(HELP_GROUPS.every(([group, names]) => names.filter((n) => groupedInJson.has(n)).every((n) => groupedInJson.get(n) === group || HELP_GROUPS.some(([g2, n2]) => g2 === groupedInJson.get(n) && n2.includes(n)))), 'help --json groups are help’s groups')
  const one = await caps('help --json ls', EDITS)
  check(one.commands.length === 1 && one.commands[0].manual === 'ls --help' || one.commands[0].manual === 'man ls', 'help --json ls answers one command with its manual', JSON.stringify(one.commands.map((c: { manual: string }) => c.manual)))
  const bad = await result('help --json nonsense-cmd')
  check(bad.exit_code !== 0, 'help --json for an unknown command fails')
  // Interactive: no limits, no policy.
  const plain = JSON.parse(await terminal('help --json'))
  check(plain.session.kind === 'interactive' && plain.limits === null && plain.permissions === null && !('available' in plain.commands[0]), 'the same query in the user’s own terminal reports an interactive session: no limits, no grant', JSON.stringify([plain.session.kind, plain.limits, plain.permissions]))
  // The structured tool.
  const cap = await tool('terminal_capabilities', {}, READONLY)
  const capJson = JSON.parse(cap.capabilities ?? 'null')
  check(cap.status === 0 && capJson?.session.kind === 'agent' && capJson.limits.maxSteps === AGENT_LIMITS.maxSteps && capJson.permissions.write === false, 'terminal_capabilities answers this session’s capabilities as JSON')
  check((cap.capabilities ?? '').length < 30_000 && typeof capJson.commands[0].summary === 'string' && Array.isArray(capJson.commands.find((c: { name: string }) => c.name === 'ls').options), `its overview is compact (${(cap.capabilities ?? '').length} chars) and lists each command’s option flags`)
  const capOne = JSON.parse((await tool('terminal_capabilities', { command: 'grep' }, EDITS)).capabilities ?? 'null')
  check(capOne.commands.length === 1 && capOne.commands[0].usage?.startsWith('grep') && capOne.commands[0].options.length === 8, 'terminal_capabilities {command} gives that command in full')
  const capMissing = await tool('terminal_capabilities', { command: 'no-such' }, EDITS)
  check(capMissing.status !== 0 && !capMissing.capabilities, 'terminal_capabilities for an unknown command fails with a message')
  check((capJson.integrations as { id: string }[]).some((i) => i.id === 'seafile') && (capJson.filesystem.mounts as unknown[]).length > 0, 'it lists integrations and mounts')
  eq(capJson.notes.length > 0, true, 'it carries its notes')

  // --- the two windows run calls the same way ---------------------------------------------------------------

  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const app = read('../src/apps/Agents.tsx')
  const tui = read('../src/terminal/agents/app.ts')
  const printMode = read('../src/terminal/agents/index.ts')
  check(app.includes("terminal/agents/exec") && tui.includes("from './exec'") && printMode.includes("from './exec'"), 'the Agents app, the agents command and agents -p all run calls through terminal/agents/exec')
  check(!/runCaptured/.test(app + tui + printMode) && !/runCommand\([^)]*e\.call|runCommand\(this\.ctx, dir, command, this\.turn/.test(tui + printMode), 'none of them runs an agent call another way')
  check(app.includes('claimClientCall') && tui.includes('claimClientCall') && printMode.includes('claimClientCall'), 'each claims a call before running it, so two windows never run it twice')
  const a1 = await tool('terminal', { command: 'echo parity; echo err >&2; exit 4' })
  const a2 = await tool('terminal', { command: 'echo parity; echo err >&2; exit 4' })
  eq([a1.result?.stdout, a1.result?.stderr, a1.result?.exit_code], [a2.result?.stdout, a2.result?.stderr, a2.result?.exit_code], 'the same call gives the same answer however often, and in either window')
  check(a1.output === 'parity\nerr', 'the plain text of an answer is stdout, then stderr', a1.output)
  const cwdCall = await tool('terminal', { command: 'pwd', cwd: '..' })
  check(cwdCall.status !== 0 && /outside/.test(cwdCall.output), 'a cwd outside the work folder is refused')
  const cwdOk = await tool('terminal', { command: 'pwd', cwd: '/tmp' })
  check(cwdOk.result?.stdout === '/tmp' && cwdOk.result?.cwd === '/tmp', 'cwd names the folder the call starts in')

  // Round-two regressions, first run against f958cc5 to reproduce the review findings.
  {
    const previous = g.fetch
    let requests = 0
    g.fetch = async () => { requests++; return new Response('{}', { status: 503 }) }
    const noFolder = grantOf({ root: null, write: false })
    const pathGit = await result('/bin/../bin/git show private-text', noFolder)
    check(pathGit.exit_code === 126 && requests === 0, 'R2 canonical executable cannot bypass network authority', JSON.stringify({ requests, pathGit }))
    const pathTar = await result('/bin/../bin/tar --help', noFolder)
    check(pathTar.exit_code === 126 && pathTar.stdout === '', 'R2 blocked executable cannot bypass policy through help', JSON.stringify(pathTar))
    for (const name of ['calc', 'units', 'bc']) {
      requests = 0
      const r = await result(`${name} 10 EUR in USD`, READONLY)
      check(r.exit_code !== 0 && requests === 0, `R2 ${name} cannot fetch rates without network authority`, JSON.stringify({ requests, r }))
    }
    g.fetch = previous
  }
  {
    const previous = g.fetch
    let requests = 0
    g.fetch = async () => { requests++; return new Response('{}', { status: 503 }) }
    for (const name of ['git', 'changelog', 'releases', 'tar', 'unzip']) {
      for (const path of [`/bin//${name}`, `/bin/./${name}`, `/bin/../bin/${name}`]) {
        for (const prefix of ['', 'command ', 'eval ']) {
          const r = await result(`${prefix}${path} --help`, grantOf({ root: null, write: false }))
          check(r.exit_code === 126 && !r.stdout && requests === 0, `resolved registry identity gates ${prefix}${path}, including help`)
        }
      }
    }
    for (const path of ['./git', '../bin/git']) {
      const r = await execute(path + ' show private-text', '/bin', grantOf({ root: null, write: false }), AGENT_LIMITS, new AbortController().signal)
      check(r.status === 126 && requests === 0, `relative executable ${path} is gated after resolution`)
    }
    eq((await result('/bin/../bin/echo pure', grantOf({ root: null }))).stdout, 'pure', 'canonical resolution preserves useful pure commands')
    for (const command of ['calc 2 + 2', 'units 1 km in m', 'bc 15% of 80']) {
      const r = await result(command, READONLY)
      check(r.exit_code === 0 && requests === 0, `${command} stays useful offline`)
    }
    for (const line of ['calc 10 EUR in USD', "calc '10 EUR in USD'", 'units 10 EUR in USD', 'bc 10 EUR in USD', '/bin/../bin/calc 10 EUR in USD']) {
      check(terminalGrant('default', line, 'approved', true).network, `server grants explicitly approved rate expression: ${line}`)
      check(!readOnlyCommand(line), `server does not classify rate expression as pure: ${line}`)
    }
    g.fetch = previous
  }
  const unknownExecutable = await result('echo opaque > /tmp/opaque-executable; chmod +x /tmp/opaque-executable; /tmp/opaque-executable')
  check(unknownExecutable.exit_code === 126 && unknownExecutable.stderr.includes('authorized registry identity'), 'unknown executable handlers fail closed after the script check')
  const dashPattern = await result("echo '-aaaaaaaaaaaaaaaaaaaaaaaa!' | grep '-(a+)+$'", READONLY, { ...AGENT_LIMITS, timeoutMs: 50 })
  check(dashPattern.exit_code === 126, 'R2 dash-prefixed regex is authorized using the executed pattern', JSON.stringify(dashPattern))
  const heredoc = `x=${'a'.repeat(2000)}; wc -c <<EOF\n${'$x'.repeat(100)}\nEOF`
  const heredocTotal = await result(heredoc, EDITS, { ...AGENT_LIMITS, maxTotal: 10_000 })
  check(heredocTotal.terminated === 'output', 'R2 every expanded heredoc append charges total allocation', JSON.stringify(heredocTotal))

  for (const args of ["'-(a+)+$'", "-- '-(a+)+$'", "'-F(a+)+$'", "-- '-(a+)+$' -F", "-n '-(a+)+$'"]) {
    const r = await result(`echo '-aaaaaaaaaaaaaaaaaaaaaaaa!' | /bin/../bin/grep ${args}`, grantOf({ root: null }), { ...AGENT_LIMITS, timeoutMs: 50 })
    check(r.exit_code === 126, `executed grep parser rejects regex variant ${args}`)
  }
  eq((await result("echo '-(a+)+$' | grep -F -- '-(a+)+$'")).stdout, '-(a+)+$', 'explicit fixed-string dash pattern still works')
  eq((await result("echo '-(a+)+$' | grep '-(a+)+$' -F")).stdout, '-(a+)+$', 'policy and execution agree on trailing letter options')
  const { parseGrepArgs } = await load<typeof import('../src/terminal/grepArgs.ts')>('/src/terminal/grepArgs.ts')
  eq(parseGrepArgs(['--', '/outside', '-F']).files, ['-F'], '-- preserves a dash-prefixed filename instead of changing matching mode')
  for (const expansion of ['$x'.repeat(100), '${x}'.repeat(100), '$(echo "$x")'.repeat(20), '`echo "$x"`'.repeat(20), '$@'.repeat(30), String.raw`\$`.repeat(6000)]) {
    const command = `x=${'a'.repeat(2000)}; set -- "$x" "$x"; wc -c <<EOF\n${expansion}\nEOF`
    const r = await result(command, EDITS, { ...AGENT_LIMITS, maxBuffer: 5000 })
    check(r.terminated === 'output' && !r.stdout, `heredoc allocation bounded for ${expansion.slice(0, 28)}`)
  }
  const quotedDoc = await result(`wc -c <<'EOF'\n${'a'.repeat(6000)}\nEOF`, EDITS, { ...AGENT_LIMITS, maxBuffer: 5000 })
  check(quotedDoc.terminated === 'output', 'literal quoted heredoc also obeys the intermediate-buffer bound')
  eq((await result('x=ok; cat <<EOF\n$x $(echo sub) `echo tick`\nEOF')).stdout, 'ok sub tick', 'small heredoc substitutions remain functional')

  // Regression: patterns are data, not filenames. No accidental directory fetch for /outside.
  eq((await result('echo /outside | grep /outside')).stdout, '/outside', 'grep does not authorize its pattern as a file')
  for (const command of ['tar -xf review.tar -C /outside', 'unzip review.zip -d /outside', 'git show secret-data', 'changelog', 'releases']) {
    let requests = 0
    const previous = g.fetch
    g.fetch = () => { requests++; return Promise.reject(new Error('unexpected request')) }
    const r = await result(command, READONLY)
    g.fetch = previous
    check(r.exit_code !== 0 && requests === 0, `${command}: denied before any request`)
  }
  for (const command of ["echo aaaa | grep '(a+)+$'", "find /tmp -regex '(a+)+$'", "fd -F --regex '(a+)+$'", 'x=aaaa; echo ${x//a*a*a*/x}']) {
    check((await result(command)).exit_code !== 0, `uninterruptible pattern workload refused: ${command}`)
  }
  const fields = await result('x=\"a a a a a a a a a a a a a a a a\"; for i in 1 2 3 4 5 6 7 8 9 10; do x=\"$x $x\"; done; echo $x')
  check(fields.terminated === 'memory', 'field expansion stops incrementally before a giant argument vector is allocated')
  const formatted = await result("printf '%1000s' $(seq 1 1000)", EDITS, { ...AGENT_LIMITS, maxBuffer: 5000 })
  check(formatted.terminated === 'output', 'printf charges each field before padding/concatenation')
  eq(optionsOf('tar -t|-x [-vzkO] -f archive [-C dir] [member]...').options.find((o) => o.flag === '-C')?.takesValue, true, 'tar -C requires a directory value')
  eq(optionsOf('ls [-a] [-l]').complete, false, 'usage-derived option lists never claim completeness')
  const query = JSON.parse((await tool('terminal_capabilities', {}, grantOf({ mode: 'bypass', write: false }))).capabilities!)
  check(query.permissions.write === false && query.sessionRights.write === true && query.sessionRights.writeApproval.includes('not required'), 'capability query authority is distinct from Bypass session rights')

  // Rates: actual fetch boundary, abort propagation, no fallback after cancellation, no
  // borrowing somebody else's unguarded promise, and cached/offline calculations preserved.
  {
    const { loadRates, cachedRates } = await load<typeof import('../src/os/smartcalc.ts')>('/src/os/smartcalc.ts')
    const previous = g.fetch
    const permitted = grantOf({ network: true })
    const tick = () => new Promise((r) => setTimeout(r, 0))
    try {
      for (const name of ['calc', 'units', 'bc']) {
        const requests: { url: string; signal?: AbortSignal | null }[] = []
        let release!: (r: Response) => void
        let entered!: () => void
        const started = new Promise<void>((r) => { entered = r })
        g.fetch = (url: string, init?: RequestInit) => {
          requests.push({ url, signal: init?.signal }); entered()
          return new Promise<Response>((r) => { release = r })
        }
        const task = run(`${name} 10 EUR in USD`, permitted, { ...AGENT_LIMITS, timeoutMs: 100 })
        await started
        const stopped = await task
        release(new Response('{}', { status: 503 })); await tick()
        check(stopped.result?.terminated === 'timeout' && requests.length === 1 && requests[0].signal?.aborted && !cachedRates(), `${name}: timeout aborts API fetch and suppresses later fallbacks/cache writes`)
      }
      let release!: (r: Response) => void
      let entered!: () => void
      const started = new Promise<void>((r) => { entered = r })
      let requests = 0
      g.fetch = () => {
        requests++
        if (requests === 1) { entered(); return new Promise<Response>((r) => { release = r }) }
        return Promise.resolve(new Response('{}', { status: 503 }))
      }
      const spotlight = loadRates()
      await started
      const denied = await result('calc 10 EUR in USD', READONLY, { ...AGENT_LIMITS, timeoutMs: 500 })
      check(denied.exit_code === 126 && denied.terminated === null && requests === 1, 'unapproved calc cannot borrow an in-flight unguarded rate fetch')
      release(new Response('{}', { status: 503 })); await spotlight

      const signals: (AbortSignal | null | undefined)[] = []
      const pending: ((r: Response) => void)[] = []
      let fallbacks!: () => void
      const reachedFallbacks = new Promise<void>((r) => { fallbacks = r })
      g.fetch = (url: string, init?: RequestInit) => {
        signals.push(init?.signal)
        if (url === '/api/fx') return Promise.resolve(new Response('{}', { status: 503 }))
        const response = new Promise<Response>((r) => { pending.push(r) })
        if (pending.length === 2) fallbacks()
        return response
      }
      const ctl = new AbortController()
      const fallbackRun = run('calc 10 EUR in USD', permitted, AGENT_LIMITS, ctl.signal)
      await reachedFallbacks; ctl.abort()
      await fallbackRun
      for (const resolve of pending) resolve(Response.json({ date: '2026-01-01', rates: { EUR: 1, USD: 2 } }))
      await tick()
      check(signals.length === 3 && signals.every((s) => s?.aborted) && !cachedRates(), 'all rate sources receive cancellation; late fallback results cannot populate cache')

      for (const target of ['/api/fx', 'fallback']) {
        requests = 0
        g.fetch = async (url: string) => { requests++; return url === '/api/fx' && target === 'fallback' ? new Response('{}', { status: 503 }) : Response.json({ base: 'EUR', date: '2026-01-01', source: 'fixture', rates: { EUR: 1, USD: 2 }, unused: 'x'.repeat(20_000) }) }
        const r = await result('calc 10 EUR in USD', permitted, smallBounds)
        check(r.terminated === 'output' && !cachedRates() && requests <= 3, `round4: exchange rates ${target} body bounded before parse/cache`, JSON.stringify(r))
      }
      requests = 0
      g.fetch = async () => { requests++; return Response.json({ base: 'EUR', date: '2026-01-01', source: 'fixture', rates: { EUR: 1, USD: 2 } }) }
      const storageGet = fakeStorage.getItem
      fakeStorage.getItem = () => { throw new Error('storage blocked') }
      const calcResult = await result('calc 10 EUR in USD', permitted)
      fakeStorage.getItem = storageGet
      check(calcResult.exit_code === 0 && requests === 1, 'approved rate lookup still calculates successfully with blocked browser storage', JSON.stringify(calcResult))
      for (const name of ['calc', 'units', 'bc']) {
        check((await result(`${name} 10 EUR in USD`, READONLY)).exit_code === 0 && requests === 1, `${name} may use cached rates without network authority or new requests`)
      }
    } finally { g.fetch = previous }
  }

  // Real delayed Seafile requests: release after timeout and verify no mutation is submitted.
  const { loadAccount } = await load<typeof import('../src/os/account.ts')>('/src/os/account.ts')
  const { loadLibraries } = await load<typeof import('../src/data/seafile.ts')>('/src/data/seafile.ts')
  const { setFstab, getFstab } = await load<typeof import('../src/data/mounts.ts')>('/src/data/mounts.ts')
  const { makePolicy } = await load<typeof import('../src/terminal/policy.ts')>('/src/terminal/policy.ts')
  const { transfer, removePath, writeFile, actorOf } = await load<typeof import('../src/terminal/fs.ts')>('/src/terminal/fs.ts')
  const originalFstab = getFstab()
  const previousFetch = g.fetch
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  let hold = false
  let holdLink = false
  const requests: { url: string; method: string }[] = []
  g.fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push({ url: url.href, method: init?.method ?? 'GET' })
    if (url.pathname === '/api/me') return Response.json({ authEnabled: false, user: null, forges: [], seafile: { url: 'https://files.invalid', username: 'test' } })
    if (url.pathname === '/api/seafile/libraries') return Response.json(['repo', 'foreign'].map((id) => ({ id, name: id, permission: 'rw', type: 'mine' })))
    if (url.pathname === '/api/seafile/dir') {
      if (hold) { hold = false; entered?.(); await new Promise<void>((r) => { release = r }) }
      return Response.json({ perm: 'rw', entries: [{ name: '.agents', dir: true, size: 0, mtime: 1 }, { name: '.claude', dir: true, size: 0, mtime: 1 }, { name: 'rules.md', dir: false, size: 4, mtime: 1 }, { name: 'src', dir: true, size: 0, mtime: 1 }, { name: 'AGENTS.md', dir: false, size: 4, mtime: 1 }, { name: 'existing.txt', dir: false, size: 4, mtime: 1 }] })
    }
    if (url.pathname === '/api/seafile/link') {
      if (holdLink) { holdLink = false; entered?.(); await new Promise<void>((r) => { release = r }) }
      return Response.json({ url: 'http://localhost/mock-file' })
    }
    if (url.pathname === '/mock-file') return new Response('data')
    return Response.json({ path: '/late.txt' })
  }
  try {
    await loadAccount()
    await loadLibraries(true)
    setFstab('UUID=repo /review seafile defaults 0 0')
    const sfGrant: Grant = { ...EDITS, root: '/review', backing: { repo: 'repo', path: '/' } }
    hold = true
    const began = new Promise<void>((r) => { entered = r })
    const delayed = execute('touch late.txt', '/review', sfGrant, { ...AGENT_LIMITS, timeoutMs: 100 }, new AbortController().signal)
    await Promise.race([began, new Promise((_, reject) => setTimeout(() => reject(new Error('prepare not reached')), 3000))])
    const stopped = await delayed
    release!()
    await new Promise((r) => setTimeout(r, 80))
    check(stopped.result?.terminated === 'timeout' && !requests.some((r) => r.method === 'POST'), 'delayed preparation released after timeout cannot submit touch POST')
    const actor = actorOf({ budget: new Budget(AGENT_LIMITS), policy: makePolicy({ ...sfGrant, delete: true }), signal: new AbortController().signal })
    await prepare('/review', 'ls', ['src'], actor)
    for (const operation of [() => transfer('copy', '/review', 'src', 'dest', true, actor), () => removePath('/review', 'src', { recursive: true, force: true, dir: false, root: actor })]) {
      let denied = false
      try { await operation() } catch { denied = true }
      check(denied && !requests.some((r) => r.method === 'POST'), 'bulk directory mutation is denied without relying on partial descendant cache')
    }
    const ctl = new AbortController()
    holdLink = true
    const linked = new Promise<void>((r) => { entered = r })
    const write = writeFile('/review', 'existing.txt', 'new', false, actorOf({ budget: new Budget(AGENT_LIMITS), policy: makePolicy(sfGrant), signal: ctl.signal })).catch(() => {})
    await Promise.race([linked, new Promise((_, reject) => setTimeout(() => reject(new Error('update link not reached')), 3000))])
    ctl.abort(); release!(); await write
    check(!requests.some((r) => r.method === 'POST'), 'abort during update-link lookup prevents upload POST')
    // Every Seafile helper reachable from an agent must use the same response boundary,
    // including link metadata, error bodies, successful mutation acknowledgements and caches.
    const sf = await load<typeof import('../src/data/seafile.ts')>('/src/data/seafile.ts')
    const { downloadJson, downloadText } = await load<typeof import('../src/terminal/download.ts')>('/src/terminal/download.ts')
    const { boundedJson } = await load<typeof import('../src/terminal/jq-safe.ts')>('/src/terminal/jq-safe.ts')
    const sfFetch = g.fetch as typeof fetch
    const guardedIo = (budget: InstanceType<typeof Budget>) => {
      const context = { budget, signal: new AbortController().signal, policy: makePolicy(sfGrant) }
      return { signal: context.signal, check: () => { context.signal.throwIfAborted(); if (budget.step()) throw new Error('stopped') }, json: (r: Response) => downloadJson(r, context), text: (r: Response) => downloadText(r, context), snapshot: async (v: unknown) => { await boundedJson(v, context) } }
    }
    const sfPath = 'seafile://repo/existing.txt'
    const sfCases: [string, string, (guard: ReturnType<typeof guardedIo>) => Promise<unknown>][] = [
      ['libraries', '/api/seafile/libraries', guard => sf.loadLibraries(true, guard)],
      ['listing', '/api/seafile/dir', guard => sf.listDir('seafile://repo/audit-listing', 0, guard)],
      ...(['download', 'upload', 'update'] as const).map(op => [`${op} link`, '/api/seafile/link', (guard: ReturnType<typeof guardedIo>) => sf.fileLink(sfPath, op, guard)] as [string, string, (guard: ReturnType<typeof guardedIo>) => Promise<unknown>]),
      ['file text', '/mock-file', guard => sf.readText(sfPath, guard)],
      ['write acknowledgement', '/mock-file', guard => sf.writeText(sfPath, 'ok', guard)],
      ['upload acknowledgement', '/mock-file', guard => sf.uploadBlob('seafile://repo/', 'audit.txt', new Blob(['ok']), guard)],
      ['create acknowledgement', '/api/seafile/file', guard => sf.createFile(sfPath, guard)],
      ['mkdir acknowledgement', '/api/seafile/dir', guard => sf.mkdir('seafile://repo/audit-dir', guard)],
      ['delete acknowledgement', '/api/seafile/delete', guard => sf.deleteItems([sfPath], guard)],
      ['history metadata', '/api/seafile/history', guard => sf.historyDays('repo', guard)],
    ]
    for (const [name, target, operation] of sfCases) {
      for (const status of [200, 500]) {
        g.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => new URL(String(input), 'http://localhost').pathname === target ? Promise.resolve(new Response(JSON.stringify({ unused: 'x'.repeat(20_000) }), { status })) : sfFetch(input, init)
        const budget = new Budget(smallBounds)
        let failed = false
        try { await operation(guardedIo(budget)) } catch { failed = true }
        check(failed && budget.stopped === 'output', `round4: Seafile ${name} streams before parse/retention (HTTP ${status})`, JSON.stringify({ failed, stopped: budget.stopped }))
      }
    }
    g.fetch = sfFetch
    const cacheBudget = new Budget({ ...AGENT_LIMITS, maxBuffer: 100, maxTotal: 1000 })
    await sf.loadLibraries(false, guardedIo(cacheBudget)).catch(() => {})
    check(cacheBudget.stopped !== null, 'round4: existing Seafile library cache is charged before use')
    const prepared = await execute('pwd', '/review', sfGrant, { ...AGENT_LIMITS, maxBuffer: 100, maxTotal: 1000 }, new AbortController().signal, '.')
    check(prepared.result?.terminated !== null && prepared.status === 125, 'round4: cwd preparation budget failures keep structured termination', JSON.stringify(prepared))
    const read = await execute('cat existing.txt', '/review', sfGrant, AGENT_LIMITS, new AbortController().signal)
    check(read.status === 0 && read.result?.stdout === 'data', 'round4: guarded Seafile file read still works', JSON.stringify(read))
    setFstab('UUID=repo /review seafile defaults 0 0\n/review/.agents /review/innocent none bind 0 0')
    const steeringAlias = makePolicy(sfGrant)
    check(!!steeringAlias.write('/review/innocent/rules.md'), 'R2 steering protection follows backing identity through a bind alias')
    requests.length = 0
    const aliasWrite = await execute('echo injected > innocent/rules.md', '/review', sfGrant, AGENT_LIMITS, new AbortController().signal)
    check(aliasWrite.status !== 0 && !requests.some((r) => r.method === 'POST'), 'bind alias steering write is refused before any mutation request')
    setFstab('UUID=repo /review seafile defaults 0 0\n/review/.agents /review/innocent none bind 0 0\n/review/innocent /review/second none bind 0 0\n/review/AGENTS.md /review/ordinary.txt none bind 0 0\n/review/.claude /review/other none bind 0 0')
    for (const target of ['/review/second/rules.md', '/review/ordinary.txt', '/review/other/rules.md']) {
      check(!!steeringAlias.write(target), `backing steering check follows alias ${target}`)
      check(makePolicy({ ...sfGrant, steering: true }).write(target) === null, `fresh steering authority still permits ${target}`)
    }
    setFstab('UUID=repo /review seafile defaults 0 0\n/bin /review/tools none bind 0 0')
    requests.length = 0
    const boundExec = await execute('/review/tools/git show private-text', '/review', { ...sfGrant, root: null }, AGENT_LIMITS, new AbortController().signal)
    check(boundExec.status === 126 && requests.length === 0, 'registry identity gates executables reached through bind mounts before preparation')

    setFstab('UUID=repo /review seafile defaults 0 0')
    const frozen = makePolicy(sfGrant)
    setFstab('UUID=repo /review seafile defaults 0 0\nUUID=foreign /review/foreign seafile defaults 0 0')
    check(!!frozen.read('/review/foreign/private') && !!frozen.write('/review/foreign/new') && !!frozen.tree('/review'), 'nested foreign mount cannot inherit lexical workdir rights, including traversal')
    setFstab('UUID=repo /review seafile defaults 0 0\n/review/outside /review/project/foreign none bind 0 0')
    const bound = makePolicy({ ...sfGrant, root: '/review/project', backing: { repo: 'repo', path: '/project' } })
    check(!!bound.read('/review/project/foreign/secret'), 'same-repo bind mount cannot escape authorized backing path')
    setFstab('UUID=repo /review seafile defaults 0 0')
    requests.length = 0
    await execute('ls .', '/review/project', { ...sfGrant, root: '/review/project', backing: { repo: 'repo', path: '/project' } }, AGENT_LIMITS, new AbortController().signal)
    check(requests.every((r) => new URL(r.url).searchParams.get('p') !== '/'), 'preparing the work folder never requests its unauthorized parent listing')
  } finally { setFstab(originalFstab); g.fetch = previousFetch }

  // Shared executor tests use actual claim promises and the real shell, not source-string checks.
  const { ClientCalls } = await load<typeof import('../src/terminal/agents/lifecycle.ts')>('/src/terminal/agents/lifecycle.ts')
  for (const action of ['stop', 'close', 'switch', 'clientDone'] as const) {
    const calls = new ClientCalls()
    calls.select('a')
    let resolveClaim!: (mine: boolean) => void
    let ran = 0, delivered = 0
    const pending = calls.run('call', () => new Promise((r) => { resolveClaim = r }), async () => { ran++; return 1 }, async () => { delivered++ })
    if (action === 'switch') calls.select('b')
    else if (action === 'clientDone') calls.done('call')
    else calls[action]()
    resolveClaim(true); await pending
    eq([ran, delivered], [0, 0], `${action} during pending claim prevents late execution`)
  }
  const calls = new ClientCalls()
  let running!: () => void
  const began = new Promise<void>((r) => { running = r })
  const active = calls.run('active', async () => true, async (signal) => { running(); return run('sleep 30; touch lifecycle-late', EDITS, AGENT_LIMITS, signal) }, async () => { throw new Error('cancelled result delivered') })
  await began; calls.done('active'); await active
  check(!exists('lifecycle-late'), 'clientDone aborts real in-flight shell execution')
} finally {
  await vite.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
