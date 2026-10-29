// Agent-safe JSON transformations. No import or fallback to the rich jq evaluator.
// Text sizes are UTF-16 code units; allocation accounting deliberately overestimates JSON.
export const SAFE_JQ_LIMITS = Object.freeze({ text: 65536, filter: 4096, tokens: 512, depth: 32, nodes: 4096, steps: 50000, total: 4 * 1024 * 1024, output: 65536, timeoutMs: 2000 })
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
// Shared evaluator budget contract; implemented by the shell execution Budget.
export interface SafeJqBudget {
  step(): string | null
  write(n: number, held: number): string | null
  stop(why: 'cancelled' | 'timeout' | 'steps' | 'output' | 'memory'): unknown
}
export class SafeJqError extends Error {}
class Run {
  steps = 0
  total = 0
  deadline = Date.now() + SAFE_JQ_LIMITS.timeoutMs
  readonly signal: AbortSignal
  readonly budget?: SafeJqBudget
  constructor(signal: AbortSignal, budget?: SafeJqBudget) { this.signal = signal; this.budget = budget }
  fail(why: 'cancelled' | 'timeout' | 'steps' | 'output' | 'memory'): never {
    this.budget?.stop(why)
    throw new SafeJqError(`jq-safe: ${why} limit`)
  }
  async tick() {
    // A macrotask, not Promise.resolve: abort events and the agent timeout must run.
    if (++this.steps % 64 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (this.signal.aborted) this.fail('cancelled')
    if (Date.now() > this.deadline) this.fail('timeout')
    if (this.steps > SAFE_JQ_LIMITS.steps) this.fail('steps')
    const stop = this.budget?.step()
    if (stop) throw new SafeJqError(`jq-safe: shared budget ${stop}`)
  }
  charge(n: number, held = 0) {
    this.total += n
    if (this.total > SAFE_JQ_LIMITS.total || held + n > SAFE_JQ_LIMITS.text) this.fail('memory')
    const stop = this.budget?.write(n, held)
    if (stop) throw new SafeJqError(`jq-safe: shared budget ${stop}`)
  }
  // Walk occurrences, not identities: repeated references also cost when serialized.
  async size(value: Json, depth = 0): Promise<number> {
    let nodes = 0, size = 0
    const visit = async (v: Json, d: number): Promise<void> => {
      await this.tick()
      if (++nodes > SAFE_JQ_LIMITS.nodes || d > SAFE_JQ_LIMITS.depth) this.fail('memory')
      size += (typeof v === 'string' ? 6 * v.length + 2 : 24) + 4 * d + 4
      if (size > SAFE_JQ_LIMITS.text) this.fail('memory')
      if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          size += Array.isArray(v) ? 1 : 6 * k.length + 3
          if (size > SAFE_JQ_LIMITS.text) this.fail('memory')
          await visit((v as Record<string, Json>)[k], d + 1)
        }
      }
    }
    await visit(value, depth)
    return size
  }
  async retain(value: Json) { this.charge(await this.size(value)); return value }
  async parse(text: string): Promise<Json> {
    if (text.length > SAFE_JQ_LIMITS.text) this.fail('memory')
    // Bound nesting BEFORE native JSON.parse. Its remaining synchronous work is capped at 64 KiB.
    let depth = 0, quoted = false
    for (let i = 0; i < text.length; i++) {
      await this.tick()
      const c = text[i]
      if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false }
      else if (c === '"') quoted = true
      else if (c === '[' || c === '{') { if (++depth > SAFE_JQ_LIMITS.depth) this.fail('memory') }
      else if (c === ']' || c === '}') depth--
    }
    let value: Json
    try { value = JSON.parse(text) } catch { throw new SafeJqError('jq-safe: invalid JSON') }
    // JSON's numeric syntax can overflow JS's finite range.
    const check = async (v: Json): Promise<void> => {
      await this.tick()
      if (typeof v === 'number' && !Number.isFinite(v)) throw new SafeJqError('jq-safe: non-finite number')
      if (v && typeof v === 'object') for (const x of Object.values(v)) await check(x)
    }
    await this.retain(value)
    await check(value)
    return value
  }
}
type Token = { kind: string; text: string; start: number }
// Adapted from jq.ts's token vocabulary; interpolation and arbitrary builtins are excluded.
async function tokenize(src: string, run: Run): Promise<Token[]> {
  if (src.length > SAFE_JQ_LIMITS.filter) run.fail('memory')
  const out: Token[] = []
  for (let i = 0; i < src.length;) {
    await run.tick()
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (out.length >= SAFE_JQ_LIMITS.tokens) run.fail('memory')
    if (c === '"') {
      let j = i + 1
      for (; j < src.length; j++) { if (src[j] === '\\') j++; else if (src[j] === '"') break }
      if (j >= src.length) throw new SafeJqError('jq-safe: unterminated string')
      const text = src.slice(i, j + 1)
      try { JSON.parse(text) } catch { throw new SafeJqError('jq-safe: invalid string literal') }
      out.push({ kind: 'string', text, start: i }); i = j + 1
    } else {
      const m = /^(?:-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i))
      if (m) { out.push({ kind: m[0][0] === '$' ? 'var' : /^-?\d/.test(m[0]) ? 'number' : 'id', text: m[0], start: i }); i += m[0].length }
      else {
        const op = ['==', '!=', '<=', '>='].includes(src.slice(i, i + 2)) ? src.slice(i, i + 2) : c
        if (!['.', '[', ']', '{', '}', '(', ')', ':', ',', '|', '?', '==', '!=', '<=', '>=', '<', '>'].includes(op)) throw new SafeJqError(`jq-safe: unsupported token ${c}`)
        out.push({ kind: 'op', text: op, start: i }); i += op.length
      }
    }
  }
  return out
}
type Ast = { op: string; value?: Json; name?: string; children: Ast[] }
const ast = (op: string, children: Ast[] = [], value?: Json, name?: string): Ast => ({ op, children, value, name })
class Parser {
  p = 0
  depth = 0
  readonly tokens: Token[]
  constructor(tokens: Token[]) { this.tokens = tokens }
  peek(s: string) { return this.tokens[this.p]?.text === s && this.tokens[this.p]?.kind !== 'string' }
  eat(s: string) { if (!this.peek(s)) throw new SafeJqError(`jq-safe: expected ${s}`); this.p++ }
  expr(min = 0): Ast {
    if (++this.depth > SAFE_JQ_LIMITS.depth) throw new SafeJqError('jq-safe: filter nesting limit')
    let left = this.primary()
    const precedence: Record<string, number> = { '|': 1, or: 2, and: 3, '==': 4, '!=': 4, '<': 4, '>': 4, '<=': 4, '>=': 4 }
    while (this.tokens[this.p]?.kind !== 'string') {
      const op = this.tokens[this.p]?.text
      const rank = Object.hasOwn(precedence, op ?? '') ? precedence[op] : 0
      if (!rank || rank <= min) break
      this.p++
      left = ast(op, [left, this.expr(rank)])
    }
    this.depth--
    return left
  }
  primary(): Ast {
    const t = this.tokens[this.p++]
    if (!t) throw new SafeJqError('jq-safe: unexpected end of filter')
    let n: Ast
    if (t.kind === 'string' || t.kind === 'number') {
      const v = JSON.parse(t.text) as Json
      if (typeof v === 'number' && !Number.isFinite(v)) throw new SafeJqError('jq-safe: non-finite number')
      n = ast('literal', [], v)
    } else if (t.kind === 'var') n = ast('var', [], undefined, t.text.slice(1))
    else if (t.text === '.') {
      n = ast('identity')
      const next = this.tokens[this.p]
      if ((next?.kind === 'id' && (next.start === t.start + 1 || !['and', 'or'].includes(next.text))) || next?.kind === 'string') n = this.field(n)
    } else if (['true', 'false', 'null'].includes(t.text)) n = ast('literal', [], JSON.parse(t.text))
    else if (t.text === '(') { n = this.expr(); this.eat(')') }
    else if (t.text === '[') { n = ast('array', this.peek(']') ? [] : [this.expr()]); this.eat(']') }
    else if (t.text === '{') {
      const entries: Ast[] = []
      while (!this.peek('}')) {
        const k = this.tokens[this.p++]
        if (!k) throw new SafeJqError('jq-safe: expected object key')
        let key: Ast, value: Ast
        if (k.text === '(') { key = this.expr(); this.eat(')'); this.eat(':'); value = this.expr() }
        else if (k.kind === 'id' || k.kind === 'string' || k.kind === 'var') {
          const name = k.kind === 'string' ? JSON.parse(k.text) as string : k.kind === 'var' ? k.text.slice(1) : k.text
          key = ast('literal', [], name)
          if (this.peek(':')) { this.p++; if (k.kind === 'var') key = ast('var', [], undefined, name); value = this.expr() }
          else value = k.kind === 'var' ? ast('var', [], undefined, name) : ast('index', [ast('identity'), key])
        } else throw new SafeJqError('jq-safe: invalid object key')
        entries.push(ast('entry', [key, value]))
        if (!this.peek(',')) break
        this.p++
      }
      this.eat('}'); n = ast('object', entries)
    } else if (['map', 'select'].includes(t.text)) { this.eat('('); n = ast(t.text, [this.expr()]); this.eat(')') }
    else if (['fromjson', 'tojson', 'length', 'not'].includes(t.text)) n = ast(t.text)
    else throw new SafeJqError(`jq-safe: unsupported filter ${t.text}`)
    for (;;) {
      if (this.peek('.')) { this.p++; n = this.field(n) }
      else if (this.peek('[')) {
        this.p++
        n = this.peek(']') ? ast('iterate', [n]) : ast('index', [n, this.expr()])
        this.eat(']')
      } else break
    }
    if (this.peek('?')) { this.p++; n = ast('optional', [n]) }
    return n
  }
  field(base: Ast) {
    const k = this.tokens[this.p++]
    if (!k || !['id', 'string'].includes(k.kind)) throw new SafeJqError('jq-safe: expected field')
    return ast('index', [base, ast('literal', [], k.kind === 'string' ? JSON.parse(k.text) : k.text)])
  }
}
class TypeErrorJq extends SafeJqError {}
const truth = (v: Json) => v !== null && v !== false
async function evaluate(n: Ast, input: Json, vars: Record<string, Json>, run: Run, depth = 0): Promise<Json[]> {
  await run.tick()
  if (depth > SAFE_JQ_LIMITS.depth) run.fail('memory')
  const ev = (node: Ast, x = input) => evaluate(node, x, vars, run, depth + 1)
  const one = async (node: Ast, x = input): Promise<Json> => {
    const values = await ev(node, x)
    if (values.length !== 1) throw new SafeJqError('jq-safe: expected exactly one value')
    return values[0]
  }
  const out: Json[] = []
  let held = 0
  const add = async (v: Json) => { const size = await run.size(v); run.charge(size, held); held += size; out.push(v) }
  switch (n.op) {
    case 'identity': await add(input); break
    case 'literal': await add(n.value!); break
    case 'var': if (!Object.hasOwn(vars, n.name!)) throw new SafeJqError(`jq-safe: undefined variable $${n.name}`); await add(vars[n.name!]); break
    case '|': for (const v of await ev(n.children[0])) for (const w of await ev(n.children[1], v)) await add(w); break
    case 'array': await add(n.children.length ? await ev(n.children[0]) : []); break
    case 'map': {
      if (!Array.isArray(input)) throw new TypeErrorJq('jq-safe: map requires an array')
      for (const v of input) for (const w of await ev(n.children[0], v)) await add(w)
      await run.retain(out)
      return [out]
    }
    case 'select': if ((await ev(n.children[0])).some(truth)) await add(input); break
    case 'optional': try { for (const v of await ev(n.children[0])) await add(v) } catch (e) { if (!(e instanceof TypeErrorJq)) throw e } break
    case 'index': {
      const key = await one(n.children[1])
      for (const v of await ev(n.children[0])) {
        if (v === null) await add(null)
        else if (Array.isArray(v) && typeof key === 'number' && Number.isInteger(key)) await add(v[key < 0 ? v.length + key : key] ?? null)
        else if (v && typeof v === 'object' && !Array.isArray(v) && typeof key === 'string') await add(Object.hasOwn(v, key) ? v[key] : null)
        else throw new TypeErrorJq('jq-safe: invalid index type')
      }
      break
    }
    case 'iterate': for (const v of await ev(n.children[0])) {
      if (!v || typeof v !== 'object') throw new TypeErrorJq('jq-safe: cannot iterate this value')
      for (const w of Object.values(v)) await add(w)
    } break
    case 'object': {
      const obj: Record<string, Json> = Object.create(null)
      let size = 24
      for (const entry of n.children) {
        const key = await one(entry.children[0])
        if (typeof key !== 'string') throw new TypeErrorJq('jq-safe: object key must be a string')
        const value = await one(entry.children[1])
        const cost = 6 * key.length + 3 + await run.size(value)
        run.charge(cost, size); size += cost
        obj[key] = value
      }
      await add(obj); break
    }
    case 'fromjson': if (typeof input !== 'string') throw new TypeErrorJq('jq-safe: fromjson requires a string'); await add(await run.parse(input)); break
    case 'tojson': await run.size(input); await add(JSON.stringify(input)); break
    case 'length': if (input === null) await add(0); else if (typeof input === 'string' || Array.isArray(input)) await add(input.length); else if (typeof input === 'object') await add(Object.keys(input).length); else throw new TypeErrorJq('jq-safe: length requires string, array, object or null'); break
    case 'not': await add(!truth(input)); break
    default: {
      const a = await one(n.children[0])
      if (n.op === 'and' || n.op === 'or') {
        if (n.op === 'and' && !truth(a)) await add(false)
        else if (n.op === 'or' && truth(a)) await add(true)
        else await add(truth(await one(n.children[1])))
      } else {
        const b = await one(n.children[1])
        // Scalar comparisons only: no recursive equality, coercion or user regex.
        if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')) throw new TypeErrorJq('jq-safe: comparisons require scalars')
        if (n.op === '==' || n.op === '!=') await add(n.op === '==' ? a === b : a !== b)
        else {
          if (typeof a !== typeof b || !['number', 'string'].includes(typeof a)) throw new TypeErrorJq('jq-safe: ordering requires matching numbers or strings')
          const aa = a as number, bb = b as number
          await add(n.op === '<' ? aa < bb : n.op === '>' ? aa > bb : n.op === '<=' ? aa <= bb : aa >= bb)
        }
      }
    }
  }
  return out
}

