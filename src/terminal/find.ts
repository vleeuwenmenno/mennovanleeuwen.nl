import { profile } from '../data/profile'
import { runLine, writeTmp, type Completion } from './commands'
import { CmdError, type Ctx } from './types'
import { HOME, lookup, resolvePath, stat, type DirNode, type Node } from './vfs'

// GNU find (findutils 4.10) and sharkdp's fd (10.2) over the in-memory filesystem: their options,
// expression language, output formats, --help, --version and error messages, as close to the real
// tools as a read-only filesystem allows. Everything is owned by root outside the home folder and
// /tmp, nothing is a symlink, and /tmp is the only place -delete can delete.

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void>; complete?: (args: string[], word: string) => Completion[] }

const c = (color: string, s: string) => `{c:${color}}${s}{/}`

// ---------------------------------------------------------------------------------------------
// What the filesystem says about a path, the way stat(2) would

const DIR_SIZE = 4096

const isUnderTmp = (abs: string) => abs.startsWith('/tmp/')
const owner = (abs: string) => (abs === HOME || abs.startsWith(`${HOME}/`) || isUnderTmp(abs) ? profile.handle : 'root')
const idOf = (abs: string) => (owner(abs) === 'root' ? 0 : 1000)
const isExecutable = (node: Node) => node.type === 'dir' || node.name.endsWith('.game')

/** Read-only everywhere (0555 folders and runnable games, 0444 files), except /tmp. */
function modeOf(abs: string, node: Node): number {
  if (abs === '/tmp') return 0o1777
  if (isUnderTmp(abs)) return 0o644
  return isExecutable(node) ? 0o555 : 0o444
}

function permString(abs: string, node: Node) {
  const m = modeOf(abs, node)
  const bits = [6, 3, 0].map((s) => `${m & (4 << s) ? 'r' : '-'}${m & (2 << s) ? 'w' : '-'}${m & (1 << s) ? 'x' : '-'}`).join('')
  const sticky = m & 0o1000 ? bits.slice(0, 8) + (bits[8] === 'x' ? 't' : 'T') : bits
  return (node.type === 'dir' ? 'd' : '-') + sticky
}

const sizeOf = (abs: string, node: Node) => (node.type === 'dir' ? DIR_SIZE : stat(abs, node).size)
/** Disk space taken, in whole 4 KiB ext4 blocks. */
const allocated = (abs: string, node: Node) => Math.ceil(sizeOf(abs, node) / 4096) * 4096
const mtimeOf = (abs: string, node: Node) => stat(abs, node).mtime
const linksOf = (node: Node) => (node.type === 'dir' ? 2 + [...node.children.values()].filter((n) => n.type === 'dir').length : 1)
const fsType = (abs: string) => (abs === '/proc' || abs.startsWith('/proc/') ? 'proc' : abs === '/tmp' || isUnderTmp(abs) ? 'tmpfs' : 'ext4')
const isEmpty = (abs: string, node: Node) => (node.type === 'dir' ? node.children.size === 0 : sizeOf(abs, node) === 0)

function inodeOf(abs: string) {
  let h = 2166136261
  for (const ch of abs) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return 131072 + (h % 8_000_000)
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
const DAYS = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ')
const LONG_MONTHS = 'January February March April May June July August September October November December'.split(' ')
const LONG_DAYS = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ')
const pad = (n: number, w = 2, ch = '0') => String(n).padStart(w, ch)

/** `ls -l`'s date: the time for the last six months, the year before that. */
function lsDate(ms: number) {
  const d = new Date(ms)
  const recent = Math.abs(Date.now() - ms) < 182 * 864e5
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate(), 2, ' ')} ${recent ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ` ${d.getFullYear()}`}`
}

/** Sizes the way `ls -lh` prints them: 620, 4.0K, 1.2M. */
function humanSize(bytes: number) {
  const units = ['K', 'M', 'G', 'T']
  if (bytes < 1024) return String(bytes)
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : Math.ceil(v)}${units[i]}`
}

/** Shell-quotes one argument for a command line run through msh. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** Runs a command line in the shell, as -exec and fd -x do, and returns what it printed. */
async function runCommand(ctx: Ctx, line: string, cwd = ctx.cwd): Promise<{ output: string; ok: boolean }> {
  const printed: string[] = []
  const results = await runLine(line, { ...ctx, cwd, setCwd: () => {}, print: (t) => void printed.push(t) })
  return { output: printed.join('\n'), ok: results.every((r) => r.ok) }
}

// ---------------------------------------------------------------------------------------------
// Glob patterns: fnmatch(3) for find, globset for fd

