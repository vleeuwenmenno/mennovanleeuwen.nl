import { bytesToText, dumpChar, hexByte, textToBytes } from './bytes'
import type { Completion } from './commands'
import { emit, readInputs } from './read'
import { CmdError, type Ctx } from './types'

// The commands that work on bytes: head and tail (-c as well as -n), and the hex dumpers xxd,
// hexdump and od. Text reaches them as the shell's strings, which stand for bytes the way
// bytes.ts says: head -c 16 /dev/urandom | xxd shows 16 bytes, echo é | xxd shows c3a9 0a.

type Command = {
  desc: string
  usage?: string
  man?: string
  run: (ctx: Ctx) => string | void | Promise<string | void>
  complete?: (args: string[], word: string) => Completion[]
}

const lines = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
/** What head and tail print above each input when there are several: `==> name <==`. */
const banner = (name: string, first: boolean) => `${first ? '' : '\n'}==> ${name === '-' ? 'standard input' : name} <==\n`

/** A number the way GNU tools take it: with a sign, and a unit (K, M, kB, b…) after it. */
const UNITS: Record<string, number> = { b: 512, k: 1024, K: 1024, kB: 1000, KiB: 1024, M: 1024 ** 2, MB: 1000 ** 2, MiB: 1024 ** 2, G: 1024 ** 3, GB: 1000 ** 3, GiB: 1024 ** 3, T: 1024 ** 4, TB: 1000 ** 4, TiB: 1024 ** 4 }
function gnuNumber(raw: string, cmd: string, what: 'lines' | 'bytes'): { sign: string; n: number } {
  const m = /^([+-]?)(\d+)([A-Za-z]*)$/.exec(raw)
  const unit = m ? (m[3] ? UNITS[m[3]] : 1) : undefined
  if (!m || !unit) throw new CmdError(`${cmd}: invalid number of ${what}: ‘${raw}’`)
  return { sign: m[1], n: Number(m[2]) * unit }
}

// --- head and tail ---------------------------------------------------------------------------------

type Slicing = { mode: 'lines' | 'bytes'; sign: string; n: number }

function sliceOptions(ctx: Ctx, cmd: 'head' | 'tail'): { cut: Slicing; files: string[]; headers: boolean } {
  const cut: Slicing = { mode: 'lines', sign: '', n: 10 }
  const files: string[] = []
  let quiet = false
  let verbose = false
  const set = (mode: 'lines' | 'bytes', raw: string | undefined) => {
    if (raw === undefined) throw new CmdError(`${cmd}: option requires an argument -- '${mode === 'lines' ? 'n' : 'c'}'\nTry '${cmd} --help' for more information.`)
    Object.assign(cut, { mode }, gnuNumber(raw, cmd, mode))
  }
  const args = ctx.args
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      files.push(...args.slice(i + 1))
      break
    }
    if (a === '-' || !a.startsWith('-')) files.push(a)
    else if (a === '-n' || a === '--lines') set('lines', args[++i])
    else if (a === '-c' || a === '--bytes') set('bytes', args[++i])
    else if (a.startsWith('--lines=')) set('lines', a.slice(8))
    else if (a.startsWith('--bytes=')) set('bytes', a.slice(8))
    else if (a === '-q' || a === '--quiet' || a === '--silent') quiet = true
    else if (a === '-v' || a === '--verbose') verbose = true
    else if (/^-\d+$/.test(a)) set('lines', a.slice(1))
    else if (/^-[nc]./.test(a)) set(a[1] === 'n' ? 'lines' : 'bytes', a.slice(2))
    else if (/^-[qv]+$/.test(a)) {
      if (a.includes('q')) quiet = true
      if (a.includes('v')) verbose = true
    } else throw new CmdError(`${cmd}: invalid option -- '${a.replace(/^--?/, '')}'\nTry '${cmd} --help' for more information.`)
  }
  return { cut, files, headers: verbose || (!quiet && files.length > 1) }
}

