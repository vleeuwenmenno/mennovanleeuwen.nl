// Checks the find_image page cache's bounds (server/sizedcache.ts): past its entry cap the oldest
// entries go first, past its byte cap too, one entry too big to keep is dropped, and a failure's
// slot can be removed without touching a newer entry under the same key.
//
//   node scripts/find-image-cache-check.ts
//
// Exits 1 on any failure.

import { sizedCache } from '../server/sizedcache.ts'

let failed = false
const check = (what: string, test: boolean) => {
  console.log(test ? 'PASS' : 'FAIL', what)
  if (!test) failed = true
}

const a = sizedCache<number>({ maxEntries: 50, maxBytes: 1e9 })
for (let i = 0; i < 1000; i++) {
  a.set(`k${i}`, i)
  a.settle(`k${i}`, i, 100)
}
check('1000 unique fresh entries: the count stays at the cap', a.size() === 50)
check('the oldest were evicted, the newest kept', a.get('k0') === undefined && a.get('k949') === undefined && a.get('k950')?.value === 950 && a.get('k999')?.value === 999)
check('bytes follow the entries', a.bytes() === 50 * 100)

const b = sizedCache<number>({ maxEntries: 1000, maxBytes: 1000 })
for (let i = 0; i < 100; i++) {
  b.set(`k${i}`, i)
  b.settle(`k${i}`, i, 100)
}
check('the byte cap holds', b.bytes() <= 1000 && b.size() === 10)
check('byte eviction drops the oldest', b.get('k89') === undefined && b.get('k90')?.value === 90)
b.set('big', 7)
b.settle('big', 7, 5000)
check('one entry over the whole byte cap is not kept', b.get('big') === undefined && b.bytes() <= 1000)

const c = sizedCache<number>({ maxEntries: 10, maxBytes: 1000 })
c.set('x', 1)
c.set('x', 2)
c.delete('x', 1)
check('deleting with an older value leaves the newer entry', c.get('x')?.value === 2)
c.delete('x', 2)
check('deleting with the current value removes it', c.get('x') === undefined && c.size() === 0)

console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