/** A glob as a regular expression. `slash`: wildcards cross `/` (find -path); `**` always does. */
function globToRegExp(glob: string, { slash = true, ci = false } = {}): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '\\' && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    else if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += slash ? '.*' : '[^/]*'
    } else if (ch === '?') re += slash ? '.' : '[^/]'
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end < 0) re += '\\['
      else {
        let set = glob.slice(i + 1, end)
        if (set[0] === '!' || set[0] === '^') set = '^' + set.slice(1)
        re += `[${set.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += ch.replace(/[.+^${}()|/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, ci ? 'si' : 's')
}

// ---------------------------------------------------------------------------------------------
// find

type Start = { abs: string; shown: string }
type Entry = { abs: string; shown: string; node: Node; depth: number; start: Start }
/** The last part of the path as find shows it: `.` for a starting point of `.`, `/` for `/`. */
const baseName = (e: Entry) => e.shown.replace(/(.)\/+$/, '$1').split('/').pop() || '/'

type Expr = { ev: (e: Entry) => Promise<boolean>; action: boolean }

const FIND_VERSION = `find (GNU findutils) 4.10.0
Copyright (C) 2024 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Eric B. Decker, James Youngman, and Kevin Dalley.
Features enabled: D_TYPE O_NOFOLLOW(enabled) LEAF_OPTIMISATION FTS(FTS_CWDFD) CBO(level=2)`

const FIND_HELP = `Usage: find [-H] [-L] [-P] [-Olevel] [-D debugopts] [path...] [expression]

default path is the current directory; default expression is -print
expression may consist of: operators, options, tests, and actions.

Operators (decreasing precedence; -and is implicit where no others are given):
      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2
      EXPR1 -o EXPR2   EXPR1 -or EXPR2   EXPR1 , EXPR2

Positional options (always true):
      -daystart -follow -nowarn -regextype -warn

Normal options (always true, specified before other expressions):
      -depth -files0-from FILE -maxdepth LEVELS -mindepth LEVELS
       -mount -noleaf -xdev -ignore_readdir_race -noignore_readdir_race

Tests (N can be +N or -N or N):
      -amin N -anewer FILE -atime N -cmin N -cnewer FILE -context CONTEXT
      -ctime N -empty -false -fstype TYPE -gid N -group NAME -ilname PATTERN
      -iname PATTERN -inum N -iwholename PATTERN -iregex PATTERN
      -links N -lname PATTERN -mmin N -mtime N -name PATTERN -newer FILE
      -nouser -nogroup -path PATTERN -perm [-/]MODE -regex PATTERN
      -readable -writable -executable
      -wholename PATTERN -size N[bcwkMG] -true -type [bcdpflsD] -uid N
      -used N -user NAME -xtype [bcdpfls]

Actions:
      -delete -print0 -printf FORMAT -fprintf FILE FORMAT -print
      -fprint0 FILE -fprint FILE -ls -fls FILE -prune -quit
      -exec COMMAND ; -exec COMMAND {} + -ok COMMAND ;
      -execdir COMMAND ; -execdir COMMAND {} + -okdir COMMAND ;

Other common options:
      --help                   display this help and exit
      --version                output version information and exit

Valid arguments for -D:
exec, opt, rates, search, stat, time, tree, all, help
Use '-D help' for a description of the options, or see find(1)

Please see also the documentation at https://www.gnu.org/software/findutils/.
You can report (and track progress on fixing) bugs in the "find"
program via the GNU findutils bug-reporting page at
https://savannah.gnu.org/bugs/?group=findutils or, if
you have no web access, by sending email to <bug-findutils@gnu.org>.`

/** Every primary find knows, with its argument and what it does: for Tab and the manual. */
const FIND_PRIMARIES: [name: string, arg: string, desc: string][] = [
  ['-name', 'PATTERN', 'base name matches the shell pattern'],
  ['-iname', 'PATTERN', 'like -name, ignoring case'],
  ['-path', 'PATTERN', 'whole path matches the shell pattern'],
  ['-ipath', 'PATTERN', 'like -path, ignoring case'],
  ['-wholename', 'PATTERN', 'same as -path'],
  ['-iwholename', 'PATTERN', 'same as -ipath'],
  ['-regex', 'PATTERN', 'whole path matches the regular expression'],
  ['-iregex', 'PATTERN', 'like -regex, ignoring case'],
  ['-type', 'C', 'file type: f file, d directory (comma-separated for several)'],
  ['-xtype', 'C', 'like -type (nothing here is a symlink)'],
  ['-size', 'N[bcwkMG]', 'size in units, rounded up: +N more, -N less'],
  ['-empty', '', 'empty file or directory'],
  ['-mtime', 'N', 'modified N days ago (+N more, -N less)'],
  ['-mmin', 'N', 'modified N minutes ago'],
  ['-atime', 'N', 'accessed N days ago'],
  ['-amin', 'N', 'accessed N minutes ago'],
  ['-ctime', 'N', 'status changed N days ago'],
  ['-cmin', 'N', 'status changed N minutes ago'],
  ['-newer', 'FILE', 'modified more recently than FILE'],
  ['-anewer', 'FILE', 'accessed more recently than FILE was modified'],
  ['-cnewer', 'FILE', 'changed more recently than FILE was modified'],
  ['-newermt', 'DATE', 'modified after a date, e.g. 2026-10-01'],
  ['-user', 'NAME', 'owned by user NAME'],
  ['-group', 'NAME', 'belongs to group NAME'],
  ['-uid', 'N', 'numeric owner id is N'],
  ['-gid', 'N', 'numeric group id is N'],
  ['-nouser', '', 'no user owns it'],
  ['-nogroup', '', 'no group owns it'],
  ['-perm', '[-/]MODE', 'permission bits: exactly, all of (-) or any of (/)'],
  ['-readable', '', 'you can read it'],
  ['-writable', '', 'you can write it'],
  ['-executable', '', 'you can run it (or enter it)'],
  ['-links', 'N', 'has N hard links'],
  ['-inum', 'N', 'has inode number N'],
  ['-samefile', 'FILE', 'is the same file as FILE'],
  ['-fstype', 'TYPE', 'on a filesystem of TYPE'],
  ['-lname', 'PATTERN', 'symlink whose target matches'],
  ['-ilname', 'PATTERN', 'like -lname, ignoring case'],
  ['-used', 'N', 'accessed N days after its status changed'],
  ['-context', 'CONTEXT', 'SELinux context matches'],
  ['-true', '', 'always true'],
  ['-false', '', 'always false'],
  ['-print', '', 'print the path, then a newline'],
  ['-print0', '', 'print the path, then a NUL'],
  ['-printf', 'FORMAT', 'print with a format: %p path, %f name, %s size…'],
  ['-ls', '', 'list it like ls -dils'],
  ['-fprint', 'FILE', 'like -print, into FILE'],
  ['-fprint0', 'FILE', 'like -print0, into FILE'],
  ['-fprintf', 'FILE FORMAT', 'like -printf, into FILE'],
  ['-fls', 'FILE', 'like -ls, into FILE'],
  ['-exec', 'COMMAND ;', 'run COMMAND, {} is the path; true if it succeeds'],
  ['-execdir', 'COMMAND ;', 'like -exec, from the file’s own folder'],
  ['-ok', 'COMMAND ;', 'like -exec, asking first'],
  ['-okdir', 'COMMAND ;', 'like -execdir, asking first'],
  ['-delete', '', 'delete it (implies -depth)'],
  ['-prune', '', 'do not descend into this directory'],
  ['-quit', '', 'stop right away'],
  ['-maxdepth', 'LEVELS', 'descend at most LEVELS below the starting points'],
  ['-mindepth', 'LEVELS', 'skip anything less than LEVELS deep'],
  ['-depth', '', 'contents before the directory itself'],
  ['-daystart', '', 'measure times from the start of today'],
  ['-regextype', 'TYPE', 'regular expression dialect'],
  ['-mount', '', 'stay on this filesystem'],
  ['-xdev', '', 'stay on this filesystem'],
  ['-noleaf', '', 'for filesystems without Unix link counts'],
  ['-follow', '', 'follow symbolic links (same as -L)'],
  ['-not', '', 'negate the next expression'],
  ['-and', '', 'both expressions (implied)'],
  ['-or', '', 'either expression'],
  ['-a', '', 'same as -and'],
  ['-o', '', 'same as -or'],
  ['-help', '', 'show the help'],
  ['-version', '', 'show the version'],
]

const FIND_MAN = `${c('bold', 'NAME')}
       find - search for files in a directory hierarchy

${c('bold', 'SYNOPSIS')}
       find [-H] [-L] [-P] [-D debugopts] [-Olevel] [starting-point...] [expression]

${c('bold', 'DESCRIPTION')}
       find searches the directory tree rooted at each given starting-point by evaluating the given
       expression from left to right, according to the rules of precedence, until the outcome is
       known (the left hand side is false for and operations, true for or), at which point find
       moves on to the next file name. If no starting-point is specified, '.' is assumed.

       The expression is made up of options (which affect overall operation rather than the
       processing of a specific file, and always return true), tests (which return a true or false
       value), and actions (which have side effects and return a true or false value), all separated
       by operators. -and is assumed where the operator is omitted. If the expression contains no
       actions other than -prune, -print is performed on all files for which the expression is true.

${c('bold', 'EXPRESSION')}
${FIND_PRIMARIES.filter(([n]) => !['-a', '-o', '-help', '-version'].includes(n))
  .map(([n, a, d]) => `       ${`${n} ${a}`.trim().padEnd(24)} ${d}`)
  .join('\n')}

${c('bold', 'OPERATORS')}
       ( expr )        force precedence
       ! expr          true if expr is false (also -not)
       expr1 expr2     and; expr2 is not evaluated if expr1 is false (also -a, -and)
       expr1 -o expr2  or; expr2 is not evaluated if expr1 is true (also -or)
       expr1 , expr2   list; both are evaluated, the value is that of expr2

${c('bold', 'EXAMPLES')}
       find . -name '*.md'                      Markdown files below here
       find ~ -type d -name 'p*'                folders starting with p
       find / -size +1M -printf '%s\\t%p\\n'      big files with their size
       find . -mtime -7 -ls                     changed this week, listed
       find projects -name README.md -exec head -1 {} \\;
       find /tmp -empty -delete                 tidy /tmp (the only writable place)

${c('bold', 'SEE ALSO')}
       fd(1), grep(1), ls(1), tree(1)`

class FindError extends Error {}

/** `N`, `+N` or `-N`: exactly, more than, less than. */
function parseN(arg: string, pred: string): (v: number) => boolean {
  const m = /^([+-]?)(\d+)$/.exec(arg)
  if (!m) throw new FindError(`find: invalid argument '${arg}' to '${pred}'`)
  const n = Number(m[2])
  return m[1] === '+' ? (v) => v > n : m[1] === '-' ? (v) => v < n : (v) => v === n
}

/** chmod-style modes, octal or symbolic (u+rwx,go=r…), from nothing. */
function parseMode(spec: string, pred: string): number {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8)
  let mode = 0
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([+=-])([rwxXst]*)$/.exec(clause)
    if (!m) throw new FindError(`find: invalid mode '${spec}'`)
    const who = m[1] || 'a'
    let bits = 0
    for (const p of m[3]) bits |= p === 'r' ? 4 : p === 'w' ? 2 : p === 'x' || p === 'X' ? 1 : 0
    let mask = 0
    if (/[ua]/.test(who)) mask |= bits << 6
    if (/[ga]/.test(who)) mask |= bits << 3
    if (/[oa]/.test(who)) mask |= bits
    if (m[3].includes('t')) mask |= 0o1000
    if (m[3].includes('s')) mask |= (/[ua]/.test(who) ? 0o4000 : 0) | (/[ga]/.test(who) ? 0o2000 : 0)
    mode = m[2] === '-' ? mode & ~mask : m[2] === '=' ? mask : mode | mask
  }
  void pred
  return mode
}

const SIZE_UNITS: Record<string, number> = { b: 512, c: 1, w: 2, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }

/** strftime-ish fields for -printf's %Tk, %Ak and %Ck. */
function timeField(ms: number, k: string): string | null {
  const d = new Date(ms)
  const frac = `${pad(d.getMilliseconds(), 3)}0000000`
  const h12 = d.getHours() % 12 || 12
  const tz = /\(([^)]+)\)/.exec(d.toString())?.[1]?.replace(/[a-z ]/g, '') ?? 'UTC'
  const startOfYear = new Date(d.getFullYear(), 0, 1)
  const yday = Math.floor((d.getTime() - startOfYear.getTime()) / 864e5) + 1
  const fields: Record<string, () => string> = {
    '@': () => `${Math.floor(ms / 1000)}.${frac}`,
    H: () => pad(d.getHours()),
    I: () => pad(h12),
    k: () => pad(d.getHours(), 2, ' '),
    l: () => pad(h12, 2, ' '),
    M: () => pad(d.getMinutes()),
    p: () => (d.getHours() < 12 ? 'AM' : 'PM'),
    r: () => `${pad(h12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`,
    S: () => `${pad(d.getSeconds())}.${frac}`,
    T: () => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${frac}`,
    '+': () => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}+${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${frac}`,
    X: () => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${frac}`,
    Z: () => tz,
    a: () => DAYS[d.getDay()],
    A: () => LONG_DAYS[d.getDay()],
    b: () => MONTHS[d.getMonth()],
    h: () => MONTHS[d.getMonth()],
    B: () => LONG_MONTHS[d.getMonth()],
    c: () => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad(d.getDate(), 2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`,
    d: () => pad(d.getDate()),
    D: () => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`,
    F: () => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    j: () => pad(yday, 3),
    m: () => pad(d.getMonth() + 1),
    U: () => pad(Math.floor((yday + startOfYear.getDay() - 1) / 7)),
    w: () => String(d.getDay()),
    W: () => pad(Math.floor((yday + ((startOfYear.getDay() + 6) % 7) - 1) / 7)),
    x: () => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`,
    y: () => pad(d.getFullYear() % 100),
    Y: () => String(d.getFullYear()),
  }
  return fields[k]?.() ?? null
}

/** `%t`: ctime(3)'s date, with find's nanoseconds. */
const ctimeString = (ms: number) => {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad(d.getDate(), 2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}0000000 ${d.getFullYear()}`
}

/** -printf: escapes are read once, directives filled in for each file. */
function compilePrintf(fmt: string): (e: Entry) => string {
  // Backslash escapes first; \c ends the output there.
  let text = ''
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]
    if (ch !== '\\' || i + 1 >= fmt.length) {
      text += ch
      continue
    }
    const n = fmt[++i]
    const oct = /^[0-7]{1,3}/.exec(fmt.slice(i))
    if (oct) {
      text += String.fromCharCode(parseInt(oct[0], 8))
      i += oct[0].length - 1
    } else if (n === 'c') break
    else text += { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' }[n] ?? `\\${n}`
  }
  const directive = /%([-+ #0]*)(\d*)(?:\.(\d+))?(?:([ACT])(.)|([%abcdDfFgGhHiklmMnpPsStuUyYZ]))/g
  return (e) =>
    text.replace(directive, (whole, flags: string, width: string, prec: string | undefined, timeKind: string | undefined, timeKey: string | undefined, d: string | undefined) => {
      const { abs, node } = e
      let v: string | null
      let numeric = false
      if (timeKind) v = timeField(mtimeOf(abs, node), timeKey!)
      else {
        numeric = 'bdDGikmnsU'.includes(d!)
        const dirname = e.shown.includes('/') ? e.shown.replace(/\/[^/]*$/, '') || '/' : '.'
        const values: Record<string, () => string> = {
          '%': () => '%',
          a: () => ctimeString(mtimeOf(abs, node)),
          c: () => ctimeString(mtimeOf(abs, node)),
          t: () => ctimeString(mtimeOf(abs, node)),
          b: () => String(allocated(abs, node) / 512),
          k: () => String(allocated(abs, node) / 1024),
          d: () => String(e.depth),
          D: () => (fsType(abs) === 'tmpfs' ? '36' : fsType(abs) === 'proc' ? '22' : '2049'),
          f: () => baseName(e),
          F: () => fsType(abs),
          g: () => owner(abs),
          G: () => String(idOf(abs)),
          h: () => dirname,
          H: () => e.start.shown,
          i: () => String(inodeOf(abs)),
          l: () => '',
          m: () => (flags.includes('#') ? '0' : '') + modeOf(abs, node).toString(8),
          M: () => permString(abs, node),
          n: () => String(linksOf(node)),
          p: () => e.shown,
          P: () => (e.depth === 0 ? '' : e.shown.slice(e.start.shown.replace(/\/$/, '').length + 1)),
          s: () => String(sizeOf(abs, node)),
          S: () => '1',
          u: () => owner(abs),
          U: () => String(idOf(abs)),
          y: () => (node.type === 'dir' ? 'd' : 'f'),
          Y: () => (node.type === 'dir' ? 'd' : 'f'),
          Z: () => '?',
        }
        v = values[d!]()
      }
      if (v === null) return whole
      if (prec !== undefined && !numeric) v = v.slice(0, Number(prec))
      const w = Number(width || 0)
      if (v.length >= w) return v
      return flags.includes('-') ? v.padEnd(w) : flags.includes('0') && numeric ? v.padStart(w, '0') : v.padStart(w)
    })
}

/** -ls and -fls: `ls -dils`. */
function lsLine(e: Entry) {
  const { abs, node } = e
  return `${String(inodeOf(abs)).padStart(9)} ${String(allocated(abs, node) / 1024).padStart(6)} ${permString(abs, node)} ${String(linksOf(node)).padStart(3)} ${owner(abs).padEnd(8)} ${owner(abs).padEnd(8)} ${String(sizeOf(abs, node)).padStart(8)} ${lsDate(mtimeOf(abs, node))} ${e.shown}`
}

const DATE_RE = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?$/
function parseDate(s: string): number | null {
  const m = DATE_RE.exec(s.trim())
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime()
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

type FindState = {
  ctx: Ctx
  out: string[]
  failed: boolean
  prune: boolean
  quit: boolean
  files: Map<string, string[]>
  batches: { cmd: string[]; dir: boolean; paths: { path: string; cwd: string }[] }[]
}

const GLOBAL_OPTIONS = new Set(['-maxdepth', '-mindepth', '-depth', '-d', '-mount', '-xdev', '-noleaf', '-ignore_readdir_race', '-noignore_readdir_race', '-files0-from'])
const TAKES_PATTERN = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname'])

/** Parses an expression into something to run per file, the way find's parser does. */
class FindParser {
  i = 0
  maxdepth = Infinity
  mindepth = 0
  depthFirst = false
  daystart = false
  sawTest: string | null = null
  warnings: string[] = []
  constructor(
    readonly toks: string[],
    readonly st: FindState,
  ) {}

  peek = () => this.toks[this.i]
  next = () => this.toks[this.i++]
  arg(pred: string) {
    if (this.i >= this.toks.length) throw new FindError(`find: missing argument to '${pred}'`)
    return this.next()
  }

  parse(): Expr {
    if (this.i >= this.toks.length) return { ev: async () => true, action: false }
    const e = this.list()
    if (this.i < this.toks.length) {
      const t = this.peek()
      if (t === ')') throw new FindError("find: invalid expression; you have too many ')'")
      throw new FindError(`find: unexpected extra predicate '${t}'`)
    }
    return e
  }

  list(): Expr {
    let left = this.or()
    while (this.peek() === ',') {
      this.next()
      if (this.i >= this.toks.length || this.peek() === ')') throw new FindError("find: invalid expression; you have used a binary operator ',' with nothing after it.")
      const a = left
      const b = this.or()
      left = { ev: async (x) => (await a.ev(x), b.ev(x)), action: a.action || b.action }
    }
    return left
  }

  or(): Expr {
    let left = this.and()
    while (this.peek() === '-o' || this.peek() === '-or') {
      const op = this.next()
      if (this.i >= this.toks.length || [')', ',', '-o', '-or', '-a', '-and'].includes(this.peek())) throw new FindError(`find: invalid expression; you have used a binary operator '${op}' with nothing after it.`)
      const a = left
      const b = this.and()
      left = { ev: async (x) => (await a.ev(x)) || b.ev(x), action: a.action || b.action }
    }
    return left
  }

  and(): Expr {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      if (t === undefined || t === ')' || t === ',' || t === '-o' || t === '-or') return left
      if (t === '-a' || t === '-and') {
        this.next()
        if (this.i >= this.toks.length || [')', ',', '-o', '-or'].includes(this.peek())) throw new FindError(`find: invalid expression; you have used a binary operator '${t}' with nothing after it.`)
      }
      const a = left
      const b = this.unary()
      left = { ev: async (x) => (await a.ev(x)) && b.ev(x), action: a.action || b.action }
    }
  }

  unary(): Expr {
    const t = this.peek()
    if (t === '!' || t === '-not') {
      this.next()
      if (this.i >= this.toks.length) throw new FindError(`find: invalid expression; '${t}' must be followed by an expression.`)
      const a = this.unary()
      return { ev: async (x) => !(await a.ev(x)), action: a.action }
    }
    if (t === '(') {
      this.next()
      if (this.peek() === ')') throw new FindError("find: invalid expression; empty parentheses are not allowed.")
      const e = this.list()
      if (this.next() !== ')') throw new FindError("find: invalid expression; I was expecting to find a ')' somewhere but did not see one.")
      return e
    }
    if (t === '-a' || t === '-and' || t === '-o' || t === '-or' || t === ',') throw new FindError(`find: invalid expression; you have used a binary operator '${t}' with nothing before it.`)
    if (t === ')') throw new FindError("find: invalid expression; you have too many ')'")
    return this.primary()
  }

  primary(): Expr {
    const pred = this.next()
    const st = this.st
    const test = (ev: (e: Entry) => boolean | Promise<boolean>): Expr => {
      this.sawTest ??= pred
      return { ev: async (e) => ev(e), action: false }
    }
    const action = (ev: (e: Entry) => boolean | Promise<boolean>): Expr => {
      this.sawTest ??= pred
      return { ev: async (e) => ev(e), action: true }
    }
    const option = (set: () => void): Expr => {
      if (GLOBAL_OPTIONS.has(pred) && this.sawTest)
        this.warnings.push(
          `find: warning: you have specified the global option ${pred} after the argument ${this.sawTest}, but global options are not positional, i.e., ${pred} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.`,
        )
      set()
      return { ev: async () => true, action: false }
    }
    const now = () => (this.daystart ? new Date(new Date().setHours(24, 0, 0, 0)).getTime() : Date.now())
    const depthArg = () => {
      const a = this.arg(pred)
      if (!/^\d+$/.test(a)) throw new FindError(`find: Expected a positive decimal integer argument to ${pred}, but got '${a}'`)
      return Number(a)
    }
    const refFile = () => {
      const a = this.arg(pred)
      const abs = resolvePath(st.ctx.cwd, a)
      const node = lookup(abs)
      if (!node) throw new FindError(`find: '${a}': No such file or directory`)
      return { abs, node }
    }

    switch (pred) {
      // Options
      case '-maxdepth':
        return option(() => (this.maxdepth = depthArg()))
      case '-mindepth':
        return option(() => (this.mindepth = depthArg()))
      case '-depth':
      case '-d':
        return option(() => (this.depthFirst = true))
      case '-daystart':
        return option(() => (this.daystart = true))
      case '-mount':
      case '-xdev':
      case '-noleaf':
      case '-ignore_readdir_race':
      case '-noignore_readdir_race':
      case '-follow':
      case '-warn':
      case '-nowarn':
        return option(() => {})
      case '-regextype': {
        const t = this.arg(pred)
        const types = ['findutils-default', 'ed', 'emacs', 'gnu-awk', 'grep', 'posix-awk', 'awk', 'posix-basic', 'posix-egrep', 'egrep', 'posix-extended', 'posix-minimal-basic', 'sed']
        if (!types.includes(t)) throw new FindError(`find: Unknown regular expression type '${t}'; valid types are ${types.map((x) => `'${x}'`).join(', ')}.`)
        return option(() => {})
      }
      case '-files0-from':
        throw new FindError('find: -files0-from: reading starting points from a file is not supported here')

      // Tests: names and paths
      case '-name':
      case '-iname': {
        const p = this.arg(pred)
        if (p.includes('/') && p !== '/')
          this.warnings.push(
            `find: warning: '${pred}' matches against basenames only, but the given pattern contains a directory separator ('/'), thus the expression will evaluate to false all the time.  Did you mean '-wholename'?`,
          )
        const re = globToRegExp(p, { ci: pred === '-iname' })
        return test((e) => re.test(baseName(e)))
      }
      case '-path':
      case '-ipath':
      case '-wholename':
      case '-iwholename': {
        const re = globToRegExp(this.arg(pred), { ci: pred.startsWith('-i') })
        return test((e) => re.test(e.shown))
      }
      case '-regex':
      case '-iregex': {
        const p = this.arg(pred)
        let re: RegExp
        try {
          re = new RegExp(`^(?:${p})$`, pred === '-iregex' ? 'si' : 's')
        } catch (err) {
          throw new FindError(`find: Invalid regular expression '${p}': ${(err as Error).message.replace(/^.*: /, '')}`)
        }
        return test((e) => re.test(e.shown))
      }
      case '-lname':
      case '-ilname':
        this.arg(pred)
        return test(() => false)

      // Tests: types and sizes
      case '-type':
      case '-xtype': {
        const a = this.arg(pred)
        const kinds = a.split(',')
        for (const k of kinds) {
          if (!k) throw new FindError(`find: Last file type in list argument to ${pred} is missing, i.e., list is ending on: ','`)
          if (k.length > 1) throw new FindError(`find: Must separate multiple arguments to ${pred} using: ','`)
          if (!'bcdpflsD'.includes(k)) throw new FindError(`find: Unknown argument to ${pred}: ${k}`)
        }
        return test((e) => kinds.includes(e.node.type === 'dir' ? 'd' : 'f'))
      }
      case '-size': {
        const a = this.arg(pred)
        const m = /^([+-]?)(\d+)([bcwkMG]?)$/.exec(a)
        if (!m) throw new FindError(`find: invalid -size type '${a.replace(/^[+-]?\d+/, '')}'`)
        const unit = SIZE_UNITS[m[3] || 'b']
        const cmp = parseN(m[1] + m[2], pred)
        return test((e) => cmp(Math.ceil(sizeOf(e.abs, e.node) / unit)))
      }
      case '-empty':
        return test((e) => isEmpty(e.abs, e.node))

      // Tests: times
      case '-mtime':
      case '-atime':
      case '-ctime': {
        const cmp = parseN(this.arg(pred), pred)
        return test((e) => cmp(Math.floor((now() - mtimeOf(e.abs, e.node)) / 864e5)))
      }
      case '-mmin':
      case '-amin':
      case '-cmin': {
        const cmp = parseN(this.arg(pred), pred)
        return test((e) => cmp(Math.ceil((now() - mtimeOf(e.abs, e.node)) / 6e4)))
      }
      case '-used': {
        parseN(this.arg(pred), pred)
        return test(() => false)
      }
      case '-newer':
      case '-anewer':
      case '-cnewer': {
        const ref = refFile()
        const t = mtimeOf(ref.abs, ref.node)
        return test((e) => mtimeOf(e.abs, e.node) > t)
      }

      // Tests: ownership and permissions
      case '-user':
      case '-group': {
        const name = this.arg(pred)
        if (!/^\d+$/.test(name) && name !== profile.handle && name !== 'root') throw new FindError(`find: '${name}' is not the name of a known ${pred === '-user' ? 'user' : 'group'}`)
        return test((e) => (/^\d+$/.test(name) ? idOf(e.abs) === Number(name) : owner(e.abs) === name))
      }
      case '-uid':
      case '-gid': {
        const cmp = parseN(this.arg(pred), pred)
        return test((e) => cmp(idOf(e.abs)))
      }
      case '-nouser':
      case '-nogroup':
        return test(() => false)
      case '-perm': {
        const a = this.arg(pred)
        const kind = a[0] === '-' || a[0] === '/' ? a[0] : ''
        const want = parseMode(kind ? a.slice(1) : a, pred)
        return test((e) => {
          const m = modeOf(e.abs, e.node) & 0o7777
          return kind === '-' ? (m & want) === want : kind === '/' ? want === 0 || (m & want) !== 0 : m === want
        })
      }
      case '-readable':
        return test(() => true)
      case '-writable':
        return test((e) => e.abs === '/tmp' || isUnderTmp(e.abs))
      case '-executable':
        return test((e) => isExecutable(e.node))
      case '-links': {
        const cmp = parseN(this.arg(pred), pred)
        return test((e) => cmp(linksOf(e.node)))
      }
      case '-inum': {
        const cmp = parseN(this.arg(pred), pred)
        return test((e) => cmp(inodeOf(e.abs)))
      }
      case '-samefile': {
        const ref = refFile()
        return test((e) => e.abs === ref.abs)
      }
      case '-fstype': {
        const t = this.arg(pred)
        return test((e) => fsType(e.abs) === t)
      }
      case '-context':
        this.arg(pred)
        return test(() => false)
      case '-true':
        return test(() => true)
      case '-false':
        return test(() => false)

      // Actions
      case '-print':
        return action((e) => (st.out.push(`${e.shown}\n`), true))
      case '-print0':
        return action((e) => (st.out.push(`${e.shown}\0`), true))
      case '-printf': {
        const f = compilePrintf(this.arg(pred))
        return action((e) => (st.out.push(f(e)), true))
      }
      case '-ls':
        return action((e) => (st.out.push(`${lsLine(e)}\n`), true))
      case '-fprint':
      case '-fprint0':
      case '-fls':
      case '-fprintf': {
        const file = this.arg(pred)
        const f = pred === '-fprintf' ? compilePrintf(this.arg(pred)) : null
        const abs = resolvePath(st.ctx.cwd, file)
        if (!isUnderTmp(abs) || abs.slice(5).includes('/')) throw new FindError(`find: '${file}': Read-only file system`)
        if (!st.files.has(file)) st.files.set(file, [])
        const buf = st.files.get(file)!
        return action((e) => (buf.push(pred === '-fprint' ? `${e.shown}\n` : pred === '-fprint0' ? `${e.shown}\0` : pred === '-fls' ? `${lsLine(e)}\n` : f!(e)), true))
      }
      case '-delete':
        this.depthFirst = true
        return action((e) => {
          if (e.abs === '/tmp' || !isUnderTmp(e.abs)) {
            st.out.push(`${c('red', `find: cannot delete '${e.shown}': Read-only file system`)}\n`)
            st.failed = true
            return false
          }
          if (e.node.type === 'dir' && e.node.children.size) {
            st.out.push(`${c('red', `find: cannot delete '${e.shown}': Directory not empty`)}\n`)
            st.failed = true
            return false
          }
          ;(lookup('/tmp') as DirNode).children.delete(e.node.name)
          return true
        })
      case '-prune':
        return { ev: async () => ((st.prune = true), true), action: false }
      case '-quit':
        return { ev: async () => ((st.quit = true), true), action: false }
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir':
        return this.exec(pred)

      case '-help':
      case '--help':
        throw new HelpRequest(FIND_HELP)
      case '-version':
      case '--version':
        throw new HelpRequest(FIND_VERSION)
      default:
        if (/^-newer[aBcm][aBcmt]$/.test(pred)) {
          const a = this.arg(pred)
          let t: number
          if (pred.endsWith('t')) {
            const parsed = parseDate(a)
            if (parsed === null) throw new FindError(`find: I cannot figure out how to interpret '${a}' as a date or time`)
            t = parsed
          } else {
            const abs = resolvePath(st.ctx.cwd, a)
            const node = lookup(abs)
            if (!node) throw new FindError(`find: '${a}': No such file or directory`)
            t = mtimeOf(abs, node)
          }
          return test((e) => mtimeOf(e.abs, e.node) > t)
        }
        if (pred.startsWith('-')) throw new FindError(`find: unknown predicate '${pred}'`)
        throw new FindError(
          `find: paths must precede expression: '${pred}'` +
            (this.i >= 3 && TAKES_PATTERN.has(this.toks[this.i - 3]) ? `\nfind: possible unquoted pattern after predicate '${this.toks[this.i - 3]}'?` : ''),
        )
    }
  }

  /** -exec CMD ; runs once per file; -exec CMD {} + gathers files and runs at the end. */
  exec(pred: string): Expr {
    const st = this.st
    const cmd: string[] = []
    let batch = false
    for (;;) {
      if (this.i >= this.toks.length) throw new FindError(`find: missing argument to '${pred}'`)
      const t = this.next()
      if (t === ';') break
      if (t === '+' && cmd[cmd.length - 1] === '{}' && !pred.startsWith('-ok')) {
        batch = true
        cmd.pop()
        break
      }
      cmd.push(t)
    }
    if (!cmd.length) throw new FindError(`find: missing argument to '${pred}'`)
    if (batch && cmd.includes('{}')) throw new FindError(`find: In '${pred} ... {} +' the '{}' must appear by itself, but you specified '${cmd.find((x) => x.includes('{}'))}'`)
    const inDir = pred.endsWith('dir')
    const where = (e: Entry) => {
      if (!inDir) return { path: e.shown, cwd: st.ctx.cwd }
      const parent = e.abs === '/' ? '/' : e.abs.replace(/\/[^/]*$/, '') || '/'
      return { path: e.abs === '/' ? '/' : `./${e.node.name}`, cwd: parent }
    }
    this.sawTest ??= pred
    if (batch) {
      const group = { cmd, dir: inDir, paths: [] as { path: string; cwd: string }[] }
      st.batches.push(group)
      return { ev: async (e) => (group.paths.push(where(e)), true), action: true }
    }
    return {
      action: true,
      ev: async (e) => {
        const { path, cwd } = where(e)
        const line = cmd.map((a) => quote(a.replaceAll('{}', path))).join(' ')
        if (pred.startsWith('-ok')) {
          st.ctx.print(`< ${cmd.map((a) => a.replaceAll('{}', path)).join(' ')} > ? `)
          const yes = await askYesNo(st.ctx)
          if (!yes) return false
        }
        const r = await runCommand(st.ctx, line, cwd)
        if (r.output) st.out.push(`${r.output}\n`)
        return r.ok
      },
    }
  }
}

class HelpRequest extends Error {}

/** -ok's question: y answers yes, anything else no (Ctrl+C stops). */
function askYesNo(ctx: Ctx): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      ctx.onKey(null)
      resolve(v)
    }
    ctx.signal.addEventListener('abort', () => done(false), { once: true })
    ctx.onKey((k) => {
      if (k.length === 1 || k === 'Enter' || k === 'Escape') done(k === 'y' || k === 'Y')
      return true
    })
  })
}