/** head: the first part of each input; `-N` or `-n -N` (and `-c -N`) is all but the last N. */
function head(ctx: Ctx) {
  const { cut, files, headers } = sliceOptions(ctx, 'head')
  const inputs = readInputs(ctx, files, 'head')
  const allButLast = cut.sign === '-'
  if (cut.mode === 'bytes') {
    const chunks: Uint8Array[] = []
    inputs.forEach(({ name, bytes }, i) => {
      if (headers) chunks.push(textToBytes(banner(name, i === 0)))
      chunks.push(allButLast ? bytes.subarray(0, Math.max(0, bytes.length - cut.n)) : bytes.subarray(0, cut.n))
    })
    return emit(ctx, concat(chunks))
  }
  return inputs
    .map(({ name, bytes }, i) => {
      const all = lines(bytesToText(bytes))
      const part = (allButLast ? all.slice(0, Math.max(0, all.length - cut.n)) : all.slice(0, cut.n)).join('\n')
      return headers ? `${banner(name, i === 0)}${part}` : part
    })
    .join('\n')
}

/** tail: the last part of each input; `-n +N` and `-c +N` start at the Nth. */
function tail(ctx: Ctx) {
  const { cut, files, headers } = sliceOptions(ctx, 'tail')
  const inputs = readInputs(ctx, files, 'tail')
  const fromStart = cut.sign === '+'
  if (cut.mode === 'bytes') {
    const chunks: Uint8Array[] = []
    inputs.forEach(({ name, bytes }, i) => {
      if (headers) chunks.push(textToBytes(banner(name, i === 0)))
      chunks.push(fromStart ? bytes.subarray(Math.max(0, cut.n - 1)) : bytes.subarray(Math.max(0, bytes.length - cut.n)))
    })
    return emit(ctx, concat(chunks))
  }
  return inputs
    .map(({ name, bytes }, i) => {
      const all = lines(bytesToText(bytes))
      const part = (fromStart ? all.slice(Math.max(0, cut.n - 1)) : cut.n === 0 ? [] : all.slice(-cut.n)).join('\n')
      return headers ? `${banner(name, i === 0)}${part}` : part
    })
    .join('\n')
}

// --- xxd -------------------------------------------------------------------------------------------

type XxdOptions = { cols: number | null; group: number; len: number | null; seek: number; plain: boolean; upper: boolean; reverse: boolean; files: string[] }

/** A number for xxd: decimal, or hex with 0x. */
function xxdNumber(raw: string | undefined, flag: string): number {
  if (raw === undefined) throw new CmdError(`xxd: option -${flag} requires an argument`)
  const n = /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN
  if (Number.isNaN(n)) throw new CmdError(`xxd: invalid number: ${raw}`)
  return n
}

function xxdOptions(args: string[]): XxdOptions {
  const o: XxdOptions = { cols: null, group: 2, len: null, seek: 0, plain: false, upper: false, reverse: false, files: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      o.files.push(...args.slice(i + 1))
      break
    }
    if (a === '-' || !a.startsWith('-')) {
      o.files.push(a)
      continue
    }
    if (['-p', '-ps', '-postscript', '-plain'].includes(a)) o.plain = true
    else if (a === '-r' || a === '-revert') o.reverse = true
    else if (a === '-u' || a === '-uppercase') o.upper = true
    else if (a === '-cols') o.cols = xxdNumber(args[++i], 'c')
    else if (a === '-len') o.len = xxdNumber(args[++i], 'l')
    else if (a === '-groupsize') o.group = xxdNumber(args[++i], 'g')
    else if (a === '-seek') seek(o, args[++i])
    else {
      // Short flags, in a bunch (-pu, -l2, -s -4): a flag that takes a value takes the rest of the word or the next word.
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]
        const value = () => {
          const rest = a.slice(k + 1)
          k = a.length
          return rest || args[++i]
        }
        if (ch === 'p') o.plain = true
        else if (ch === 'r') o.reverse = true
        else if (ch === 'u') o.upper = true
        else if (ch === 'c') o.cols = xxdNumber(value(), 'c')
        else if (ch === 'l') o.len = xxdNumber(value(), 'l')
        else if (ch === 'g') o.group = xxdNumber(value(), 'g')
        else if (ch === 's') seek(o, value())
        else if (ch === 'v') throw new CmdError('xxd 2024-02-10 by Juergen Weigert et al.', true)
        else throw new CmdError(`xxd: unknown option '-${ch}'. Try 'xxd --help'.`)
      }
    }
  }
  return o
}

function seek(o: XxdOptions, raw: string | undefined) {
  const text = raw?.replace(/^\+/, '')
  o.seek = text?.startsWith('-') ? -xxdNumber(text.slice(1), 's') : xxdNumber(text, 's')
}