export type SafeJsonContext = { signal: AbortSignal; budget?: SafeJqBudget; policy?: unknown }

/** Serialize ordinary, already-parsed JSON data without calling user getters or toJSON.
 * Proxies/executable host objects are not a supported input boundary; callers pass parsed data.
 * Snapshot before serialization: data may change while validation yields to the event loop.
 */
export async function boundedJson(value: unknown, context: SafeJsonContext): Promise<string> {
  if (context.policy && !context.budget) throw new SafeJqError('jq-safe: agent budget required')
  const run = new Run(context.signal, context.budget)
  const active = new WeakSet<object>()
  let nodes = 0, held = 0
  const invalid = (): never => { throw new SafeJqError('jq-safe: expected JSON data (no cycles, accessors or non-JSON values)') }
  const copy = async (v: unknown, depth: number): Promise<Json> => {
    await run.tick()
    if (++nodes > SAFE_JQ_LIMITS.nodes || depth > SAFE_JQ_LIMITS.depth) run.fail('memory')
    const cost = (typeof v === 'string' ? 6 * v.length + 2 : 24) + 4 * depth + 4
    run.charge(cost, held); held += cost
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number') { if (!Number.isFinite(v)) invalid(); return v }
    if (typeof v !== 'object') return invalid()
    if (active.has(v)) return invalid()
    const array = Array.isArray(v)
    const proto = Object.getPrototypeOf(v)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid()
    if (Object.getOwnPropertySymbols(v).length) return invalid()
    active.add(v)
    const result: Json[] | Record<string, Json> = array ? [] : Object.create(null)
    if (array) {
      const length = Object.getOwnPropertyDescriptor(v, 'length')!.value as number
      if (length > SAFE_JQ_LIMITS.nodes) run.fail('memory')
      // Shadow an inherited toJSON without introducing an enumerable output key.
      Object.defineProperty(result, 'toJSON', { value: undefined })
      for (let i = 0; i < length; i++) {
        const desc = Object.getOwnPropertyDescriptor(v, String(i))
        if (!desc || !('value' in desc) || !desc.enumerable) return invalid()
        ;(result as Json[]).push(await copy(desc.value, depth + 1))
      }
    }
    // Incremental enumeration avoids building a key array for a huge response object.
    for (const key in v) {
      await run.tick()
      if (!Object.hasOwn(v, key)) continue
      if (array) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (result as Json[]).length) return invalid()
        continue
      }
      const desc = Object.getOwnPropertyDescriptor(v, key)
      if (!desc || !('value' in desc) || !desc.enumerable) return invalid()
      const keyCost = 6 * key.length + 3
      run.charge(keyCost, held); held += keyCost
      ;(result as Record<string, Json>)[key] = await copy(desc.value, depth + 1)
    }
    active.delete(v)
    return result
  }
  const snapshot = await copy(value, 0)
  // Reuse evaluator accounting and its depth/size walk BEFORE native serialization.
  await run.retain(snapshot)
  const output = JSON.stringify(snapshot).replace(/"(?:[^"\\]|\\.)*"/g,
    (s) => s.replace(/\{/g, '\\u007b').replace(/\}/g, '\\u007d'))
  if (output.length > SAFE_JQ_LIMITS.output) run.fail('output')
  run.charge(output.length)
  await run.tick()
  return output
}