async function find(ctx: Ctx): Promise<string> {
  const st: FindState = { ctx, out: [], failed: false, prune: false, quit: false, files: new Map(), batches: [] }
  const args = ctx.args.slice()
  // Leading -H, -L, -P, -O3 and -D opts come before the starting points.
  while (args.length && /^-([HLP]|O\d?)$/.test(args[0])) args.shift()
  while (args[0] === '-D') {
    args.shift()
    const opt = args.shift()
    if (opt === 'help')
      return `Valid arguments for -D:
exec       Show diagnostic information relating to -exec, -execdir, -ok and -okdir
opt        Show diagnostic information relating to optimisation
rates      Indicate how often each predicate succeeded
search     Navigate the directory tree verbosely
stat       Trace calls to stat(2) and lstat(2)
time       Show diagnostic information relating to time-of-day and timestamps
tree       Display the expression tree
all        Set all of the debug flags (but help)
help       Explain the various -D options`
  }
  if (args.includes('--help') || args.includes('-help')) return FIND_HELP
  if (args.includes('--version') || args.includes('-version')) return FIND_VERSION
  const starts: string[] = []
  while (args.length && !(args[0].startsWith('-') && args[0].length > 1) && !['(', ')', '!', ','].includes(args[0])) starts.push(args.shift()!)
  if (!starts.length) starts.push('.')

  let parser: FindParser
  let expr: Expr
  try {
    parser = new FindParser(args, st)
    expr = parser.parse()
  } catch (err) {
    if (err instanceof HelpRequest) return err.message
    if (err instanceof FindError) throw new CmdError(c('red', err.message), true)
    throw err
  }
  // Without an action (other than -prune or -quit), everything that matches is printed.
  if (!expr.action) {
    const inner = expr
    expr = { ev: async (e) => (await inner.ev(e)) && (st.out.push(`${e.shown}\n`), true), action: true }
  }
  const warnings = parser.warnings.map((w) => `${c('yellow', w)}\n`)

  const visit = async (e: Entry): Promise<void> => {
    if (st.quit || ctx.signal.aborted) return
    const here = e.depth >= parser.mindepth
    st.prune = false
    if (!parser.depthFirst && here) await expr.ev(e)
    const pruned = st.prune && !parser.depthFirst
    if (e.node.type === 'dir' && e.depth < parser.maxdepth && !pruned)
      for (const child of [...e.node.children.values()]) {
        if (st.quit) return
        const abs = e.abs === '/' ? `/${child.name}` : `${e.abs}/${child.name}`
        const shown = e.shown.endsWith('/') ? e.shown + child.name : `${e.shown}/${child.name}`
        await visit({ abs, shown, node: child, depth: e.depth + 1, start: e.start })
      }
    if (parser.depthFirst && here && !st.quit) await expr.ev(e)
  }

  for (const s of starts) {
    if (st.quit) break
    const shown = s === '~' ? HOME : s.startsWith('~/') ? HOME + s.slice(1) : s
    const abs = resolvePath(ctx.cwd, s)
    const node = lookup(abs)
    if (!node) {
      st.out.push(`${c('red', `find: '${s}': No such file or directory`)}\n`)
      st.failed = true
      continue
    }
    const start = { abs, shown }
    await visit({ abs, shown, node, depth: 0, start })
  }

  // -exec ... {} + runs once at the end with everything it gathered (per folder for -execdir).
  for (const b of st.batches) {
    const groups = new Map<string, string[]>()
    for (const p of b.paths) groups.set(p.cwd, [...(groups.get(p.cwd) ?? []), p.path])
    for (const [cwd, paths] of groups) {
      if (!paths.length) continue
      const r = await runCommand(ctx, [...b.cmd, ...paths].map(quote).join(' '), cwd)
      if (r.output) st.out.push(`${r.output}\n`)
      if (!r.ok) st.failed = true
    }
  }
  for (const [file, chunks] of st.files) writeTmp(ctx.cwd, file, chunks.join('').replace(/\n$/, ''), false)

  const text = [...warnings, ...st.out].join('').replace(/\n$/, '')
  if (st.failed) throw new CmdError(text, true)
  return text
}