/** The classic dump: `00000000: 6865 6c6c 6f0a                           hello.` */
function xxdDump(bytes: Uint8Array, o: XxdOptions, shown: number): string {
  const cols = o.cols ?? 16
  const out: string[] = []
  const hex = (b: number) => hexByte(b, o.upper)
  const width = cols * 2 + (o.group > 0 ? Math.ceil(cols / o.group) : 0)
  for (let at = 0; at < bytes.length; at += cols) {
    const chunk = bytes.subarray(at, at + cols)
    let digits = ''
    chunk.forEach((b, i) => {
      digits += hex(b)
      if (o.group > 0 && (i + 1) % o.group === 0) digits += ' '
    })
    const offset = (shown + at).toString(16).padStart(8, '0')
    out.push(`${o.upper ? offset.toUpperCase() : offset}: ${digits.padEnd(width)} ${[...chunk].map(dumpChar).join('')}`)
  }
  return out.join('\n')
}

/** Plain hex: only the digits, `cols` bytes to a line (30 by default). */
function xxdPlain(bytes: Uint8Array, o: XxdOptions): string {
  const cols = o.cols ?? 30
  const out: string[] = []
  for (let at = 0; at < bytes.length; at += cols) out.push([...bytes.subarray(at, at + cols)].map((b) => hexByte(b, o.upper)).join(''))
  return out.join('\n')
}

/** xxd -r: the bytes a dump (or, with -p, plain hex) stands for. Dumps are placed at their offsets. */
function xxdRevert(text: string, o: XxdOptions): Uint8Array {
  const parse = (digits: string) => {
    const clean = digits.replace(/[^0-9a-fA-F]/g, '')
    return Uint8Array.from({ length: clean.length >> 1 }, (_, i) => parseInt(clean.slice(i * 2, i * 2 + 2), 16))
  }
  if (o.plain) return parse(text)
  const out: number[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([0-9a-fA-F]+):\s?(.*)$/.exec(line)
    if (!m) continue
    const at = parseInt(m[1], 16) - o.seek
    // The hex stops at the first double space: what follows is the text column.
    const bytes = parse(m[2].split('  ')[0])
    if (at < 0 || at > 1 << 28) continue
    while (out.length < at) out.push(0)
    bytes.forEach((b, i) => (out[at + i] = b))
  }
  return Uint8Array.from(out)
}

function xxd(ctx: Ctx) {
  const o = xxdOptions(ctx.args)
  if (o.files.length > 1) throw new CmdError('xxd: writing to a file is not supported here; use a redirect: xxd in > out')
  if (o.cols !== null && (o.cols < 1 || o.cols > 256)) throw new CmdError(`xxd: invalid number of columns (max. 256)`)
  const [{ bytes }] = readInputs(ctx, o.files, 'xxd')
  if (o.reverse) return emit(ctx, xxdRevert(bytesToText(bytes), o))
  const start = o.seek < 0 ? Math.max(0, bytes.length + o.seek) : o.seek
  const part = bytes.subarray(start, o.len === null ? undefined : start + o.len)
  return o.plain ? xxdPlain(part, o) : xxdDump(part, o, start)
}

const XXD_MAN = `XXD(1)

NAME
       xxd - make a hex dump or do the reverse

SYNOPSIS
       xxd [-p] [-u] [-c cols] [-g bytes] [-l len] [-s [+|-]seek] [infile]
       xxd -r [-p] [-s offset] [infile]

DESCRIPTION
       xxd shows a file (or what a pipe brings) as hexadecimal, 16 bytes to a line with the
       text beside it. With -r it goes the other way and turns a dump back into bytes.

OPTIONS
       -c cols      bytes per line (16; 30 with -p)
       -g bytes     bytes per group, 0 for none (2)
       -l len       stop after len bytes
       -s seek      start at byte seek; -s -N counts from the end
       -p           plain hex: only the digits
       -u           upper case hex digits
       -r           reverse: dump (or plain hex with -p) back to bytes

EXAMPLES
       head -c 16 /dev/urandom | xxd     16 random bytes
       printf hi | xxd -p                6869
       echo 68690a | xxd -r -p           hi

SEE ALSO
       hexdump(1), od(1), head(1)`

