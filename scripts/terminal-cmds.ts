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
//   - Permissions: `ls -l` and `find` agreeing on one mode per path, `chmod` (octal, symbolic, -R),
//     scripts needing an x bit (Permission denied, status 126; source and msh file do not), Tab
//     offering only what runs, modes staying with a file through mv, and reads and writes refused
//     only where chmod set the mode (src/terminal/modes.ts, chmod.ts).
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

  // --- permissions (src/terminal/modes.ts, chmod.ts) -----------------------------------------------

  {
    const mode = async (path: string) => (await out(`find ${path} -maxdepth 0 -printf '%m'`)).trim()
    // The listing line of a path, from its folder's own listing.
    const row = async (path: string) => {
      const dir = path.replace(/\/[^/]*$/, '') || '/'
      const name = path.split('/').pop()!
      return (await out(`ls -l ${dir}`)).split('\n').find((l) => l.endsWith(`  ${name}`) || l.endsWith(`  ${name}/`))?.split(/\s+/)[0] ?? '(no row)'
    }
    const mods = (await vite.ssrLoadModule('/src/terminal/modes.ts')) as typeof import('../src/terminal/modes.ts')
    const { completions: complete } = (await vite.ssrLoadModule('/src/terminal/commands.ts')) as typeof import('../src/terminal/commands.ts')
    const vfs = (await vite.ssrLoadModule('/src/terminal/vfs.ts')) as typeof import('../src/terminal/vfs.ts')

    // Defaults: what ls -l showed before, apart from the places where it disagreed with find.
    eq(await row('/etc/hostname'), '-r--r--r--', 'default: a site file is 444')
    eq(await row('/bin/ls'), '-r-xr-xr-x', 'default: a /bin program is 555')
    eq(await row('/srv'), 'dr-xr-xr-x', 'default: a read-only folder is 555')
    eq(await row('/etc/fstab'), '-r--r--r--', 'default: /etc/fstab is 444')
    eq(await mode('/etc/hostname'), '444', 'find %m agrees: 444')
    eq(await mode('/bin/ls'), '555', 'find %m agrees: 555')
    eq(await mode('/srv'), '555', 'find %m agrees: a folder is 555')
    await run("echo hi > /tmp/perm-a.txt")
    eq(await row('/tmp/perm-a.txt'), '-rw-r--r--', 'default: a /tmp file is 644')
    eq(await mode('/tmp/perm-a.txt'), '644', 'find %m agrees: a /tmp file is 644')
    eq(await mode('/tmp'), '1777', '/tmp is 1777 in find')
    eq(await row('/tmp'), 'drwxrwxrwt', '/tmp is 1777 in ls -l too (it said 555 before)')
    const game = (await out('ls ~/games | cat')).split('\n')[0]
    eq(await row(`~/games/${game}`), '-r-xr-xr-x', 'default: a .game file runs, so ls -l shows x (find said so already)')
    check((await out('find ~/games -executable -type f')).split('\n').length === (await out('ls ~/games | cat')).split('\n').length, 'find -executable lists every .game file')
    eq(await out('find /etc -maxdepth 1 -type f -executable'), '', 'find -executable: no plain file in /etc')

    // A game runs without a chmod.
    {
      const before = opened.length
      cwd = `${HOME}/games`
      const r = await run(`./${game}`)
      check(r.ok && opened.length === before + 1, `./${game} runs without chmod`, r.out)
    }

    // Running a script needs its x bit.
    await run("echo 'echo ran-$1' > /tmp/perm-s.msh")
    await run("echo 'echo ran-$1' > /tmp/perm-t.sh")
    await run("printf '#!/bin/sh\\necho shebang\\n' > /tmp/perm-b")
    cwd = '/tmp'
    for (const f of ['./perm-s.msh', './perm-t.sh', '/tmp/perm-s.msh', './perm-b']) {
      const r = await run(`${f}; echo status=$?`)
      check(r.out.includes(`msh: ${f}: Permission denied`) && r.out.includes('status=126') && !r.out.includes('ran-') && !r.out.includes('shebang'), `${f} without x: Permission denied, status 126`, r.out)
    }
    const plain = await run('./perm-a.txt; echo status=$?')
    check(plain.out.includes('msh: ./perm-a.txt: Permission denied') && plain.out.includes('status=126'), 'a plain file without x: Permission denied too', plain.out)
    const readme = await run(`${HOME}/README.md; echo status=$?`)
    check(readme.out.includes('Permission denied') && readme.out.includes('status=126'), 'a site file: Permission denied', readme.out)
    // source, . and msh read it without.
    eq((await run('source ./perm-s.msh one')).out, 'ran-one', 'source runs a script without x')
    eq((await run('. ./perm-s.msh two')).out, 'ran-two', '. runs a script without x')
    eq((await run('msh ./perm-s.msh three')).out, 'ran-three', 'msh file runs a script without x')
    eq((await run('./perm-s.msh; echo status=$?', true)).out.includes('ran-'), true, 'root runs it anyway')

    // chmod +x, and it runs.
    check((await run('chmod +x perm-s.msh perm-t.sh perm-b')).ok, 'chmod +x on three files')
    eq(await row('/tmp/perm-s.msh'), '-rwxr-xr-x', 'chmod +x: ls -l shows rwxr-xr-x')
    eq(await mode('/tmp/perm-s.msh'), '755', 'chmod +x: find %m says 755')
    eq((await run('./perm-s.msh hi')).out, 'ran-hi', './x.msh runs with x')
    eq((await run('/tmp/perm-t.sh yo')).out, 'ran-yo', 'an .sh file runs with x')
    eq((await run('./perm-b')).out, 'shebang', 'a shebang script runs with x')
    eq((await run("echo 'echo extra' >> /tmp/perm-s.msh; ./perm-s.msh again")).out.trim(), 'ran-again\nextra', 'writing to the script keeps its mode')
    check((await out('find /tmp -maxdepth 1 -type f -executable')).split('\n').sort().join() === ['/tmp/perm-b', '/tmp/perm-s.msh', '/tmp/perm-t.sh'].join(), 'find -executable agrees with ls -l')
    const lsX = (await out('ls -l /tmp')).split('\n').filter((l) => l.startsWith('-rwx')).map((l) => l.split(/\s+/).pop()).sort()
    eq(lsX, ['perm-b', 'perm-s.msh', 'perm-t.sh'], 'ls -l: the same three files have x')
    check((await out('find /tmp -type f -perm -u+x')).split('\n').length === 3, 'find -perm -u+x finds them')
    eq((await out('find /tmp -type f -perm 755 | sort')).split('\n'), ['/tmp/perm-b', '/tmp/perm-s.msh', '/tmp/perm-t.sh'], 'find -perm 755')
    eq((await out("find /tmp/perm-s.msh -printf '%M'")), '-rwxr-xr-x', 'find %M')

    // Tab, in command position.
    const offers = (line: string) => complete(line, '/tmp').items.map((i) => i.label)
    eq(offers('./perm-').sort(), ['perm-b', 'perm-s.msh', 'perm-t.sh'], './perm-<Tab> offers the executable files, not the .txt')
    check(!offers('./perm-a').includes('perm-a.txt'), 'a plain .txt is not offered as a command')
    check(complete('./perm-', '/tmp').items.every((i) => i.hint === 'executable'), 'the picker calls them executable')
    check(complete('cat ./perm-', '/tmp').items.some((i) => i.label === 'perm-a.txt' && i.hint === 'text'), 'as an argument the .txt is still offered, as text')
    check(complete(`${HOME}/games/`, '/tmp').items.length === (await out('ls ~/games | cat')).split('\n').length, 'folders and .game files are offered without chmod')
    check(complete('./', HOME).items.some((i) => i.label === 'games/'), 'folders are offered as commands')

    // chmod modes.
    const m = async (spec: string, start: string, file = '/tmp/perm-c') => {
      await run(`echo x > ${file}`)
      await run(`chmod ${start} ${file}`)
      const r = await run(`chmod ${spec} ${file}`)
      return r.ok ? await mode(file) : r.out
    }
    eq(await m('644', '000'), '644', 'chmod 644')
    eq(await m('0755', '000'), '755', 'chmod 0755')
    eq(await m('+x', '644'), '755', 'chmod +x: all three, as umask 022 allows')
    eq(await m('-x', '755'), '644', 'chmod -x is a mode, not a flag')
    eq(await m('u+x', '644'), '744', 'chmod u+x')
    eq(await m('go=r', '777'), '744', 'chmod go=r')
    eq(await m('a-rx', '755'), '200', 'chmod a-rx')
    eq(await m('u=rwx,go=rx', '000'), '755', 'chmod u=rwx,go=rx')
    eq(await m('g=u', '740'), '770', 'chmod g=u copies the owner bits')
    eq(await m('+w', '444'), '644', 'chmod +w only adds the owner (umask)')
    eq(await m('a+w', '444'), '666', 'chmod a+w adds everyone')
    eq(await m('u+X', '644'), '644', 'chmod X leaves a plain file alone')
    eq(await m('u+X', '744'), '744', 'chmod X on a file that runs')
    eq(await m('o+t', '755'), '1755', 'chmod o+t sets the sticky bit')
    for (const [line, why] of [['chmod 999 /tmp/perm-c', "invalid mode: '999'"], ['chmod u+z /tmp/perm-c', "invalid mode: 'u+z'"], ['chmod', 'missing operand'], ['chmod 755', "missing operand after '755'"], ['chmod 755 /tmp/nope', "cannot access '/tmp/nope': No such file or directory"], ['chmod +x /etc/hostname', "Operation not permitted"], ['chmod +x /bin/ls', 'Operation not permitted'], [`chmod +x ${HOME}/README.md`, 'Read-only file system']] as const) {
      const r = await run(line)
      check(!r.ok && r.out.includes(why), `${line}: ${why}`, r.out)
    }
    await run('chmod 600 /tmp/perm-c')
    eq((await run('chmod -v 640 /tmp/perm-c')).out, "mode of '/tmp/perm-c' changed from 0600 (rw-------) to 0640 (rw-r-----)", 'chmod -v says what changed')
    eq((await run('chmod -c 640 /tmp/perm-c')).out, '', 'chmod -c is quiet when nothing changed')

    // -R: /tmp is flat for commands, so give it a folder of its own to walk.
    const tmpDir = vfs.lookup('/tmp') as import('../src/terminal/vfs.ts').DirNode
    const leaf = (name: string): import('../src/terminal/vfs.ts').FileNode => ({ type: 'file', name, content: () => 'echo leaf' })
    tmpDir.children.set('perm-d', { type: 'dir', name: 'perm-d', children: new Map([['a.msh', leaf('a.msh')], ['sub', { type: 'dir', name: 'sub', children: new Map([['b.msh', leaf('b.msh')]]) }]]) })
    check((await run('chmod -R 750 /tmp/perm-d')).ok, 'chmod -R on a folder')
    eq([await mode('/tmp/perm-d'), await mode('/tmp/perm-d/a.msh'), await mode('/tmp/perm-d/sub'), await mode('/tmp/perm-d/sub/b.msh')], ['750', '750', '750', '750'], 'chmod -R: the folder and everything in it')
    await run('chmod u-x /tmp/perm-d/sub/b.msh')
    check((await run('chmod -R go-rwx /tmp/perm-d')).ok && (await mode('/tmp/perm-d/sub/b.msh')) === '600', 'chmod -R, symbolic, goes per file')
    await run('chmod 644 /tmp/perm-d/a.msh')
    check(!(await run('chmod +x /tmp/perm-d/a.msh /etc/hostname')).ok && (await mode('/tmp/perm-d/a.msh')) === '755', 'chmod on several: the ones that can change do, the status says the rest did not')
    tmpDir.children.delete('perm-d')

    // The mode stays with the file: mv keeps it, rm and a new file start over, writing keeps it.
    await run('echo x > /tmp/perm-m; chmod 700 /tmp/perm-m')
    check((await run('mv /tmp/perm-m /tmp/perm-n')).ok, 'mv a file with a mode')
    eq([await mode('/tmp/perm-n'), (await run('ls /tmp/perm-m')).ok], ['700', false], 'mv keeps the mode')
    await run('cp /tmp/perm-n /tmp/perm-o')
    eq(await mode('/tmp/perm-o'), '700', 'cp carries it to the copy')
    await run('echo y > /tmp/perm-n')
    eq(await mode('/tmp/perm-n'), '700', 'overwriting keeps the mode')
    await run('rm /tmp/perm-n; touch /tmp/perm-n')
    eq(await mode('/tmp/perm-n'), '644', 'rm then touch: the default again')
    await run('echo x > /tmp/perm-p; chmod 700 /tmp/perm-p; echo x > /tmp/perm-q; mv /tmp/perm-q /tmp/perm-p')
    eq(await mode('/tmp/perm-p'), '644', 'mv over a file with a mode: the moved file wins')

    // Reads and writes are refused only where chmod set the mode.
    await run('echo secret > /tmp/perm-r; chmod a-r /tmp/perm-r')
    const noRead = await run('cat /tmp/perm-r')
    check(!noRead.ok && noRead.out === 'cat: /tmp/perm-r: Permission denied', 'chmod a-r: cat is Permission denied', noRead.out)
    check(!(await run('grep s /tmp/perm-r')).ok && !(await run('cat < /tmp/perm-r')).ok && !(await run('source /tmp/perm-r')).ok, 'grep, < and source are refused too')
    eq((await run('cat /tmp/perm-r', true)).out, 'secret', 'root reads it anyway')
    await run('chmod u+r /tmp/perm-r')
    eq((await run('cat /tmp/perm-r')).out, 'secret', 'chmod u+r: readable again')
    await run('chmod a-w /tmp/perm-r')
    const noWrite = await run('echo more > /tmp/perm-r')
    check(!noWrite.ok && noWrite.out.includes('/tmp/perm-r: Permission denied'), 'chmod a-w: > is Permission denied', noWrite.out)
    check(!(await run('echo more >> /tmp/perm-r')).ok && !(await run('echo more | tee /tmp/perm-r')).ok, '>> and tee are refused too')
    check((await run('echo more > /tmp/perm-r', true)).ok, 'root writes anyway')
    check((await run('cat /etc/hostname')).ok && (await run(`cat ${HOME}/README.md`)).ok, 'files nobody chmod-ed still read, although ls -l says 444')
    check(!(await run('echo x > /etc/hostname')).ok, 'and site files still cannot be written')

    // Round 2: no way round a mode. Reads (readFileText: nano, @path, the viewers), writes (cp,
    // find -fprint, curl -o all end in writeTmp), root forwarded, replaced files, special bits.
    {
      const fsm = (await vite.ssrLoadModule('/src/terminal/fs.ts')) as typeof import('../src/terminal/fs.ts')
      const types = (await vite.ssrLoadModule('/src/terminal/types.ts')) as typeof import('../src/terminal/types.ts')
      const tmpDir = vfs.lookup('/tmp') as import('../src/terminal/vfs.ts').DirNode
      const leaf = (name: string, mode?: number): import('../src/terminal/vfs.ts').FileNode => ({ type: 'file', name, content: () => `text of ${name}`, mode })

      // 1. readFileText says no, root may, and nano (which reads through it) shows the reason.
      await run('echo secret > /tmp/perm-rd; chmod a-r /tmp/perm-rd')
      const refused = await fsm.readFileText('/tmp/perm-rd').then(() => null, (e: Error) => e)
      check(refused instanceof types.DeniedError && refused.message === 'Permission denied', 'readFileText: a mode without r refuses the read', String(refused))
      eq((await fsm.readFileText('/tmp/perm-rd', true))?.text, 'secret', 'readFileText as root: the text')
      // (Were the read let through, nano would open and wait for keys: do not wait for it.)
      const nano = await Promise.race([run('nano /tmp/perm-rd'), new Promise<null>((r) => setTimeout(() => r(null), 3000))])
      check(nano !== null && !nano.ok && nano.out === 'nano: /tmp/perm-rd: Permission denied', 'nano on a file without r: Permission denied, no editor', nano ? nano.out : 'it opened')
      eq((await fsm.readFileText('/etc/hostname'))?.text, 'mvlos', 'readFileText: a default 444 site file still reads')
      eq((await fsm.readFileText('/tmp/perm-a.txt'))?.text, 'hi', 'readFileText: a file nobody chmod-ed still reads')
      await run('chmod u+r /tmp/perm-rd')
      eq((await fsm.readFileText('/tmp/perm-rd'))?.text, 'secret', 'readFileText: readable again after chmod u+r')
      // the shell's own readers
      await run("echo 'echo ran' > /tmp/perm-xo; chmod 100 /tmp/perm-xo")
      const noRead = await run('/tmp/perm-xo; echo status=$?')
      check(noRead.out.includes('msh: /tmp/perm-xo: Permission denied') && noRead.out.includes('status=126') && !noRead.out.includes('ran'), 'a script with x but no r: Permission denied (a shell has to read it)', noRead.out)

      // 2. Writes: cp and find -fprint onto a file without w, and a normal one still works.
      await run('echo one > /tmp/perm-src; echo two > /tmp/perm-dst; chmod 444 /tmp/perm-dst')
      const cp = await run('cp /tmp/perm-src /tmp/perm-dst')
      check(!cp.ok && cp.out === "cp: cannot create regular file '/tmp/perm-dst': Permission denied", 'cp onto a 444 file: Permission denied', cp.out)
      eq((await out('cat /tmp/perm-dst')), 'two', 'and the destination is untouched')
      const mv = await run('mv /tmp/perm-src /tmp/perm-dst')
      check(!mv.ok && mv.out === "mv: cannot move '/tmp/perm-src' to '/tmp/perm-dst': Permission denied" && (await run('cat /tmp/perm-src')).ok, 'mv onto a 444 file: refused, the source stays', mv.out)
      check((await run('cp /tmp/perm-src /tmp/perm-dst', true)).ok && (await out('cat /tmp/perm-dst')) === 'one', 'root copies onto it anyway')
      await run('chmod 644 /tmp/perm-dst')
      check((await run('cp /tmp/perm-src /tmp/perm-dst2')).ok && (await run('cp /tmp/perm-src /tmp/perm-dst')).ok, 'a normal cp (new file, and onto a writable one) still works')
      await run('chmod 444 /tmp/perm-dst')
      const fprint = await run('find /etc/hostname -fprint /tmp/perm-dst')
      check(!fprint.ok && fprint.out.includes('find: /tmp/perm-dst: Permission denied'), 'find -fprint onto a 444 file: Permission denied', fprint.out)
      eq(await out('cat /tmp/perm-dst'), 'one', 'and the protected file is as it was')
      check((await run('find /etc/hostname -fprint /tmp/perm-dst', true)).ok && (await out('cat /tmp/perm-dst')) === '/etc/hostname', 'root: find -fprint writes it')
      await run('chmod 644 /tmp/perm-dst')
      check((await run('find /etc/hostname -fprint /tmp/perm-dst')).ok, 'find -fprint onto a writable file still works')
      await run('chmod 444 /tmp/perm-dst')
      check((await run('echo x | tee /tmp/perm-dst')).ok === false && (await run('echo x | tee /tmp/perm-dst', true)).ok, 'tee: refused, root passes (writeFile forwards root)')

      // 2b. A recursive copy looks at every file under the source, not just its root.
      tmpDir.children.set('perm-tree', { type: 'dir', name: 'perm-tree', children: new Map([['ok.txt', leaf('ok.txt')], ['sub', { type: 'dir', name: 'sub', children: new Map([['secret.txt', leaf('secret.txt', 0o200)]]) }]]) })
      const tree = await run('cp -r /tmp/perm-tree /tmp/perm-copy')
      check(!tree.ok && tree.out === "cp: cannot open '/tmp/perm-tree/sub/secret.txt' for reading: Permission denied", 'cp -r with an unreadable file deep inside: refused up front', tree.out)
      check(!tmpDir.children.has('perm-copy'), 'and nothing was copied')
      const rootTree = await run('cp -r /tmp/perm-tree /tmp/perm-copy', true)
      check(!rootTree.out.includes('Permission denied'), 'root is not stopped by the unreadable file', rootTree.out)
      tmpDir.children.delete('perm-tree')

      // 3. Root travels on: sudo find -delete under a parent without w.
      const parent = (): import('../src/terminal/vfs.ts').DirNode => ({ type: 'dir', name: 'perm-par', mode: 0o500, children: new Map([['child', leaf('child')]]) })
      tmpDir.children.set('perm-par', parent())
      const del = await run('find /tmp/perm-par/child -delete')
      check(!del.ok && del.out.includes('Permission denied') && (tmpDir.children.get('perm-par') as import('../src/terminal/vfs.ts').DirNode).children.has('child'), 'find -delete in a folder without w: refused, the file stays', del.out)
      const rdel = await run('find /tmp/perm-par/child -delete', true)
      check(rdel.ok && !(tmpDir.children.get('perm-par') as import('../src/terminal/vfs.ts').DirNode).children.has('child'), 'sudo find -delete: root gets through')
      tmpDir.children.set('perm-par', parent())
      check(!(await run('rm /tmp/perm-par/child')).ok && (await run('rm /tmp/perm-par/child', true)).ok, 'rm: the same, and root forwarded')
      tmpDir.children.delete('perm-par')

      // 4. A replaced file takes the new file's mode (the defaults, unless the source has its own).
      await run("echo new > /tmp/perm-n1; echo old > /tmp/perm-n2; chmod 755 /tmp/perm-n2")
      await run('mv /tmp/perm-n1 /tmp/perm-n2')
      eq(await mode('/tmp/perm-n2'), '644', 'mv over an executable file: the default mode, not 755')
      await run('echo new > /tmp/perm-n1; echo old > /tmp/perm-n3; chmod 755 /tmp/perm-n3')
      await run('cp /tmp/perm-n1 /tmp/perm-n3')
      eq(await mode('/tmp/perm-n3'), '644', 'cp over an executable file: the default mode')
      await run('chmod 700 /tmp/perm-n1; cp /tmp/perm-n1 /tmp/perm-n3')
      eq(await mode('/tmp/perm-n3'), '700', 'and the source mode, when it has one')

      // 5. Special bits.
      await run('echo x > /tmp/perm-sp')
      await run('chmod 4755 /tmp/perm-sp')
      eq(await row('/tmp/perm-sp'), '-rwsr-xr-x', 'setuid shows as s')
      await run('chmod 4644 /tmp/perm-sp')
      eq(await row('/tmp/perm-sp'), '-rwSr--r--', 'setuid without x shows as S')
      await run('chmod 2755 /tmp/perm-sp')
      eq(await row('/tmp/perm-sp'), '-rwxr-sr-x', 'setgid shows as s')
      await run('chmod 1755 /tmp/perm-sp')
      eq(await row('/tmp/perm-sp'), '-rwxr-xr-t', 'sticky shows as t')
      await run('chmod 1644 /tmp/perm-sp')
      eq(await row('/tmp/perm-sp'), '-rw-r--r-T', 'sticky without x shows as T')
      eq(await out("find /tmp/perm-sp -printf '%M %m'"), '-rw-r--r-T 1644', 'find %M and %m agree')
      await run('chmod 1755 /tmp/perm-sp; chmod a=rw /tmp/perm-sp')
      eq(await mode('/tmp/perm-sp'), '666', 'a=rw clears the sticky bit')
      await run('chmod 7777 /tmp/perm-sp; chmod a=rw /tmp/perm-sp')
      eq(await mode('/tmp/perm-sp'), '666', 'a=rw clears setuid, setgid and sticky')
      await run('chmod 7777 /tmp/perm-sp; chmod u=rw /tmp/perm-sp')
      eq(await mode('/tmp/perm-sp'), '3677', 'u=rw clears setuid only')
      await run('chmod 7777 /tmp/perm-sp; chmod u+s,g-s,o-t /tmp/perm-sp')
      eq(await mode('/tmp/perm-sp'), '4777', 'u+s, g-s and o-t work one by one')
      eq(mods.applyMode('a=rw', 0o7777, true), 0o6666, 'a folder keeps its setuid and setgid on a=rw (chmod does), but not sticky')

      // 6. One owner, everywhere.
      await run('echo x > /tmp/perm-own')
      eq(await out('ls -l /tmp/perm-own'), `-rw-r--r--  ${vfs.HOME.split('/').pop()}       1  perm-own`, 'ls -l: your files show your handle')
      eq((await out("find /tmp/perm-own /etc/hostname -printf '%u '")).trim(), `${vfs.HOME.split('/').pop()} root`, 'find %u says the same')
      const browserFile = { type: 'file', name: 'b', browser: '/b', content: () => '' } as import('../src/terminal/vfs.ts').FileNode
      eq([mods.ownerOf('/mnt/browser/b', browserFile), mods.ownerOf('/etc/hostname'), mods.ownerOf('/srv/site/cv.md'), mods.ownerOf(vfs.HOME), mods.ownerOf('/mnt/seafile/x', { ...browserFile, browser: undefined, sf: 'seafile://r/x' })], [vfs.HOME.split('/').pop(), 'root', vfs.HOME.split('/').pop(), vfs.HOME.split('/').pop(), vfs.HOME.split('/').pop()], 'ownerOf: browser files and Seafile are yours, /etc is root')

      for (const f of ['rd', 'xo', 'src', 'dst', 'dst2', 'n1', 'n2', 'n3', 'sp', 'own']) await run(`rm -f /tmp/perm-${f}`)
    }

    // The Seafile table: where the server has no modes.
    {
      const sf = 'seafile://repo/dir/run.msh'
      mods.setSfMode(sf, 0o755)
      mods.setSfMode('seafile://repo/dir/other', 0o600)
      eq(mods.sfModeOf(sf), 0o755, 'sfModes: set')
      check([...store.entries()].some(([k, v]) => k.endsWith('terminal.modes') && JSON.parse(v)[sf] === 0o755), 'sfModes: kept in localStorage, in the account space', JSON.stringify([...store.keys()]))
      mods.carrySfModes('seafile://repo/dir', 'seafile://repo/dir2', false)
      eq([mods.sfModeOf('seafile://repo/dir2/run.msh'), mods.sfModeOf(sf)], [0o755, undefined], 'sfModes: a rename carries the folder and what is in it')
      mods.carrySfModes('seafile://repo/dir2', 'seafile://repo/copy', true)
      eq([mods.sfModeOf('seafile://repo/copy/other'), mods.sfModeOf('seafile://repo/dir2/other')], [0o600, 0o600], 'sfModes: a copy keeps the original too')
      mods.dropSfModes('seafile://repo/dir2')
      mods.dropSfModes('seafile://repo/copy')
      eq([mods.sfModeOf('seafile://repo/dir2/run.msh'), mods.sfModeOf('seafile://repo/copy/other'), Object.keys(mods.sfModes.get()).length], [undefined, undefined, 0], 'sfModes: removing a folder drops what was under it')
      const seafile = { type: 'file', name: 'x.msh', sf: 'seafile://repo/x.msh', content: () => '', mode: undefined } as import('../src/terminal/vfs.ts').FileNode
      eq([mods.modeOf('/mnt/seafile/x.msh', seafile), mods.modeOf('/mnt/seafile/x.msh', { ...seafile, ro: true }), mods.canRun('/mnt/seafile/x.msh', seafile)], [0o644, 0o444, false], 'Seafile files: 644, or 444 in a read-only library, and not runnable by default')
      const browser = { type: 'file', name: 'x.msh', browser: '/x.msh', content: () => '' } as import('../src/terminal/vfs.ts').FileNode
      eq([mods.modeOf(`${HOME}/x.msh`, browser), mods.modeOf(`${HOME}/x.msh`, { ...browser, mode: 0o700 }), mods.canRun(`${HOME}/x.msh`, { ...browser, mode: 0o700 })], [0o644, 0o700, true], 'browser files: 644 by default, the stored mode wins')
      eq(mods.canRun(`${HOME}/x.msh`, { ...browser, mode: 0o070 }), false, 'the owner class counts for your own files: g+x alone does not run')
      eq(mods.canRun('/srv/x', { type: 'file', name: 'x', content: () => '', mode: 0o001 }), true, 'the other class counts for root-owned ones')
    }

    // Help, man, Tab.
    check((await out('help')).split('\n').some((l) => /\bchmod\b/.test(l)), 'help lists chmod')
    check((await out('man chmod')).includes('Permission denied') && (await out('chmod --help')).includes('CHMOD(1)'), 'man chmod and chmod --help')
    check(complete('chm', HOME).items.some((i) => i.value === 'chmod'), 'Tab completes chmod')
    check(complete('chmod -', HOME).items.some((i) => i.value === '-R'), 'Tab completes chmod -R')
    eq(complete('chmod +x ./perm-', '/tmp').items.map((i) => i.label).sort().slice(0, 2), ['perm-a.txt', 'perm-b'], 'Tab completes the paths chmod takes, plain files too')

    for (const f of ['a.txt', 's.msh', 't.sh', 'b', 'c', 'm', 'n', 'o', 'p', 'q', 'r']) await run(`rm -f /tmp/perm-${f}`)
    cwd = HOME
  }

  // --- permissions on Seafile (a second module graph, with Seafile's API faked in memory) -----------

  {
    // The site's API as src/data/seafile.ts calls it, backed by a Map: one library, "Mine", as home.
    type Item = { dir: boolean; data: string }
    const files = new Map<string, Item>([['/', { dir: true, data: '' }]])
    const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
    const join = (d: string, n: string) => (d === '/' ? `/${n}` : `${d}/${n}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const realFetch = g.fetch as typeof fetch
    g.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost')
      const q = url.searchParams
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
      const post = (init.method ?? 'GET') === 'POST'
      if (url.host === 'sf.mock') {
        if (!post) return new Response(files.get(q.get('p')!)?.data ?? '')
        const form = body as FormData
        const file = form.get('file') as File
        const path = q.get('op') === 'update' ? (form.get('target_file') as string) : join(form.get('parent_dir') as string, file.name)
        files.set(path, { dir: false, data: await file.text() })
        return json([{ name: file.name }])
      }
      switch (url.pathname) {
        case '/api/me':
          return json({ authEnabled: false, user: null, forges: [], seafile: { url: 'http://sf.mock', username: 'check', name: null, version: null, office: null } })
        case '/api/seafile/libraries':
          return json([{ id: 'repo-1', name: 'Mine', type: 'mine', owner: 'check', encrypted: false, permission: 'rw', size: 0, mtime: 0 }])
        case '/api/seafile/dir':
          if (post) return files.set(body.path, { dir: true, data: '' }) && json({ path: body.path })
          return json({ perm: 'rw', entries: [...files].filter(([k]) => k !== '/' && parentOf(k) === q.get('p')).map(([k, v]) => ({ name: k.split('/').pop(), dir: v.dir, size: v.data.length, mtime: 1, id: k })) })
        case '/api/seafile/file':
          files.set(body.path, { dir: false, data: '' })
          return json({ path: body.path })
        case '/api/seafile/link':
          return json({ url: `http://sf.mock/${q.get('op')}?op=${q.get('op')}&p=${encodeURIComponent(q.get('p')!)}` })
        case '/api/seafile/rename': {
          const to = join(parentOf(body.path), body.name)
          for (const k of [...files.keys()].filter((x) => x === body.path || x.startsWith(`${body.path}/`))) {
            files.set(to + k.slice(body.path.length), files.get(k)!)
            files.delete(k)
          }
          return json({ path: to })
        }
        case '/api/seafile/delete':
          for (const n of body.names as string[]) for (const k of [...files.keys()].filter((x) => x === join(body.parent, n) || x.startsWith(`${join(body.parent, n)}/`))) files.delete(k)
          return json({})
        case '/api/seafile/transfer':
          for (const n of body.names as string[]) {
            const from = join(body.from.parent, n)
            for (const k of [...files.keys()].filter((x) => x === from || x.startsWith(`${from}/`))) {
              files.set(join(body.to.parent, n) + k.slice(from.length), files.get(k)!)
              if (body.op === 'move') files.delete(k)
            }
          }
          return json({})
      }
      return json({ error: `not faked: ${url.pathname}` }, 404)
    }
    const vite2 = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', define: { __APP_VERSION__: '"0.0.0"', __APP_COMMIT__: '"test"', __BUILD_TIME__: '"2026-01-01T00:00:00.000Z"' }, optimizeDeps: { noDiscovery: true, include: [] } })
    try {
      const cmds = (await vite2.ssrLoadModule('/src/terminal/commands.ts')) as typeof import('../src/terminal/commands.ts')
      const home = ((await vite2.ssrLoadModule('/src/terminal/vfs.ts')) as typeof import('../src/terminal/vfs.ts')).HOME
      const sfMods = (await vite2.ssrLoadModule('/src/terminal/modes.ts')) as typeof import('../src/terminal/modes.ts')
      await ((await vite2.ssrLoadModule('/src/os/account.ts')) as typeof import('../src/os/account.ts')).loadAccount()
      let at = home
      const sh = async (text: string, root = false) => {
        const base = { args: [], stdin: null, cwd: at, setCwd: (p: string) => void (at = p), env: { HOME: home, USER: 'menno' }, history: [], windows: [], openApp() {}, openNewApp() {}, root, closeWindow() {}, clear() {}, exit() {}, setAccent: () => true, print() {}, tty: false, live() {}, size: { cols: 80, rows: 24 }, signal: new AbortController().signal, onKey() {} }
        const results = await cmds.runLine(text, base as never)
        return { out: cmds.strip(results.map((r) => r.output).join('\n')), ok: results.every((r) => r.ok) }
      }
      const modeAt = async (p: string) => (await sh(`find ${p} -maxdepth 0 -printf '%m'`)).out.trim()

      await sh('ls ~') // the first command loads the libraries
      await sh('echo hi > ~/perm-first.txt')
      check(files.has('/perm-first.txt'), 'Seafile fake: a file written under ~ lands in the library', JSON.stringify([...files.keys()]))
      eq(await modeAt('~/perm-first.txt'), '644', 'a Seafile file: 644 by default')
      const noX = await sh('cd ~; echo "echo ran" > run.msh; ./run.msh; echo status=$?')
      check(noX.out.includes('Permission denied') && noX.out.includes('status=126'), 'a Seafile script without x: Permission denied', noX.out)
      await sh('chmod +x ~/run.msh')
      eq(await modeAt('~/run.msh'), '755', 'chmod +x on a Seafile file')
      eq((await sh('./run.msh')).out, 'ran', 'and it runs')
      check([...store.entries()].some(([k, v]) => k.endsWith('terminal.modes') && JSON.parse(v)['seafile://repo-1/run.msh'] === 0o755), 'the mode is in the account table in localStorage, not sent to the server')
      await sh('mv ~/run.msh ~/moved.msh')
      eq([await modeAt('~/moved.msh'), sfMods.sfModeOf('seafile://repo-1/run.msh')], ['755', undefined], 'mv keeps the mode and leaves no entry behind')
      // (cp into the folder it is in makes "name (1)" on Seafile, so the copies go to folders of their own.)
      await sh('mkdir ~/d1 ~/d2 ~/d3')
      await sh('cp ~/moved.msh ~/d1/copied.msh')
      eq([await modeAt('~/d1/copied.msh'), await modeAt('~/moved.msh')], ['755', '755'], 'cp carries it to the copy, and the original keeps it')

      // 4. Replacing an executable file: the new content is not runnable by inheritance.
      await sh('echo "echo old" > ~/dst.msh; chmod 755 ~/dst.msh; echo "echo new" > ~/src.msh')
      eq(await modeAt('~/dst.msh'), '755', 'the destination starts executable')
      check((await sh('mv ~/src.msh ~/dst.msh')).ok, 'mv over it')
      eq(await modeAt('~/dst.msh'), '644', 'mv over an executable Seafile file: the default mode')
      const denied = await sh('./dst.msh; echo status=$?')
      check(denied.out.includes('Permission denied') && !denied.out.includes('echo new') && denied.out.includes('status=126'), 'and the replacement does not run', denied.out)
      await sh('echo "echo old" > ~/d2/dst2.msh; chmod 755 ~/d2/dst2.msh; echo "echo new" > ~/src2.msh')
      await sh('cp ~/src2.msh ~/d2/dst2.msh')
      eq(await modeAt('~/d2/dst2.msh'), '644', 'cp over an executable Seafile file: the default mode')
      await sh('chmod 700 ~/src2.msh; echo "echo old" > ~/d3/dst3.msh; chmod 755 ~/d3/dst3.msh')
      await sh('mv ~/src2.msh ~/d3/dst3.msh')
      eq(await modeAt('~/d3/dst3.msh'), '700', 'a source with a mode of its own passes it on')

      // A stale entry (the file was deleted somewhere else) does not come back with a new file.
      sfMods.setSfMode('seafile://repo-1/stale-touch.msh', 0o755)
      sfMods.setSfMode('seafile://repo-1/stale-write.msh', 0o755)
      sfMods.setSfMode('seafile://repo-1/stale-dir', 0o700)
      await sh('touch ~/stale-touch.msh; echo "echo x" > ~/stale-write.msh; mkdir ~/stale-dir')
      eq([await modeAt('~/stale-touch.msh'), await modeAt('~/stale-write.msh'), await modeAt('~/stale-dir')], ['644', '644', '755'], 'touch, > and mkdir at a path with a stale entry: the defaults')
      sfMods.setSfMode('seafile://repo-1/stale-write.msh', 0o755)
      await sh('echo "echo y" >> ~/stale-write.msh')
      eq(await modeAt('~/stale-write.msh'), '755', 'writing to an existing file keeps its mode')
      await sh('rm ~/stale-write.msh')
      eq(sfMods.sfModeOf('seafile://repo-1/stale-write.msh'), undefined, 'rm drops the entry')

      // The Seafile checks that forward root: sudo cp onto a file without w.
      await sh('echo a > ~/ro-src; echo b > ~/d1/ro-dst; chmod 444 ~/d1/ro-dst')
      check(!(await sh('cp ~/ro-src ~/d1/ro-dst')).ok && (await sh('cp ~/ro-src ~/d1/ro-dst', true)).ok, 'cp onto a 444 Seafile file: refused, root passes')
      await sh('chmod a-r ~/ro-src')
      const sfRead = await sh('cat ~/ro-src')
      check(!sfRead.ok && sfRead.out.includes('Permission denied'), 'cat on a Seafile file without r: Permission denied', sfRead.out)
    } finally {
      await vite2.close()
      g.fetch = realFetch
    }
  }

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