/** Tab after `find`: its tests, actions and options, once the word starts with a dash. */
function completeFind(_args: string[], word: string): Completion[] {
  if (!word.startsWith('-')) return []
  return FIND_PRIMARIES.filter(([n]) => n.startsWith(word)).map(([n, a, d]) => ({ value: n, label: a ? `${n} ${a}` : n, hint: d }))
}

// ---------------------------------------------------------------------------------------------
// fd

const FD_VERSION = 'fd 10.2.0'

/** fd's options: long name, short letter, value name (if it takes one) and the help text. */
type FdOption = { long: string; short?: string; value?: string; help: string; long_help?: string; hidden?: boolean }
const FD_OPTIONS: FdOption[] = [
  { long: 'hidden', short: 'H', help: 'Search hidden files and directories', long_help: 'Include hidden directories and files in the search results (default: hidden files and directories are skipped). Files and directories are considered to be hidden if their name starts with a `.` sign (dot). Any files or directories that are ignored due to the rules described by --no-ignore are still ignored unless otherwise specified. The flag can be overridden with --no-hidden.' },
  { long: 'no-hidden', help: 'Overrides --hidden', hidden: true },
  { long: 'no-ignore', short: 'I', help: 'Do not respect .(git|fd)ignore files', long_help: 'Show search results from files and directories that would otherwise be ignored by \'.gitignore\', \'.ignore\', \'.fdignore\', or the global ignore file. The flag can be overridden with --ignore.' },
  { long: 'ignore', help: 'Overrides --no-ignore', hidden: true },
  { long: 'no-ignore-vcs', help: 'Do not respect .gitignore files', long_help: 'Show search results from files and directories that would otherwise be ignored by \'.gitignore\' files.' },
  { long: 'no-ignore-parent', help: 'Do not respect .(git|fd)ignore files in parent directories', long_help: 'Show search results from files and directories that would otherwise be ignored by \'.gitignore\', \'.ignore\', or \'.fdignore\' files in parent directories.' },
  { long: 'unrestricted', short: 'u', help: 'Unrestricted search, alias for \'--no-ignore --hidden\'', long_help: 'Perform an unrestricted search, including ignored and hidden files. This is an alias for \'--no-ignore --hidden\'.' },
  { long: 'case-sensitive', short: 's', help: 'Case-sensitive search (default: smart case)', long_help: 'Perform a case-sensitive search. By default, fd uses case-insensitive searches, unless the pattern contains an uppercase character (smart case).' },
  { long: 'ignore-case', short: 'i', help: 'Case-insensitive search (default: smart case)', long_help: 'Perform a case-insensitive search. By default, fd uses case-insensitive searches, unless the pattern contains an uppercase character (smart case).' },
  { long: 'glob', short: 'g', help: 'Glob-based search (default: regular expression)', long_help: 'Perform a glob-based search instead of a regular expression search.' },
  { long: 'regex', help: 'Regular-expression based search (default)', long_help: 'Perform a regular-expression based search (default). This can be used to override --glob.' },
  { long: 'fixed-strings', short: 'F', help: 'Treat pattern as literal string stead of regex', long_help: 'Treat the pattern as a literal string instead of a regular expression. Note that this also performs substring comparison. If you want to match on an exact filename, consider using \'--glob\'.' },
  { long: 'and', value: 'pattern', help: 'Additional search patterns that need to be matched', long_help: 'Add additional required search patterns, all of which must be matched. Multiple additional patterns can be specified. The patterns are regular expressions, unless \'--glob\' or \'--fixed-strings\' is used.' },
  { long: 'absolute-path', short: 'a', help: 'Show absolute instead of relative paths', long_help: 'Shows the full path starting from the root as opposed to relative paths. The flag can be overridden with --relative-path.' },
  { long: 'relative-path', help: 'Overrides --absolute-path', hidden: true },
  { long: 'list-details', short: 'l', help: 'Use a long listing format with file metadata', long_help: "Use a detailed listing format like 'ls -l'. This is basically an alias for '--exec-batch ls -l' with some additional 'ls' options. This can be used to see more metadata, to show symlink targets and to achieve a deterministic sort order." },
  { long: 'follow', short: 'L', help: 'Follow symbolic links', long_help: 'By default, fd does not descend into symlinked directories. Using this flag, symbolic links are also traversed. Flag can be overridden with --no-follow.' },
  { long: 'full-path', short: 'p', help: 'Search full abs. path (default: filename only)', long_help: "By default, the search pattern is only matched against the filename (or directory name). Using this flag, the pattern is matched against the full (absolute) path. Example:\n  fd --glob -p '**/.git/config'" },
  { long: 'print0', short: '0', help: 'Separate search results by the null character', long_help: "Separate search results by the null character (instead of newlines). Useful for piping results to 'xargs'." },
  { long: 'max-depth', short: 'd', value: 'depth', help: 'Set maximum search depth (default: none)', long_help: 'Limit the directory traversal to a given depth. By default, there is no limit on the search depth.' },
  { long: 'min-depth', value: 'depth', help: 'Only show search results starting at the given depth.', long_help: "Only show search results starting at the given depth. See also: '--max-depth' and '--exact-depth'" },
  { long: 'exact-depth', value: 'depth', help: 'Only show search results at the exact given depth', long_help: "Only show search results at the exact given depth. This is an alias for '--min-depth <depth> --max-depth <depth>'." },
  { long: 'exclude', short: 'E', value: 'pattern', help: 'Exclude entries that match the given glob pattern', long_help: "Exclude files/directories that match the given glob pattern. This overrides any other ignore logic. Multiple exclude patterns can be specified.\n\nExamples:\n  --exclude '*.pyc'\n  --exclude node_modules" },
  { long: 'prune', help: 'Do not traverse into directories that match the search criteria. If you want to exclude specific directories, use the \'--exclude=…\' option.' },
  { long: 'type', short: 't', value: 'filetype', help: 'Filter by type: file (f), directory (d/dir), symlink (l), executable (x), empty (e), socket (s), pipe (p), char-device (c), block-device (b)', long_help: "Filter the search by type:\n  'f' or 'file':         regular files\n  'd' or 'dir' or 'directory':    directories\n  'l' or 'symlink':      symbolic links\n  's' or 'socket':       socket\n  'p' or 'pipe':         named pipe (FIFO)\n  'b' or 'block-device': block device\n  'c' or 'char-device':  character device\n\n  'x' or 'executable':   executables\n  'e' or 'empty':        empty files or directories\n\nThis option can be specified more than once to include multiple file types. Searching for '--type file --type symlink' will show both regular files as well as symlinks. Note that the 'executable' and 'empty' filters work differently: '--type executable' implies '--type file' by default. And '--type empty' searches for empty files and directories, unless either '--type file' or '--type directory' is specified in addition.\n\nExamples:\n  - Only search for files:\n      fd --type file …\n      fd -tf …\n  - Find both files and symlinks\n      fd --type file --type symlink …\n      fd -tf -tl …\n  - Find executable files:\n      fd --type executable\n      fd -tx\n  - Find empty files:\n      fd --type empty --type file\n      fd -te -tf\n  - Find empty directories:\n      fd --type empty --type directory\n      fd -te -td" },
  { long: 'extension', short: 'e', value: 'ext', help: 'Filter by file extension', long_help: "(Additionally) filter search results by their file extension. Multiple allowable file extensions can be specified.\n\nIf you want to search for files without extension, you can use the regex '^[^.]+$' as a normal search pattern." },
  { long: 'size', short: 'S', value: 'size', help: 'Limit results based on the size of files', long_help: "Limit results based on the size of files using the format <+-><NUM><UNIT>.\n   '+': file size must be greater than or equal to this\n   '-': file size must be less than or equal to this\n\nIf neither '+' nor '-' is specified, file size must be exactly equal to this.\n   'NUM':  The numeric size (e.g. 500)\n   'UNIT': The units for NUM. They are not case-sensitive.\nAllowed unit values:\n    'b':  bytes\n    'k':  kilobytes (base ten, 10^3 = 1000 bytes)\n    'm':  megabytes\n    'g':  gigabytes\n    't':  terabytes\n    'ki': kibibytes (base two, 2^10 = 1024 bytes)\n    'mi': mebibytes\n    'gi': gibibytes\n    'ti': tebibytes" },
  { long: 'changed-within', value: 'date|dur', help: 'Filter by file modification time (newer than)', long_help: "Filter results based on the file modification time. Files with modification times greater than the argument are returned. The argument can be provided as a specific point in time (YYYY-MM-DD HH:MM:SS or @timestamp) or as a duration (10h, 1d, 35min). If the time is not specified, it defaults to 00:00:00. '--change-newer-than', '--newer', or '--changed-after' can be used as aliases.\n\nExamples:\n    --changed-within 2weeks\n    --change-newer-than '2018-10-27 10:00:00'\n    --newer 2018-10-27\n    --changed-after 1day" },
  { long: 'changed-before', value: 'date|dur', help: 'Filter by file modification time (older than)', long_help: "Filter results based on the file modification time. Files with modification times less than the argument are returned. The argument can be provided as a specific point in time (YYYY-MM-DD HH:MM:SS or @timestamp) or as a duration (10h, 1d, 35min). '--change-older-than' or '--older' can be used as aliases.\n\nExamples:\n    --changed-before '2018-10-27 10:00:00'\n    --change-older-than 2weeks\n    --older 2018-10-27" },
  { long: 'owner', short: 'o', value: 'user:group', help: 'Filter by owning user and/or group', long_help: "Filter files by their user and/or group. Format: [(user|uid)][:(group|gid)]. Either side is optional. Precede either side with a '!' to exclude files instead.\n\nExamples:\n    --owner john\n    --owner :students\n    --owner '!john:students'" },
  { long: 'one-file-system', help: 'Do not descend into a different file system', long_help: "By default, fd will traverse the file system tree as far as other options dictate. With this flag, fd ensures that it does not descend into a different file system than the one it started in. Comparable to the -mount or -xdev filters of find(1)." },
  { long: 'format', value: 'fmt', help: 'Print results according to template', long_help: "Print each search result according to a template. The template can contain the placeholders described for --exec:\n  '{}':   path (of the current search result)\n  '{/}':  basename\n  '{//}': parent directory\n  '{.}':  path without file extension\n  '{/.}': basename without file extension\n  '{{':   literal '{' (for escaping)\n  '}}':   literal '}' (for escaping)" },
  { long: 'exec', short: 'x', value: 'cmd', help: 'Execute a command for each search result', long_help: "Execute a command for each search result.\nThe command is ended by a ';' argument (use '\\;' in the shell) or by the end of the line. The following placeholders are substituted before the command is executed:\n  '{}':   path (of the current search result)\n  '{/}':  basename\n  '{//}': parent directory\n  '{.}':  path without file extension\n  '{/.}': basename without file extension\n  '{{':   literal '{' (for escaping)\n  '}}':   literal '}' (for escaping)\n\nIf no placeholder is present, an implicit \"{}\" at the end is assumed.\n\nExamples:\n\n  - find all *.zip files and unzip them:\n\n      fd -e zip -x unzip\n\n  - find *.h and *.cpp files and run \"clang-format -i ..\" for each of them:\n\n      fd -e h -e cpp -x clang-format -i" },
  { long: 'exec-batch', short: 'X', value: 'cmd', help: 'Execute a command with all search results at once', long_help: "Execute the given command once, with all search results as arguments.\nThe command is ended by a ';' argument or by the end of the line. One of the following placeholders is substituted before the command is executed:\n  '{}':   path (of all search results)\n  '{/}':  basename\n  '{//}': parent directory\n  '{.}':  path without file extension\n  '{/.}': basename without file extension\n\nIf no placeholder is present, an implicit \"{}\" at the end is assumed.\n\nExamples:\n\n  - Find all test_*.py files and open them in your favorite editor:\n\n      fd -g 'test_*.py' -X vim\n\n  - Find all *.rs files and count the lines with \"wc -l ...\":\n\n      fd -e rs -X wc -l" },
  { long: 'batch-size', value: 'size', help: 'Max number of arguments to run as a batch size with -X', long_help: 'Maximum number of arguments to pass to the command given with -X. If the number of results is greater than the given size, the command given with -X is run again with remaining arguments. A batch size of zero means there is no limit (default), but note that batching might still happen due to OS restrictions on the maximum length of command lines.' },
  { long: 'ignore-file', value: 'path', help: 'Add a custom ignore-file in \'.gitignore\' format', long_help: "Add a custom ignore-file in '.gitignore' format. These files have a low precedence." },
  { long: 'color', short: 'c', value: 'when', help: 'When to use colors [default: auto] [possible values: auto, always, never]', long_help: "Declare when to use color for the pattern match output\n\nPossible values:\n- auto:   show colors if the output goes to an interactive console (default)\n- always: always use colorized output\n- never:  do not use colorized output" },
  { long: 'hyperlink', value: 'when', help: 'Add hyperlinks to output paths [default: never] [possible values: auto, always, never]' },
  { long: 'threads', short: 'j', value: 'num', help: 'Set number of threads to use for searching & executing (default: number of available CPU cores)' },
  { long: 'max-results', value: 'count', help: 'Limit the number of search results', long_help: 'Limit the number of search results to \'count\' and quit immediately.' },
  { long: 'max-one-result', short: '1', help: 'Limit search to a single result', long_help: "Limit the search to a single result and quit immediately. This is an alias for '--max-results=1'." },
  { long: 'quiet', short: 'q', help: 'Print nothing, exit code 0 if match found, 1 otherwise', long_help: "When the flag is present, the program does not print anything and will return with an exit code of 0 if there is at least one match. Otherwise, the exit code will be 1. '--has-results' can be used as an alias." },
  { long: 'show-errors', help: 'Show filesystem errors', long_help: 'Enable the display of filesystem errors for situations such as insufficient permissions or dead symlinks.' },
  { long: 'base-directory', value: 'path', help: 'Change current working directory', long_help: 'Change the current working directory of fd to the provided path. This means that search results will be shown with respect to the given base path. Note that relative paths which are passed to fd via the positional <path> argument or the \'--search-path\' option will also be resolved relative to this directory.' },
  { long: 'path-separator', value: 'separator', help: 'Set path separator when printing file paths', long_help: 'Set the path separator to use when printing file paths. The default is the OS-specific separator (\'/\' on Unix, \'\\\' on Windows).' },
  { long: 'search-path', value: 'search-path', help: 'Provides paths to search as an alternative to the positional <path> argument', long_help: "Provide paths to search as an alternative to the positional <path> argument. Changes the usage to `fd [OPTIONS] --search-path <path> --search-path <path2> [<pattern>]`" },
  { long: 'strip-cwd-prefix', value: 'when', help: 'By default, relative paths are prefixed with \'./\' when -x/--exec, -X/--exec-batch, or -0/--print0 are given, to reduce the risk of a path starting with \'-\' being treated as a command line option. Use this flag to change this behavior. If this flag is used without a value, it is equivalent to passing "always".' },
  { long: 'help', short: 'h', help: "Print help (see more with '--help')" },
  { long: 'version', short: 'V', help: 'Print version' },
]
const FD_ALIASES: Record<string, string> = {
  'change-newer-than': 'changed-within',
  newer: 'changed-within',
  'changed-after': 'changed-within',
  'change-older-than': 'changed-before',
  older: 'changed-before',
  'has-results': 'quiet',
  'no-ignore-vcs': 'no-ignore-vcs',
}
const FD_SHORT_HELP = new Set(['hidden', 'no-ignore', 'case-sensitive', 'ignore-case', 'glob', 'absolute-path', 'list-details', 'follow', 'full-path', 'max-depth', 'exclude', 'type', 'extension', 'size', 'changed-within', 'changed-before', 'owner', 'format', 'exec', 'exec-batch', 'color', 'hyperlink', 'help', 'version'])

