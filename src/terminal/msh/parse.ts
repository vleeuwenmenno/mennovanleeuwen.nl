// msh's grammar: a POSIX-ish shell language, parsed into a tree the interpreter walks.
// Words stay raw (quotes, $(…) and all) until the interpreter expands them, as a real shell does.
// No imports: the server reads command lines with this too (server/agents.ts).

export type Redirect = {
  /** File descriptor: 0 stdin, 1 stdout, 2 stderr */
  fd: number
  op: '<' | '>' | '>>' | '>|' | '>&' | '<&' | '<<' | '<<-' | '&>'
  /** The target word (raw); for a heredoc, its delimiter */
  target: string
  /** A heredoc's text, and whether its delimiter was quoted (then nothing in it is expanded) */
  heredoc?: { body: string; quoted: boolean }
}

export type SourceSpan = { start: number; end: number; line: number; column: number; filename: string; expression: string }

export type Node = { span?: SourceSpan } & (
  | { t: 'simple'; assigns: [string, string][]; words: string[]; redirs: Redirect[] }
  | { t: 'pipeline'; cmds: Node[]; bang: boolean }
  | { t: 'andor'; first: Node; rest: ['&&' | '||', Node][] }
  | { t: 'list'; items: { node: Node; bg: boolean }[] }
  | { t: 'group'; body: Node; redirs: Redirect[] }
  | { t: 'subshell'; body: Node; redirs: Redirect[] }
  | { t: 'if'; clauses: [Node, Node][]; else: Node | null; redirs: Redirect[] }
  | { t: 'for'; name: string; items: string[] | null; body: Node; redirs: Redirect[] }
  | { t: 'while'; until: boolean; cond: Node; body: Node; redirs: Redirect[] }
  | { t: 'case'; word: string; arms: { patterns: string[]; body: Node | null }[]; redirs: Redirect[] }
  | { t: 'func'; name: string; body: Node }
  /** (( expression )): true when the arithmetic is not 0 (bash) */
  | { t: 'arith'; expr: string; redirs: Redirect[] }
)

/** The input stops halfway (an open quote, `if` without `fi`, a trailing `|`): more lines would finish it. */
export class Incomplete extends Error {
  readonly offset: number
  constructor(what = 'unexpected end of file', offset = 0) {
    super(`syntax error: ${what}`)
    this.offset = offset
  }
}

export class SyntaxError extends Error {
  readonly offset: number
  constructor(message: string, offset = 0) {
    super(`syntax error ${message}`)
    this.offset = offset
  }
}

export type Token = { start: number; end: number } & ({ k: 'word'; v: string; heredoc?: { body: string; quoted: boolean } } | { k: 'op'; v: string } | { k: 'io'; v: string } | { k: 'arith'; v: string } | { k: 'nl' } | { k: 'eof' })

const OPS = ['&&', '||', ';;', '<<-', '<<', '>>', '>&', '<&', '>|', '&>', '|', '&', ';', '(', ')', '<', '>']
const META = /[|&;()<>\s]/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// --- lexing ---------------------------------------------------------------------------------------

/** Where a `$(…)`, `${…}` or backtick quote that starts at `i` ends (the index after it). */
export function nestedEnd(src: string, i: number): number {
  return skipNested(src, i)
}

function skipNested(src: string, i: number): number {
  if (src.startsWith('$((', i)) {
    let depth = 0
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')' && --depth === 0) return j + 1
    }
    throw new Incomplete('unterminated $((', i)
  }
  if (src.startsWith('$(', i)) return skipParens(src, i + 2)
  if (src.startsWith('${', i)) {
    let depth = 1
    for (let j = i + 2; j < src.length; j++) {
      const ch = src[j]
      if (ch === '\\') j++
      else if (ch === "'") j = skipSingle(src, j)
      else if (ch === '"') j = skipDouble(src, j) - 1
      else if (ch === '$' && (src[j + 1] === '(' || src[j + 1] === '{')) j = skipNested(src, j) - 1
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) return j + 1
    }
    throw new Incomplete('unterminated ${', i)
  }
  if (src[i] === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++
      else if (src[j] === '`') return j + 1
    }
    throw new Incomplete('unterminated `', i)
  }
  return i + 1
}

