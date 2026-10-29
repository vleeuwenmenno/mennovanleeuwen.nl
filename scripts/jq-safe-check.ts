import assert from 'node:assert/strict'
import { safeJq, boundedJson, SAFE_JQ_LIMITS, type SafeJqBudget } from '../src/terminal/jq-safe.ts'
import { stripMarkup } from '../src/terminal/markup.ts'
const signal = new AbortController().signal
const run = (args: string[], input = '') => safeJq(args, input, { signal })
const value = async (filter: string, input: unknown) => JSON.parse(await run(['-c', filter], JSON.stringify(input)))
let passed = 0
async function rejects(args: string[], input: string, pattern: RegExp) {
  await assert.rejects(run(args, input), pattern); passed++
}
assert.equal(await value('.user.name', { user: { name: 'Ada' } }), 'Ada')
assert.equal(await value('.["odd.key"]', { 'odd.key': 4 }), 4)
assert.equal(await value('.[-1]', [2, 3]), 3)
assert.deepEqual(await value('[.[] | select(.active and .score >= 2) | {name}]', [{ name: 'Ada', active: true, score: 2 }, { name: 'No', active: false, score: 3 }]), [{ name: 'Ada' }])
assert.deepEqual(await value('map(select(. > 1))', [0, 1, 2]), [2])
assert.deepEqual(await value('[.[] | .name?]', [1, {}, { name: 'Ada' }]), [null, 'Ada'])
assert.equal(await run(['-nc', '--arg', 'text', 'quotes "\n\\ {c:red}text{/}', '$text | tojson | fromjson | tojson | fromjson']), '"quotes \\"\\n\\\\ \\u007bc:red\\u007dtext\\u007b/\\u007d"')
const constructed = await run(['-nc', '--arg', 'key', '__proto__', '--argjson', 'obj', '{"constructor":7,"prototype":8}', '{($key): $obj, obj: $obj}'])
assert.deepEqual(JSON.parse(constructed), JSON.parse('{"__proto__":{"constructor":7,"prototype":8},"obj":{"constructor":7,"prototype":8}}'))
assert.deepEqual(await value('{constructor, __proto__}', {}), { constructor: null, ['__proto__']: null })
assert.equal(({} as Record<string, unknown>).polluted, undefined)
assert.deepEqual(JSON.parse(await run(['-nc', '--arg', 'key', 'chosen', '{$key: 7}'])), { chosen: 7 })
assert.deepEqual(JSON.parse(await run(['-nc', '--arg', 'key', 'chosen', '{$key}'])), { key: 'chosen' })
const markup = { '{c:red}key{/}': '{anim:spin}{/} {fg:red} hi {link:x}{/}' }
assert.deepEqual(JSON.parse(stripMarkup(await run(['.'], JSON.stringify(markup)))), markup)
assert.deepEqual(JSON.parse(stripMarkup(await run(['-c', '.'], JSON.stringify(markup)))), markup)
for (const filter of ['test("(a+)+$")', 'gsub("x";"y")', 'recurse', '..', 'range(99999999)', 'def x: x; x', '. * 999999', '.a = 1', '. as $x | $x', 'inputs']) await rejects(['-n', filter], '', /unsupported|expected/)
await rejects(['.', 'file.json'], '{}', /stdin only/)
await rejects(['--slurp', '.'], '{}', /unsupported option/)
await rejects(['--argjson', 'x', '{bad}', '$x'], '{}', /invalid JSON/)
await rejects(['--arg', 'x'], '{}', /requires NAME VALUE/)
await rejects(['$missing'], '{}', /undefined variable/)
await rejects(['fromjson'], '3', /requires a string/)
await rejects(['fromjson'], '"broken"', /invalid JSON/)
await rejects(['.'], '1 2', /invalid JSON/)
await rejects(['.'], '1e999', /non-finite/)
await rejects(['-n', '1e999'], '', /non-finite/)
await rejects(['-n', '{(1): 2}'], '', /object key/)
await rejects(['map(.)'], '{}', /requires an array/)
await rejects(['.'], '['.repeat(40) + '0' + ']'.repeat(40), /memory limit/)
await rejects(['-n', '('.repeat(40) + '.' + ')'.repeat(40)], '', /nesting limit/)
await rejects(['-n', '.'.repeat(SAFE_JQ_LIMITS.filter + 1)], '', /memory limit/)
await rejects(['.'], ' '.repeat(SAFE_JQ_LIMITS.text + 1), /memory limit/)
await rejects(['.'], ' '.repeat(SAFE_JQ_LIMITS.steps) + '0', /steps limit/)
await rejects(['-n', '--arg', 'x', 'a'.repeat(12000), '$x'], '', /memory limit/)
await rejects(['-n', '[.] | [.,.]'], '', /expected/)
// Amplification is refused while accumulating intermediates, before JSON serialization.
const array = JSON.stringify(Array.from({ length: 300 }, (_, i) => i))
await rejects(['map([., .])'], array, /expected/)
await rejects(['map({a: ., b: ., c: ., d: ., e: .})'], array, /memory limit|steps limit/)
// No catch-all optional operator may suppress budget exhaustion or unsupported code.
await rejects(['map({a: ., b: ., c: ., d: ., e: .})?'], array, /memory limit|steps limit/)
const aborted = new AbortController(); aborted.abort()
await assert.rejects(safeJq(['.'], '{}', { signal: aborted.signal }), /cancelled/)
let steps = 0, writes = 0, stopped = ''
const budget: SafeJqBudget = { step() { return ++steps > 5 ? 'steps' : null }, write(n) { writes += n; return null }, stop(why) { stopped = why } }
await assert.rejects(safeJq(['.'], '[1,2,3,4]', { signal, budget }), /shared budget steps/)
await assert.rejects(safeJq(['.'], '{}', { signal, policy: {} }), /budget required/)
const denied: SafeJqBudget = { step: () => null, write: () => 'output', stop() {} }
await assert.rejects(safeJq(['.'], '{}', { signal, budget: denied }), /shared budget output/)
// Trigger abort via a timer only after evaluation has started (literal construction, no input parse).
const ctl = new AbortController()
let ticks = 0, evaluationWrites = 0, scheduledAt = 0, abortScheduled = false, timerFired = false
const cancelling: SafeJqBudget = {
  step() { ticks++; return null },
  write() {
    if (++evaluationWrites === 10) {
      abortScheduled = true; scheduledAt = ticks
      setTimeout(() => { timerFired = true; ctl.abort() }, 0)
    }
    return null
  },
  stop(why) { stopped = why },
}
const chain = '{a: "' + 'x'.repeat(100) + '"}' + ' | {a: ., b: .}'.repeat(10)
await assert.rejects(safeJq(['-n', chain], '', { signal: ctl.signal, budget: cancelling }), /cancelled/)
assert.ok(abortScheduled && timerFired)
assert.equal(stopped, 'cancelled')
assert.ok(ticks - scheduledAt <= 64, 'cancellation stops evaluation by the next yield')
console.log(`jq-safe: functional cases, ${passed} adversarial cases, shared budget and in-computation timer cancellation passed`)

