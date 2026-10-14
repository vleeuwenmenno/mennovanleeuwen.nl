// Checks the terminal's commands without a browser: `node scripts/terminal-cmds.ts`.
//
//   - Shell quoting of the paths a drop pastes (src/terminal/words.ts): spaces, quotes, `$`,
//     globs, unicode and the like each come back from msh's parser as exactly one word, the
//     same name.
//   - Whether `open photos` means the app or a folder of that name.
//   - The /dev devices and the byte commands: /dev/urandom, /dev/zero and /dev/null, the disks that
//     refuse to be read, `ls -l /dev`, `open /dev/seafile/<library>`, `head -c`, `tail -c`, `xxd`,
//     `hexdump -C`, `od`, and bytes that pass through pipes intact (src/terminal/bytes.ts).
//   - `ls` with several arguments (GNU style: files first, then each folder under `name:`) and
//     `open <app>`, run through the real command table (src/terminal/commands.ts), loaded by Vite
//     the way the site loads it.
//   - cmatrix: its flags, its usage, refusing a pipe, quitting on q, Esc, Ctrl+C and (with -s)
//     any key, and the rain itself staying inside its grid through resizes.
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

  // --- /dev and bytes ---------------------------------------------------------------------------

  const sp = (n: number) => ' '.repeat(n)
  const hexOf = async (line: string) => (await out(`${line} | xxd -p`)).replace(/\n/g, '')
  const urandom = await out('head -c 16 /dev/urandom | xxd')
  check(/^00000000: (?:[0-9a-f]{4} ){7}[0-9a-f]{4} {2}.{16}$/.test(urandom), 'head -c 16 /dev/urandom | xxd: one line, 16 bytes', urandom)
  eq(await out('head -c 4 /dev/zero | xxd -p'), '00000000', 'head -c 4 /dev/zero | xxd -p')
  eq(await out("printf 'hello\\n' | xxd"), `00000000: 6865 6c6c 6f0a${sp(27)}hello.`, "printf 'hello\\n' | xxd: the classic line")
  eq(await out('echo é | xxd -p'), 'c3a90a', 'echo é | xxd -p: UTF-8 bytes, like Linux')
  eq(await out('echo é | xxd'), `00000000: c3a9 0a${sp(34)}...`, 'echo é | xxd: the dump')
  eq(await out("printf 'hi' | xxd -p"), '6869', "printf 'hi' | xxd -p: no newline added")
  eq(await out("printf 'hello\\n' | xxd -l 2 -s 1"), `00000001: 656c${sp(37)}el`, 'xxd -l 2 -s 1: two bytes from offset 1, shown at offset 1')
  eq(await out("printf 'hello\\n' | xxd -s -2 -p"), '6f0a', 'xxd -s -2: counts from the end')
  eq(await out("printf 'abc' | xxd -g 1"), `00000000: 61 62 63${sp(41)}abc`, 'xxd -g 1: groups of one byte')
  eq(await out("printf 'abc' | xxd -g 0"), `00000000: 616263${sp(27)}abc`, 'xxd -g 0: no groups')
  eq(await out("printf 'abcde' | xxd -c 2"), '00000000: 6162  ab\n00000002: 6364  cd\n00000004: 65    e', 'xxd -c 2: two bytes to a line')
  eq(await out("printf 'abcde' | xxd -p -c 2"), '6162\n6364\n65', 'xxd -p -c 2')
  eq(await out("printf '\\xab\\xcd' | xxd -u -p"), 'ABCD', 'xxd -u -p: upper case digits')
  eq(await out("printf '\\xab\\xcd' | xxd -u"), `00000000: ABCD${sp(37)}..`, 'xxd -u: dump')
  eq(await out("printf 'hello\\n' | xxd -p | xxd -r -p | xxd -p"), '68656c6c6f0a', 'xxd -p | xxd -r -p round trip')
  eq(await out("printf 'hello\\n' | xxd | xxd -r | xxd -p"), '68656c6c6f0a', 'xxd | xxd -r round trip (a full dump)')
  eq(await out('echo 68690a | xxd -r -p'), 'hi', 'xxd -r -p: plain hex to text')
  eq((await out('head -c 300 /dev/urandom | xxd -p | xxd -r -p | wc -c')).trim(), '300', '300 random bytes survive xxd -p | xxd -r -p')
  eq((await out('head -c 300 /dev/urandom | xxd | xxd -r | wc -c')).trim(), '300', '300 random bytes survive xxd | xxd -r')
  eq(await out("printf '\\xc3\\xa9' | xxd -p"), 'c3a9', "printf '\\xc3\\xa9': two bytes that spell é")
  eq(await out("printf '\\xc3\\xa9'"), 'é', "printf '\\xc3\\xa9' shows é")
  eq(await out("printf '\\xff\\xfe\\x00' | xxd -p"), 'fffe00', 'bytes that are not UTF-8, and a NUL, go through a pipe')
  eq(await out("printf '\\xff' | sha256sum"), 'a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89  -', 'sha256sum sees the byte, not a replacement character')
  eq((await out("printf 'é' | wc -c")).trim(), '2', 'wc -c counts bytes')
  eq((await out('cat /dev/zero | wc -c')).trim(), '65536', 'cat /dev/zero stops at 64 KiB')
  eq((await out('cat /dev/urandom | wc -c')).trim(), '65536', 'cat /dev/urandom stops at 64 KiB, byte for byte')
  eq((await out('head -c 70000 /dev/zero | wc -c')).trim(), '65536', 'a read of a device is capped at 64 KiB')
  eq(await out('head -c 100 /dev/zero | xxd -p -c 100'), '0'.repeat(200), '/dev/zero is all zeros')
  check((await out('head -c 64 /dev/urandom | xxd -p')) !== (await out('head -c 64 /dev/urandom | xxd -p')), '/dev/urandom differs from read to read')
  check((await hexOf('head -c 64 /dev/random')).length === 128, '/dev/random gives bytes too')
  eq(await out('cat /dev/null'), '', 'cat /dev/null: nothing')
  check((await run('cat /dev/null')).ok, 'cat /dev/null succeeds')
  eq((await out('echo hi | cat /dev/null | wc -c')).trim(), '0', '/dev/null reads as empty')

  // On the screen: bounded, with nothing that breaks the line view.
  const screen = await run('cat /dev/urandom')
  check(screen.ok && !/[\ud800-\udfff\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(screen.printed.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')) && screen.printed.length > 1000, 'cat /dev/urandom on the screen: bounded, no escapes or control characters', JSON.stringify(screen.printed.slice(0, 60)))
  eq((await run('cat /dev/zero')).printed, '', 'cat /dev/zero on the screen shows nothing')

  // The disks refuse.
  for (const dev of ['/dev/nvme0n1', '/dev/nvme0n1p1', '/dev/nvme0n1p2']) {
    for (const cmd of ['cat', 'head -c 4', 'tail -c 4', 'xxd', 'wc -c', 'grep x']) {
      const r = await run(`${cmd} ${dev}`)
      check(!r.ok && r.out === `${cmd.split(' ')[0]}: ${dev}: Permission denied`, `${cmd} ${dev}: Permission denied`, r.out)
    }
  }
  const denied = await run('cat < /dev/nvme0n1')
  check(!denied.ok && denied.out.includes('/dev/nvme0n1: Permission denied'), 'cat < /dev/nvme0n1: Permission denied', denied.out)
  const rooted = await run('cat /dev/nvme0n1', true)
  check(!rooted.ok && rooted.out.startsWith('cat: /dev/nvme0n1: No such device or address'), 'cat as root: still refused, with a reason', rooted.out)
  check((await run('echo hi > /dev/null')).ok && (await run('echo hi > /dev/zero')).ok && (await run('echo hi > /dev/urandom')).ok, 'writes to /dev/null, zero and urandom are swallowed')
  const refused = await run('echo hi > /dev/nvme0n1')
  check(!refused.ok && refused.out.includes('/dev/nvme0n1: Permission denied'), 'echo hi > /dev/nvme0n1: Permission denied', refused.out)
  check(!(await run('echo hi | tee /dev/nvme0n1p1')).ok, 'tee to a disk is refused')
  eq((await run('grep -r zzzz /dev')).out, '', 'grep -r over /dev skips the devices')

  // The Seafile libraries as devices (the libraries themselves are mocked: slug and id).
  dynamic.devices = () => [
    { slug: 'my-library', repo: 'repo-1' },
    { slug: 'photos', repo: 'repo-2' },
  ]
  const seaf = await run('cat /dev/seafile/photos')
  check(!seaf.ok && seaf.out === 'cat: /dev/seafile/photos: Permission denied', 'cat /dev/seafile/photos: Permission denied', seaf.out)
  check((await run('cat /dev/seafile/photos', true)).out.includes('Operation not supported'), 'a library device as root: not supported')

  // ls -l /dev
  const long = (await out('ls -l /dev')).split('\n')
  const row = (name: string) => long.find((l) => l.endsWith(`  ${name}`) || l.endsWith(`  ${name}/`)) ?? ''
  const want: [string, RegExp][] = [
    ['null', /^crw-rw-rw-\s.* 1, 3 {2}null$/],
    ['zero', /^crw-rw-rw-\s.* 1, 5 {2}zero$/],
    ['random', /^crw-rw-rw-\s.* 1, 8 {2}random$/],
    ['urandom', /^crw-rw-rw-\s.* 1, 9 {2}urandom$/],
    ['nvme0n1', /^brw-rw----\s.* 259, 0 {2}nvme0n1$/],
    ['nvme0n1p1', /^brw-rw----\s.* 259, 1 {2}nvme0n1p1$/],
    ['nvme0n1p2', /^brw-rw----\s.* 259, 2 {2}nvme0n1p2$/],
    ['seafile', /^dr-xr-xr-x\s/],
  ]
  for (const [name, re] of want) check(re.test(row(name)), `ls -l /dev: ${name}`, JSON.stringify(row(name)))
  const seafLong = (await out('ls -l /dev/seafile')).split('\n')
  check(/^brw-rw----\s.* 252, 0 {2}my-library$/.test(seafLong[0]) && /^brw-rw----\s.* 252, 1 {2}photos$/.test(seafLong[1]), 'ls -l /dev/seafile: block devices numbered like lsblk', seafLong.join('|'))
  check(/^crw-rw-rw-\s.* 1, 3 {2}null$/.test(await out('ls -l /dev/null')), 'ls -l /dev/null: one device named on the line')
  check(/^-r--r--r--\s+root\s+5\s+hostname$/.test(await out('ls -l /etc/hostname')), 'ls -l of a plain file is unchanged')
  eq((await out('find /dev -type c')).split('\n').sort(), ['/dev/null', '/dev/random', '/dev/urandom', '/dev/zero'], 'find /dev -type c')
  eq((await out('find /dev -type b')).split('\n').sort(), ['/dev/nvme0n1', '/dev/nvme0n1p1', '/dev/nvme0n1p2', '/dev/seafile/my-library', '/dev/seafile/photos'], 'find /dev -type b')
  eq(await out('find /dev -type f'), '', 'find /dev -type f: devices are not regular files')

  // open
  {
    const n = opened.length
    const r = await run('open /dev/seafile/photos')
    check(r.ok && opened.slice(n).join() === 'new files' && openedProps?.path === 'seafile://repo-2', 'open /dev/seafile/photos opens that library in Files', `${opened.slice(n)} ${JSON.stringify(openedProps)}`)
    const m = opened.length
    for (const [dev, why] of [['/dev/null', 'swallows'], ['/dev/urandom', 'stream of bytes'], ['/dev/nvme0n1', 'not a document']] as const) {
      const x = await run(`open ${dev}`)
      check(!x.ok && x.out.startsWith(`open: ${dev}: `) && x.out.includes(why), `open ${dev} says why not`, x.out)
    }
    check(opened.length === m, 'open on the other devices opens nothing')
    check(!(await run('open /dev/seafile/nope')).ok, 'open /dev/seafile/<unknown> fails')
  }

  // head and tail
  const six = "printf 'hello\\n'"
  eq(await out(`${six} | head -c 3`), 'hel', 'head -c 3')
  eq(await out(`${six} | head -c3`), 'hel', 'head -c3')
  eq(await out(`${six} | head --bytes=3`), 'hel', 'head --bytes=3')
  eq(await out(`${six} | head --bytes 3`), 'hel', 'head --bytes 3')
  eq(await hexOf(`${six} | head -c -2`), '68656c6c', 'head -c -2: all but the last two bytes')
  eq(await hexOf(`${six} | head -c 0`), '', 'head -c 0')
  eq(await hexOf(`${six} | head -c 1K`), '68656c6c6f0a', 'head -c 1K: units')
  eq(await out(`${six} | tail -c 3`), 'lo', 'tail -c 3 (the newline is the last byte)')
  eq(await hexOf(`${six} | tail -c 3`), '6c6f0a', 'tail -c 3: bytes')
  eq(await hexOf(`${six} | tail -c +3`), '6c6c6f0a', 'tail -c +3: from the third byte')
  eq(await hexOf(`${six} | tail --bytes=2`), '6f0a', 'tail --bytes=2')
  eq(await hexOf(`${six} | tail -c2`), '6f0a', 'tail -c2')
  eq(await hexOf('head -c 20 /dev/zero | tail -c 4'), '00000000', 'tail -c 4 of a pipe')
  eq(await hexOf('tail -c 4 /dev/zero'), '00000000', 'tail -c 4 /dev/zero: on a file argument')
  const abc = "printf 'a\\nb\\nc\\n'"
  eq(await out(`${abc} | head -n 2`), 'a\nb', 'head -n 2 unchanged')
  eq(await out(`${abc} | head -2`), 'a\nb', 'head -2 unchanged')
  eq(await out(`${abc} | head -n2`), 'a\nb', 'head -n2')
  eq(await out(`${abc} | head --lines=1`), 'a', 'head --lines=1')
  eq(await out(`${abc} | head -n -1`), 'a\nb', 'head -n -1: all but the last line')
  eq(await out(`${abc} | head`), 'a\nb\nc', 'head with no count: ten lines')
  eq(await out(`${abc} | tail -n 2`), 'b\nc', 'tail -n 2 unchanged')
  eq(await out(`${abc} | tail -2`), 'b\nc', 'tail -2 unchanged')
  eq(await out(`${abc} | tail -n +2`), 'b\nc', 'tail -n +2: from the second line')
  eq(await out(`${abc} | tail -n 0`), '', 'tail -n 0: nothing')
  eq(await out('head -n 1 /etc/hostname /etc/motd'), '==> /etc/hostname <==\nmvlos\n\n==> /etc/motd <==\nWelcome to MvL OS. Nothing in here can hurt you, or me.', 'head over two files: headers')
  eq(await out('head -q -n 1 /etc/hostname /etc/motd'), 'mvlos\nWelcome to MvL OS. Nothing in here can hurt you, or me.', 'head -q: no headers')
  check((await run('head -c x /etc/hostname')).out.includes('invalid number of bytes'), 'head -c x: invalid number')
  check(!(await run('head -z /etc/hostname')).ok, 'head: an unknown option fails')
  eq(await out('cat /etc/hostname /etc/hostname'), 'mvlosmvlos', 'cat joins files with nothing between them')
  eq(await hexOf(`${six} | cat -`), '68656c6c6f0a', 'cat - reads stdin')

  // hexdump and od
  eq(await out(`${six} | hexdump -C`), `00000000  ${'68 65 6c 6c 6f 0a'.padEnd(23)}  ${sp(23)}  |hello.|\n00000006`, 'hexdump -C')
  eq(await out('head -c 64 /dev/zero | hexdump -C'), `00000000  ${Array(8).fill('00').join(' ')}  ${Array(8).fill('00').join(' ')}  |................|\n*\n00000040`, 'hexdump -C folds repeated lines into a *')
  eq(await out(`${six} | od -An -tx1`), ' 68 65 6c 6c 6f 0a', 'od -An -tx1')
  eq(await out(`${six} | od -An -tu1 -N 2`), ' 104 101', 'od -An -tu1 -N 2')
  eq(await out(`${six} | od -An -c`), '   h   e   l   l   o  \\n', 'od -An -c')
  eq(await out(`${six} | od -A x -t x1`), '000000 68 65 6c 6c 6f 0a\n000006', 'od -A x -t x1')

  // help and Tab
  check((await out('help')).includes('xxd'), 'help lists xxd')
  check((await out('man xxd')).includes('hex dump'), 'man xxd')
  check((await out('xxd --help')).includes('hex dump'), 'xxd --help')
  const { completions } = (await vite.ssrLoadModule('/src/terminal/commands.ts')) as typeof import('../src/terminal/commands.ts')
  check(completions('xx', HOME).items.some((i) => i.value === 'xxd'), 'Tab completes xxd')
  check(completions('xxd -', HOME).items.some((i) => i.value === '-p'), 'Tab completes the options of xxd')

  // --- cmatrix ------------------------------------------------------------------------------------

  const mx = (await vite.ssrLoadModule('/src/terminal/cmatrix.ts')) as typeof import('../src/terminal/cmatrix.ts')
  const opts = (line: string) => {
    const o = mx.parseMatrixArgs(line.split(' ').filter(Boolean))
    return [o.ascii, o.color, o.rainbow, o.speed, o.screensaver, o.help]
  }
  eq(opts(''), [false, 'green', false, 4, false, false], 'cmatrix: katakana, green, speed 4 by default')
  eq(opts('-a'), [true, 'green', false, 4, false, false], 'cmatrix -a: ascii')
  eq(opts('-a -k'), [false, 'green', false, 4, false, false], 'cmatrix -a -k: katakana again')
  eq(opts('-ars'), [true, 'green', true, 4, true, false], 'cmatrix -ars: flags cluster')
  eq(opts('-u 7'), [false, 'green', false, 7, false, false], 'cmatrix -u 7')
  eq(opts('-u0'), [false, 'green', false, 0, false, false], 'cmatrix -u0')
  eq(opts('-C red'), [false, 'red', false, 4, false, false], 'cmatrix -C red')
  eq(opts('-sCcyan'), [false, 'cyan', false, 4, true, false], 'cmatrix -sCcyan')
  eq(opts('-C Blue -r'), [false, 'blue', true, 4, false, false], 'cmatrix -C Blue -r')
  for (const [line, want] of [
    ['cmatrix -u 12', '-u takes a delay from 0 to 9'],
    ['cmatrix -u', "option requires an argument -- 'u'"],
    ['cmatrix -C pink', "invalid color 'pink'"],
    ['cmatrix -x', "invalid option -- 'x'"],
    ['cmatrix now', "unexpected argument 'now'"],
  ]) {
    const r = await run(line)
    check(!r.ok && r.out.includes(want), `${line}: ${want}`, r.out)
  }
  const usage = await run('cmatrix -h')
  check(usage.ok && usage.out.includes('Usage: cmatrix') && usage.out.includes('-C color'), 'cmatrix -h: usage', usage.out)
  check((await out('cmatrix -r -h')).includes('Usage: cmatrix'), 'cmatrix -r -h: usage too')
  check((await out('man cmatrix')).includes('-u delay'), 'man cmatrix lists the options')
  const piped = await run('cmatrix | cat')
  check(piped.out.includes('cmatrix: not a terminal'), 'cmatrix | cat: not a terminal', piped.out)
  const noScreen = await run('cmatrix')
  check(!noScreen.ok && noScreen.out === 'cmatrix: needs a terminal window', 'cmatrix with no window to paint (here, Node): says so', noScreen.out)

  // Running: the area is taken, q gives it back and the command ends; Ctrl+C too.
  const session = (args: string[]) => {
    let key: ((k: string) => boolean) | null = null
    const log: string[] = []
    const abort = new AbortController()
    const ctx = {
      args,
      tty: true,
      signal: abort.signal,
      onKey: (h: ((k: string) => boolean) | null) => void ((key = h), log.push(h ? 'keys' : 'no keys')),
      paint: () => (log.push('paint'), () => void log.push('released')),
    }
    const done = mx.cmatrix(ctx as never)
    return { done, log, press: (k: string) => key?.(k), abort: () => abort.abort() }
  }
  const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))])
  {
    const s = session([])
    eq(s.log, ['keys', 'paint'], 'cmatrix takes the keys and the area')
    s.press('5')
    s.press(' ')
    s.press('!')
    check(!(await settled(s.done)), 'speed, pause and colour keys do not quit')
    check(s.press('q') === true, 'q is swallowed')
    check(await settled(s.done), 'q ends it')
    eq(s.log, ['keys', 'paint', 'no keys', 'released'], 'and hands keys and area back')
  }
  {
    const s = session([])
    s.press('Escape')
    check(await settled(s.done), 'Esc ends it')
  }
  {
    const s = session([])
    s.abort()
    check(await settled(s.done), 'Ctrl+C ends it')
    check(s.log.includes('released'), 'Ctrl+C hands the area back')
  }
  {
    const s = session(['-s'])
    s.press('Shift')
    check(!(await settled(s.done)), 'cmatrix -s: Shift alone does not quit')
    s.press('x')
    check(await settled(s.done), 'cmatrix -s: any other key quits')
  }
  {
    const s = session([])
    s.press('x')
    check(!(await settled(s.done)), 'without -s, other keys do not quit')
    s.press('Q')
    await s.done
  }

  // The rain itself: any size, resized while it runs, stays inside its grid.
  {
    const rain = new mx.Rain(200, 60, 67, 4, 7)
    const sane = (what: string) => {
      const { cols, rows } = rain
      const size = cols * rows
      let ok = rain.glyph.length === size && rain.bright.length === size && rain.wait.length === cols && rain.n <= rain.dx.length
      for (let i = 0; i < size && ok; i++) ok = rain.glyph[i] < 67 && rain.bright[i] <= 1 && rain.hue[i] < 7
      for (let k = 0; k < rain.n && ok; k++) ok = rain.dx[k] >= 0 && rain.dx[k] < cols && rain.dy[k] < rows + 1
      check(ok, what)
    }
    for (let i = 0; i < 600; i++) rain.step(1 / 144)
    sane('rain: 200×60 after 600 frames at 144 Hz')
    let lit = 0
    for (let i = 0; i < rain.bright.length; i++) if (rain.bright[i] > 0) lit++
    check(lit > 200 * 60 * 0.1 && lit < 200 * 60 * 0.9, 'rain: a good part of the screen is lit, not all of it', String(lit))
    rain.resize(40, 10)
    for (let i = 0; i < 100; i++) rain.step(1 / 60)
    sane('rain: shrunk to 40×10 while running')
    rain.resize(250, 70)
    for (let i = 0; i < 100; i++) rain.step(1 / 240)
    sane('rain: grown to 250×70')
    rain.resize(1, 1)
    rain.step(0.1)
    sane('rain: 1×1')
    const shades = new Set<number>()
    for (const b of [1, 0.99, 0.5, 0.01, 0, -0.2]) shades.add(mx.shadeOf(b))
    eq([...shades], [12, 6, 1, 0], 'shades: full, half, nearly gone, empty')
    const paused = new mx.Rain(30, 20, 67, 4)
    for (let i = 0; i < 100; i++) paused.step(1 / 60)
    const before = paused.glyph.join() + paused.bright.join()
    paused.paused = true
    for (let i = 0; i < 100; i++) paused.step(1 / 60)
    check(paused.glyph.join() + paused.bright.join() === before, 'rain: paused, nothing moves')
    // The same distance per second at any refresh rate.
    const fall = (hz: number) => {
      const r = new mx.Rain(1, 1000, 67, 4, 1, () => 0.5)
      r.wait[0] = 0
      for (let i = 0; i < hz; i++) r.step(1 / hz)
      return r.dy[0]
    }
    check(Math.abs(fall(60) - fall(240)) < 0.5, 'rain: falls as far in a second at 60 Hz as at 240 Hz', `${fall(60)} ${fall(240)}`)
  }
} finally {
  await vite.close()
}
process.exit(failures ? 1 : 0)
