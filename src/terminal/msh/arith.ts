// $(( … )): integer arithmetic with C's operators, as POSIX shells do it.

export type Vars = { get: (name: string) => string; set: (name: string, value: string) => void }

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string }

const OPS = ['<<=', '>>=', '**', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '^', '|', '?', ':', '(', ')', ',']

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      i++
      continue
    }
    const num = /^(0[xX][0-9a-fA-F]+|\d+)/.exec(src.slice(i))
    if (num) {
      const s = num[1]
      out.push({ k: 'num', v: /^0[xX]/.test(s) ? parseInt(s, 16) : s.length > 1 && s.startsWith('0') ? parseInt(s, 8) : parseInt(s, 10) })
      i += s.length
      continue
    }
    const id = /^[A-Za-z_]\w*/.exec(src.slice(i))
    if (id) {
      out.push({ k: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Error(`arithmetic: syntax error near '${src.slice(i)}'`)
    out.push({ k: 'op', v: op })
    i += op.length
  }
  return out
}

const BINARY: Record<string, [number, (a: number, b: number) => number]> = {
  '||': [1, (a, b) => +(a !== 0 || b !== 0)],
  '&&': [2, (a, b) => +(a !== 0 && b !== 0)],
  '|': [3, (a, b) => a | b],
  '^': [4, (a, b) => a ^ b],
  '&': [5, (a, b) => a & b],
  '==': [6, (a, b) => +(a === b)],
  '!=': [6, (a, b) => +(a !== b)],
  '<': [7, (a, b) => +(a < b)],
  '<=': [7, (a, b) => +(a <= b)],
  '>': [7, (a, b) => +(a > b)],
  '>=': [7, (a, b) => +(a >= b)],
  '<<': [8, (a, b) => a << b],
  '>>': [8, (a, b) => a >> b],
  '+': [9, (a, b) => a + b],
  '-': [9, (a, b) => a - b],
  '*': [10, (a, b) => a * b],
  '/': [10, (a, b) => div(a, b, Math.trunc(a / b))],
  '%': [10, (a, b) => div(a, b, a % b)],
}

function div(_a: number, b: number, result: number) {
  if (b === 0) throw new Error('arithmetic: division by zero')
  return result
}

/** Evaluates an arithmetic expression; names are shell variables (unset or empty is 0). */
export function arith(src: string, vars: Vars): number {
  const toks = lex(src)
  let i = 0
  const peek = () => toks[i]
  const isOp = (v: string) => peek()?.k === 'op' && (peek() as { v: string }).v === v
  const value = (name: string): number => {
    const raw = vars.get(name).trim()
    if (!raw) return 0
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
    // A variable holding an expression is evaluated, as bash does (with a depth guard).
    if (depth > 20) throw new Error(`arithmetic: ${name}: expression recursion level exceeded`)
    depth++
    try {
      return arith(raw, vars)
    } finally {
      depth--
    }
  }
  const assign = (name: string, v: number) => {
    vars.set(name, String(v))
    return v
  }

  function primary(): number {
    const t = toks[i++]
    if (!t) throw new Error('arithmetic: syntax error: operand expected')
    if (t.k === 'num') return t.v
    if (t.k === 'id') {
      if (isOp('++') || isOp('--')) {
        const op = (toks[i++] as { v: string }).v
        const old = value(t.v)
        assign(t.v, op === '++' ? old + 1 : old - 1)
        return old
      }
      return value(t.v)
    }
    if (t.v === '(') {
      const v = comma()
      if (!isOp(')')) throw new Error("arithmetic: missing ')'")
      i++
      return v
    }
    throw new Error(`arithmetic: syntax error near '${t.v}'`)
  }

  function unary(): number {
    const t = peek()
    if (t?.k === 'op') {
      if (t.v === '++' || t.v === '--') {
        i++
        const id = toks[i++]
        if (id?.k !== 'id') throw new Error('arithmetic: ++/-- needs a variable')
        return assign(id.v, value(id.v) + (t.v === '++' ? 1 : -1))
      }
      if (t.v === '!' || t.v === '~' || t.v === '-' || t.v === '+') {
        i++
        const v = unary()
        return t.v === '!' ? +(v === 0) : t.v === '~' ? ~v : t.v === '-' ? -v : v
      }
    }
    return power()
  }

  function power(): number {
    const base = primary()
    if (isOp('**')) {
      i++
      const exp = unary()
      if (exp < 0) throw new Error('arithmetic: exponent less than 0')
      return Math.trunc(base ** exp)
    }
    return base
  }

  function binary(minPrec: number): number {
    let left = unary()
    for (;;) {
      const t = peek()
      if (t?.k !== 'op' || !(t.v in BINARY)) return left
      const [prec, fn] = BINARY[t.v]
      if (prec < minPrec) return left
      i++
      // && and || skip the side they do not need (its assignments do not happen).
      if (t.v === '&&' && left === 0) return skipped(prec + 1, 0)
      if (t.v === '||' && left !== 0) return skipped(prec + 1, 1)
      left = Math.trunc(fn(left, binary(prec + 1)))
    }
  }

  function skipped(prec: number, result: number): number {
    const saved = { get: vars.get, set: vars.set }
    vars.set = () => {}
    try {
      binary(prec)
    } finally {
      vars.set = saved.set
    }
    return result
  }

  function ternary(): number {
    const cond = binary(1)
    if (!isOp('?')) return cond
    i++
    const a = assignment()
    if (!isOp(':')) throw new Error("arithmetic: expected ':'")
    i++
    const b = assignment()
    return cond !== 0 ? a : b
  }

  function assignment(): number {
    const t = peek()
    const n = toks[i + 1]
    if (t?.k === 'id' && n?.k === 'op' && /^(=|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\^=|\|=)$/.test(n.v)) {
      i += 2
      const rhs = assignment()
      if (n.v === '=') return assign(t.v, rhs)
      const op = n.v.slice(0, -1)
      return assign(t.v, Math.trunc(BINARY[op][1](value(t.v), rhs)))
    }
    return ternary()
  }

  function comma(): number {
    let v = assignment()
    while (isOp(',')) {
      i++
      v = assignment()
    }
    return v
  }

  let depth = 0
  if (!toks.length) return 0
  const result = comma()
  if (i < toks.length) throw new Error(`arithmetic: syntax error near '${(toks[i] as { v: unknown }).v}'`)
  return result
}
