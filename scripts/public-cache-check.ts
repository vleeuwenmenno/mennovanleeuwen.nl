// Checks the public proxy caches (server/boundedcache.ts, github.ts, suggest.ts): the entry cap
// holds, expired and failed entries go first, identical requests share one fetch, and upstream
// requests running at once are limited.
//
//   node scripts/public-cache-check.ts
//
// No network: fetch is replaced. Exits 1 on any failure.

import { boundedCache } from '../server/boundedcache.ts'
import { githubCacheStats, githubCommits } from '../server/github.ts'
import { suggest, suggestCacheStats } from '../server/suggest.ts'

let failed = false
const check = (what: string, test: boolean, detail?: unknown) => {
  if (test) console.log('PASS', what)
  else {
    failed = true
    console.log('FAIL', what, detail ?? '')
  }
}

// --- the cache itself, with a fake clock
{
  let t = 0
  const c = boundedCache<string>({ max: 5, ttlMs: 1000, failTtlMs: 100, maxInFlight: 100, now: () => t })
  let loads = 0
  const ok = (v: string) => () => (loads++, Promise.resolve({ value: v, ok: true }))
  const bad = (v: string) => () => (loads++, Promise.resolve({ value: v, ok: false }))
  let peak = 0
  for (let i = 0; i < 50; i++) {
    await c.get(`k${i}`, i % 2 ? ok('x') : bad('x'), 'busy')
    peak = Math.max(peak, c.size())
  }
  check('size never exceeds the cap', peak <= 5, peak)
  check('size at the cap after a flood', c.size() === 5, c.size())

  await c.get('a', ok('1'), 'busy')
  loads = 0
  await c.get('a', ok('2'), 'busy')
  check('a live entry is shared', loads === 0)
  t += 1001
  await c.get('a', ok('3'), 'busy')
  check('an expired entry loads again', loads === 1)

  const c2 = boundedCache<string>({ max: 3, ttlMs: 1000, failTtlMs: 100, maxInFlight: 100, now: () => t })
  await c2.get('good', ok('g'), 'busy')
  await c2.get('fail', bad('f'), 'busy')
  t += 500 // 'fail' is over its short time, 'good' is not
  await c2.get('n1', ok('n'), 'busy')
  await c2.get('n2', ok('n'), 'busy') // full: the expired failure goes, 'good' stays
  loads = 0
  await c2.get('good', ok('g2'), 'busy')
  check('expired failure is evicted before live entries', loads === 0 && c2.size() === 3, [loads, c2.size()])
  await c2.get('fail', bad('f'), 'busy')
  check('a failure is cached only briefly', loads === 1)

  const c3 = boundedCache<string>({ max: 2, ttlMs: 1000, failTtlMs: 100, maxInFlight: 100, now: () => t })
  await c3.get('a', ok('a'), 'busy')
  await c3.get('b', ok('b'), 'busy')
  await c3.get('a', ok('a'), 'busy') // touch: 'b' is now the oldest
  await c3.get('c', ok('c'), 'busy')
  loads = 0
  await c3.get('a', ok('a'), 'busy')
  check('oldest entry goes first when nothing expired', loads === 0)
  await c3.get('b', ok('b'), 'busy')
  check('the least recently used one was evicted', loads === 1)

  const c4 = boundedCache<string>({ max: 3, ttlMs: 1000, failTtlMs: 100, maxInFlight: 100, now: () => t })
  const never = () => new Promise<{ value: string; ok: boolean }>(() => {})
  for (let i = 0; i < 10; i++) void c4.get(`p${i}`, never, 'busy')
  check('in-flight entries count against the cap', c4.size() === 3, c4.size())

  const c5 = boundedCache<string>({ max: 10, ttlMs: 1000, failTtlMs: 100, maxInFlight: 100, now: () => t })
  let release: (() => void) | undefined
  let n = 0
  const slow = () => (n++, new Promise<{ value: string; ok: boolean }>((r) => (release = () => r({ value: 'v', ok: true }))))
  const p1 = c5.get('same', slow, 'busy')
  const p2 = c5.get('same', slow, 'busy')
  release?.()
  check('identical in-flight requests share one fetch', n === 1 && (await p1) === 'v' && (await p2) === 'v', n)

  const c6 = boundedCache<string>({ max: 100, ttlMs: 1000, failTtlMs: 100, maxInFlight: 3, now: () => t })
  const releases: (() => void)[] = []
  let running = 0
  let most = 0
  const gated = () => {
    running++
    most = Math.max(most, running)
    return new Promise<{ value: string; ok: boolean }>((r) => releases.push(() => (running--, r({ value: 'v', ok: true }))))
  }
  const results = Array.from({ length: 10 }, (_, i) => c6.get(`u${i}`, gated, 'busy'))
  check('running upstream requests stay at the limit', most === 3 && c6.inFlight() === 3, [most, c6.inFlight()])
  check('the rest are answered busy at once, not queued', (await Promise.all(results.slice(3))).every((v) => v === 'busy'))
  check('busy answers are not cached', c6.size() === 3, c6.size())
  releases.forEach((r) => r())
  await Promise.all(results)
  check('slots free up afterwards', c6.inFlight() === 0 && (await c6.get('fresh', async () => ({ value: 'w', ok: true }), 'busy')) === 'w')
}

// --- the two endpoints, with a fake fetch
const realFetch = globalThis.fetch
{
  let active = 0
  let peak = 0
  let calls = 0
  const waiting: (() => void)[] = []
  globalThis.fetch = (() => {
    calls++
    active++
    peak = Math.max(peak, active)
    return new Promise((resolve) =>
      waiting.push(() => {
        active--
        resolve(new Response('{}', { status: 200 }))
      }),
    )
  }) as typeof fetch

  const gh = Array.from({ length: 40 }, (_, i) => githubCommits(`vleeuwenmenno/boltwarden/commits/${i.toString(16).padStart(7, '0')}`))
  const dup = githubCommits('vleeuwenmenno/boltwarden/commits/0000000')
  check('github: upstream requests limited', peak <= 6 && calls === 6, [peak, calls])
  waiting.splice(0).forEach((r) => r())
  const answers = await Promise.all(gh)
  check('github: saturated requests get a quick 503', answers.filter((a) => a.status === 503).length === 34, answers.map((a) => a.status).join())
  check('github: duplicate shares the in-flight answer', (await dup).status === 200 && calls === 6)

  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url)
    return u.includes('q=fail') ? new Response('no', { status: 500 }) : new Response('["q",["a","b"]]', { status: 200 })
  }) as typeof fetch
  for (let i = 0; i < 1500; i++) await githubCommits(`vleeuwenmenno/boltwarden/commits/${(i + 4096).toString(16)}`).catch(() => {})
  for (let i = 0; i < 2500; i++) await suggest('ddg', i % 3 ? `query ${i}` : `fail ${i}`)
  check('suggest: cache stays within its cap', suggestCacheStats().size <= 1000, suggestCacheStats())
  check('suggest: nothing left running', suggestCacheStats().inFlight === 0)
  check('github: cache stays within its cap', githubCacheStats().size <= 500, githubCacheStats())
}
globalThis.fetch = realFetch
process.exit(failed ? 1 : 0)
