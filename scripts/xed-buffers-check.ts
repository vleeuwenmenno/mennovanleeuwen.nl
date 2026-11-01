import assert from 'node:assert/strict'
import { reconcileBuffer } from '../src/data/xedBuffers.ts'
const clean = { text: 'one', saved: 'one' }
assert.deepEqual(reconcileBuffer(clean, clean, 'two'), { text: 'two', saved: 'two' })
const dirty = { text: 'mine', saved: 'one' }
assert.deepEqual(reconcileBuffer(dirty, dirty, 'two'), { ...dirty, external: 'two', deleted: false })
assert.deepEqual(reconcileBuffer(clean, dirty, 'two'), { ...dirty, external: 'two', deleted: false })
assert.equal(reconcileBuffer(clean, { text: 'new save', saved: 'new save' }, 'two')?.text, 'new save')
assert.equal(reconcileBuffer(clean, undefined, 'two'), undefined)
assert.deepEqual(reconcileBuffer(clean, clean, null), { ...clean, external: null, deleted: true })
assert.deepEqual(reconcileBuffer(dirty, dirty, null), { ...dirty, external: null, deleted: true })
assert.equal(reconcileBuffer(dirty, dirty, 'one'), dirty)
console.log('PASS clean, dirty, deletion, closed tab and in-flight edit/save reconciliation')
assert.deepEqual(reconcileBuffer(clean, { ...clean, external: null, deleted: true }, 'one'), clean)