/** The end of a command substitution's body, from just inside `$(`. */
function skipParens(src: string, i: number): number {
  let depth = 1
  for (let j = i; j < src.length; j++) {
    const ch = src[j]
    if (ch === '\\') j++
    else if (ch === "'") j = skipSingle(src, j)
    else if (ch === '"') j = skipDouble(src, j) - 1
    else if (ch === '`' || (ch === '$' && (src[j + 1] === '(' || src[j + 1] === '{'))) j = skipNested(src, j) - 1
    else if (ch === '#' && (j === i || /\s/.test(src[j - 1]))) while (j < src.length && src[j] !== '\n') j++
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return j + 1
  }
  throw new Incomplete('unterminated $(', Math.max(0, i - 2))
}

/** The end of `(( … ))` starting at `i` (after the `))`), or -1 when it is really nested subshells. */
function arithEnd(src: string, i: number): number {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '(') depth++
    else if (src[j] === ')') {
      depth--
      if (depth === 1 && src[j + 1] === ')') return j + 2
      if (depth <= 1) return -1
    } else if (src[j] === '\n' || src[j] === ';') return -1
  }
  return -1
}

/** The index of the closing `'` for the one at `i`. */
function skipSingle(src: string, i: number): number {
  const j = src.indexOf("'", i + 1)
  if (j < 0) throw new Incomplete("unterminated '", i)
  return j
}

/** The index after the closing `"` for the one at `i`. */
function skipDouble(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j]
    if (ch === '\\') j++
    else if (ch === '"') return j + 1
    else if (ch === '`' || (ch === '$' && (src[j + 1] === '(' || src[j + 1] === '{'))) j = skipNested(src, j) - 1
  }
  throw new Incomplete('unterminated "', i)
}

/** Removes quotes from a heredoc delimiter: 'EOF', "EOF" and \EOF all mean EOF, quoted. */
function unquoteDelimiter(raw: string): { word: string; quoted: boolean } {
  let word = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === "'" || ch === '"') {
      quoted = true
      const end = raw.indexOf(ch, i + 1)
      word += raw.slice(i + 1, end < 0 ? raw.length : end)
      i = end < 0 ? raw.length : end
    } else if (ch === '\\') {
      quoted = true
      word += raw[++i] ?? ''
    } else word += ch
  }
  return { word, quoted }
}

