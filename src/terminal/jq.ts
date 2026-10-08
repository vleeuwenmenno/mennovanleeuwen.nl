// A small jq: paths (.a.b, .[0], .[], .[1:3], ."key"), optional ?, pipes, commas, literals,
// arrays/objects construction, comparisons, and/or/not, //, + - * / %, and the common built-ins
// (keys, length, map, select, has, type, sort, sort_by, group_by, unique, reverse, first, last,
// min, max, add, to_entries, from_entries, with_entries, tostring, tonumber, split, join, test,
// ascii_downcase, ascii_upcase, startswith, endswith, contains, flatten, range, empty, recurse...).

type J = unknown
type Node = (input: J) => J[]

class JqError extends Error {}

const typeOf = (v: J) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v)
const truthy = (v: J) => v !== false && v !== null

function compare(a: J, b: J): number {
  const order = ['null', 'boolean', 'number', 'string', 'array', 'object']
  const ta = order.indexOf(typeOf(a))
  const tb = order.indexOf(typeOf(b))
  if (ta !== tb) return ta - tb
  if (typeof a === 'number' || typeof a === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'string') return a < (b as string) ? -1 : a > (b as string) ? 1 : 0
  if (Array.isArray(a)) {
    const bb = b as J[]
    for (let i = 0; i < Math.min(a.length, bb.length); i++) {
      const c = compare(a[i], bb[i])
      if (c) return c
    }
    return a.length - bb.length
  }
  if (a === null) return 0
  return compare(JSON.stringify(a), JSON.stringify(b))
}

const equal = (a: J, b: J) => compare(a, b) === 0

function index(v: J, k: J, optional: boolean): J[] {
  if (v === null) return [null]
  if (typeof k === 'string') {
    if (typeOf(v) !== 'object') {
      if (optional) return []
      throw new JqError(`Cannot index ${typeOf(v)} with "${k}"`)
    }
    return [(v as Record<string, J>)[k] ?? null]
  }
  if (typeof k === 'number') {
    if (!Array.isArray(v)) {
      if (optional) return []
      throw new JqError(`Cannot index ${typeOf(v)} with number`)
    }
    const i = k < 0 ? v.length + k : k
    return [v[Math.floor(i)] ?? null]
  }
  if (optional) return []
  throw new JqError(`Cannot index ${typeOf(v)} with ${typeOf(k)}`)
}

function iterate(v: J, optional: boolean): J[] {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') return Object.values(v)
  if (optional) return []
  throw new JqError(`Cannot iterate over ${typeOf(v)}`)
}

function arith(op: string, a: J, b: J): J {
  if (op === '+') {
    if (a === null) return b
    if (b === null) return a
    if (typeof a === 'number' && typeof b === 'number') return a + b
    if (typeof a === 'string' && typeof b === 'string') return a + b
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
    if (typeOf(a) === 'object' && typeOf(b) === 'object') return { ...(a as object), ...(b as object) }
  } else if (op === '-') {
    if (typeof a === 'number' && typeof b === 'number') return a - b
    if (Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.some((y) => equal(x, y)))
  } else if (typeof a === 'number' && typeof b === 'number') {
    if (op === '*') return a * b
    if (b === 0) throw new JqError(`${a} and ${b} cannot be divided because the divisor is zero`)
    if (op === '/') return a / b
    if (op === '%') return a % b
  } else if (op === '/' && typeof a === 'string' && typeof b === 'string') return a.split(b)
  else if (op === '*' && typeof a === 'string' && typeof b === 'number') return b > 0 ? a.repeat(b) : null
  throw new JqError(`${typeOf(a)} and ${typeOf(b)} cannot be combined with ${op}`)
}