// --- hexdump and od ----------------------------------------------------------------------------------

/** The lines of a dump with runs of identical lines folded into a `*`, like hexdump and od do. */
function folded(rows: { key: string; text: string }[], all: boolean): string[] {
  if (all) return rows.map((r) => r.text)
  const out: string[] = []
  let star = false
  rows.forEach((r, i) => {
    if (i > 0 && rows[i - 1].key === r.key) {
      if (!star) out.push('*')
      star = true
    } else {
      star = false
      out.push(r.text)
    }
  })
  return out
}

/** Skips and counts the way hexdump -s/-n and od -j/-N do. */
function window(bytes: Uint8Array, skip: number, length: number | null) {
  return bytes.subarray(skip, length === null ? undefined : skip + length)
}

function hexdump(ctx: Ctx) {
  let canonical = false
  let all = false
  let skip = 0
  let length: number | null = null
  const files: string[] = []
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i]
    if (a === '-C') canonical = true
    else if (a === '-v') all = true
    else if (a === '-s') skip = xxdNumber(ctx.args[++i], 's')
    else if (a === '-n') length = xxdNumber(ctx.args[++i], 'n')
    else if (a.startsWith('-') && a !== '-') throw new CmdError(`hexdump: invalid option -- '${a.replace(/^-+/, '')}'\nTry 'hexdump --help' for more information.`)
    else files.push(a)
  }
  const [{ bytes: whole }] = readInputs(ctx, files, 'hexdump')
  const bytes = window(whole, skip, length)
  if (!bytes.length) return ''
  const width = canonical ? 8 : 7
  const rows: { key: string; text: string }[] = []
  for (let at = 0; at < bytes.length; at += 16) {
    const chunk = bytes.subarray(at, at + 16)
    const offset = (skip + at).toString(16).padStart(width, '0')
    let text: string
    if (canonical) {
      const left = [...chunk.subarray(0, 8)].map((b) => hexByte(b)).join(' ')
      const right = [...chunk.subarray(8)].map((b) => hexByte(b)).join(' ')
      text = `${offset}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${[...chunk].map(dumpChar).join('')}|`
    } else {
      const words: string[] = []
      for (let k = 0; k < chunk.length; k += 2) words.push(hexByte(chunk[k + 1] ?? 0) + hexByte(chunk[k]))
      text = `${offset} ${words.join(' ')}`
    }
    rows.push({ key: [...chunk].join(','), text })
  }
  return [...folded(rows, all), (skip + bytes.length).toString(16).padStart(width, '0')].join('\n')
}

const OD_SIZES: Record<string, number> = { C: 1, S: 2, I: 4, L: 8 }

