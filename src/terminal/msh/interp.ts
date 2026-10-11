// msh, the MvL OS shell: runs the tree from parse.ts. POSIX-ish: pipelines, && ||, if/for/while/
// until/case, functions, subshells, $(…), $((…)), ${…} forms, globbing, heredocs and redirects.
//
// Commands still give their output as one string (with {c:…} markup); the shell turns that into a
// byte stream for pipes, $(…) and files (markup stripped) and into lines for the screen.

import { CmdError, type Ctx } from '../types'
import { HOME, resolvePath } from '../vfs'
import { lookup, prepare, prepareFolder, readFileText, writeFile } from '../fs'
import { arith } from './arith'
import { globMatch, globSource, hasGlob, unescapeGlob } from './glob'
import { Incomplete, nestedEnd, parse, type Node, type Redirect } from './parse'

export type Base = Omit<Ctx, 'args' | 'stdin' | 'tty'>
export type RunResult = { output: string; ok: boolean }
type Cmd = { run: (ctx: Ctx) => string | void | Promise<string | void> }

/** What the shell needs from the command table (commands.ts), which imports the shell. */
export type ShellHooks = {
  commands: Record<string, Cmd>
  executable: (name: string, cwd: string) => Cmd | undefined
  manPage: (name: string) => string
  asksHelp: (name: string, args: string[]) => boolean
  suggest: (name: string) => string
  strip: (s: string) => string
}
let hooks: ShellHooks
export const setShellHooks = (h: ShellHooks) => void (hooks = h)

type Sink = { write: (text: string) => void; tty: boolean; flush?: () => void }
type Stdin = { data: string; pos: number }
type Io = { out: Sink; err: Sink; stdin: Stdin | null }

const red = (s: string) => `{c:red}${s}{/}`
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const nullSink: Sink = { tty: false, write: () => {} }
const bufferSink = () => {
  const sink = { tty: false, text: '', write: (t: string) => void (sink.text += t) }
  return sink
}

// Control flow travels as exceptions.
class Signal {}
class LoopSignal extends Signal {
  constructor(
    readonly kind: 'break' | 'continue',
    public n: number,
  ) {
    super()
  }
}
class ReturnSignal extends Signal {
  constructor(readonly status: number) {
    super()
  }
}
class ExitSignal extends Signal {
  constructor(readonly status: number) {
    super()
  }
}
class AbortSignal_ extends Signal {}
/** An error the shell itself reports (bad substitution, unbound variable): the command fails. */
class ShellError extends Error {}

type State = {
  vars: Record<string, string>
  funcs: Map<string, Node>
  opts: { e: boolean; x: boolean; u: boolean; pipefail: boolean }
  positional: string[]
  arg0: string
  /** Saved values for `local`, one frame per function call */
  locals: Map<string, string | undefined>[]
  loops: number
  getopts: number
}

/** Functions and options outlive one command line: they belong to the terminal's environment. */
const kept = new WeakMap<Record<string, string>, Pick<State, 'funcs' | 'opts' | 'positional'>>()

let ticks = 0
/** Lets the page breathe in long loops, so Ctrl+C gets through. */
const breathe = () => (++ticks % 128 === 0 ? new Promise<void>((r) => setTimeout(r, 0)) : null)

/** The terminal's screen as a sink: whole lines go out as they complete. */
function screen(print: (text: string) => void) {
  let pending = ''
  const flush = () => {
    if (pending) print(pending)
    pending = ''
  }
  const sink: Sink = {
    tty: true,
    flush,
    write(t) {
      pending += t
      const i = pending.lastIndexOf('\n')
      if (i < 0) return
      print(pending.slice(0, i) || ' ')
      pending = pending.slice(i + 1)
    },
  }
  return sink
}

/** The rest of stdin, used up. */
function drain(stdin: Stdin): string {
  const s = stdin.data.slice(stdin.pos)
  stdin.pos = stdin.data.length
  return s.replace(/\n$/, '')
}

function readLine(stdin: Stdin): string | null {
  if (stdin.pos >= stdin.data.length) return null
  const nl = stdin.data.indexOf('\n', stdin.pos)
  const line = stdin.data.slice(stdin.pos, nl < 0 ? undefined : nl)
  stdin.pos = nl < 0 ? stdin.data.length : nl + 1
  return line
}

const escapeGlob = (s: string) => s.replace(/[*?[\]\\]/g, '\\$&')

/** Words being built up during expansion: what they say, and as a glob pattern. */
type Field = { text: string; pat: string; glob: boolean; quoted: boolean }
class Fields {
  out: Field[] = []
  cur: Field | null = null
  private get f() {
    return (this.cur ??= { text: '', pat: '', glob: false, quoted: false })
  }
  /** Text as written (`quoted`: no globbing, and an empty word still counts). */
  lit(s: string, quoted: boolean) {
    const f = this.f
    f.text += s
    f.pat += quoted ? escapeGlob(s) : s
    if (quoted) f.quoted = true
    else if (hasGlob(s)) f.glob = true
  }
  /** An unquoted expansion: split on IFS. */
  split(s: string, ifs: string) {
    if (!s) return
    if (!ifs) return this.lit(s, false)
    const white = [...ifs].filter((ch) => /\s/.test(ch)).join('').replace(/[\]\\^-]/g, '\\$&')
    const hard = [...ifs].filter((ch) => !/\s/.test(ch)).join('').replace(/[\]\\^-]/g, '\\$&')
    const sep = new RegExp(hard ? `[${white}]*[${hard}][${white}]*|[${white}]+` : `[${white}]+`)
    const parts = s.split(sep)
    parts.forEach((p, i) => {
      if (i > 0) this.end()
      if (p) this.lit(p, false)
      else if (i > 0 && i < parts.length - 1 && hard) this.lit('', true)
    })
    if (parts[parts.length - 1] === '' && parts.length > 1) this.end()
  }
  /** "$@": one word per item, the first and last joined to what is around them. */
  list(items: string[]) {
    items.forEach((item, i) => {
      if (i > 0) this.end()
      this.lit(item, true)
    })
  }
  end() {
    if (this.cur && (this.cur.text || this.cur.quoted)) this.out.push(this.cur)
    this.cur = null
  }
  done() {
    this.end()
    return this.out
  }
}

/** The escapes echo -e and printf understand. `stop` is \c: print nothing more. */
function escapes(s: string): { text: string; stop: boolean } {
  let text = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      text += s[i]
      continue
    }
    const ch = s[++i]
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', '"': '"', "'": "'" }
    if (ch in simple) text += simple[ch]
    else if (ch === 'c') return { text, stop: true }
    else if (/[0-7]/.test(ch)) {
      // \0NNN (echo) and \NNN (printf)
      const start = ch === '0' ? i + 1 : i
      const m = /^[0-7]{0,3}/.exec(s.slice(start))![0]
      text += String.fromCharCode(parseInt(m || '0', 8))
      i = start + m.length - 1
    } else if (ch === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1))?.[0]
      if (m) {
        text += String.fromCharCode(parseInt(m, 16))
        i += m.length
      } else text += '\\x'
    } else text += `\\${ch}`
  }
  return { text, stop: false }
}