/** Wraps help text at `width` columns, continuing at `indent`. */
function wrap(text: string, width: number, indent: number): string {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/(?<=\S) (?=\S)/)) {
      if (line && line.length + 1 + word.length > width - indent) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    lines.push(line)
  }
  return lines.map((l, i) => (i ? ' '.repeat(indent) + l : l)).join('\n')
}

const optName = (o: FdOption) => `${o.short ? `-${o.short}, ` : '    '}--${o.long}${o.value ? ` <${o.value}>` : ''}`

/** `fd -h`: one line per option, like clap's short help. */
function fdShortHelp() {
  const shown = FD_OPTIONS.filter((o) => FD_SHORT_HELP.has(o.long))
  return [
    'A program to find entries in your filesystem',
    '',
    `${c('bold', 'Usage:')} fd [OPTIONS] [pattern] [path]...`,
    '',
    c('bold', 'Arguments:'),
    "  [pattern]  the search pattern (a regular expression, unless '--glob' is used; optional)",
    '  [path]...  the root directories for the filesystem search (optional)',
    '',
    c('bold', 'Options:'),
    ...shown.map((o) => `  ${optName(o).padEnd(31)}  ${wrap(o.help, 100, 35)}`),
  ].join('\n')
}

/** `fd --help`: every option with its long explanation, like clap's long help. */
function fdLongHelp() {
  return [
    'A program to find entries in your filesystem',
    '',
    `${c('bold', 'Usage:')} fd [OPTIONS] [pattern] [path]...`,
    '',
    c('bold', 'Arguments:'),
    '  [pattern]',
    `          ${wrap("the search pattern which is either a regular expression (default) or a glob pattern (if --glob is used). If no pattern has been specified, every entry is considered a match. If your pattern starts with a dash (-), make sure to pass '--' first, or it will be considered as a flag (fd -- '-foo').", 100, 10)}`,
    '',
    '  [path]...',
    `          ${wrap('The directory where the filesystem search is rooted (optional). If omitted, search the current working directory.', 100, 10)}`,
    '',
    c('bold', 'Options:'),
    ...FD_OPTIONS.filter((o) => !o.hidden).flatMap((o) => [`  ${optName(o)}`, `          ${wrap(o.long_help ?? o.help, 100, 10)}`, '']),
  ]
    .join('\n')
    .trimEnd()
}