// Boolean operands are lazy; whitespace after identity must not become a field name.
assert.equal(await value('false and fromjson', 3), false)
assert.equal(await value('true or fromjson', 3), true)
await rejects(['true and fromjson'], '3', /requires a string/)
await rejects(['false or fromjson'], '3', /requires a string/)
assert.equal(await value('. and true', false), false)
assert.equal(await value('. or false', true), true)
assert.equal(await value('select(. and true)', 3), 3)
assert.equal(await value('.and', { and: 7 }), 7)
assert.equal(await value('.or', { or: 8 }), 8)
assert.equal(await value('.["and"]', { and: 9 }), 9)
const jsonContext = { signal }
const data = JSON.parse('{"__proto__":{"safe":true},"constructor":"{c:red}literal{/}","values":[null,false,3]}')
assert.deepEqual(JSON.parse(stripMarkup(await boundedJson(data, jsonContext))), data)
const shared = { v: 1 }
assert.deepEqual(JSON.parse(await boundedJson([shared, shared], jsonContext)), [{ v: 1 }, { v: 1 }])
const cycle: unknown[] = []; cycle.push(cycle)
let getterRan = false, hookRan = false
const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { getterRan = true; return 1 } })
for (const bad of [undefined, NaN, Infinity, 1n, Symbol('x'), () => 1, new Date(), new Map(), cycle, accessor, { toJSON() { hookRan = true; return 1 } }, [undefined], new Array(3), { x: undefined }]) {
  await assert.rejects(boundedJson(bad, jsonContext), /expected JSON data/)
}
assert.equal(getterRan, false); assert.equal(hookRan, false)
await assert.rejects(boundedJson('x'.repeat(65537), jsonContext), /memory limit/)
await assert.rejects(boundedJson(Array(5000).fill(0), jsonContext), /memory limit/)
let deep: unknown = null
for (let i = 0; i < 40; i++) deep = { deep }
await assert.rejects(boundedJson(deep, jsonContext), /memory limit/)
await assert.rejects(boundedJson({}, { signal, policy: {} }), /budget required/)
await assert.rejects(boundedJson({}, { signal, budget: denied }), /shared budget output/)
await assert.rejects(boundedJson({}, { signal: aborted.signal }), /cancelled/)
const jsonAbort = new AbortController()
let jsonTicks = 0
const jsonBudget: SafeJqBudget = {
  step() { if (++jsonTicks === 100) setTimeout(() => jsonAbort.abort(), 0); return null },
  write() { return null }, stop() {},
}
await assert.rejects(boundedJson(Array(1000).fill(1), { signal: jsonAbort.signal, budget: jsonBudget }), /cancelled/)
assert.ok(jsonTicks <= 128, 'boundedJson yields during validation')
// Oversized values must never reach native stringify, even when no budget was supplied.
const stringify = JSON.stringify
let serialized = false
JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { serialized = true; return stringify(...args) }) as typeof JSON.stringify
try { await assert.rejects(boundedJson('x'.repeat(65537), jsonContext), /memory limit/) }
finally { JSON.stringify = stringify }
assert.equal(serialized, false)
console.log('jq-safe: lazy booleans, identity parsing, boundedJson validation/escaping/budget/cancellation passed')
