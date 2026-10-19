// Checks aliases and the ~/.mvshrc startup file without a browser: `node scripts/msh-rc.ts`.
//
//   - alias: define, list, show one, remove one (unalias, unalias -a), the errors.
//   - Expansion: the first word of a command, in pipelines and after ; && ||, with the rest of the
//     words after it; not inside quotes; `type`, `command -v` and `which` say what an alias is.
//   - The loop guard: alias ls='ls -l', and a=b with b=a, end instead of looping.
//   - Tab completes alias names.
//   - ~/.mvshrc: runs at the start of a session (aliases, variables, cd), skips comments, names the
//     line of a failing one and still runs the rest, refuses to source itself, can be turned off,
//     and is a normal file for echo >>, cat and ls (kept in this browser while home is read-only).
//
// Exits 1 on any failure.

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
  const { runLine, strip, completions } = (await vite.ssrLoadModule('/src/terminal/commands.ts')) as typeof import('../src/terminal/commands.ts')
  const { HOME } = (await vite.ssrLoadModule('/src/terminal/vfs.ts')) as typeof import('../src/terminal/vfs.ts')
  const { runStartupFile } = (await vite.ssrLoadModule('/src/terminal/startup.ts')) as typeof import('../src/terminal/startup.ts')
  const { aliasesOf } = (await vite.ssrLoadModule('/src/terminal/msh/interp.ts')) as typeof import('../src/terminal/msh/interp.ts')
  const { setTerminalPrefs } = (await vite.ssrLoadModule('/src/terminal/prefs.ts')) as typeof import('../src/terminal/prefs.ts')
  const { writeFile } = (await vite.ssrLoadModule('/src/terminal/fs.ts')) as typeof import('../src/terminal/fs.ts')
  const { loadAccount } = (await vite.ssrLoadModule('/src/os/account.ts')) as typeof import('../src/os/account.ts')
  const { startBrowserFiles } = (await vite.ssrLoadModule('/src/data/browserfs.ts')) as typeof import('../src/data/browserfs.ts')
  await loadAccount()
  startBrowserFiles()

  /** One terminal session: its own environment, so its own aliases. */
  const session = () => {
    const printed: string[] = []
    let cwd = HOME
    const base = {
      args: [],
      stdin: null,
      get cwd() {
        return cwd
      },
      setCwd: (p: string) => void (cwd = p),
      env: { HOME, USER: 'menno' } as Record<string, string>,
      history: [],
      windows: [],
      openApp() {},
      openNewApp() {},
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
    const run = async (line: string) => {
      const results = await runLine(line, base as never)
      return { out: strip(results.map((r) => r.output).join('\n')).replace(/^\n+/, ''), ok: results.every((r) => r.ok) }
    }
    return { env: base.env, printed, cwd: () => cwd, run, out: async (line: string) => (await run(line)).out, start: () => runStartupFile(base as never) }
  }
  const rcFile = (text: string) => writeFile(HOME, '~/.mvshrc'.replace('~', HOME), text, false)

  // --- alias ------------------------------------------------------------------------------------

  {
    const s = session()
    const { out } = s
    eq(await out('alias'), '', 'no aliases: alias lists nothing')
    await out("alias ll='ls -l'")
    await out('alias hi=echo')
    await out("alias say='echo hello world'")
    eq(await out('alias'), "alias hi='echo'\nalias ll='ls -l'\nalias say='echo hello world'", "alias lists them, sorted, as alias name='value'")
    eq(await out('alias ll'), "alias ll='ls -l'", 'alias name shows one')
    const missing = await s.run('alias nope')
    check(!missing.ok && missing.out.includes('alias: nope: not found'), 'alias of an unknown name fails')
    eq(await out('say'), 'hello world', 'an alias runs its value')
    eq(await out('hi there'), 'there', 'the rest of the words follow the alias')
    eq(await out('alias q="echo \'a  b\'"; q'), 'a  b', 'a value with quotes inside keeps them')
    eq(await out('alias q'), "alias q='echo '\\''a  b'\\'''", 'a quote in a value is shown so it can be pasted back')
    await out('unalias q')
    const gone = await s.run('unalias q')
    check(!gone.ok && gone.out.includes('unalias: q: not found'), 'unalias of a missing alias fails')
    eq(await out('type say'), "say is aliased to `echo hello world'", 'type says it is an alias')
    eq(await out('command -v say'), "alias say='echo hello world'", 'command -v shows the alias line')
    eq(await out('which say'), 'say: aliased to echo hello world', 'which says it is an alias')
    eq((await s.run('command say hi')).ok, false, 'command skips aliases (say is not a command)')
    await out('unalias -a')
    eq(await out('alias'), '', 'unalias -a removes all')
    const bad = await s.run('alias a/b=x')
    check(!bad.ok && bad.out.includes('invalid alias name'), 'a name with a slash is refused')
    eq((await s.run('unalias')).ok, false, 'unalias alone is a usage error')
  }

  // --- expansion --------------------------------------------------------------------------------

  {
    const s = session()
    const { out } = s
    await out("alias up='sort -r'; alias e=echo; alias g='grep -i'")
    eq(await out('printf "a\\nb\\n" | up'), 'b\na', 'in a pipeline: the command after | expands')
    eq(await out('e abc | g ABC'), 'abc', 'both commands of a pipeline expand')
    eq(await out('true && e second'), 'second', 'after &&')
    eq(await out('false || e third'), 'third', 'after ||')
    eq(await out('e one; e two'), 'one\ntwo', 'after ;')
    eq(await out('echo e'), 'e', 'only the first word: echo e is not expanded')
    check(!(await s.run('"e" x')).ok, 'a double-quoted first word is not expanded')
    check(!(await s.run("'e' x")).ok, 'a single-quoted first word is not expanded')
    check(!(await s.run('\\e x')).ok, 'a backslashed first word is not expanded')
    check(!(await s.run('/bin/e x')).ok, 'a path is not expanded')
    eq(await out('if e yes; then e ok; fi'), 'yes\nok', 'inside if: condition and body')
    eq(await out('(e sub)'), 'sub', 'in a subshell')
    eq(await out('f() { e in-function; }; f'), 'in-function', 'inside a function body')
    eq(await out('e "quoted e" | g QUOTED'), 'quoted e', 'quotes in the arguments stay one word')
    await out("alias both='e one | g ONE'")
    eq(await out('both'), 'one', 'an alias whose value is a pipeline')
    eq(await out('both > /tmp/rc-both.txt; cat /tmp/rc-both.txt'), 'one', 'a pipeline alias with a redirect')
    await out("alias x='e A;'")
    eq(await out('x e B'), 'A\nB', 'a value ending in ; then more words as the next command')
    eq(await out('FOO=bar e $FOO'), 'bar'.slice(0, 0), 'an assignment before an alias still applies to it (the shell expands $FOO first, so empty)')
    // Scripts do not see aliases, like bash.
    await s.run("echo 'e from-script' > /tmp/rc-script.sh")
    check(!(await s.run('msh /tmp/rc-script.sh')).ok, 'msh script.sh does not expand aliases')
    check(!(await s.run('msh -c "e in-c"')).ok, 'msh -c does not expand aliases')
    const names = [...aliasesOf(s.env).keys()]
    check(names.includes('up'), 'aliasesOf lists the names for completion')
    check(completions('u', HOME, names).items.some((i) => i.value === 'up' && i.hint === 'alias'), 'Tab completes an alias name as a command')
    check(completions('e abc u', HOME, names).items.every((i) => i.hint !== 'alias'), 'not after the first word')
    check(completions('true && u', HOME, names).items.some((i) => i.value === 'up'), 'after && it does')
    check(completions('u', HOME).items.every((i) => i.value !== 'up'), 'a session without it does not offer it')
    eq((await session().run('alias')).out, '', 'aliases belong to one session')
  }

  // --- loops ------------------------------------------------------------------------------------

  {
    const s = session()
    const { out } = s
    await out("alias ls='ls -l'")
    const listed = await out('ls /etc | cat')
    check(listed.length > 0 && !listed.includes('not found'), "alias ls='ls -l' runs ls once, no loop", listed.slice(0, 80))
    await out('alias a=b; alias b=a')
    const loop = await s.run('a')
    check(!loop.ok && loop.out.includes('command not found'), 'a=b and b=a end: command not found', loop.out)
    await out("alias self='self self'")
    check(!(await s.run('self')).ok, 'an alias for itself ends')
    await out("alias echo='echo wrapped'")
    eq(await out('echo x'), 'wrapped x', 'an alias can wrap the command of the same name')
    await out("alias w='w | cat'")
    check((await s.run('w')).out.includes('command not found: w'), 'a pipeline alias that names itself ends: the inner w is the command')
  }

  // --- ~/.mvshrc ---------------------------------------------------------------------------------

  {
    const s = session()
    const { out } = s
    await out('rm -f ~/.mvshrc')
    check(!(await s.run('cat ~/.mvshrc')).ok, 'no ~/.mvshrc to begin with')
    const fresh = session()
    await fresh.start()
    eq(fresh.printed, [], 'no rc: starts silently')

    await out('echo "alias ll=\'ls -l\'" >> ~/.mvshrc')
    await out('echo "alias e=echo" >> ~/.mvshrc')
    eq(await out('cat ~/.mvshrc'), "alias ll='ls -l'\nalias e=echo", 'echo >> builds the file; cat reads it')
    check((await out('ls -a ~')).split(/\s+/).includes('.mvshrc'), 'ls -a shows .mvshrc in home')
    check(!(await out('ls ~')).split(/\s+/).includes('.mvshrc'), 'ls without -a hides it')

    const t = session()
    await t.start()
    eq(t.printed.length, 0, 'a session with a fine rc prints nothing')
    eq(await t.out('alias'), "alias e='echo'\nalias ll='ls -l'", 'the rc ran at the start: its aliases are there')
    eq(await t.out('e works'), 'works', 'and they work')

    // Comments, blank lines, a variable, cd, a failing line in the middle, a multi-line if.
    await rcFile(
      [
        '# my shell',
        '',
        '  # indented comment',
        'export GREETING=hello',
        'cd /tmp',
        "alias say='echo $GREETING'",
        'nosuchcommand --flag',
        'alias after=echo   # still runs',
        'if true; then',
        '  alias multi=echo',
        'fi',
        'echo "unterminated',
      ].join('\n'),
    )
    const u = session()
    await u.start()
    const shown = strip(u.printed.join('\n'))
    check(shown.includes('~/.mvshrc, line 7') && shown.includes('nosuchcommand'), 'a failing line shows its number and the error', shown)
    check(shown.includes('line 12'), 'an unterminated quote is reported with its line number', shown)
    check(!shown.includes('line 4') && !shown.includes('line 6') && !shown.includes('line 8'), 'lines that worked are not mentioned', shown)
    eq(u.cwd(), '/tmp', 'cd in the rc moves the session')
    eq(u.env.GREETING, 'hello', 'export in the rc sets the variable')
    eq([...aliasesOf(u.env).keys()].sort(), ['after', 'multi', 'say'], 'aliases after the failing line and inside a multi-line if exist')
    eq(await u.out('say'), 'hello', "an alias that uses the rc's variable works")

    // An rc that runs itself.
    await rcFile(['alias first=echo', 'source ~/.mvshrc', 'msh ~/.mvshrc', '. ~/.mvshrc', 'alias last=echo'].join('\n'))
    const v = session()
    const started = Date.now()
    await v.start()
    check(Date.now() - started < 3000, 'an rc that sources itself ends quickly', `${Date.now() - started} ms`)
    eq([...aliasesOf(v.env).keys()].sort(), ['first', 'last'], 'the rest of that rc still ran')
    check(strip(v.printed.join('\n')).includes('already running'), 'the self-source is refused with a message', strip(v.printed.join('\n')))
    eq((await v.run('source ~/.mvshrc')).ok, true, 'source ~/.mvshrc by hand, at the prompt, runs it (and its own source line is refused)')

    // Turned off in the terminal settings.
    setTerminalPrefs({ runRc: false })
    const { terminalPrefs } = (await vite.ssrLoadModule('/src/terminal/prefs.ts')) as typeof import('../src/terminal/prefs.ts')
    eq(terminalPrefs().runRc, false, 'the setting turns off (the terminal window checks it before running the rc)')
    setTerminalPrefs({ runRc: true })
    eq(terminalPrefs().runRc, true, 'and on again')

    // Removing it.
    await out('rm ~/.mvshrc')
    check(!(await s.run('cat ~/.mvshrc')).ok, 'rm removes ~/.mvshrc')
    const w = session()
    await w.start()
    eq([...aliasesOf(w.env).keys()], [], 'and the next session has none')

    // Any file can be sourced.
    await out('echo "alias t=echo" > /tmp/other-rc')
    const x = session()
    await x.run('source /tmp/other-rc')
    eq(await x.out('t sourced'), 'sourced', 'source of an ordinary file defines aliases in the session')
    await out('rm -f /tmp/other-rc /tmp/rc-both.txt /tmp/rc-script.sh')
  }
} finally {
  await vite.close()
}
process.exit(failures ? 1 : 0)