const FD_MAN = `${c('bold', 'NAME')}
       fd - find entries in the filesystem

${c('bold', 'SYNOPSIS')}
       fd [-HIEsiaLp0hV] [-d depth] [-t filetype] [-e ext] [-E exclude] [-c when] [-j num]
          [-x cmd] [pattern] [path...]

${c('bold', 'DESCRIPTION')}
       fd is a simple, fast and user-friendly alternative to find(1).

       By default fd uses regular expressions for the pattern. However, this can be changed to
       use simple glob patterns with the '--glob' option.

       By default fd will exclude hidden files and directories, as well as any files that match
       gitignore rules or ignore rules in .ignore or .fdignore files.

       The pattern is matched against the file name only, unless --full-path is given, and the
       search is case-insensitive unless the pattern contains an uppercase letter (smart case).

${c('bold', 'OPTIONS')}
${FD_OPTIONS.filter((o) => !o.hidden)
  .map((o) => `       ${optName(o).trim()}\n              ${wrap(o.long_help ?? o.help, 92, 14)}`)
  .join('\n\n')}

${c('bold', 'EXAMPLES')}
       fd md                       anything with "md" in its name
       fd -e md                    Markdown files
       fd -tf -e url . projects    the links inside projects/
       fd -H bash                  hidden files too (.bashrc)
       fd -S +1mi                  files of a mebibyte or more
       fd -g 'README*' -x head -3  the first lines of every README
       fd --changed-within 1week   changed this week

${c('bold', 'SEE ALSO')}
       find(1), grep(1), ls(1)`

type FdOpts = {
  hidden: boolean
  noIgnore: boolean
  caseMode: 'smart' | 'sensitive' | 'insensitive'
  mode: 'regex' | 'glob' | 'fixed'
  absolute: boolean
  listDetails: boolean
  fullPath: boolean
  print0: boolean
  maxDepth: number
  minDepth: number
  excludes: string[]
  types: Set<string>
  extensions: string[]
  sizes: ((n: number) => boolean)[]
  within: number | null
  before: number | null
  owner: { user?: string; group?: string; notUser?: boolean; notGroup?: boolean } | null
  format: string | null
  exec: string[] | null
  execBatch: string[] | null
  batchSize: number
  color: 'auto' | 'always' | 'never'
  maxResults: number
  quiet: boolean
  prune: boolean
  baseDir: string | null
  searchPaths: string[]
  and: string[]
  separator: string
  stripCwd: 'auto' | 'always' | 'never'
}

/** clap's usage error, the way fd prints it. */
const clapError = (msg: string, tip?: string) =>
  new CmdError(`${c('red', 'error:')} ${msg}\n${tip ? `\n  ${c('green', 'tip:')} ${tip}\n` : ''}\n${c('bold', 'Usage:')} fd [OPTIONS] [pattern] [path]...\n\nFor more information, try '${c('bold', '--help')}'.`, true)
const fdError = (msg: string) => new CmdError(`${c('red', '[fd error]:')} ${msg}`, true)

const TYPE_NAMES: Record<string, string> = { f: 'f', file: 'f', d: 'd', dir: 'd', directory: 'd', l: 'l', symlink: 'l', x: 'x', executable: 'x', e: 'e', empty: 'e', s: 's', socket: 's', p: 'p', pipe: 'p', b: 'b', 'block-device': 'b', c: 'c', 'char-device': 'c' }