/** printf(1): the format is reused while arguments are left. */
function printf(fmt: string, args: string[]): string {
  let out = ''
  let ai = 0
  for (let pass = 0; pass < 1000; pass++) {
    let used = false
    for (let i = 0; i < fmt.length; i++) {
      const ch = fmt[i]
      if (ch === '\\') {
        const m = /^\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/.exec(fmt.slice(i))![0]
        const r = escapes(m)
        out += r.text
        if (r.stop) return out
        i += m.length - 1
        continue
      }
      if (ch !== '%') {
        out += ch
        continue
      }
      const m = /^%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?([sbcdiouxXfFeEgG%])/.exec(fmt.slice(i))
      if (!m) {
        out += ch
        continue
      }
      i += m[0].length - 1
      const [, flagStr, widthRaw, precRaw, conv] = m
      if (conv === '%') {
        out += '%'
        continue
      }
      const next = () => {
        if (ai < args.length) used = true
        return args[ai++] ?? ''
      }
      const width = widthRaw === '*' ? parseInt(next(), 10) || 0 : widthRaw ? parseInt(widthRaw, 10) : 0
      const prec = precRaw === '*' ? parseInt(next(), 10) : precRaw !== undefined ? parseInt(precRaw, 10) : undefined
      const arg = next()
      const num = () => {
        const t = arg.trim()
        if (/^['"]./.test(t)) return t.charCodeAt(1)
        const n = Number(t || 0)
        if (Number.isNaN(n)) throw new ShellError(`printf: ${arg}: invalid number`)
        return n
      }
      let s: string
      switch (conv) {
        case 's':
          s = prec !== undefined ? arg.slice(0, prec) : arg
          break
        case 'b': {
          const r = escapes(arg)
          s = r.text
          break
        }
        case 'c':
          s = arg.slice(0, 1)
          break
        case 'd':
        case 'i':
        case 'u': {
          const n = Math.trunc(num())
          s = String(Math.abs(n))
          if (prec !== undefined) s = s.padStart(prec, '0')
          s = (n < 0 ? '-' : flagStr.includes('+') ? '+' : flagStr.includes(' ') ? ' ' : '') + s
          break
        }
        case 'o':
          s = (flagStr.includes('#') ? '0' : '') + Math.trunc(num()).toString(8)
          break
        case 'x':
        case 'X':
          s = (flagStr.includes('#') ? '0x' : '') + Math.trunc(num()).toString(16)
          if (conv === 'X') s = s.toUpperCase()
          break
        case 'e':
        case 'E':
          s = num().toExponential(prec ?? 6)
          if (conv === 'E') s = s.toUpperCase()
          break
        case 'g':
        case 'G':
          s = String(Number(num().toPrecision(prec || 6)))
          break
        default:
          s = num().toFixed(prec ?? 6)
          if (flagStr.includes('+') && !s.startsWith('-')) s = `+${s}`
      }
      if (s.length < width) {
        if (flagStr.includes('-')) s = s.padEnd(width)
        else if (flagStr.includes('0') && /[diouxXfFeEgG]/.test(conv)) {
          const sign = /^[-+ ]/.test(s) ? s[0] : ''
          s = sign + s.slice(sign.length).padStart(width - sign.length, '0')
        } else s = s.padStart(width)
      }
      out += s
    }
    if (!used || ai >= args.length) break
  }
  return out
}

type Builtin = (sh: Shell, args: string[], io: Io) => number | Promise<number>

class Shell {
  /** The status of the last $(…) in the current command, for a line of assignments only */
  private substStatus: number | null = null
  private depth = 0

  constructor(
    readonly base: Base,
    readonly st: State,
    readonly interactive: boolean,
  ) {}

  // --- variables ----------------------------------------------------------------------------------

  get status() {
    return Number(this.st.vars['?'] ?? 0)
  }
  setStatus(s: number) {
    this.st.vars['?'] = String(s)
  }

  isSet(name: string): boolean {
    if (/^\d+$/.test(name)) return name === '0' || Number(name) <= this.st.positional.length
    if ('?#@*$!-'.includes(name) || name === 'RANDOM') return true
    return name in this.st.vars
  }

  getVar(name: string): string {
    const p = this.st.positional
    switch (name) {
      case '#':
        return String(p.length)
      case '@':
      case '*':
        return p.join(name === '*' ? (this.st.vars.IFS ?? ' ')[0] ?? '' : ' ')
      case '$':
        return '4242'
      case '!':
        return ''
      case '-':
        return Object.entries(this.st.opts).filter(([k, v]) => v && k.length === 1).map(([k]) => k).join('')
      case 'RANDOM':
        return String(Math.floor(Math.random() * 32768))
    }
    if (/^\d+$/.test(name)) return name === '0' ? this.st.arg0 : (p[Number(name) - 1] ?? '')
    if (this.st.opts.u && !(name in this.st.vars)) throw new ShellError(`${name}: unbound variable`)
    return this.st.vars[name] ?? ''
  }

  setVar(name: string, value: string) {
    if (!NAME.test(name)) throw new ShellError(`${name}: not a valid identifier`)
    this.st.vars[name] = value
  }

  private arithVars() {
    return { get: (n: string) => (this.isSet(n) ? this.getVar(n) : ''), set: (n: string, v: string) => this.setVar(n, v) }
  }

  // --- expansion ----------------------------------------------------------------------------------

  /** A `$…` form starting at `i`: its value (a list for "$@") and where it ends. */
  private async dollar(raw: string, i: number, io: Io, quoted: boolean): Promise<{ v: string | string[]; end: number }> {
    const rest = raw.slice(i + 1)
    if (rest.startsWith('((')) {
      const end = nestedEnd(raw, i)
      const expr = await this.expandString(raw.slice(i + 3, end - 2), io, true)
      try {
        return { v: String(arith(expr, this.arithVars())), end }
      } catch (e) {
        throw new ShellError((e as Error).message)
      }
    }
    if (rest.startsWith('(')) {
      const end = nestedEnd(raw, i)
      return { v: await this.substitute(raw.slice(i + 2, end - 1), io), end }
    }
    if (rest.startsWith('{')) {
      const end = nestedEnd(raw, i)
      return { v: await this.param(raw.slice(i + 2, end - 1), io, quoted), end }
    }
    const name = /^([A-Za-z_]\w*|\d|[?#@*$!-])/.exec(rest)?.[1]
    if (!name) return { v: '$', end: i + 1 }
    if (name === '@' && quoted) return { v: [...this.st.positional], end: i + 2 }
    return { v: this.getVar(name), end: i + 1 + name.length }
  }

  /** ${…}: defaults, lengths, trimming and replacing. */
  private async param(body: string, io: Io, quoted: boolean): Promise<string | string[]> {
    if (body.length > 1 && body[0] === '#' && /^#([A-Za-z_]\w*|\d+|[@*#?])$/.test(body)) {
      const name = body.slice(1)
      return name === '@' || name === '*' ? String(this.st.positional.length) : String(this.getVar(name).length)
    }
    const m = /^([A-Za-z_]\w*|\d+|[?#@*$!-])([\s\S]*)$/.exec(body)
    if (!m) throw new ShellError(`\${${body}}: bad substitution`)
    const [, name, rest] = m
    const set = this.isSet(name)
    const get = () => (name === '@' && quoted ? [...this.st.positional] : this.getVar(name))
    if (!rest) return set || !this.st.opts.u ? get() : this.getVar(name)
    const op = /^(:?[-=+?]|##?|%%?|\/\/?|:)/.exec(rest)?.[1]
    if (!op) throw new ShellError(`\${${body}}: bad substitution`)
    const word = rest.slice(op.length)
    const value = set ? this.getVar(name) : ''
    const empty = op.startsWith(':') ? !set || value === '' : !set
    switch (op) {
      case '-':
      case ':-':
        return empty ? this.expandString(word, io) : get()
      case '=':
      case ':=':
        if (!empty) return get()
        this.setVar(name, await this.expandString(word, io))
        return this.getVar(name)
      case '+':
      case ':+':
        return empty ? '' : this.expandString(word, io)
      case '?':
      case ':?':
        if (empty) throw new ShellError(`${name}: ${(await this.expandString(word, io)) || 'parameter null or not set'}`)
        return get()
      case '#':
      case '##':
      case '%':
      case '%%': {
        const pat = await this.expandPattern(word, io)
        const greedy = op.length === 2
        const src = globSource(pat, greedy)
        const re = op[0] === '#' ? new RegExp(`^(?:${src})`) : new RegExp(`(?:${src})$`)
        if (op[0] === '#') return value.replace(re, '')
        // Shortest suffix: try from the end.
        if (!greedy) {
          for (let k = value.length; k >= 0; k--) if (new RegExp(`^(?:${globSource(pat)})$`).test(value.slice(k))) return value.slice(0, k)
          return value
        }
        for (let k = 0; k <= value.length; k++) if (new RegExp(`^(?:${globSource(pat)})$`).test(value.slice(k))) return value.slice(0, k)
        return value
      }
      case '/':
      case '//': {
        const slash = word.indexOf('/')
        const pat = await this.expandPattern(slash < 0 ? word : word.slice(0, slash), io)
        const rep = slash < 0 ? '' : await this.expandString(word.slice(slash + 1), io)
        if (!pat) return value
        const anchor = pat.startsWith('#') ? '^' : pat.startsWith('%') ? '$' : ''
        const src = globSource(anchor ? pat.slice(1) : pat)
        const re = new RegExp(anchor === '^' ? `^(?:${src})` : anchor === '$' ? `(?:${src})$` : src, op === '//' ? 'g' : '')
        return value.replace(re, () => rep)
      }
      case ':': {
        const [offRaw, lenRaw] = word.split(':')
        const vars = this.arithVars()
        let off = arith(offRaw || '0', vars)
        if (off < 0) off = Math.max(0, value.length + off)
        if (lenRaw === undefined) return value.slice(off)
        const len = arith(lenRaw, vars)
        return len < 0 ? value.slice(off, value.length + len) : value.slice(off, off + len)
      }
    }
    return get()
  }

  /** $(…) and `…`: runs in a subshell and gives what it printed, trailing newlines removed. */
  private async substitute(src: string, io: Io): Promise<string> {
    const sub = this.subshell()
    const out = bufferSink()
    let status: number
    try {
      status = await sub.exec(parse(src), { out, err: io.err, stdin: null })
    } catch (e) {
      status = this.caught(e, io)
    }
    this.substStatus = status
    return hooks.strip(out.text).replace(/\n+$/, '')
  }

  /** Expands one word into `f`. `split`: unquoted expansions become several words. */
  private async expandInto(raw: string, io: Io, f: Fields, split: boolean, arithmetic = false) {
    const ifs = this.st.vars.IFS ?? ' \t\n'
    const put = (v: string | string[], quoted: boolean) => {
      if (Array.isArray(v)) {
        if (quoted) f.list(v)
        else v.forEach((x, k) => (k > 0 && f.end(), split ? f.split(x, ifs) : f.lit(x, true)))
      } else if (quoted || !split) f.lit(v, true)
      else f.split(v, ifs)
    }
    let i = 0
    if (raw[0] === '~' && !arithmetic) {
      const m = /^~(?=\/|$|:)/.exec(raw)
      if (m) {
        f.lit(this.st.vars.HOME || HOME, true)
        i = 1
      }
    }
    let plain = ''
    const flush = () => {
      if (plain) f.lit(plain, false)
      plain = ''
    }
    while (i < raw.length) {
      const ch = raw[i]
      if (ch === '\\' && i + 1 < raw.length) {
        flush()
        f.lit(raw[i + 1], true)
        i += 2
      } else if (ch === "'" && !arithmetic) {
        flush()
        const end = raw.indexOf("'", i + 1)
        f.lit(raw.slice(i + 1, end < 0 ? raw.length : end), true)
        i = end < 0 ? raw.length : end + 1
      } else if (ch === '"') {
        flush()
        // "$@" with no arguments is no word at all.
        if (raw.startsWith('"$@"', i) && !this.st.positional.length) {
          i += 4
          continue
        }
        f.lit('', true)
        i++
        let lit = ''
        while (i < raw.length && raw[i] !== '"') {
          const c = raw[i]
          if (c === '\\' && /[$`"\\\n]/.test(raw[i + 1] ?? '')) {
            lit += raw[i + 1]
            i += 2
          } else if (c === '$') {
            if (lit) f.lit(lit, true)
            lit = ''
            const { v, end } = await this.dollar(raw, i, io, true)
            put(v, true)
            i = end
          } else if (c === '`') {
            if (lit) f.lit(lit, true)
            lit = ''
            const end = nestedEnd(raw, i)
            put(await this.substitute(raw.slice(i + 1, end - 1).replace(/\\([`\\$])/g, '$1'), io), true)
            i = end
          } else {
            lit += c
            i++
          }
        }
        if (lit) f.lit(lit, true)
        i++
      } else if (ch === '$') {
        flush()
        const { v, end } = await this.dollar(raw, i, io, false)
        put(v, false)
        i = end
      } else if (ch === '`') {
        flush()
        const end = nestedEnd(raw, i)
        put(await this.substitute(raw.slice(i + 1, end - 1).replace(/\\([`\\$])/g, '$1'), io), false)
        i = end
      } else {
        plain += ch
        i++
      }
    }
    flush()
  }

  /** Words of a command: expanded, split and globbed. */
  async expandWords(words: string[], io: Io): Promise<string[]> {
    const out: string[] = []
    for (const raw of words) {
      const f = new Fields()
      await this.expandInto(raw, io, f, true)
      for (const field of f.done()) {
        if (field.glob) {
          const hits = await this.glob(field.pat)
          if (hits.length) {
            out.push(...hits)
            continue
          }
        }
        out.push(field.text)
      }
    }
    return out
  }

  /** One word as one string: assignments, redirect targets, `case` words. */
  async expandString(raw: string, io: Io, arithmetic = false): Promise<string> {
    const f = new Fields()
    await this.expandInto(raw, io, f, false, arithmetic)
    return f
      .done()
      .map((x) => x.text)
      .join(' ')
  }

  /** A word as a pattern: quoted parts match themselves. */
  async expandPattern(raw: string, io: Io): Promise<string> {
    const f = new Fields()
    await this.expandInto(raw, io, f, false)
    return f
      .done()
      .map((x) => x.pat)
      .join(' ')
  }

  /** A heredoc's text: $, ` and \ work, quotes are just characters. */
  private async expandHeredoc(body: string, io: Io): Promise<string> {
    let out = ''
    for (let i = 0; i < body.length; ) {
      const ch = body[i]
      if (ch === '\\' && /[$`\\\n]/.test(body[i + 1] ?? '')) {
        if (body[i + 1] !== '\n') out += body[i + 1]
        i += 2
      } else if (ch === '$') {
        const { v, end } = await this.dollar(body, i, io, true)
        out += Array.isArray(v) ? v.join(' ') : v
        i = end
      } else if (ch === '`') {
        const end = nestedEnd(body, i)
        out += await this.substitute(body.slice(i + 1, end - 1), io)
        i = end
      } else {
        out += ch
        i++
      }
    }
    return out
  }

  /** Pathname expansion against the filesystem (Seafile folders are fetched first). */
  private async glob(pat: string): Promise<string[]> {
    const absolute = pat.startsWith('/')
    const dirsOnly = pat.endsWith('/')
    const segs = pat.split('/').filter((s, k) => s || k === 0)
    let found: { shown: string; abs: string }[] = [{ shown: absolute ? '/' : '', abs: absolute ? '/' : this.base.cwd }]
    const join = (a: string, b: string) => (a === '' ? b : a.endsWith('/') ? a + b : `${a}/${b}`)
    let globbed = false
    for (const seg of segs) {
      if (!seg) continue
      if (!hasGlob(seg)) {
        const name = unescapeGlob(seg)
        found = found.map((x) => ({ shown: join(x.shown, name), abs: resolvePath(x.abs, name) }))
        continue
      }
      globbed = true
      const re = new RegExp(`^${globSource(seg)}$`)
      const next: typeof found = []
      for (const x of found) {
        await prepareFolder(x.abs)
        const node = lookup(x.abs)
        if (node?.type !== 'dir') continue
        const names = [...node.children.keys()].sort((a, b) => a.localeCompare(b, 'en'))
        for (const name of names) if ((!name.startsWith('.') || seg.startsWith('.') || seg.startsWith('\\.')) && re.test(name)) next.push({ shown: join(x.shown, name), abs: resolvePath(x.abs, name) })
      }
      found = next
      if (!found.length) return []
    }
    if (!globbed) return []
    return found.filter((x) => (dirsOnly ? lookup(x.abs)?.type === 'dir' : lookup(x.abs))).map((x) => (dirsOnly ? `${x.shown}/` : x.shown))
  }

  // --- running ------------------------------------------------------------------------------------

  /** A copy for ( … ) and $(…): changes stay inside. */
  subshell(): Shell {
    const base: Base = { ...this.base }
    const st: State = { ...this.st, vars: { ...this.st.vars }, funcs: new Map(this.st.funcs), opts: { ...this.st.opts }, positional: [...this.st.positional], locals: [] }
    base.setCwd = (p) => {
      base.cwd = p
      st.vars.PWD = p
    }
    return new Shell(base, st, false)
  }

  /** A new shell for a script or `msh -c`: the environment copied, no functions. */
  child(arg0: string, positional: string[]): Shell {
    const sh = this.subshell()
    sh.st.funcs.clear()
    sh.st.arg0 = arg0
    sh.st.positional = positional
    sh.st.opts = { e: false, x: false, u: false, pipefail: false }
    return sh
  }

  /** Turns a thrown signal or error into a status (printing what needs saying). */
  caught(e: unknown, io: Io): number {
    if (e instanceof ExitSignal || e instanceof ReturnSignal) return e.status
    if (e instanceof AbortSignal_) return 130
    if (e instanceof LoopSignal) return 0
    if (e instanceof ShellError || e instanceof Incomplete || (e instanceof Error && e.message.startsWith('syntax error'))) {
      io.err.write(`${red(`msh: ${e.message}`)}\n`)
      return e instanceof ShellError ? 1 : 2
    }
    throw e
  }

  private checkAbort() {
    if (this.base.signal.aborted) throw new AbortSignal_()
  }

  private errexit(status: number) {
    if (status !== 0 && this.st.opts.e) throw new ExitSignal(status)
  }

  async exec(n: Node, io: Io, cond = false): Promise<number> {
    this.checkAbort()
    switch (n.t) {
      case 'list': {
        let s = 0
        for (const it of n.items) {
          s = await this.exec(it.node, io, cond)
          this.setStatus(s)
        }
        return s
      }
      case 'andor': {
        let s = await this.exec(n.first, io, true)
        let ranLast = false
        for (let k = 0; k < n.rest.length; k++) {
          const [op, next] = n.rest[k]
          this.setStatus(s)
          if (op === '&&' ? s === 0 : s !== 0) {
            s = await this.exec(next, io, true)
            ranLast = k === n.rest.length - 1
          }
        }
        if (!cond && ranLast) this.errexit(s)
        return s
      }
      case 'pipeline': {
        let stdin = io.stdin
        let status = 0
        let failed = 0
        for (let k = 0; k < n.cmds.length; k++) {
          const last = k === n.cmds.length - 1
          const out = last ? io.out : bufferSink()
          status = await this.exec(n.cmds[k], { out, err: io.err, stdin }, true)
          if (status !== 0) failed = status
          if (!last) stdin = { data: hooks.strip((out as { text: string }).text), pos: 0 }
        }
        if (this.st.opts.pipefail && status === 0) status = failed
        if (n.bang) return status === 0 ? 1 : 0
        if (!cond) this.errexit(status)
        return status
      }
      case 'simple': {
        const s = await this.simple(n, io)
        if (!cond) this.errexit(s)
        return s
      }
      case 'func':
        this.st.funcs.set(n.name, n.body)
        return 0
      case 'arith':
        return this.redirected(n.redirs, io, async (io2) => {
          let s: number
          try {
            s = arith(await this.expandString(n.expr, io2, true), this.arithVars()) !== 0 ? 0 : 1
          } catch (e) {
            s = this.caught(e instanceof ShellError ? e : new ShellError((e as Error).message), io2)
          }
          if (!cond) this.errexit(s)
          return s
        })
      case 'group':
        return this.redirected(n.redirs, io, (io2) => this.exec(n.body, io2, cond))
      case 'subshell':
        return this.redirected(n.redirs, io, async (io2) => {
          const sub = this.subshell()
          try {
            return await sub.exec(n.body, io2, cond)
          } catch (e) {
            return sub.caught(e, io2)
          }
        })
      case 'if':
        return this.redirected(n.redirs, io, async (io2) => {
          for (const [c, body] of n.clauses) {
            const s = await this.exec(c, io2, true)
            this.setStatus(s)
            if (s === 0) return this.exec(body, io2, cond)
          }
          return n.else ? this.exec(n.else, io2, cond) : 0
        })
      case 'for':
        return this.redirected(n.redirs, io, async (io2) => {
          const items = n.items ? await this.expandWords(n.items, io2) : [...this.st.positional]
          return this.loop(io2, async (first) => {
            if (!first) items.shift()
            if (!items.length) return false
            this.setVar(n.name, items[0])
            return true
          }, n.body, cond)
        })
      case 'while':
        return this.redirected(n.redirs, io, (io2) =>
          this.loop(io2, async () => {
            const s = await this.exec(n.cond, io2, true)
            this.setStatus(s)
            return n.until ? s !== 0 : s === 0
          }, n.body, cond),
        )
      case 'case':
        return this.redirected(n.redirs, io, async (io2) => {
          const word = await this.expandString(n.word, io2)
          for (const arm of n.arms)
            for (const p of arm.patterns) if (globMatch(await this.expandPattern(p, io2), word)) return arm.body ? this.exec(arm.body, io2, cond) : 0
          return 0
        })
    }
  }

  /** for and while: `more` says whether to go round again (and sets up the round). */
  private async loop(io: Io, more: (first: boolean) => Promise<boolean>, body: Node, cond: boolean): Promise<number> {
    let status = 0
    this.st.loops++
    try {
      for (let first = true; await more(first); first = false) {
        await breathe()
        this.checkAbort()
        try {
          status = await this.exec(body, io, cond)
          this.setStatus(status)
        } catch (e) {
          if (!(e instanceof LoopSignal)) throw e
          if (e.n > 1) {
            e.n--
            throw e
          }
          if (e.kind === 'break') break
        }
      }
    } finally {
      this.st.loops--
    }
    return status
  }

  /** Runs `fn` with redirections in place; files are written once it is done. */
  private async redirected(redirs: Redirect[], io: Io, fn: (io: Io) => Promise<number>): Promise<number> {
    if (!redirs.length) return fn(io)
    const next: Io = { ...io }
    const files: { target: string; append: boolean; sink: ReturnType<typeof bufferSink> }[] = []
    try {
      for (const r of redirs) {
        if (r.op === '<<' || r.op === '<<-') {
          const body = r.heredoc!.quoted ? r.heredoc!.body : await this.expandHeredoc(r.heredoc!.body, io)
          next.stdin = { data: body, pos: 0 }
          continue
        }
        const target = await this.expandString(r.target, io)
        if (r.op === '>&' || r.op === '<&') {
          if (target === '-') {
            if (r.fd === 2) next.err = nullSink
            else if (r.fd === 1) next.out = nullSink
          } else if (target === '1' || target === '2') {
            const to = target === '1' ? next.out : next.err
            if (r.fd === 2) next.err = to
            else if (r.fd === 1) next.out = to
          } else if (r.op === '>&' && r.fd === 1) {
            // `>& file` is &> file.
            const sink = bufferSink()
            files.push({ target, append: false, sink })
            next.out = next.err = sink
          }
          continue
        }
        if (r.op === '<') {
          const abs = resolvePath(this.base.cwd, target)
          await prepare(this.base.cwd, 'cat', [target])
          const node = lookup(abs)
          if (!node) throw new ShellError(`${target}: No such file or directory`)
          if (node.type === 'dir') throw new ShellError(`${target}: Is a directory`)
          const text = (await readFileText(abs).catch(() => null))?.text ?? node.content()
          if (r.fd === 0) next.stdin = { data: text, pos: 0 }
          continue
        }
        // > >> >| &>
        const sink = target === '/dev/null' ? null : bufferSink()
        if (sink) files.push({ target, append: r.op === '>>', sink })
        const to = sink ?? nullSink
        if (r.op === '&>') next.out = next.err = to
        else if (r.fd === 1) next.out = to
        else if (r.fd === 2) next.err = to
      }
    } catch (e) {
      if (e instanceof ShellError || e instanceof CmdError) {
        io.err.write(`${red(`msh: ${e.message}`)}\n`)
        return 1
      }
      throw e
    }
    let status = 0
    try {
      status = await fn(next)
    } finally {
      for (const f of files) {
        try {
          await writeFile(this.base.cwd, f.target, hooks.strip(f.sink.text).replace(/\n$/, ''), f.append, !!this.base.root)
        } catch (e) {
          io.err.write(`${red(e instanceof CmdError ? e.message : `msh: ${(e as Error).message}`)}\n`)
          status = 1
        }
      }
    }
    return status
  }

  private async simple(n: Node & { t: 'simple' }, io: Io): Promise<number> {
    this.substStatus = null
    let fields: string[]
    const assigns: [string, string][] = []
    try {
      fields = await this.expandWords(n.words, io)
      for (const [k, v] of n.assigns) assigns.push([k, await this.expandString(v, io)])
    } catch (e) {
      return this.caught(e, io)
    }
    if (!fields.length) {
      for (const [k, v] of assigns) this.setVar(k, v)
      const s = this.substStatus ?? 0
      return n.redirs.length ? this.redirected(n.redirs, io, async () => s) : s
    }
    if (this.st.opts.x) io.err.write(`+ ${[...assigns.map(([k, v]) => `${k}=${v}`), ...fields].join(' ')}\n`)
    return this.redirected(n.redirs, io, (io2) => this.invoke(fields, assigns, io2))
  }

  async invoke(fields: string[], assigns: [string, string][], io: Io, skipFunctions = false): Promise<number> {
    const [name, ...args] = fields
    const saved = assigns.map(([k]) => [k, this.st.vars[k]] as const)
    for (const [k, v] of assigns) this.st.vars[k] = v
    try {
      const fn = skipFunctions ? undefined : this.st.funcs.get(name)
      if (fn) return await this.call(name, fn, args, io)
      const b = BUILTINS[name]
      if (b) {
        try {
          return await b(this, args, io)
        } catch (e) {
          if (e instanceof Signal) throw e
          return this.caught(e, io)
        }
      }
      return await this.external(name, args, io)
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete this.st.vars[k]
        else this.st.vars[k] = v
      }
    }
  }

  private async call(name: string, body: Node, args: string[], io: Io): Promise<number> {
    if (this.depth >= 100) {
      io.err.write(`${red(`msh: ${name}: maximum function nesting level exceeded (100)`)}\n`)
      return 1
    }
    const savedArgs = this.st.positional
    const frame = new Map<string, string | undefined>()
    this.st.positional = args
    this.st.locals.push(frame)
    this.depth++
    await breathe()
    try {
      return await this.exec(body, io)
    } catch (e) {
      if (e instanceof ReturnSignal) return e.status
      throw e
    } finally {
      this.depth--
      this.st.locals.pop()
      this.st.positional = savedArgs
      for (const [k, v] of frame) {
        if (v === undefined) delete this.st.vars[k]
        else this.st.vars[k] = v
      }
    }
  }

  /** A script's text, when `path` names one msh can run (a shebang for a shell, or .sh). */
  private async scriptAt(path: string, io: Io): Promise<string | null | 'refused'> {
    const abs = resolvePath(this.base.cwd, path)
    await prepare(this.base.cwd, 'cat', [path])
    const node = lookup(abs)
    if (node?.type !== 'file' || node.exec || node.name.endsWith('.game')) return null
    const text = (await readFileText(abs).catch(() => null))?.text ?? node.content()
    const bang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text)
    const interp = bang ? (bang[1].endsWith('/env') ? bang[2] : bang[1].split('/').pop()) : null
    if (interp && /^(msh|sh|bash|dash|zsh|ksh|ash)$/.test(interp)) return text
    if (!bang && /\.(sh|msh|bash)$/.test(node.name)) return text
    if (interp) {
      io.err.write(`${red(`msh: ${path}: ${interp} is not available in MvL OS (only msh scripts run here)`)}\n`)
      return 'refused'
    }
    return null
  }

  /** Runs a script's text in a new shell; `label` names it in errors. */
  async runSource(src: string, io: Io, label: string): Promise<number> {
    let tree: Node
    try {
      tree = parse(src)
    } catch (e) {
      io.err.write(`${red(`msh: ${label}: ${(e as Error).message}`)}\n`)
      return 2
    }
    try {
      return await this.exec(tree, io)
    } catch (e) {
      return this.caught(e, io)
    }
  }

  private async external(name: string, args: string[], io: Io): Promise<number> {
    if (name.includes('/')) {
      const script = await this.scriptAt(name, io)
      if (script === 'refused') return 126
      if (script !== null) return this.child(name, args).runSource(script, io, name)
    }
    const cmd = hooks.commands[name] ?? hooks.executable(name, this.base.cwd)
    if (!cmd) {
      io.err.write(`${red(`msh: command not found: ${name}${name.length > 2 ? hooks.suggest(name) : ''}`)}\n`)
      return 127
    }
    const known = hooks.commands[name] ? name : (Object.keys(hooks.commands).find((k) => hooks.commands[k] === cmd) ?? null)
    const stdin = io.stdin ? drain(io.stdin) : null
    try {
      const help = known !== null && hooks.asksHelp(known, args)
      if (known && !help) await prepare(this.base.cwd, known, known === 'cd' && !args.length ? [HOME] : args)
      io.out.flush?.()
      const out = help ? hooks.manPage(known!) : ((await cmd.run({ ...this.base, env: this.st.vars, args, stdin, tty: io.out.tty })) ?? '')
      if (out) io.out.write(out.endsWith('\n') ? out : `${out}\n`)
      return 0
    } catch (err) {
      if (err instanceof Signal) throw err
      if (err instanceof CmdError && err.raw) {
        if (err.message) io.err.write(`${err.message}\n`)
        return 1
      }
      const msg = err instanceof CmdError ? err.message : `msh: ${(err as Error).message}`
      if (msg) io.err.write(`${red(msg)}\n`)
      return 1
    }
  }

  /** `read` from the keyboard: a line typed at the terminal. */
  readKeyboard(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      let buf = ''
      const draw = () => this.base.live(`${prompt}${buf}{c:inverse} {/}`)
      const done = (v: string | null) => {
        this.base.onKey(null)
        this.base.live(null)
        this.base.print(`${prompt}${v ?? '^C'}`)
        resolve(v)
      }
      this.base.signal.addEventListener('abort', () => done(null), { once: true })
      this.base.onKey((k) => {
        if (k === 'Enter') done(buf)
        else if (k === 'Backspace') buf = buf.slice(0, -1)
        else if (k.length === 1) buf += k
        else return false
        if (k !== 'Enter') draw()
        return true
      })
      draw()
    })
  }

  /** A script file's text for msh/source, or null when there is none. */
  async readScript(path: string): Promise<string | null> {
    const abs = resolvePath(this.base.cwd, path)
    await prepare(this.base.cwd, 'cat', [path])
    const node = lookup(abs)
    if (node?.type !== 'file') return null
    return (await readFileText(abs).catch(() => null))?.text ?? node.content()
  }

  /** How `type` and `command -v` describe a name. */
  describe(name: string): { kind: 'function' | 'builtin' | 'file' | 'keyword'; text: string } | null {
    if (['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', '{', '}', '!', 'function'].includes(name)) return { kind: 'keyword', text: `${name} is a shell keyword` }
    if (this.st.funcs.has(name)) return { kind: 'function', text: `${name} is a function` }
    if (BUILTINS[name]) return { kind: 'builtin', text: `${name} is a shell builtin` }
    if (hooks.commands[name]) return { kind: 'file', text: `${name} is /bin/${name}` }
    return null
  }
}

// --- builtins -------------------------------------------------------------------------------------

const fail = (io: Io, msg: string, status = 1) => {
  io.err.write(`${red(`msh: ${msg}`)}\n`)
  return status
}

/** test / [: strings, numbers and files. */
async function test(sh: Shell, argv: string[], io: Io, bracket: boolean): Promise<number> {
  let args = argv
  if (bracket) {
    if (args[args.length - 1] !== ']') return fail(io, "[: missing `]'", 2)
    args = args.slice(0, -1)
  }
  const UNARY_FILE = new Set(['-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h', '-b', '-c', '-p', '-S'])
  const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot'])
  // Files the test looks at, fetched first (Seafile).
  const paths = args.filter((_, k) => k > 0 && UNARY_FILE.has(args[k - 1]))
  if (paths.length) await prepare(sh.base.cwd, 'test', paths).catch(() => {})
  const node = (p: string) => lookup(resolvePath(sh.base.cwd, p))
  const int = (s: string) => {
    if (!/^\s*-?\d+\s*$/.test(s)) throw new ShellError(`test: ${s}: integer expression expected`)
    return parseInt(s, 10)
  }
  const unary = (op: string, a: string): boolean => {
    if (op === '-z') return a === ''
    if (op === '-n') return a !== ''
    if (op === '-t') return false
    const n = node(a)
    const abs = resolvePath(sh.base.cwd, a)
    switch (op) {
      case '-e':
        return !!n
      case '-f':
        return n?.type === 'file'
      case '-d':
        return n?.type === 'dir'
      case '-s':
        return n?.type === 'file' ? (n.size ?? n.content().length) > 0 : !!n
      case '-r':
        return !!n
      case '-w':
        return !!n && ((!!n.sf && !n.ro) || abs.startsWith('/tmp/') || !!(n as { browser?: string }).browser)
      case '-x':
        return !!n && (n.type === 'dir' || (n.type === 'file' && !!n.exec))
      default:
        return false
    }
  }
  const binary = (a: string, op: string, b: string): boolean => {
    switch (op) {
      case '=':
      case '==':
        return a === b
      case '!=':
        return a !== b
      case '<':
        return a < b
      case '>':
        return a > b
      case '-eq':
        return int(a) === int(b)
      case '-ne':
        return int(a) !== int(b)
      case '-lt':
        return int(a) < int(b)
      case '-le':
        return int(a) <= int(b)
      case '-gt':
        return int(a) > int(b)
      case '-ge':
        return int(a) >= int(b)
      case '-nt':
        return (node(a)?.mtime ?? 0) > (node(b)?.mtime ?? 0)
      case '-ot':
        return (node(a)?.mtime ?? 0) < (node(b)?.mtime ?? 0)
    }
    return false
  }
  let i = 0
  const expr = (): boolean => {
    let v = and()
    while (args[i] === '-o') {
      i++
      const r = and()
      v = v || r
    }
    return v
  }
  const and = (): boolean => {
    let v = not()
    while (args[i] === '-a') {
      i++
      const r = not()
      v = v && r
    }
    return v
  }
  const not = (): boolean => {
    if (args[i] === '!' && i + 1 < args.length) {
      i++
      return !not()
    }
    return primary()
  }
  const primary = (): boolean => {
    const a = args[i]
    if (a === undefined) throw new ShellError('test: argument expected')
    if (a === '(' && args.length - i > 2) {
      i++
      const v = expr()
      if (args[i] !== ')') throw new ShellError("test: missing ')'")
      i++
      return v
    }
    if (i + 2 < args.length + 1 && BINARY.has(args[i + 1]) && args[i + 2] !== undefined) {
      i += 3
      return binary(a, args[i - 2], args[i - 1])
    }
    if ((UNARY_FILE.has(a) || a === '-z' || a === '-n' || a === '-t') && args[i + 1] !== undefined) {
      i += 2
      return unary(a, args[i - 1])
    }
    i++
    return a !== ''
  }
  try {
    if (!args.length) return 1
    const v = expr()
    if (i < args.length) throw new ShellError(`test: ${args[i]}: unexpected argument`)
    return v ? 0 : 1
  } catch (e) {
    if (e instanceof ShellError) return fail(io, e.message, 2)
    throw e
  }
}

const BUILTINS: Record<string, Builtin> = {
  ':': () => 0,
  true: () => 0,
  false: () => 1,
  echo: (_sh, argv, io) => {
    let args = argv
    let newline = true
    let esc = false
    while (args[0] && /^-[neE]+$/.test(args[0])) {
      for (const ch of args[0].slice(1)) {
        if (ch === 'n') newline = false
        else esc = ch === 'e'
      }
      args = args.slice(1)
    }
    let s = args.join(' ')
    if (esc) {
      const r = escapes(s)
      s = r.text
      if (r.stop) newline = false
    }
    io.out.write(newline ? `${s}\n` : s)
    return 0
  },
  printf: (_sh, args, io) => {
    if (!args.length) return fail(io, 'printf: usage: printf format [arguments]', 2)
    io.out.write(printf(args[0], args.slice(1)))
    return 0
  },
  test: (sh, args, io) => test(sh, args, io, false),
  '[': (sh, args, io) => test(sh, args, io, true),
  export: (sh, args, io) => {
    const list = args.filter((a) => a !== '-n' && a !== '-p')
    if (!list.length) {
      io.out.write(
        Object.entries(sh.st.vars)
          .filter(([k]) => NAME.test(k))
          .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'\n`)
          .join(''),
      )
      return 0
    }
    for (const a of list) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a : a.slice(0, eq)
      if (!NAME.test(name)) return fail(io, `export: '${a}': not a valid identifier`)
      if (eq >= 0) sh.setVar(name, a.slice(eq + 1))
      else sh.st.vars[name] ??= ''
    }
    return 0
  },
  unset: (sh, args) => {
    let fns = false
    for (const a of args) {
      if (a === '-f') fns = true
      else if (a === '-v') fns = false
      else if (fns) sh.st.funcs.delete(a)
      else if (a in sh.st.vars) delete sh.st.vars[a]
      else sh.st.funcs.delete(a)
    }
    return 0
  },
  set: (sh, args, io) => {
    if (!args.length) {
      io.out.write(
        Object.entries(sh.st.vars)
          .filter(([k]) => NAME.test(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'\n`)
          .join(''),
      )
      return 0
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '--') {
        sh.st.positional = args.slice(i + 1)
        return 0
      }
      if (a === '-o' || a === '+o') {
        const opt = args[++i]
        if (opt === 'pipefail') sh.st.opts.pipefail = a === '-o'
        else if (opt === 'errexit') sh.st.opts.e = a === '-o'
        else if (opt === 'xtrace') sh.st.opts.x = a === '-o'
        else if (opt === 'nounset') sh.st.opts.u = a === '-o'
        else return fail(io, `set: ${opt ?? ''}: invalid option name`, 2)
        continue
      }
      if (/^[-+][a-zA-Z]+$/.test(a)) {
        for (const ch of a.slice(1)) {
          if (ch === 'e' || ch === 'x' || ch === 'u') sh.st.opts[ch] = a[0] === '-'
          else if (ch !== 'f' && ch !== 'h' && ch !== 'm' && ch !== 'v') return fail(io, `set: -${ch}: invalid option`, 2)
        }
        continue
      }
      sh.st.positional = args.slice(i)
      return 0
    }
    return 0
  },
  local: (sh, args, io) => {
    const frame = sh.st.locals[sh.st.locals.length - 1]
    if (!frame) return fail(io, 'local: can only be used in a function')
    for (const a of args) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a : a.slice(0, eq)
      if (!NAME.test(name)) return fail(io, `local: '${a}': not a valid identifier`)
      if (!frame.has(name)) frame.set(name, name in sh.st.vars ? sh.st.vars[name] : undefined)
      sh.st.vars[name] = eq < 0 ? (sh.st.vars[name] ?? '') : a.slice(eq + 1)
    }
    return 0
  },
  shift: (sh, args, io) => {
    const n = args[0] === undefined ? 1 : Number(args[0])
    if (!Number.isInteger(n) || n < 0) return fail(io, `shift: ${args[0]}: numeric argument required`)
    if (n > sh.st.positional.length) return 1
    sh.st.positional = sh.st.positional.slice(n)
    return 0
  },
  return: (sh, args) => {
    throw new ReturnSignal(args[0] === undefined ? sh.status : Number(args[0]) & 255)
  },
  exit: (sh, args) => {
    const status = args[0] === undefined ? sh.status : Number(args[0]) & 255
    if (sh.interactive) {
      sh.base.exit()
      return status
    }
    throw new ExitSignal(status)
  },
  break: (sh, args, io) => {
    if (!sh.st.loops) return fail(io, 'break: only meaningful in a loop', 0)
    throw new LoopSignal('break', Math.max(1, Number(args[0] ?? 1) || 1))
  },
  continue: (sh, args, io) => {
    if (!sh.st.loops) return fail(io, 'continue: only meaningful in a loop', 0)
    throw new LoopSignal('continue', Math.max(1, Number(args[0] ?? 1) || 1))
  },
  read: async (sh, argv, io) => {
    let raw = false
    let prompt = ''
    const names: string[] = []
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '-r') raw = true
      else if (argv[i] === '-p') prompt = argv[++i] ?? ''
      else if (argv[i] === '-s') continue
      else names.push(argv[i])
    }
    if (!names.length) names.push('REPLY')
    let line: string | null
    if (io.stdin) {
      line = readLine(io.stdin)
      if (line !== null && !raw) while (line.endsWith('\\')) line = line.slice(0, -1) + (readLine(io.stdin) ?? '')
    } else line = await sh.readKeyboard(prompt)
    if (line === null) {
      for (const n of names) sh.setVar(n, '')
      return 1
    }
    if (!raw) line = line.replace(/\\(.)/g, '$1')
    const ifs = sh.st.vars.IFS ?? ' \t\n'
    const white = [...ifs].filter((c) => /\s/.test(c)).join('')
    const trimmed = white ? line.replace(new RegExp(`^[${white}]+|[${white}]+$`, 'g'), '') : line
    const parts: string[] = []
    let rest = trimmed
    for (let k = 0; k < names.length - 1 && rest; k++) {
      const m = new RegExp(`^([^${ifs.replace(/[\]\\^-]/g, '\\$&')}]*)[${ifs.replace(/[\]\\^-]/g, '\\$&')}]+`).exec(rest)
      if (!m) break
      parts.push(m[1])
      rest = rest.slice(m[0].length)
    }
    parts.push(rest)
    names.forEach((n, k) => sh.setVar(n, parts[k] ?? ''))
    return 0
  },
  source: async (sh, args, io) => {
    if (!args[0]) return fail(io, 'source: filename argument required', 2)
    const text = await sh.readScript(args[0])
    if (text === null) return fail(io, `source: ${args[0]}: No such file or directory`)
    const savedArgs = sh.st.positional
    if (args.length > 1) sh.st.positional = args.slice(1)
    try {
      return await sh.runSource(text, io, args[0])
    } finally {
      if (args.length > 1) sh.st.positional = savedArgs
    }
  },
  '.': (sh, args, io) => BUILTINS.source(sh, args, io),
  eval: async (sh, args, io) => {
    const src = args.join(' ')
    if (!src.trim()) return 0
    try {
      return await sh.exec(parse(src), io)
    } catch (e) {
      if (e instanceof Signal) throw e
      return sh.caught(e, io)
    }
  },
  command: async (sh, args, io) => {
    if (args[0] === '-v' || args[0] === '-V') {
      let status = 0
      for (const name of args.slice(1)) {
        const d = sh.describe(name)
        if (!d) status = 1
        else io.out.write(`${args[0] === '-V' ? d.text : d.kind === 'file' ? `/bin/${name}` : name}\n`)
      }
      return status
    }
    if (!args.length) return 0
    return sh.invoke(args, [], io, true)
  },
  type: (sh, args, io) => {
    let status = 0
    for (const name of args) {
      const d = sh.describe(name)
      if (d) io.out.write(`${d.text}\n`)
      else {
        io.err.write(`${red(`msh: type: ${name}: not found`)}\n`)
        status = 1
      }
    }
    return status
  },
  getopts: (sh, args, io) => {
    const [spec, name, ...given] = args
    if (!spec || !name) return fail(io, 'getopts: usage: getopts optstring name [arg ...]', 2)
    const params = given.length ? given : sh.st.positional
    let optind = parseInt(sh.st.vars.OPTIND ?? '1', 10) || 1
    if (optind === 1 && sh.st.getopts === 0) sh.st.getopts = 1
    const arg = params[optind - 1]
    const finish = () => {
      sh.setVar(name, '?')
      sh.st.getopts = 1
      return 1
    }
    if (arg === undefined || !arg.startsWith('-') || arg === '-') return finish()
    if (arg === '--') {
      sh.st.vars.OPTIND = String(optind + 1)
      return finish()
    }
    const pos = sh.st.getopts || 1
    const ch = arg[pos]
    const at = spec.indexOf(ch)
    const advance = () => {
      if (pos + 1 >= arg.length) {
        optind++
        sh.st.getopts = 1
      } else sh.st.getopts = pos + 1
    }
    if (at < 0 || ch === ':') {
      sh.setVar(name, '?')
      if (!spec.startsWith(':')) io.err.write(`${red(`msh: illegal option -- ${ch}`)}\n`)
      else sh.setVar('OPTARG', ch)
      advance()
      sh.st.vars.OPTIND = String(optind)
      return 0
    }
    sh.setVar(name, ch)
    if (spec[at + 1] === ':') {
      if (pos + 1 < arg.length) {
        sh.setVar('OPTARG', arg.slice(pos + 1))
        optind++
      } else {
        const value = params[optind]
        if (value === undefined) {
          sh.setVar(name, spec.startsWith(':') ? ':' : '?')
          if (!spec.startsWith(':')) io.err.write(`${red(`msh: option requires an argument -- ${ch}`)}\n`)
          optind++
          sh.st.vars.OPTIND = String(optind)
          sh.st.getopts = 1
          return 0
        }
        sh.setVar('OPTARG', value)
        optind += 2
      }
      sh.st.getopts = 1
    } else advance()
    sh.st.vars.OPTIND = String(optind)
    return 0
  },
  wait: () => 0,
  trap: () => 0,
  sleep: async (sh, args, io) => {
    if (!args.length) return fail(io, 'sleep: missing operand')
    let ms = 0
    for (const a of args) {
      const m = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(a)
      if (!m) return fail(io, `sleep: invalid time interval '${a}'`)
      ms += Number(m[1]) * { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]!
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t)
        sh.base.signal.removeEventListener('abort', done)
        resolve()
      }
      const t = setTimeout(done, ms)
      sh.base.signal.addEventListener('abort', done)
    })
    return sh.base.signal.aborted ? 130 : 0
  },
  msh: (sh, args, io) => mshCommand(sh, args, io),
  sh: (sh, args, io) => mshCommand(sh, args, io),
  bash: (sh, args, io) => mshCommand(sh, args, io),
}

/** msh -c 'cmd' [arg0 args…], msh file [args…], msh < script. */
async function mshCommand(sh: Shell, args: string[], io: Io): Promise<number> {
  let i = 0
  let src: string | null = null
  let label = 'msh'
  let check = false
  let trace = false
  let errexit = false
  let positional: string[] = []
  let arg0 = 'msh'
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '-c') {
      src = args[i + 1]
      if (src === undefined) return fail(io, '-c: option requires an argument', 2)
      arg0 = args[i + 2] ?? 'msh'
      positional = args.slice(i + 3)
      label = '-c'
      break
    }
    if (a === '--version') {
      io.out.write('msh 2.0 (MvL OS shell)\n')
      return 0
    }
    if (a === '--help' || a === '-h') {
      io.out.write(`${hooks.manPage('msh')}\n`)
      return 0
    }
    if (/^-[nxe]+$/.test(a)) {
      check ||= a.includes('n')
      trace ||= a.includes('x')
      errexit ||= a.includes('e')
      continue
    }
    if (a === '--') i++
    const file = args[i]
    if (file === undefined) break
    src = await sh.readScript(file)
    if (src === null) return fail(io, `${file}: No such file or directory`, 127)
    label = file
    arg0 = file
    positional = args.slice(i + 1)
    break
  }
  if (src === null) {
    if (!io.stdin) {
      io.out.write("msh 2.0 is the shell you are typing in. Run a line with msh -c 'echo hi', a script with msh file.sh, or read man msh.\n")
      return 0
    }
    src = drain(io.stdin)
  }
  if (check) {
    try {
      parse(src)
      return 0
    } catch (e) {
      return fail(io, `${label}: ${(e as Error).message}`, 2)
    }
  }
  const child = sh.child(arg0, positional)
  child.st.opts.x = trace
  child.st.opts.e = errexit
  return child.runSource(src, io, label)
}

// --- entry points ---------------------------------------------------------------------------------

function topShell(shell: Base, interactive: boolean): Shell {
  const base: Base = { ...shell }
  base.setCwd = (p) => {
    base.cwd = p
    shell.env.PWD = p
    shell.setCwd(p)
  }
  let keep = kept.get(shell.env)
  if (!keep) kept.set(shell.env, (keep = { funcs: new Map(), opts: { e: false, x: false, u: false, pipefail: false }, positional: [] }))
  // set -e at the prompt lasts for that line: the terminal does not close on a failure.
  if (interactive) keep.opts.e = false
  const st: State = { vars: shell.env, funcs: keep.funcs, opts: keep.opts, positional: keep.positional, arg0: 'msh', locals: [], loops: 0, getopts: 0 }
  return new Shell(base, st, interactive)
}

/**
 * Runs a command line typed at the prompt (or handed over by sudo, find -exec, watch). Each
 * top-level command's output is printed as it comes, and returned with whether it succeeded.
 */
export async function runLine(line: string, shell: Base): Promise<RunResult[]> {
  const sh = topShell(shell, true)
  let tree: Node
  try {
    tree = parse(line)
  } catch (e) {
    const msg = red(`msh: ${(e as Error).message}`)
    shell.print(msg)
    sh.setStatus(2)
    return [{ output: msg, ok: false }]
  }
  const items = tree.t === 'list' ? tree.items : [{ node: tree, bg: false }]
  const results: RunResult[] = []
  const tty = screen(shell.print)
  for (const item of items) {
    let rec = ''
    const out: Sink = {
      tty: true,
      flush: tty.flush,
      write: (t) => {
        rec += t
        tty.write(t)
      },
    }
    const io: Io = { out, err: out, stdin: null }
    let status: number
    let stop = false
    try {
      status = await sh.exec(item.node, io)
    } catch (e) {
      stop = e instanceof ExitSignal || e instanceof AbortSignal_
      try {
        status = sh.caught(e, io)
      } catch {
        out.write(`${red(`msh: ${(e as Error)?.message ?? e}`)}\n`)
        status = 1
      }
    }
    tty.flush?.()
    sh.setStatus(status)
    results.push({ output: rec.replace(/\n$/, ''), ok: status === 0 })
    if (stop) break
  }
  return results
}

/**
 * Runs a script the way `msh -c` does, with everything it prints collected as plain text (no
 * terminal: ls lists one name per line). For the agents' terminal tool.
 */
export async function runCaptured(src: string, shell: Base): Promise<{ output: string; status: number }> {
  const sh = topShell({ ...shell, env: { ...shell.env }, print: () => {} }, false)
  const out = bufferSink()
  const status = await sh.runSource(src, { out, err: out, stdin: null }, '-c')
  return { output: hooks.strip(out.text).replace(/\n$/, ''), status }
}

/** Whether a line is unfinished (an open quote, `if` without `fi`), so more could be typed. */
export function unfinished(line: string): boolean {
  try {
    parse(line)
    return false
  } catch (e) {
    return e instanceof Incomplete
  }
}

/** Names the shell itself answers (for `/bin`, help and completion). */
export const SHELL_BUILTINS = Object.keys(BUILTINS)