// ---------------------------------------------------------------------------
// Tokenizer

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'field' | 'var' | 'tpl'; v: string; parts?: (string | { src: string })[] }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (ch === '"') {
      let j = i + 1
      let s = ''
      const parts: (string | { src: string })[] = []
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && src[j + 1] === '(') {
          // String interpolation: "\(expr)"
          let depth = 1
          let k = j + 2
          for (; k < src.length && depth; k++) {
            if (src[k] === '(') depth++
            else if (src[k] === ')') depth--
          }
          if (s) parts.push(s)
          s = ''
          parts.push({ src: src.slice(j + 2, k - 1) })
          j = k
        } else if (src[j] === '\\') {
          const e = src[j + 1]
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'u' ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : e
          j += e === 'u' ? 6 : 2
        } else s += src[j++]
      }
      if (j >= src.length) throw new JqError('unterminated string')
      if (parts.length) {
        if (s) parts.push(s)
        out.push({ t: 'tpl', v: '', parts })
      } else out.push({ t: 'str', v: s })
      i = j + 1
    } else if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(src.slice(i))!
      out.push({ t: 'num', v: m[0] })
      i += m[0].length
    } else if (ch === '.' && /[A-Za-z_]/.test(src[i + 1] ?? '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1))!
      out.push({ t: 'field', v: m[0] })
      i += 1 + m[0].length
    } else if (ch === '$' && /[A-Za-z_]/.test(src[i + 1] ?? '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1))!
      out.push({ t: 'var', v: m[0] })
      i += 1 + m[0].length
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      out.push({ t: 'id', v: m[0] })
      i += m[0].length
    } else {
      const two = src.slice(i, i + 2)
      if (['==', '!=', '<=', '>=', '//', '..', '|='].includes(two)) {
        out.push({ t: 'op', v: two })
        i += 2
      } else if ('.[](){},:;|<>+-*/%?'.includes(ch)) {
        out.push({ t: 'op', v: ch })
        i++
      } else throw new JqError(`syntax error: unexpected '${ch}'`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Parser: builds closures that map one input to a list of outputs.

type Env = Record<string, J>

class Parser {
  private p = 0
  private toks: Tok[]
  private env: Env
  constructor(toks: Tok[], env: Env = {}) {
    this.toks = toks
    this.env = env
  }

  private peek(v?: string) {
    const t = this.toks[this.p]
    return t && (v === undefined || (t.v === v && (t.t === 'op' || t.t === 'id'))) ? t : undefined
  }
  private eat(v: string) {
    if (!this.peek(v)) throw new JqError(`syntax error: expected '${v}'${this.toks[this.p] ? ` near '${this.toks[this.p].v}'` : ' at end'}`)
    this.p++
  }

  parse(): Node {
    const n = this.pipe()
    if (this.p < this.toks.length) throw new JqError(`syntax error: unexpected '${this.toks[this.p].v}'`)
    return n
  }

  pipe(): Node {
    let left = this.comma()
    // `expr as $name | body`
    if (this.peek('as')) {
      this.p++
      const name = this.toks[this.p++]
      if (!name || name.t !== 'var') throw new JqError('syntax error: expected $name after as')
      this.eat('|')
      const src = left
      const saved = this.env
      const body = (() => {
        this.env = { ...saved, [name.v]: undefined }
        const b = this.pipe()
        this.env = saved
        return b
      })()
      return (x) => src(x).flatMap((v) => withVar(name.v, v, () => body(x)))
    }
    while (this.peek('|')) {
      this.p++
      const l = left
      const r = this.pipe()
      left = (x) => l(x).flatMap(r)
      break
    }
    return left
  }

  comma(): Node {
    let left = this.alt()
    while (this.peek(',')) {
      this.p++
      const l = left
      const r = this.alt()
      left = (x) => [...l(x), ...r(x)]
    }
    return left
  }

  alt(): Node {
    const left = this.or()
    if (this.peek('//')) {
      this.p++
      const right = this.alt()
      return (x) => {
        const vals = (() => {
          try {
            return left(x).filter(truthy)
          } catch {
            return []
          }
        })()
        return vals.length ? vals : right(x)
      }
    }
    return left
  }

  or(): Node {
    let left = this.and()
    while (this.peek('or')) {
      this.p++
      const l = left
      const r = this.and()
      left = (x) => l(x).flatMap((a) => (truthy(a) ? [true] : r(x).map(truthy)))
    }
    return left
  }

  and(): Node {
    let left = this.cmp()
    while (this.peek('and')) {
      this.p++
      const l = left
      const r = this.cmp()
      left = (x) => l(x).flatMap((a) => (!truthy(a) ? [false] : r(x).map(truthy)))
    }
    return left
  }

  cmp(): Node {
    const left = this.add()
    const op = ['==', '!=', '<', '<=', '>', '>='].find((o) => this.peek(o))
    if (!op) return left
    this.p++
    const right = this.add()
    const test = (a: J, b: J) => {
      const c = compare(a, b)
      return op === '==' ? c === 0 : op === '!=' ? c !== 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0
    }
    return (x) => right(x).flatMap((b) => left(x).map((a) => test(a, b)))
  }

  add(): Node {
    let left = this.mul()
    for (let op = ['+', '-'].find((o) => this.peek(o)); op; op = ['+', '-'].find((o) => this.peek(o))) {
      this.p++
      const l = left
      const r = this.mul()
      const o = op
      left = (x) => r(x).flatMap((b) => l(x).map((a) => arith(o, a, b)))
    }
    return left
  }

  mul(): Node {
    let left = this.postfix()
    for (let op = ['*', '/', '%'].find((o) => this.peek(o)); op; op = ['*', '/', '%'].find((o) => this.peek(o))) {
      this.p++
      const l = left
      const r = this.postfix()
      const o = op
      left = (x) => r(x).flatMap((b) => l(x).map((a) => arith(o, a, b)))
    }
    return left
  }

  postfix(): Node {
    let node = this.primary()
    for (;;) {
      const t = this.toks[this.p]
      if (!t) break
      if (t.t === 'field') {
        this.p++
        const n = node
        const opt = this.optional()
        node = (x) => n(x).flatMap((v) => index(v, t.v, opt))
      } else if (t.t === 'op' && t.v === '.' && this.toks[this.p + 1]?.t === 'str') {
        this.p++
        const k = this.toks[this.p++].v
        const n = node
        const opt = this.optional()
        node = (x) => n(x).flatMap((v) => index(v, k, opt))
      } else if (t.t === 'op' && (t.v === '[' || (t.v === '.' && this.toks[this.p + 1]?.v === '['))) {
        if (t.v === '.') this.p++
        node = this.bracket(node)
      } else break
    }
    return node
  }

  private optional() {
    if (this.peek('?')) {
      this.p++
      return true
    }
    return false
  }

  /** `[]`, `[expr]`, `[a:b]` after a value. */
  private bracket(base: Node): Node {
    this.eat('[')
    if (this.peek(']')) {
      this.p++
      const opt = this.optional()
      return (x) => base(x).flatMap((v) => iterate(v, opt))
    }
    let from: Node | null = null
    if (!this.peek(':')) from = this.pipe()
    if (this.peek(':')) {
      this.p++
      const to = this.peek(']') ? null : this.pipe()
      this.eat(']')
      const opt = this.optional()
      return (x) =>
        base(x).flatMap((v) => {
          if (v === null) return [null]
          if (typeof v !== 'string' && !Array.isArray(v)) {
            if (opt) return []
            throw new JqError(`Cannot slice ${typeOf(v)}`)
          }
          const a = from ? (from(x)[0] as number) : 0
          const b = to ? (to(x)[0] as number) : v.length
          return [v.slice(a ?? 0, b ?? v.length)]
        })
    }
    this.eat(']')
    const opt = this.optional()
    const f = from!
    return (x) => base(x).flatMap((v) => f(x).flatMap((k) => index(v, k, opt)))
  }

  primary(): Node {
    const t = this.toks[this.p]
    if (!t) throw new JqError('syntax error: unexpected end of filter')
    if (t.t === 'num') {
      this.p++
      const n = Number(t.v)
      return () => [n]
    }
    if (t.t === 'str') {
      this.p++
      return () => [t.v]
    }
    if (t.t === 'tpl') {
      this.p++
      const parts = t.parts!.map((part) => (typeof part === 'string' ? part : new Parser(tokenize(part.src), this.env).parse()))
      return (x) => {
        let results = ['']
        for (const part of parts) {
          if (typeof part === 'string') results = results.map((r) => r + part)
          else {
            const vals = part(x).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
            results = results.flatMap((r) => vals.map((v) => r + v))
          }
        }
        return results
      }
    }
    if (t.t === 'var') {
      this.p++
      if (t.v === 'ENV') return () => [{}]
      if (!(t.v in this.env)) throw new JqError(`$${t.v} is not defined`)
      return () => [vars[t.v]]
    }
    if (t.t === 'field') {
      this.p++
      const opt = this.optional()
      return (x) => index(x, t.v, opt)
    }
    if (t.t === 'op') {
      if (t.v === '..') {
        this.p++
        return (x) => recurse(x)
      }
      if (t.v === '.') {
        this.p++
        if (this.toks[this.p]?.t === 'str') {
          const k = this.toks[this.p++].v
          const opt = this.optional()
          return (x) => index(x, k, opt)
        }
        if (this.peek('[')) return this.bracket((x) => [x])
        return (x) => [x]
      }
      if (t.v === '(') {
        this.p++
        const inner = this.pipe()
        this.eat(')')
        return inner
      }
      if (t.v === '[') {
        this.p++
        if (this.peek(']')) {
          this.p++
          return () => [[]]
        }
        const inner = this.pipe()
        this.eat(']')
        return (x) => [inner(x)]
      }
      if (t.v === '{') return this.object()
      if (t.v === '-') {
        this.p++
        const n = this.postfix()
        return (x) => n(x).map((v) => arith('-', 0, v))
      }
    }
    if (t.t === 'id') {
      this.p++
      if (t.v === 'true') return () => [true]
      if (t.v === 'false') return () => [false]
      if (t.v === 'null') return () => [null]
      if (t.v === 'not') return (x) => [!truthy(x)]
      if (t.v === 'if') return this.ifThen()
      const args: Node[] = []
      if (this.peek('(')) {
        this.p++
        args.push(this.pipe())
        while (this.peek(';')) {
          this.p++
          args.push(this.pipe())
        }
        this.eat(')')
      }
      return builtin(t.v, args)
    }
    throw new JqError(`syntax error: unexpected '${t.v}'`)
  }

  private ifThen(): Node {
    const cond = this.pipe()
    this.eat('then')
    const then = this.pipe()
    let otherwise: Node = (x) => [x]
    if (this.peek('elif')) {
      this.toks[this.p] = { t: 'id', v: 'if' }
      this.p++
      otherwise = this.ifThen()
      return (x) => cond(x).flatMap((c) => (truthy(c) ? then(x) : otherwise(x)))
    }
    if (this.peek('else')) {
      this.p++
      otherwise = this.pipe()
    }
    this.eat('end')
    return (x) => cond(x).flatMap((c) => (truthy(c) ? then(x) : otherwise(x)))
  }

  private object(): Node {
    this.eat('{')
    const entries: [Node, Node][] = []
    while (!this.peek('}')) {
      const t = this.toks[this.p]
      let key: Node
      let value: Node | null = null
      if (t.t === 'id' || t.t === 'str') {
        this.p++
        key = () => [t.v]
        if (!this.peek(':')) value = (x) => index(x, t.v, false)
      } else if (t.t === 'var') {
        this.p++
        key = () => [t.v]
        value = () => [vars[t.v]]
      } else if (t.t === 'op' && t.v === '(') {
        this.p++
        key = this.pipe()
        this.eat(')')
      } else throw new JqError(`syntax error: bad object key '${t.v}'`)
      if (!value) {
        this.eat(':')
        value = this.alt()
      }
      entries.push([key, value])
      if (!this.peek(',')) break
      this.p++
    }
    this.eat('}')
    return (x) => {
      let results: Record<string, J>[] = [{}]
      for (const [k, v] of entries) {
        const next: Record<string, J>[] = []
        for (const r of results) for (const kk of k(x)) for (const vv of v(x)) next.push({ ...r, [String(kk)]: vv })
        results = next
      }
      return results
    }
  }
}

const vars: Env = {}
function withVar(name: string, value: J, fn: () => J[]): J[] {
  const had = name in vars
  const prev = vars[name]
  vars[name] = value
  try {
    return fn()
  } finally {
    if (had) vars[name] = prev
    else delete vars[name]
  }
}

function recurse(v: J): J[] {
  return [v, ...(Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).flatMap(recurse)]
}

const one = (n: Node, x: J) => n(x)[0]

function builtin(name: string, args: Node[]): Node {
  const str = (x: J, what: string) => {
    if (typeof x !== 'string') throw new JqError(`${typeOf(x)} cannot be ${what}`)
    return x
  }
  const arr = (x: J, what: string) => {
    if (!Array.isArray(x)) throw new JqError(`Cannot ${what} ${typeOf(x)}`)
    return x
  }
  const f = args[0]
  switch (name) {
    case 'empty':
      return () => []
    case 'error':
      return (x) => {
        throw new JqError(String(f ? one(f, x) : x))
      }
    case 'length':
      return (x) => [x === null ? 0 : typeof x === 'string' || Array.isArray(x) ? x.length : typeof x === 'object' ? Object.keys(x!).length : typeof x === 'number' ? Math.abs(x) : (() => { throw new JqError('boolean has no length') })()]
    case 'keys':
    case 'keys_unsorted':
      return (x) => [Array.isArray(x) ? x.map((_, i) => i) : x && typeof x === 'object' ? (name === 'keys' ? Object.keys(x).sort() : Object.keys(x)) : (() => { throw new JqError(`${typeOf(x)} has no keys`) })()]
    case 'values':
      return (x) => (x === null ? [] : [x])
    case 'has':
      return (x) => f(x).map((k) => (Array.isArray(x) ? typeof k === 'number' && k < x.length : !!x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, String(k))))
    case 'in':
      return (x) => f(x).map((o) => (Array.isArray(o) ? typeof x === 'number' && x < o.length : !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, String(x))))
    case 'map':
      return (x) => [iterate(x, false).flatMap((v) => f(v))]
    case 'map_values':
      return (x) => [Array.isArray(x) ? x.map((v) => f(v)[0]) : Object.fromEntries(Object.entries(x as object).map(([k, v]) => [k, f(v)[0]]))]
    case 'select':
      return (x) => (f(x).some(truthy) ? [x] : [])
    case 'recurse':
      return (x) => recurse(x)
    case 'type':
      return (x) => [typeOf(x)]
    case 'not':
      return (x) => [!truthy(x)]
    case 'add':
      return (x) => [iterate(x, false).reduce((a: J, b) => (a === undefined ? b : arith('+', a, b)), undefined) ?? null]
    case 'any':
      return (x) => [f ? iterate(x, false).some((v) => f(v).some(truthy)) : iterate(x, false).some(truthy)]
    case 'all':
      return (x) => [f ? iterate(x, false).every((v) => f(v).some(truthy)) : iterate(x, false).every(truthy)]
    case 'range':
      return (x) => {
        const a = Number(one(args[0], x))
        const b = args[1] ? Number(one(args[1], x)) : null
        const [from, to] = b === null ? [0, a] : [a, b]
        return Array.from({ length: Math.max(0, Math.ceil(to - from)) }, (_, i) => from + i)
      }
    case 'floor':
      return (x) => [Math.floor(x as number)]
    case 'ceil':
      return (x) => [Math.ceil(x as number)]
    case 'round':
      return (x) => [Math.round(x as number)]
    case 'sqrt':
      return (x) => [Math.sqrt(x as number)]
    case 'abs':
      return (x) => [Math.abs(x as number)]
    case 'tostring':
      return (x) => [typeof x === 'string' ? x : JSON.stringify(x)]
    case 'tonumber':
      return (x) => {
        const n = typeof x === 'number' ? x : Number(str(x, 'parsed as a number'))
        if (Number.isNaN(n)) throw new JqError(`Cannot parse '${x}' as JSON`)
        return [n]
      }
    case 'tojson':
      return (x) => [JSON.stringify(x)]
    case 'fromjson':
      return (x) => [JSON.parse(str(x, 'parsed'))]
    case 'ascii_downcase':
      return (x) => [str(x, 'lowercased').toLowerCase()]
    case 'ascii_upcase':
      return (x) => [str(x, 'uppercased').toUpperCase()]
    case 'ltrimstr':
      return (x) => f(x).map((p) => (typeof x === 'string' && typeof p === 'string' && x.startsWith(p) ? x.slice(p.length) : x))
    case 'rtrimstr':
      return (x) => f(x).map((p) => (typeof x === 'string' && typeof p === 'string' && p && x.endsWith(p) ? x.slice(0, -p.length) : x))
    case 'trim':
      return (x) => [str(x, 'trimmed').trim()]
    case 'startswith':
      return (x) => f(x).map((p) => str(x, 'checked').startsWith(String(p)))
    case 'endswith':
      return (x) => f(x).map((p) => str(x, 'checked').endsWith(String(p)))
    case 'split':
      return (x) => f(x).map((p) => str(x, 'split').split(String(p)))
    case 'join':
      return (x) => f(x).map((sep) => arr(x, 'join').map((v) => (v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))).join(String(sep)))
    case 'test':
      return (x) => f(x).map((re) => new RegExp(String(re), args[1] ? String(one(args[1], x)).replace(/[^gimsuy]/g, '') : '').test(str(x, 'matched')))
    case 'sub':
    case 'gsub':
      return (x) => [str(x, 'substituted').replace(new RegExp(String(one(args[0], x)), name === 'gsub' ? 'g' : ''), String(one(args[1], x)))]
    case 'contains':
      return (x) => f(x).map((b) => contains(x, b))
    case 'inside':
      return (x) => f(x).map((b) => contains(b, x))
    case 'sort':
      return (x) => [[...arr(x, 'sort')].sort(compare)]
    case 'sort_by':
      return (x) => [[...arr(x, 'sort')].sort((a, b) => compare(f(a), f(b)))]
    case 'group_by':
      return (x) => {
        const groups: J[][] = []
        for (const v of [...arr(x, 'group')].sort((a, b) => compare(f(a), f(b)))) {
          const g = groups[groups.length - 1]
          if (g && equal(f(g[0]), f(v))) g.push(v)
          else groups.push([v])
        }
        return [groups]
      }
    case 'unique':
      return (x) => [[...arr(x, 'unique')].sort(compare).filter((v, i, a) => i === 0 || !equal(v, a[i - 1]))]
    case 'unique_by':
      return (x) => [[...arr(x, 'unique')].sort((a, b) => compare(f(a), f(b))).filter((v, i, a) => i === 0 || !equal(f(v), f(a[i - 1])))]
    case 'min':
    case 'max':
      return (x) => {
        const a = [...arr(x, name)].sort(compare)
        return [a.length ? (name === 'min' ? a[0] : a[a.length - 1]) : null]
      }
    case 'min_by':
    case 'max_by':
      return (x) => {
        const a = [...arr(x, name)].sort((p, q) => compare(f(p), f(q)))
        return [a.length ? (name === 'min_by' ? a[0] : a[a.length - 1]) : null]
      }
    case 'reverse':
      return (x) => [typeof x === 'string' ? [...x].reverse().join('') : x === null ? [] : [...arr(x, 'reverse')].reverse()]
    case 'first':
      return f ? (x) => f(x).slice(0, 1) : (x) => [arr(x, 'index')[0] ?? null]
    case 'last':
      return f ? (x) => f(x).slice(-1) : (x) => [arr(x, 'index').at(-1) ?? null]
    case 'limit':
      return (x) => args[1](x).slice(0, Number(one(args[0], x)))
    case 'flatten':
      return (x) => [arr(x, 'flatten').flat(f ? Number(one(f, x)) : Infinity)]
    case 'to_entries':
      return (x) => [Object.entries(x as object).map(([key, value]) => ({ key, value }))]
    case 'from_entries':
      return (x) => [Object.fromEntries(arr(x, 'convert').map((e) => { const o = e as Record<string, J>; return [String(o.key ?? o.k ?? o.name ?? o.Name ?? o.Key), o.value ?? o.v ?? o.Value ?? null] }))]
    case 'with_entries':
      return (x) => [Object.fromEntries(Object.entries(x as object).flatMap(([key, value]) => f({ key, value }).map((e) => { const o = e as Record<string, J>; return [String(o.key), o.value] })))]
    case 'paths':
      return (x) => paths(x, []).slice(1)
    case 'getpath':
      return (x) => f(x).map((p) => (p as J[]).reduce((v: J, k) => (v == null ? null : (v as Record<string, J>)[k as string] ?? null), x))
    case 'splits':
      return (x) => f(x).flatMap((p) => str(x, 'split').split(new RegExp(String(p))))
    case 'ascii':
      return (x) => [String.fromCharCode(x as number)]
    case 'now':
      return () => [Date.now() / 1000]
    case 'todate':
    case 'todateiso8601':
      return (x) => [new Date((x as number) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')]
    case 'fromdate':
    case 'fromdateiso8601':
      return (x) => [Math.floor(new Date(str(x, 'parsed as a date')).getTime() / 1000)]
    case 'env':
      return () => [{}]
    case 'input':
    case 'inputs':
      return () => []
    case 'debug':
      return (x) => [x]
    case 'isnan':
      return (x) => [Number.isNaN(x)]
    case 'infinite':
      return () => [Infinity]
    case 'nan':
      return () => [NaN]
    case 'tostream':
    case 'splits_':
    default:
      throw new JqError(`${name}/${args.length} is not defined`)
  }
}

function paths(v: J, prefix: J[]): J[] {
  const kids = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : v && typeof v === 'object' ? Object.entries(v) : []
  return [prefix, ...kids.flatMap(([k, x]) => paths(x, [...prefix, k]))]
}

function contains(a: J, b: J): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.includes(b)
  if (Array.isArray(a) && Array.isArray(b)) return b.every((y) => a.some((x) => contains(x, y)))
  if (typeOf(a) === 'object' && typeOf(b) === 'object') return Object.entries(b as object).every(([k, v]) => k in (a as object) && contains((a as Record<string, J>)[k], v))
  return equal(a, b)
}

// ---------------------------------------------------------------------------

export type JqOptions = { raw?: boolean; compact?: boolean; color?: boolean; nullInput?: boolean; slurp?: boolean }

/** Colours JSON like jq on a terminal: keys blue, strings green, null grey. Uses the terminal's markup. */
function colorJson(v: J, indent: string, compact: boolean): string {
  const nl = compact ? '' : '\n'
  const pad = compact ? '' : indent + '  '
  const esc = (s: string) => JSON.stringify(s).replace(/\{(?=(?:c|link|anim|fg):|\/\})/g, '{​')
  if (v === null) return '{c:muted}null{/}'
  if (typeof v === 'string') return `{c:green}${esc(v)}{/}`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return `[${nl}${v.map((x) => pad + colorJson(x, pad, compact)).join(`,${nl}`)}${nl}${compact ? '' : indent}]`
  }
  const entries = Object.entries(v as object)
  if (!entries.length) return '{}'
  return `{${nl}${entries.map(([k, x]) => `${pad}{c:blue}${esc(k)}{/}:${compact ? '' : ' '}${colorJson(x, pad, compact)}`).join(`,${nl}`)}${nl}${compact ? '' : indent}}`
}

/** Runs `filter` over the JSON text `input` and returns jq's output. */
export function jq(filter: string, input: string, opts: JqOptions = {}): string {
  let data: J[]
  if (opts.nullInput) data = [null]
  else {
    // Usually one document; otherwise several whitespace-separated JSON values, like jq accepts.
    data = []
    const text = input.trim()
    try {
      data = text ? [JSON.parse(text)] : []
    } catch {
      data = []
    }
    if (!data.length && text)
    for (let i = 0; i < text.length; ) {
      let depth = 0
      let inStr = false
      let j = i
      for (; j < text.length; j++) {
        const ch = text[j]
        if (inStr) {
          if (ch === '\\') j++
          else if (ch === '"') inStr = false
        } else if (ch === '"') inStr = true
        else if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') depth--
        else if (/\s/.test(ch) && depth === 0) break
        if (depth === 0 && (ch === '}' || ch === ']' || (ch === '"' && !inStr && j > i))) {
          j++
          break
        }
      }
      const chunk = text.slice(i, j).trim()
      if (chunk) {
        try {
          data.push(JSON.parse(chunk))
        } catch {
          throw new JqError(`parse error: Invalid JSON text near '${chunk.slice(0, 20)}'`)
        }
      }
      i = j
      while (i < text.length && /\s/.test(text[i])) i++
    }
    if (opts.slurp) data = [data]
  }
  const prog = new Parser(tokenize(filter || '.')).parse()
  const out: string[] = []
  for (const d of data) {
    for (const v of prog(d)) {
      if (opts.raw && typeof v === 'string') out.push(opts.color ? v.replace(/\{(?=(?:c|link|anim|fg):|\/\})/g, '{​') : v)
      else if (opts.color) out.push(colorJson(v, '', !!opts.compact))
      else out.push(opts.compact ? JSON.stringify(v) : JSON.stringify(v, null, 2))
    }
  }
  return out.join('\n')
}

export { JqError }
