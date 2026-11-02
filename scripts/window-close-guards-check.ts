import assert from 'node:assert/strict'
import { CloseGuards } from '../src/os/closeGuards.ts'

for (const order of [['agents', 'terminal'], ['terminal', 'agents']]) {
  const guards = new CloseGuards(), seen: string[] = []
  const cleanup = new Map(order.map(name => [name, guards.register(1, () => { seen.push(name); return name !== 'agents' })]))
  assert.equal(await guards.allow(1), false)
  assert.deepEqual(seen, order.slice(0, order.indexOf('agents') + 1))
  cleanup.get('terminal')!()
  seen.length = 0
  assert.equal(await guards.allow(1), false)
  assert.deepEqual(seen, ['agents'], 'terminal cleanup must not remove the answering-thread guard')
  const remounted = guards.register(1, () => { seen.push('terminal-remounted'); return false })
  cleanup.get('terminal')!() // Late/double cleanup must not delete a newer registration.
  cleanup.get('agents')!()
  seen.length = 0
  assert.equal(await guards.allow(1), false)
  assert.deepEqual(seen, ['terminal-remounted'])
  remounted()
  assert.equal(guards.has(1), false)
  assert.equal(await guards.allow(1), true)
}
console.log('PASS either mount order, cancellation, unmount/remount, and stale cleanup')

const guards = new CloseGuards(), seen: string[] = []
let answer!: (ok: boolean) => void
const removeFirst = guards.register(2, () => { seen.push('first'); return new Promise<boolean>(resolve => { answer = resolve }) })
const removeSecond = guards.register(2, () => { seen.push('removed'); return false })
const pending = guards.allow(2)
assert.deepEqual(seen, ['first'], 'dialogs must be sequential')
removeSecond()
const removeNew = guards.register(2, () => { seen.push('new'); return false })
assert.equal(await guards.allow(3), true, 'another window has its own guard set')
answer(true)
assert.equal(await pending, false)
assert.deepEqual(seen, ['first', 'new'], 'a participant mounted while asking still gets a veto')
removeFirst(); removeNew()
const removeThrowing = guards.register(2, () => { throw new Error('guard failure') })
const removeVeto = guards.register(2, () => false)
assert.equal(await guards.allow(2), false, 'a failed guard cannot skip another owner’s veto')
removeThrowing(); removeVeto()
const shared = () => false
const removeA = guards.register(2, shared), removeB = guards.register(2, shared)
removeA()
assert.equal(await guards.allow(2), false, 'identical callbacks still have separate owners')
removeB()
console.log('PASS async composition, live registration changes, isolated PIDs, and independent ownership')