function od(ctx: Ctx) {
  let radix = 'o'
  const types: string[] = []
  let skip = 0
  let length: number | null = null
  let all = false
  const files: string[] = []
  const number = (raw: string | undefined) => {
    if (raw === undefined || !/^(0x[0-9a-f]+|\d+)$/i.test(raw)) throw new CmdError(`od: invalid number: ‘${raw ?? ''}’`)
    return Number(raw)
  }
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i]
    if (a === '-v') all = true
    else if (a === '-c') types.push('c')
    else if (a === '-A') radix = ctx.args[++i] ?? ''
    else if (a.startsWith('-A')) radix = a.slice(2)
    else if (a === '-t') types.push(ctx.args[++i] ?? '')
    else if (a.startsWith('-t')) types.push(a.slice(2))
    else if (a === '-N') length = number(ctx.args[++i])
    else if (a.startsWith('-N')) length = number(a.slice(2))
    else if (a === '-j') skip = number(ctx.args[++i])
    else if (a.startsWith('-j')) skip = number(a.slice(2))
    else if (a.startsWith('-') && a !== '-') throw new CmdError(`od: invalid option -- '${a.replace(/^-+/, '')}'\nTry 'od --help' for more information.`)
    else files.push(a)
  }
  if (!['o', 'd', 'x', 'n'].includes(radix)) throw new CmdError(`od: invalid output address radix ‘${radix}’; it must be one character from [doxn]`)
  const [{ bytes: whole }] = readInputs(ctx, files, 'od')
  const bytes = window(whole, skip, length)
  if (!bytes.length) return ''
  // -t takes a letter and a size: x1, o2, u4, d1, or c for characters.
  const spec = types.length ? types : ['o2']
  const formats = spec.map((t) => {
    const m = /^([xoud])([1248]|[CSIL])?$/.exec(t) ?? (t === 'c' ? ['c', 'c'] : null)
    if (!m) throw new CmdError(`od: invalid type string ‘${t}’`)
    if (m[1] === 'c') return { kind: 'c', size: 1, width: 3 }
    const size = m[2] ? (OD_SIZES[m[2]] ?? Number(m[2])) : 2
    if (size > 4) throw new CmdError(`od: invalid type string ‘${t}’: sizes above 4 are not supported`)
    const digits = { x: [2, 4, 0, 8], o: [3, 6, 0, 11], u: [3, 5, 0, 10], d: [4, 6, 0, 11] }[m[1] as 'x'][size - 1]
    return { kind: m[1], size, width: digits }
  })
  const lineBytes = 16
  const value = (chunk: Uint8Array, at: number, f: (typeof formats)[number]) => {
    if (f.kind === 'c') {
      const b = chunk[at]
      const names: Record<number, string> = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' }
      return (names[b] ?? (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'))).padStart(f.width + 1)
    }
    let n = 0
    for (let k = f.size - 1; k >= 0; k--) n = n * 256 + (chunk[at + k] ?? 0)
    if (f.kind === 'd' && n >= 2 ** (f.size * 8 - 1)) n -= 2 ** (f.size * 8)
    const text = n.toString(f.kind === 'x' ? 16 : f.kind === 'o' ? 8 : 10)
    return (f.kind === 'x' || f.kind === 'o' ? text.padStart(f.width, '0') : text.padStart(f.width)).padStart(f.width + 1)
  }
  const address = (n: number) => (radix === 'n' ? '' : n.toString(radix === 'x' ? 16 : radix === 'd' ? 10 : 8).padStart(radix === 'x' ? 6 : 7, '0'))
  const rows: { key: string; text: string }[] = []
  for (let at = 0; at < bytes.length; at += lineBytes) {
    const chunk = bytes.subarray(at, at + lineBytes)
    formats.forEach((f, fi) => {
      const cells: string[] = []
      for (let k = 0; k < chunk.length; k += f.size) cells.push(value(chunk, k, f))
      rows.push({ key: `${fi}:${[...chunk].join(',')}`, text: `${fi === 0 ? address(skip + at) : ' '.repeat(address(0).length)}${cells.join('')}` })
    })
  }
  const dumped = folded(rows, all || formats.length > 1)
  return (radix === 'n' ? dumped : [...dumped, address(skip + bytes.length)]).join('\n')
}

const dumpOptions = (names: string[]) => (_args: string[], word: string): Completion[] => (word.startsWith('-') ? names.filter((n) => n.startsWith(word)).map((n) => ({ value: n, label: n, hint: 'option' })) : [])

export const byteCommands: Record<string, Command> = {
  head: { desc: 'first lines (or bytes) of input', usage: 'head [-n [-]N | -c [-]N] [file...]', run: head, complete: dumpOptions(['-n', '-c', '-q', '-v', '--lines=', '--bytes=']) },
  tail: { desc: 'last lines (or bytes) of input', usage: 'tail [-n [+]N | -c [+]N] [file...]', run: tail, complete: dumpOptions(['-n', '-c', '-q', '-v', '--lines=', '--bytes=']) },
  xxd: { desc: 'hex dump of a file or input, or back to bytes with -r', usage: 'xxd [-p] [-u] [-r] [-c cols] [-g bytes] [-l len] [-s seek] [file]', man: XXD_MAN, run: xxd, complete: dumpOptions(['-c', '-g', '-l', '-s', '-p', '-u', '-r']) },
  hexdump: { desc: 'hex dump (hexdump -C for the canonical one)', usage: 'hexdump [-C] [-v] [-s skip] [-n len] [file]', run: hexdump, complete: dumpOptions(['-C', '-v', '-s', '-n']) },
  od: { desc: 'octal and other dumps (od -An -tx1 for plain hex bytes)', usage: 'od [-A doxn] [-t x1|o1|u1|d1|c] [-j skip] [-N len] [-v] [file]', run: od, complete: dumpOptions(['-A', '-t', '-j', '-N', '-v']) },
}
