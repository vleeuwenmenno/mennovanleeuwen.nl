// Checks the terminal's commands without a browser: `node scripts/terminal-cmds.ts`.
//
//   - Shell quoting of the paths a drop pastes (src/terminal/words.ts): spaces, quotes, `$`,
//     globs, unicode and the like each come back from msh's parser as exactly one word, the
//     same name.
//   - Whether `open photos` means the app or a folder of that name.
//   - `ls` with several arguments (GNU style: files first, then each folder under `name:`) and
//     `open <app>`, run through the real command table (src/terminal/commands.ts), loaded by Vite
//     the way the site loads it.
//
// Exits 1 on any failure.

import { createServer } from 'vite'
import { parse } from '../src/terminal/msh/parse.ts'
import { meansPath, quotePaths, shellQuote } from '../src/terminal/words.ts'

let failures = 0
const check = (ok: boolean, what: string, detail = '') => {
  if (ok) console.log('PASS', what)
  else {
    failures++
    console.log('FAIL', what, detail)
  }
}
const eq = (got: unknown, want: unknown, what: string) => check(JSON.stringify(got) === JSON.stringify(want), what, `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)

/** What a raw shell word means: single quotes literal, a backslash keeps the next character. */
function unquote(word: string) {
  let out = ''
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "'") {
      const end = word.indexOf("'", i + 1)
      out += word.slice(i + 1, end)
      i = end
    } else if (word[i] === '\\') out += word[++i]
    else out += word[i]
  }
  return out
}
const wordsOf = (line: string) => {
  const tree = parse(line)
  const node = tree.t === 'list' ? tree.items[0].node : tree
  return node.t === 'simple' ? node.words : []
}

// --- quoting -------------------------------------------------------------------------------------

const AWKWARD = [
  '/mnt/seafile/My Library/holiday photos/IMG 001.jpg',
  "/home/menno/it's here.txt",
  '/tmp/$HOME and `date` and $(rm -rf x).txt',
  '/tmp/star * and ? and [a-z].txt',
  '/tmp/naïve café 日本語 🎉.md',
  '/tmp/semi;colon & amp | pipe > redirect < in.txt',
  '/tmp/back\\slash "double" #hash ~tilde.txt',
  '/tmp/plain-name_1.2.txt',
  '/tmp/new\nline.txt',
  '',
]
for (const name of AWKWARD) {
  const words = wordsOf(`cat ${shellQuote(name)}`)
  eq(words.length === 2 ? unquote(words[1]) : words, name, `one word, same name: ${JSON.stringify(name)}`)
}
eq(shellQuote('/tmp/plain-name_1.2.txt'), '/tmp/plain-name_1.2.txt', 'plain paths stay bare')
eq(shellQuote("it's"), `'it'\\''s'`, 'a single quote closes, escapes and reopens')
const all = wordsOf(`cat ${quotePaths(AWKWARD)}`)
eq(all.slice(1).map(unquote), AWKWARD, 'all of them on one line, separated by spaces')
eq(quotePaths([]), '', 'no paths, no text')

// --- app or path ---------------------------------------------------------------------------------

eq(meansPath('photos', false), false, 'photos alone is the app')
eq(meansPath('photos', true), true, 'photos is a folder here: that wins')
eq(meansPath('photos/', false), true, 'a slash means a path')
eq(meansPath('photos.txt', false), true, 'a dot means a path')
eq(meansPath('./photos', false), true, './photos is a path')

// --- the real commands ---------------------------------------------------------------------------

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
  const { runLine, strip } = (await vite.ssrLoadModule('/src/terminal/commands.ts')) as typeof import('../src/terminal/commands.ts')
  const { HOME } = (await vite.ssrLoadModule('/src/terminal/vfs.ts')) as typeof import('../src/terminal/vfs.ts')
  let cwd = HOME
  const opened: string[] = []
  const run = async (text: string) => {
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
      openNewApp: (app: string) => void opened.push(`new ${app}`),
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
    return { out: strip(results.map((r) => r.output).join('\n')), ok: results.every((r) => r.ok) }
  }
  const out = async (line: string) => (await run(line)).out
  const kids = async (dir: string) => (await out(`ls -a ${dir} | cat`)).split('\n')

  const two = await out('ls /etc /srv | cat')
  eq(two, `/etc:\n${(await kids('/etc')).join('\n')}\n\n/srv:\n${(await kids('/srv')).join('\n')}`, 'ls with two folders: a header each, a blank line between')
  eq(await out('ls -a /etc /srv | cat'), two, 'ls -a with two folders: same, with the dot files (none here)')
  const three = await out('ls /etc /srv ~/Documents | cat')
  eq(three.split('\n').filter((l) => l.endsWith(':')), ['/etc:', '/srv:', '~/Documents:'.replace('~', HOME)], 'three folders, three headers (an empty one too)')
  check(!(await out('ls /etc')).includes('/etc:'), 'one folder: no header')
  check(!(await out('ls /etc | cat')).includes('/etc:'), 'one folder: no header in a pipe either')
  const mixed = await out('ls /etc ~/README.md | cat')
  check(mixed.startsWith('README.md\n\n/etc:\n'), 'files named on the line come first, folders after', mixed)
  const partly = await run('ls /etc /nope')
  check(!partly.ok && partly.out.includes("ls: cannot access '/nope'") && partly.out.includes('/etc:\n'), 'a missing one is reported and the others still listed', partly.out)
  check(!(await run('ls /nope')).ok, 'a single missing folder still fails')

  const was = opened.length
  await run('open photos')
  eq(opened.slice(was), ['photos'], 'open photos starts the Photos app')
  await run('photos')
  eq(opened.slice(was + 1), ['photos'], 'photos starts it too')
  for (const [word, app] of [['mail', 'mail'], ['contacts', 'contacts'], ['tasks', 'tasks'], ['calendar', 'calendar']] as const) {
    const n = opened.length
    await run(`open ${word}`)
    eq(opened.slice(n), [app], `open ${word}`)
  }
  const n = opened.length
  await run('open games')
  eq(opened.slice(n), ['new files'], 'a folder called games here wins over the app')
  const helpText = await out('help')
  check(['photos', 'mail', 'contacts', 'tasks'].every((w) => new RegExp(`\\b${w}\\b`).test(helpText)), 'help lists the new apps', helpText)
  const apps = await out('open')
  check(['photos', 'mail', 'contacts', 'tasks'].every((w) => new RegExp(`\\b${w}\\b`).test(apps)), 'open without arguments lists the new apps', apps)
} finally {
  await vite.close()
}
process.exit(failures ? 1 : 0)