const SIZE_FD: Record<string, number> = { b: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9, t: 1e12, tb: 1e12, ki: 1024, kib: 1024, mi: 1024 ** 2, mib: 1024 ** 2, gi: 1024 ** 3, gib: 1024 ** 3, ti: 1024 ** 4, tib: 1024 ** 4 }

/** humantime durations (2weeks, 1d, 35min) or dates, as an instant. */
function parseWhen(s: string, opt: string): number {
  if (s.startsWith('@') && /^@\d+$/.test(s)) return Number(s.slice(1)) * 1000
  const units: [RegExp, number][] = [
    [/^(ns|nsec)$/, 1e-6],
    [/^(us|usec)$/, 1e-3],
    [/^(ms|msec)$/, 1],
    [/^(s|sec|secs|second|seconds)$/, 1e3],
    [/^(m|min|mins|minute|minutes)$/, 6e4],
    [/^(h|hr|hrs|hour|hours)$/, 36e5],
    [/^(d|day|days)$/, 864e5],
    [/^(w|week|weeks)$/, 6048e5],
    [/^(M|month|months)$/, 2630016e3],
    [/^(y|year|years)$/, 31557600e3],
  ]
  const parts = [...s.matchAll(/(\d+)\s*([a-zA-Z]+)/g)]
  if (parts.length && parts.map((p) => p[0]).join('').replace(/\s/g, '') === s.replace(/\s/g, '')) {
    let ms = 0
    for (const [, n, u] of parts) {
      const unit = units.find(([re]) => re.test(u))
      if (!unit) throw clapError(`invalid value '${s}' for '--${opt} <date|dur>': unknown time unit "${u}", supported units: ns, us, ms, sec, min, hours, days, weeks, months, years (and few variations)`)
      ms += Number(n) * unit[1]
    }
    return Date.now() - ms
  }
  const t = parseDate(s)
  if (t === null) throw clapError(`invalid value '${s}' for '--${opt} <date|dur>': '${s}' is not a valid date or duration. See 'fd --help'.`)
  return t
}

function parseFdArgs(args: string[]): { opts: FdOpts; positional: string[] } {
  const o: FdOpts = {
    hidden: false,
    noIgnore: false,
    caseMode: 'smart',
    mode: 'regex',
    absolute: false,
    listDetails: false,
    fullPath: false,
    print0: false,
    maxDepth: Infinity,
    minDepth: 0,
    excludes: [],
    types: new Set(),
    extensions: [],
    sizes: [],
    within: null,
    before: null,
    owner: null,
    format: null,
    exec: null,
    execBatch: null,
    batchSize: 0,
    color: 'auto',
    maxResults: Infinity,
    quiet: false,
    prune: false,
    baseDir: null,
    searchPaths: [],
    and: [],
    separator: '/',
    stripCwd: 'auto',
  }
  const positional: string[] = []
  const byLong = new Map(FD_OPTIONS.map((x) => [x.long, x]))
  const byShort = new Map(FD_OPTIONS.filter((x) => x.short).map((x) => [x.short!, x]))
  const depth = (v: string, opt: FdOption) => {
    if (!/^\d+$/.test(v)) throw clapError(`invalid value '${v}' for '--${opt.long} <${opt.value}>': invalid digit found in string`)
    return Number(v)
  }

  // Applies one option; returns how many following args it used (for -x, which takes the rest).
  const apply = (opt: FdOption, value: string | undefined, rest: string[]): number => {
    switch (opt.long) {
      case 'help':
        throw new HelpRequest(value === 'long' ? fdLongHelp() : fdShortHelp())
      case 'version':
        throw new HelpRequest(FD_VERSION)
      case 'hidden':
        o.hidden = true
        break
      case 'no-hidden':
        o.hidden = false
        break
      case 'no-ignore':
      case 'no-ignore-vcs':
      case 'no-ignore-parent':
        o.noIgnore = true
        break
      case 'ignore':
        o.noIgnore = false
        break
      case 'unrestricted':
        o.hidden = o.noIgnore = true
        break
      case 'case-sensitive':
        o.caseMode = 'sensitive'
        break
      case 'ignore-case':
        o.caseMode = 'insensitive'
        break
      case 'glob':
        o.mode = 'glob'
        break
      case 'regex':
        o.mode = 'regex'
        break
      case 'fixed-strings':
        o.mode = 'fixed'
        break
      case 'and':
        o.and.push(value!)
        break
      case 'absolute-path':
        o.absolute = true
        break
      case 'relative-path':
        o.absolute = false
        break
      case 'list-details':
        o.listDetails = true
        break
      case 'full-path':
        o.fullPath = true
        break
      case 'print0':
        o.print0 = true
        break
      case 'max-depth':
        o.maxDepth = depth(value!, opt)
        break
      case 'min-depth':
        o.minDepth = depth(value!, opt)
        break
      case 'exact-depth':
        o.minDepth = o.maxDepth = depth(value!, opt)
        break
      case 'exclude':
        o.excludes.push(value!)
        break
      case 'prune':
        o.prune = true
        break
      case 'type': {
        const t = TYPE_NAMES[value!]
        if (!t) throw clapError(`invalid value '${value}' for '--type <filetype>'\n  [possible values: file, directory, symlink, executable, empty, socket, pipe, char-device, block-device]`)
        o.types.add(t)
        break
      }
      case 'extension':
        o.extensions.push(value!.replace(/^\./, '').toLowerCase())
        break
      case 'size': {
        const m = /^([+-]?)(\d+(?:\.\d+)?)([a-z]+)$/i.exec(value!)
        const unit = m && SIZE_FD[m[3].toLowerCase()]
        if (!m || !unit) throw clapError(`invalid value '${value}' for '--size <size>': '${value}' is not a valid size constraint. See 'fd --help'.`)
        const n = Number(m[2]) * unit
        o.sizes.push(m[1] === '+' ? (s) => s >= n : m[1] === '-' ? (s) => s <= n : (s) => s === n)
        break
      }
      case 'changed-within':
        o.within = parseWhen(value!, opt.long)
        break
      case 'changed-before':
        o.before = parseWhen(value!, opt.long)
        break
      case 'owner': {
        const [u = '', g = ''] = value!.split(':')
        o.owner = { user: u.replace(/^!/, '') || undefined, group: g.replace(/^!/, '') || undefined, notUser: u.startsWith('!'), notGroup: g.startsWith('!') }
        break
      }
      case 'format':
        o.format = value!
        break
      case 'exec':
      case 'exec-batch': {
        // The command runs to a `;` argument or the end of the line.
        const end = rest.indexOf(';')
        const cmd = [value!, ...(end >= 0 ? rest.slice(0, end) : rest)]
        if (opt.long === 'exec') o.exec = cmd
        else o.execBatch = cmd
        return end >= 0 ? end + 1 : rest.length
      }
      case 'batch-size':
        o.batchSize = depth(value!, opt)
        break
      case 'color':
        if (!['auto', 'always', 'never'].includes(value!)) throw clapError(`invalid value '${value}' for '--color <when>'\n  [possible values: auto, always, never]`)
        o.color = value as FdOpts['color']
        break
      case 'strip-cwd-prefix':
        o.stripCwd = (value ?? 'always') as FdOpts['stripCwd']
        break
      case 'max-results':
        o.maxResults = depth(value!, opt) || Infinity
        break
      case 'max-one-result':
        o.maxResults = 1
        break
      case 'quiet':
        o.quiet = true
        break
      case 'base-directory':
        o.baseDir = value!
        break
      case 'search-path':
        o.searchPaths.push(value!)
        break
      case 'path-separator':
        o.separator = value!
        break
      // Accepted, with nothing to change here: one filesystem, no threads, no hyperlinks.
      default:
        break
    }
    return 0
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--') && a.length > 2) {
      const [rawName, inline] = a.slice(2).split(/=(.*)/s)
      const name = FD_ALIASES[rawName] ?? rawName
      const opt = byLong.get(name)
      if (!opt) {
        const near = FD_OPTIONS.find((x) => x.long.startsWith(rawName) || rawName.startsWith(x.long))
        throw clapError(`unexpected argument '${a}' found`, near ? `a similar argument exists: '--${near.long}'` : `to pass '${a}' as a value, use '-- ${a}'`)
      }
      if (name === 'help') apply(opt, 'long', [])
      let value = inline
      const optional = name === 'strip-cwd-prefix' || name === 'hyperlink'
      if (opt.value && value === undefined && !optional) {
        if (i + 1 >= args.length) throw clapError(`a value is required for '--${opt.long} <${opt.value}>' but none was supplied`)
        value = args[++i]
      }
      i += apply(opt, value, args.slice(i + 1))
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const opt = byShort.get(a[j])
        if (!opt) throw clapError(`unexpected argument '-${a[j]}' found`, `to pass '-${a[j]}' as a value, use '-- -${a[j]}'`)
        if (!opt.value) {
          i += apply(opt, undefined, args.slice(i + 1))
          continue
        }
        let value = a.slice(j + 1)
        if (!value) {
          if (i + 1 >= args.length) throw clapError(`a value is required for '--${opt.long} <${opt.value}>' but none was supplied`)
          value = args[++i]
        }
        i += apply(opt, value, args.slice(i + 1))
        break
      }
      continue
    }
    positional.push(a)
  }
  return { opts: o, positional }
}