export function lex(src: string): Token[] {
  const out: Token[] = []
  const heredocs: { tok: Token & { k: 'word' }; strip: boolean }[] = []
  let i = 0
  const readHeredocs = () => {
    for (const h of heredocs.splice(0)) {
      const { word, quoted } = unquoteDelimiter(h.tok.v)
      const lines: string[] = []
      let found = false
      while (i < src.length) {
        let end = src.indexOf('\n', i)
        if (end < 0) end = src.length
        let line = src.slice(i, end)
        i = end + 1
        if (h.strip) line = line.replace(/^\t+/, '')
        if (line === word) {
          found = true
          break
        }
        lines.push(line)
      }
      if (!found) throw new Incomplete(`here-document delimited by end of file (wanted '${word}')`, src.length)
      h.tok.heredoc = { body: lines.length ? `${lines.join('\n')}\n` : '', quoted }
    }
  }
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && src[i + 1] === '\n') {
      i += 2
      continue
    }
    if (ch === '\n') {
      out.push({ k: 'nl', start: i, end: i + 1 })
      i++
      if (heredocs.length) readHeredocs()
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    // (( expr )) as a command, when the parentheses close as a pair.
    if (src.startsWith('((', i)) {
      const end = arithEnd(src, i)
      if (end > 0) {
        out.push({ k: 'arith', v: src.slice(i + 2, end - 2), start: i, end })
        i = end
        continue
      }
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (op) {
      out.push({ k: 'op', v: op, start: i, end: i + op.length })
      i += op.length
      continue
    }
    // A word: up to an unquoted blank or operator.
    const start = i
    while (i < src.length && !META.test(src[i])) {
      const c = src[i]
      if (c === '\\') {
        if (i + 1 >= src.length) throw new Incomplete('trailing backslash', i)
        i += 2
      } else if (c === "'") i = skipSingle(src, i) + 1
      else if (c === '"') i = skipDouble(src, i)
      else if (c === '`' || (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{'))) i = skipNested(src, i)
      else i++
    }
    const v = src.slice(start, i).replace(/\\\n/g, '')
    // `2>file`: digits right before a redirect are its file descriptor.
    if (/^\d$/.test(v) && (src[i] === '<' || src[i] === '>')) out.push({ k: 'io', v, start, end: i })
    else {
      const tok: Token & { k: 'word' } = { k: 'word', v, start, end: i }
      const prev = out[out.length - 1]
      if (prev?.k === 'op' && (prev.v === '<<' || prev.v === '<<-')) heredocs.push({ tok, strip: prev.v === '<<-' })
      out.push(tok)
    }
  }
  if (heredocs.length) {
    out.push({ k: 'nl', start: i, end: i + 1 })
    readHeredocs()
  }
  out.push({ k: 'eof', start: src.length, end: src.length })
  return out
}

// --- parsing --------------------------------------------------------------------------------------

const REDIR_OPS = new Set(['<', '>', '>>', '>|', '>&', '<&', '<<', '<<-', '&>'])
/** Reserved words that end a list rather than start a command. */
const ENDERS = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '}'])

class Parser {
  private i = 0
  private toks: Token[]
  private src: string
  private filename: string
  private lineStarts: number[] = [0]
  constructor(toks: Token[], src: string, filename: string) {
    this.src = src
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.lineStarts.push(i + 1)
    this.filename = filename
    this.toks = toks
  }

  private peek(): Token {
    return this.toks[this.i]
  }
  private next(): Token {
    return this.toks[this.i++]
  }
  private isWord(v: string, t = this.peek()) {
    return t.k === 'word' && t.v === v
  }
  private isOp(v: string, t = this.peek()) {
    return t.k === 'op' && t.v === v
  }
  private skipNl() {
    while (this.peek().k === 'nl') this.i++
  }
  private describe(t: Token) {
    return t.k === 'eof' ? 'end of file' : t.k === 'nl' ? 'newline' : `\`${t.v}'`
  }
  private fail(t = this.peek()): never {
    if (t.k === 'eof') throw new Incomplete(undefined, t.start)
    throw new SyntaxError(`near unexpected token ${this.describe(t)}`, t.start)
  }
  private expectWord(v: string) {
    this.skipNl()
    if (!this.isWord(v)) this.fail()
    this.i++
  }

  program(): Node {
    const body = this.list(() => false)
    if (this.peek().k !== 'eof') this.fail()
    return body
  }

  /** Commands separated by `;`, `&` or newlines, up to a token `stop` accepts. */
  private list(stop: (t: Token) => boolean): Node {
    const items: { node: Node; bg: boolean }[] = []
    this.skipNl()
    while (this.peek().k !== 'eof' && !stop(this.peek())) {
      const node = this.andOr()
      let bg = false
      const t = this.peek()
      if (this.isOp(';') || this.isOp('&')) {
        bg = (t as { v: string }).v === '&'
        this.i++
      } else if (t.k !== 'nl' && t.k !== 'eof' && !stop(t)) this.fail()
      items.push({ node, bg })
      this.skipNl()
    }
    return { t: 'list', items }
  }

  private andOr(): Node {
    const first = this.pipeline()
    const rest: ['&&' | '||', Node][] = []
    while (this.isOp('&&') || this.isOp('||')) {
      const op = (this.next() as { v: '&&' | '||' }).v
      this.skipNl()
      rest.push([op, this.pipeline()])
    }
    return rest.length ? { t: 'andor', first, rest } : first
  }

  private pipeline(): Node {
    let bang = false
    if (this.isWord('!')) {
      bang = true
      this.i++
    }
    const cmds = [this.command()]
    while (this.isOp('|')) {
      this.i++
      this.skipNl()
      cmds.push(this.command())
    }
    return cmds.length === 1 && !bang ? cmds[0] : { t: 'pipeline', cmds, bang }
  }

  private command(): Node {
    const start = this.peek().start
    const node = this.commandBody()
    const end = this.toks[this.i - 1]?.end ?? start
    let low = 0, high = this.lineStarts.length
    while (low + 1 < high) {
      const mid = (low + high) >>> 1
      if (this.lineStarts[mid] <= start) low = mid
      else high = mid
    }
    node.span = { start, end, line: low + 1, column: start - this.lineStarts[low] + 1, filename: this.filename, expression: this.src.slice(start, end) }
    return node
  }

  private commandBody(): Node {
    const t = this.peek()
    if (t.k === 'arith') {
      this.i++
      return this.withRedirs({ t: 'arith' as const, expr: t.v, redirs: [] as Redirect[] })
    }
    if (t.k === 'word') {
      if (t.v === 'if') return this.withRedirs(this.ifClause())
      if (t.v === 'for') return this.withRedirs(this.forClause())
      if (t.v === 'while' || t.v === 'until') return this.withRedirs(this.whileClause())
      if (t.v === 'case') return this.withRedirs(this.caseClause())
      if (t.v === '{') {
        this.i++
        const body = this.list((x) => this.isWord('}', x))
        this.expectWord('}')
        return this.withRedirs({ t: 'group' as const, body, redirs: [] as Redirect[] })
      }
      if (t.v === 'function' && this.toks[this.i + 1]?.k === 'word') {
        this.i++
        const name = (this.next() as { v: string }).v
        if (this.isOp('(')) {
          this.i++
          if (!this.isOp(')')) this.fail()
          this.i++
        }
        return this.funcBody(name)
      }
      if (NAME.test(t.v) && this.isOp('(', this.toks[this.i + 1]) && this.isOp(')', this.toks[this.i + 2])) {
        this.i += 3
        return this.funcBody(t.v)
      }
      if (ENDERS.has(t.v)) this.fail()
    }
    if (this.isOp('(')) {
      this.i++
      const body = this.list((x) => this.isOp(')', x))
      this.skipNl()
      if (!this.isOp(')')) this.fail()
      this.i++
      return this.withRedirs({ t: 'subshell' as const, body, redirs: [] as Redirect[] })
    }
    return this.simple()
  }

  private funcBody(name: string): Node {
    this.skipNl()
    const body = this.command()
    if (body.t === 'simple') throw new SyntaxError(`in function ${name}: the body must be { … } or ( … )`)
    return { t: 'func', name, body }
  }

  private withRedirs<T extends { redirs: Redirect[] }>(node: T): T {
    while (this.atRedirect()) node.redirs.push(this.redirect())
    return node
  }

  private atRedirect() {
    const t = this.peek()
    return t.k === 'io' || (t.k === 'op' && REDIR_OPS.has(t.v))
  }

  private redirect(): Redirect {
    let fd: number | null = null
    if (this.peek().k === 'io') fd = Number((this.next() as { v: string }).v)
    const op = (this.next() as { v: string }).v as Redirect['op']
    const target = this.peek()
    if (target.k !== 'word') this.fail(target)
    this.i++
    const r: Redirect = { fd: fd ?? (op.startsWith('<') ? 0 : 1), op, target: target.v }
    if (op === '<<' || op === '<<-') r.heredoc = target.heredoc ?? { body: '', quoted: false }
    return r
  }

  private simple(): Node {
    const node: Node & { t: 'simple' } = { t: 'simple', assigns: [], words: [], redirs: [] }
    for (;;) {
      if (this.atRedirect()) node.redirs.push(this.redirect())
      else if (this.peek().k === 'word') {
        const v = (this.next() as { v: string }).v
        const eq = v.indexOf('=')
        if (!node.words.length && eq > 0 && NAME.test(v.slice(0, eq))) node.assigns.push([v.slice(0, eq), v.slice(eq + 1)])
        else node.words.push(v)
      } else break
    }
    if (!node.words.length && !node.assigns.length && !node.redirs.length) this.fail()
    return node
  }

  private ifClause(): Node & { t: 'if' } {
    this.i++ // if
    const clauses: [Node, Node][] = []
    let otherwise: Node | null = null
    const cond = this.list((t) => this.isWord('then', t))
    this.expectWord('then')
    clauses.push([cond, this.list((t) => this.isWord('elif', t) || this.isWord('else', t) || this.isWord('fi', t))])
    for (;;) {
      this.skipNl()
      if (this.isWord('elif')) {
        this.i++
        const c = this.list((t) => this.isWord('then', t))
        this.expectWord('then')
        clauses.push([c, this.list((t) => this.isWord('elif', t) || this.isWord('else', t) || this.isWord('fi', t))])
      } else if (this.isWord('else')) {
        this.i++
        otherwise = this.list((t) => this.isWord('fi', t))
      } else break
    }
    this.expectWord('fi')
    return { t: 'if', clauses, else: otherwise, redirs: [] }
  }

  private doGroup(): Node {
    this.expectWord('do')
    const body = this.list((t) => this.isWord('done', t))
    this.expectWord('done')
    return body
  }

  private forClause(): Node & { t: 'for' } {
    this.i++ // for
    const nameTok = this.next()
    if (nameTok.k !== 'word' || !NAME.test(nameTok.v)) this.fail(nameTok)
    let items: string[] | null = null
    this.skipNl()
    if (this.isWord('in')) {
      this.i++
      items = []
      while (this.peek().k === 'word') items.push((this.next() as { v: string }).v)
      if (this.isOp(';')) this.i++
      else if (this.peek().k !== 'nl') this.fail()
    } else if (this.isOp(';')) this.i++
    return { t: 'for', name: nameTok.v, items, body: this.doGroup(), redirs: [] }
  }

  private whileClause(): Node & { t: 'while' } {
    const until = (this.next() as { v: string }).v === 'until'
    const cond = this.list((t) => this.isWord('do', t))
    return { t: 'while', until, cond, body: this.doGroup(), redirs: [] }
  }

  private caseClause(): Node & { t: 'case' } {
    this.i++ // case
    const w = this.next()
    if (w.k !== 'word') this.fail(w)
    this.expectWord('in')
    const arms: { patterns: string[]; body: Node | null }[] = []
    this.skipNl()
    while (!this.isWord('esac')) {
      if (this.peek().k === 'eof') this.fail()
      if (this.isOp('(')) this.i++
      const patterns: string[] = []
      for (;;) {
        const p = this.next()
        if (p.k !== 'word') this.fail(p)
        patterns.push(p.v)
        if (this.isOp('|')) this.i++
        else break
      }
      if (!this.isOp(')')) this.fail()
      this.i++
      const body = this.list((t) => this.isOp(';;', t) || this.isWord('esac', t))
      arms.push({ patterns, body: (body as { items: unknown[] }).items.length ? body : null })
      if (this.isOp(';;')) this.i++
      this.skipNl()
    }
    this.i++ // esac
    return { t: 'case', word: w.v, arms, redirs: [] }
  }
}

/** Parses a script or a command line. Throws Incomplete when more input would finish it. */
export function parse(src: string, filename = '-c'): Node {
  return new Parser(lex(src), src, filename).program()
}

/** The command names a line runs (first words of each simple command), for permission checks. */
export function commandWords(node: Node): { name: string; args: string[]; redirs: Redirect[] }[] {
  const out: { name: string; args: string[]; redirs: Redirect[] }[] = []
  const visit = (n: Node | null) => {
    if (!n) return
    // A compound command's own redirects (if …; fi > file) write too.
    if (n.t !== 'simple' && n.t !== 'group' && n.t !== 'subshell' && 'redirs' in n && n.redirs.length) out.push(...n.redirs.map((r) => ({ name: '', args: [], redirs: [r] })))
    switch (n.t) {
      case 'simple':
        out.push({ name: n.words[0] ?? '', args: n.words.slice(1), redirs: n.redirs })
        break
      case 'pipeline':
        n.cmds.forEach(visit)
        break
      case 'andor':
        visit(n.first)
        n.rest.forEach(([, x]) => visit(x))
        break
      case 'list':
        n.items.forEach((x) => visit(x.node))
        break
      case 'group':
      case 'subshell':
        visit(n.body)
        out.push(...n.redirs.map((r) => ({ name: '', args: [], redirs: [r] })))
        break
      case 'if':
        n.clauses.forEach(([c, b]) => (visit(c), visit(b)))
        visit(n.else)
        break
      case 'for':
        visit(n.body)
        break
      case 'while':
        visit(n.cond)
        visit(n.body)
        break
      case 'case':
        n.arms.forEach((a) => visit(a.body))
        break
      case 'arith':
        out.push({ name: '((', args: [n.expr], redirs: [] })
        break
      case 'func':
        out.push({ name: 'function', args: [n.name], redirs: [] })
        visit(n.body)
        break
    }
  }
  visit(node)
  return out
}