/** stdin-only adapter: uses the shell signal and shared execution budget. */
export async function safeJq(argv: string[], input: string, context: SafeJsonContext): Promise<string> {
  if (context.policy && !context.budget) throw new SafeJqError('jq-safe: agent budget required')
  const run = new Run(context.signal, context.budget)
  await run.tick()
  if (argv.length > 128 || input.length > SAFE_JQ_LIMITS.text) run.fail('memory')
  let chars = 0
  for (const a of argv) { chars += a.length; if (chars > SAFE_JQ_LIMITS.text) run.fail('memory') }
  let nullInput = false, raw = false, compact = false, filter: string | undefined
  const vars: Record<string, Json> = Object.create(null)
  for (let i = 0; i < argv.length; i++) {
    await run.tick()
    const a = argv[i]
    if (a === '--arg' || a === '--argjson') {
      const name = argv[++i], value = argv[++i]
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === undefined) throw new SafeJqError('jq-safe: --arg/--argjson requires NAME VALUE')
      vars[name] = a === '--arg' ? await run.retain(value) : await run.parse(value)
    } else if (/^-[ncr]+$/.test(a)) { nullInput ||= a.includes('n'); raw ||= a.includes('r'); compact ||= a.includes('c') }
    else if (a.startsWith('-')) throw new SafeJqError(`jq-safe: unsupported option ${a}`)
    else if (filter === undefined) filter = a
    else throw new SafeJqError('jq-safe: stdin only; expected one filter, no filenames')
  }
  const parser = new Parser(await tokenize(filter ?? '.', run))
  const program = parser.expr()
  if (parser.p !== parser.tokens.length) throw new SafeJqError('jq-safe: unsupported trailing syntax')
  // Exactly one JSON document (or -n); no unbounded stream parser.
  const data = nullInput ? null : await run.parse(input)
  const output = await evaluate(program, data, vars, run)
  const lines: string[] = []
  let length = 0
  for (const value of output) {
    await run.tick()
    await run.size(value)
    // Escape braces in JSON strings so terminal markup stripping preserves JSON data.
    const line = raw && typeof value === 'string' ? value : JSON.stringify(value, null, compact ? undefined : 2).replace(/"(?:[^"\\]|\\.)*"/g, (s) => s.replace(/\{/g, '\\u007b').replace(/\}/g, '\\u007d'))
    length += line.length + (lines.length ? 1 : 0)
    if (length > SAFE_JQ_LIMITS.output) run.fail('output')
    run.charge(line.length, length - line.length)
    lines.push(line)
  }
  await run.tick()
  return lines.join('\n')
}