/** Gitignore-style rules from .gitignore, .ignore and .fdignore files in one folder. */
function ignoreRules(dir: DirNode): { re: RegExp; dirOnly: boolean; negate: boolean }[] {
  const rules: { re: RegExp; dirOnly: boolean; negate: boolean }[] = []
  for (const name of ['.gitignore', '.ignore', '.fdignore']) {
    const f = dir.children.get(name)
    if (f?.type !== 'file') continue
    for (let line of f.content().split('\n')) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      const negate = line.startsWith('!')
      if (negate) line = line.slice(1)
      const dirOnly = line.endsWith('/')
      line = line.replace(/\/$/, '')
      const anchored = line.includes('/')
      const re = globToRegExp(line.replace(/^\//, ''), { slash: false })
      rules.push({ re: anchored ? re : new RegExp(`(^|/)${re.source.slice(1, -1)}$`, re.flags), dirOnly, negate })
    }
  }
  return rules
}

/** LS_COLORS' defaults, the way fd colours a name. */
function fdColor(name: string, node: Node): string | null {
  if (node.type === 'dir') return 'blue'
  if (node.name.endsWith('.game')) return 'green'
  const ext = name.split('.').pop()!.toLowerCase()
  if (['tar', 'tgz', 'gz', 'zip', 'xz', 'bz2', 'zst', '7z', 'rar', 'deb', 'rpm', 'jar'].includes(ext)) return 'red'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tif', 'tiff', 'mp4', 'mkv', 'webm', 'mov', 'avi', 'iso'].includes(ext)) return 'magenta'
  if (['flac', 'mp3', 'ogg', 'opus', 'wav', 'm4a', 'aac'].includes(ext)) return 'cyan'
  return null
}

async function fd(ctx: Ctx): Promise<string> {
  let parsed: ReturnType<typeof parseFdArgs>
  try {
    parsed = parseFdArgs(ctx.args)
  } catch (err) {
    if (err instanceof HelpRequest) return err.message
    throw err
  }
  const { opts: o, positional } = parsed
  const [pattern = '', ...pathArgs] = positional
  const cwd = o.baseDir ? resolvePath(ctx.cwd, o.baseDir) : ctx.cwd
  if (o.baseDir && lookup(cwd)?.type !== 'dir') throw fdError(`The '--base-directory' path '${o.baseDir}' is not a directory.`)

  if (pattern.includes('/') && !o.fullPath && o.mode !== 'glob')
    throw fdError(
      `The search pattern '${pattern}' contains a path-separation character ('/') and will not lead to any search results.\n\nIf you want to search for all files inside the '${pattern}' directory, use a match-all pattern:\n\n  fd . '${pattern}'\n\nInstead, if you want your pattern to match the full file path, use:\n\n  fd --full-path '${pattern}'`,
    )

  // Smart case: an uppercase letter in the pattern makes the search case-sensitive.
  const toRegExp = (p: string) => {
    const ci = o.caseMode === 'insensitive' || (o.caseMode === 'smart' && !/[A-Z]/.test(p.replace(/\\./g, '')))
    if (o.mode === 'glob') return globToRegExp(p, { slash: !o.fullPath, ci })
    const source = o.mode === 'fixed' ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p
    try {
      return new RegExp(source, ci ? 'si' : 's')
    } catch (err) {
      // In the words of Rust's regex crate, which fd uses.
      const why = (err as Error).message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '').toLowerCase()
      const rust: Record<string, string> = { 'unterminated group': 'unclosed group', 'unmatched \')\'': 'unopened group', 'unterminated character class': 'unclosed character class', 'nothing to repeat': 'repetition operator missing expression' }
      throw fdError(`regex parse error:\n    ${p}\n    ^\nerror: ${rust[why] ?? why}`)
    }
  }
  const patterns = [pattern, ...o.and].filter((p, i) => p || i > 0).map(toRegExp)
  const excludes = o.excludes.map((p) => ({ re: globToRegExp(p, { slash: false }), path: p.includes('/') }))

  const roots = [...pathArgs, ...o.searchPaths]
  const searches: { abs: string; prefix: string }[] = []
  for (const p of roots.length ? roots : ['.']) {
    const abs = resolvePath(cwd, p)
    if (lookup(abs)?.type !== 'dir') throw fdError(`Search path '${p}' is not a directory.`)
    // Without a path, results are relative to here with no "./", except when they become arguments.
    const strip = o.stripCwd === 'always' || (o.stripCwd === 'auto' && !(o.exec || o.execBatch || o.print0))
    const prefix = roots.length ? (p === '/' ? '/' : `${p.replace(/\/+$/, '')}/`) : strip ? '' : './'
    searches.push({ abs, prefix })
  }

  const wantFile = o.types.has('f') || o.types.has('x')
  const wantDir = o.types.has('d')
  const typeOk = (abs: string, node: Node) => {
    if (!o.types.size) return true
    if (o.types.has('x') && !(node.type === 'file' && isExecutable(node))) return false
    if (o.types.has('e')) {
      if (!isEmpty(abs, node)) return false
      if (!wantFile && !wantDir) return true
    }
    return (wantFile && node.type === 'file') || (wantDir && node.type === 'dir')
  }

  const results: { abs: string; shown: string; node: Node }[] = []
  const walkDir = (dir: DirNode, abs: string, rel: string, prefix: string, depth: number, rules: { base: string; rules: ReturnType<typeof ignoreRules> }[]) => {
    const here = o.noIgnore ? rules : [...rules, { base: rel, rules: ignoreRules(dir) }]
    for (const child of dir.children.values()) {
      if (results.length >= o.maxResults || ctx.signal.aborted) return
      const childAbs = abs === '/' ? `/${child.name}` : `${abs}/${child.name}`
      const childRel = rel ? `${rel}/${child.name}` : child.name
      if (!o.hidden && child.name.startsWith('.')) continue
      if (
        here.some(({ base, rules }) => {
          const local = base ? childRel.slice(base.length + 1) : childRel
          let ignored = false
          for (const r of rules) if ((!r.dirOnly || child.type === 'dir') && r.re.test(local)) ignored = !r.negate
          return ignored
        })
      )
        continue
      if (excludes.some((x) => x.re.test(x.path ? childRel : child.name))) continue
      const d = depth + 1
      const subject = o.fullPath ? childAbs : child.name
      let match =
        d >= o.minDepth &&
        patterns.every((re) => re.test(subject)) &&
        typeOk(childAbs, child) &&
        (!o.extensions.length || (child.type === 'file' && o.extensions.some((e) => child.name.toLowerCase().endsWith(`.${e}`)))) &&
        (!o.sizes.length || (child.type === 'file' && o.sizes.every((f) => f(sizeOf(childAbs, child))))) &&
        (o.within === null || mtimeOf(childAbs, child) > o.within) &&
        (o.before === null || mtimeOf(childAbs, child) < o.before)
      if (match && o.owner) {
        const who = owner(childAbs)
        const { user, group, notUser, notGroup } = o.owner
        const is = (want: string | undefined) => !want || want === who || want === String(idOf(childAbs))
        match = (notUser ? !is(user) || !user : is(user)) && (notGroup ? !is(group) || !group : is(group))
      }
      if (match) results.push({ abs: childAbs, shown: prefix + childRel, node: child })
      if (child.type === 'dir' && d < o.maxDepth && !(match && o.prune)) walkDir(child, childAbs, childRel, prefix, d, here)
    }
  }
  for (const s of searches) walkDir(lookup(s.abs) as DirNode, s.abs, '', s.prefix, 0, [])

  if (o.quiet) {
    if (!results.length) throw new CmdError('', true)
    return ''
  }

  const display = (r: (typeof results)[number]) => {
    const p = o.absolute ? r.abs : r.shown
    return (r.node.type === 'dir' ? `${p}/` : p).replaceAll('/', o.separator)
  }
  const fill = (template: string, r: (typeof results)[number]) => {
    const p = o.absolute ? r.abs : r.shown
    const base = p.split('/').pop() ?? p
    const parent = p.includes('/') ? p.replace(/\/[^/]*$/, '') || '/' : '.'
    const noExt = (s: string) => s.replace(/(?<=[^/])\.[^./]+$/, '')
    return template.replace(/\{\{|\}\}|\{\/\/\}|\{\/\.\}|\{\/\}|\{\.\}|\{\}/g, (m) => ({ '{{': '{', '}}': '}', '{//}': parent, '{/.}': noExt(base), '{/}': base, '{.}': noExt(p), '{}': p })[m]!)
  }
  const hasPlaceholder = (cmd: string[]) => cmd.some((a) => /\{(\/\/|\/\.|\/|\.)?\}/.test(a))

  if (o.exec) {
    const out: string[] = []
    let ok = true
    for (const r of results) {
      const cmd = hasPlaceholder(o.exec) ? o.exec.map((a) => fill(a, r)) : [...o.exec, fill('{}', r)]
      const res = await runCommand(ctx, cmd.map(quote).join(' '), cwd)
      if (res.output) out.push(res.output)
      ok &&= res.ok
    }
    if (!ok) throw new CmdError(out.join('\n'), true)
    return out.join('\n')
  }
  const batch = o.execBatch
  if (batch) {
    const out: string[] = []
    const size = o.batchSize || results.length || 1
    for (let i = 0; i < results.length; i += size) {
      const group = results.slice(i, i + size)
      const i0 = batch.findIndex((a) => /\{(\/\/|\/\.|\/|\.)?\}/.test(a))
      const cmd = i0 < 0 ? [...batch, ...group.map((r) => fill('{}', r))] : [...batch.slice(0, i0), ...group.map((r) => fill(batch[i0], r)), ...batch.slice(i0 + 1)]
      const res = await runCommand(ctx, cmd.map(quote).join(' '), cwd)
      if (res.output) out.push(res.output)
      if (!res.ok) throw new CmdError(out.join('\n'), true)
    }
    return out.join('\n')
  }

  const colour = o.color === 'always' || (o.color === 'auto' && ctx.tty)
  const paint = (r: (typeof results)[number]) => {
    const text = display(r)
    if (!colour) return text
    const cut = text.replace(/\/$/, '').lastIndexOf(o.separator) + 1
    const parent = text.slice(0, cut)
    const name = text.slice(cut)
    const col = fdColor(name, r.node)
    return `${parent ? c('blue', parent) : ''}${col ? c(col, name) : name}`
  }

  if (o.listDetails) {
    const rows = results.map((r) => [permString(r.abs, r.node), String(linksOf(r.node)), owner(r.abs), owner(r.abs), humanSize(sizeOf(r.abs, r.node)), lsDate(mtimeOf(r.abs, r.node))])
    const widths = [0, 1, 2, 3, 4].map((i) => Math.max(0, ...rows.map((row) => row[i].length)))
    return results
      .map((r, i) => {
        const [perm, links, user, group, size, date] = rows[i]
        return `${perm} ${links.padStart(widths[1])} ${user.padEnd(widths[2])} ${group.padEnd(widths[3])} ${size.padStart(widths[4])} ${date} ${paint(r)}`
      })
      .join('\n')
  }
  if (o.format !== null) return results.map((r) => fill(o.format!, r)).join(o.print0 ? '\0' : '\n')
  if (o.print0) return results.map(display).join('\0') + (results.length ? '\0' : '')
  return results.map(paint).join('\n')
}

/** Tab after `fd`: its options, once the word starts with a dash. */
function completeFd(_args: string[], word: string): Completion[] {
  if (!word.startsWith('-')) return []
  return FD_OPTIONS.filter((o) => !o.hidden && (`--${o.long}`.startsWith(word) || (o.short && word.length <= 2 && `-${o.short}`.startsWith(word)))).map((o) => {
    const long = `--${o.long}`
    const value = word.startsWith('--') || !o.short ? long : `-${o.short}`
    return { value, label: optName(o).trim(), hint: o.help.replace(/ \[.*$/, '') }
  })
}

export const findCommands: Record<string, Command> = {
  find: {
    desc: 'search for files in a directory hierarchy',
    usage: 'find [-H] [-L] [-P] [-Olevel] [-D debugopts] [path...] [expression]   (find --help, man find)',
    man: FIND_MAN,
    run: find,
    complete: completeFind,
  },
  fd: {
    desc: 'find entries in the filesystem, quickly and simply',
    usage: 'fd [OPTIONS] [pattern] [path]...   (fd -h, fd --help, man fd)',
    man: FD_MAN,
    run: fd,
    complete: completeFd,
  },
}
