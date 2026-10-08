// A small calculator for Spotlight. Recursive descent over + - * / % ^, parentheses, unary minus,
// pi/e and a few functions. No eval: anything it does not understand returns null.

const FUNCS: Record<string, (x: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log }
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E }

export function calculate(input: string): number | null {
  const src = input.replace(/\s+/g, '').replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').toLowerCase()
  // Only treat it as maths when it contains an operator or function; a bare number is not a sum.
  if (!src || !/[\d)][+\-*/%^]|^[a-z]+\(|^-?\d*\.?\d+\^/.test(src) || /[^0-9a-z.+\-*/%^()]/.test(src)) return null
  let i = 0

  const peek = () => src[i]
  const eat = (ch: string) => (src[i] === ch ? (i++, true) : false)

  function primary(): number {
    if (eat('(')) {
      const v = expr()
      if (!eat(')')) throw new Error('missing )')
      return v
    }
    const word = /^[a-z]+/.exec(src.slice(i))?.[0]
    if (word) {
      i += word.length
      if (word in CONSTS) return CONSTS[word]
      if (word in FUNCS && eat('(')) {
        const v = expr()
        if (!eat(')')) throw new Error('missing )')
        return FUNCS[word](v)
      }
      throw new Error(`unknown ${word}`)
    }
    const num = /^\d*\.?\d+/.exec(src.slice(i))?.[0]
    if (!num) throw new Error('expected a number')
    i += num.length
    return parseFloat(num)
  }

  function unary(): number {
    if (eat('-')) return -unary()
    if (eat('+')) return unary()
    return primary()
  }

  function power(): number {
    const base = unary()
    return eat('^') ? base ** power() : base
  }

  function term(): number {
    let v = power()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[i++]
      const r = power()
      v = op === '*' ? v * r : op === '/' ? v / r : v % r
    }
    return v
  }

  function expr(): number {
    let v = term()
    while (peek() === '+' || peek() === '-') v = src[i++] === '+' ? v + term() : v - term()
    return v
  }

  try {
    const v = expr()
    return i === src.length && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

export const formatNumber = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { maximumFractionDigits: 10 }))
