// Watch expressions and hovers for Xed's debugger. They read a paused session's bounded snapshot and
// nothing else: no parsing as shell code, no expansion, no substitution, no commands. Only variable
// references ($name, ${name}, ${#name}, $1, $#, $@, $?) and plain text are understood.

export const MAX_WATCHES = 20
export const MAX_WATCH_LENGTH = 200
/** A value is cut here when it is built, and shown up to WATCH_DISPLAY characters. */
const MAX_RESULT = 4096
export const WATCH_DISPLAY = 1000

export type WatchSnapshot = { variables: Readonly<Record<string, string>>; args: readonly string[] }
export type WatchResult = { ok: true; value: string; truncated: boolean } | { ok: false; error: string }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function lookup(ref: string, snap: WatchSnapshot | null): string | { error: string } {
  if (!snap) return ''
  if (/^\d+$/.test(ref)) {
    const n = Number(ref)
    if (n === 0) return { error: '$0 is not captured at a pause' }
    return n <= snap.args.length ? snap.args[n - 1] : { error: `$${ref} is not set` }
  }
  if (ref === '#') return String(snap.args.length)
  if (ref === '@' || ref === '*') return snap.args.join(' ')
  if (!Object.hasOwn(snap.variables, ref)) return { error: ref === '?' ? '$? is not captured' : `${ref} is not set at this pause` }
  return snap.variables[ref]
}

/** Checks an expression without a snapshot: null when it is allowed, or why not. */
export function watchError(expr: string): string | null {
  const r = evaluateWatch(expr, null)
  return r.ok ? null : r.error
}

export function evaluateWatch(input: string, snap: WatchSnapshot | null): WatchResult {
  const expr = input.trim()
  if (!expr) return { ok: false, error: 'Empty expression' }
  if (expr.length > MAX_WATCH_LENGTH) return { ok: false, error: `Longer than ${MAX_WATCH_LENGTH} characters` }
  if (NAME.test(expr)) return finish(lookup(expr, snap))
  let out = ''
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (c === '`') return { ok: false, error: 'Command substitution is never run in a watch' }
    if (c === '\\') {
      out += expr[i + 1] ?? ''
      i += 2
      continue
    }
    if (c !== '$') {
      out += c
      i++
      continue
    }
    const next = expr[i + 1]
    let value: string | { error: string }
    if (next === '(') return { ok: false, error: expr[i + 2] === '(' ? 'Arithmetic is not evaluated in a watch' : 'Command substitution is never run in a watch' }
    if (next === '{') {
      const close = expr.indexOf('}', i + 2)
      if (close < 0) return { ok: false, error: 'Missing }' }
      const inner = expr.slice(i + 2, close)
      const length = inner.startsWith('#') && inner.length > 1
      const ref = length ? inner.slice(1) : inner
      if (!NAME.test(ref) && !/^\d+$/.test(ref) && !(!length && /^[#@*?]$/.test(ref))) return { ok: false, error: 'Only ${name} and ${#name} are read in a watch' }
      value = lookup(ref, snap)
      if (length && typeof value === 'string') value = String(value.length)
      i = close + 1
    } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let end = i + 2
      while (end < expr.length && /[A-Za-z0-9_]/.test(expr[end])) end++
      value = lookup(expr.slice(i + 1, end), snap)
      i = end
    } else if (next !== undefined && /[0-9#@*?]/.test(next)) {
      value = lookup(next, snap)
      i += 2
    } else {
      out += '$'
      i++
      continue
    }
    if (typeof value !== 'string') return { ok: false, error: value.error }
    out += value
    if (out.length > MAX_RESULT) break
  }
  return finish(out)
}

function finish(value: string | { error: string }): WatchResult {
  if (typeof value !== 'string') return { ok: false, error: value.error }
  return { ok: true, value: value.slice(0, MAX_RESULT), truncated: value.length > MAX_RESULT }
}

/**
 * The variable reference at `offset` in msh source, for a hover or an inspect at the caret:
 * $name, ${name}, ${#name}, $1, or a name being assigned (name=, local/export/read/for name).
 */
export function variableAt(text: string, offset: number): string | null {
  if (offset < 0 || offset > text.length) return null
  const word = /[A-Za-z0-9_]/
  let start = offset
  let end = offset
  while (start > 0 && word.test(text[start - 1])) start--
  while (end < text.length && word.test(text[end])) end++
  // On a $ or ${ itself: the name after it.
  if (start === end) {
    let at = offset
    if (text[at] === '$') at++
    if (text[at] === '{') at++
    if (text[at] === '#') at++
    if (at === offset || !word.test(text[at] ?? '')) return null
    start = end = at
    while (end < text.length && word.test(text[end])) end++
  }
  const name = text.slice(start, end)
  if (!name) return null
  if (/^\d+$/.test(name)) return text[start - 1] === '$' || text.slice(start - 2, start) === '${' ? `$${name}` : null
  if (!NAME.test(name)) return null
  const before = text.slice(Math.max(0, start - 3), start)
  if (before.endsWith('$') || before.endsWith('${') || before.endsWith('${#')) return name
  if (text[end] === '=' || text.slice(end, end + 2) === '+=') {
    const prev = text[start - 1]
    if (start === 0 || prev === undefined || /[\s;&|(]/.test(prev)) return name
  }
  const line = text.slice(text.lastIndexOf('\n', start - 1) + 1, start)
  if (/(?:^|[\s;&|(])(?:local|export|readonly|read(?:\s+-\w+)*|for|unset)\s+(?:[A-Za-z_][A-Za-z0-9_]*(?:=\S*)?\s+)*$/.test(line)) return name
  return null
}
