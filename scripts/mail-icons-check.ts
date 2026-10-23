// Checks Mail's sender icons (server/mailicons.ts): the SVG sniffing (linear, also for hostile
// input), which domain is looked up (only the organisation's, never a sender's own host), the
// per-user allowance of new lookups, the cap on waiting lookups, that a lookup's time limit
// really stops it (its turn is held until then), and the cache's tidying (expired, orphaned, too
// many). With a scratch DATA_DIR.
//
//   node scripts/mail-icons-check.ts           # add --network for the live lookups at the end
//
// Exits 1 on any failure.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const data = mkdtempSync(join(tmpdir(), 'mail-icons-check-'))
process.env.DATA_DIR = data
process.env.MAIL_ICON_LOOKUP_MS = '1500'
const { inspect, svgStart, orgDomain, cleanDomain, senderIcon, sweep, lookupLoad } = await import('../server/mailicons.ts')

let failed = false
const check = (what: string, test: boolean, detail?: unknown) => {
  if (test) console.log('PASS', what)
  else {
    failed = true
    console.log('FAIL', what, detail ?? '')
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- SVG sniffing -------------------------------------------------------------------------------
for (const [text, ok] of [
  ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>', true],
  ['﻿  <?xml version="1.0"?>\n<!-- a -->\n<!DOCTYPE svg PUBLIC "x" "y">\n<!-- b --><svg>', true],
  ['<svg/>', true],
  ['<svgfoo>', false],
  ['<html><svg></svg></html>', false],
  ['<!-- never closed <svg>', false],
  ['<?xml version="1.0"', false],
] as const)
  check(`svgStart ${JSON.stringify(text.slice(0, 40))}`, svgStart(text) >= 0 === ok)
check('inspect: an SVG is a big square picture', inspect(Buffer.from('<svg viewBox="0 0 10 10">')) ?.type === 'image/svg+xml')
check('inspect: a wide SVG is not square', inspect(Buffer.from('<svg viewBox="0 0 300 50">'))?.square === false)
for (const payload of ['<!--x-->'.repeat(24) + 'NOT_SVG', '<!--x-->'.repeat(500) + 'NOT_SVG', '<!--' + '-'.repeat(4000), '<?xml' + ' '.repeat(4000)]) {
  const t0 = performance.now()
  const r = inspect(Buffer.from(payload))
  const ms = performance.now() - t0
  check(`inspect: hostile ${payload.length}-byte text is refused in < 50 ms (${ms.toFixed(2)} ms)`, r === null && ms < 50)
}

// --- Which domain is looked up --------------------------------------------------------------------
for (const [host, org] of [
  ['verzekeren.anwb.nl', 'anwb.nl'],
  ['anwb.nl', 'anwb.nl'],
  ['notifications.github.com', 'github.com'],
  ['recipient-9384.attacker.net', 'attacker.net'],
  ['a.b.c.example.co.uk', 'example.co.uk'],
  ['mail.example.com.au', 'example.com.au'],
  ['news.example.co.jp', 'example.co.jp'],
  ['em.ah.nl', 'ah.nl'],
  ['co.uk', null],
] as const)
  check(`orgDomain ${host}: ${org}`, orgDomain(host) === org, orgDomain(host))
for (const bad of ['127.0.0.1', 'localhost', 'router.lan', 'a@b.com', 'x.local', 'has space.com', '-a.com', 'example'])
  check(`cleanDomain refuses ${bad}`, cleanDomain(bad) === null)

// A sender's own host is never looked up: a cached answer for the organisation serves every host under it.
mkdirSync(join(data, 'mail-icons'), { recursive: true })
writeFileSync(join(data, 'mail-icons', 'tracker-org.com.json'), JSON.stringify({ at: Date.now(), type: 'image/png' }))
writeFileSync(join(data, 'mail-icons', 'tracker-org.com.img'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const viaSub = await senderIcon('recipient-9384.tracker-org.com', 1)
check('a per-recipient host is answered from the organisation’s entry (no lookup)', viaSub?.type === 'image/png' && !readdirSync(join(data, 'mail-icons')).some((n) => n.startsWith('recipient-9384')))

// --- Allowance and queue --------------------------------------------------------------------------
// Domains that don't exist end quickly (no DNS answer); each is a new lookup.
const fake = (i: number, tag: string) => `${tag}-${i}-${Date.now()}.invalid-tld-zzq`
{
  let refused = 0
  const runs: Promise<unknown>[] = []
  for (let i = 0; i < 61; i++) runs.push(senderIcon(fake(i, 'rate'), 42).catch((e: { status?: number }) => e.status === 429 && refused++))
  await Promise.all(runs)
  check('a user gets 60 new lookups a minute, then 429', refused === 1, refused)
  const other = await senderIcon(fake(0, 'other'), 43).then(
    () => 'ok',
    (e: { status?: number }) => e.status,
  )
  check('another user still has their own allowance', other === 'ok', other)
}
{
  let busy = 0
  const runs: Promise<unknown>[] = []
  for (let i = 0; i < 70; i++) runs.push(senderIcon(fake(i, 'queue')).catch((e: { status?: number }) => e.status === 503 && busy++))
  await sleep(50)
  const load = lookupLoad()
  check(`at most 4 running and 50 waiting (${load.running}, ${load.waiting})`, load.running <= 4 && load.waiting <= 50)
  await Promise.all(runs)
  check(`past 50 waiting: 503 (${busy})`, busy >= 1)
  check('all turns given back', lookupLoad().running === 0 && lookupLoad().waiting === 0, lookupLoad())
}

// --- Cache tidying --------------------------------------------------------------------------------
{
  const dir = join(data, 'mail-icons')
  const old = Date.now() - 40 * 864e5
  writeFileSync(join(dir, 'expired-found.com.json'), JSON.stringify({ at: old, type: 'image/png' }))
  writeFileSync(join(dir, 'expired-found.com.img'), 'x')
  writeFileSync(join(dir, 'expired-none.com.json'), JSON.stringify({ at: Date.now() - 4 * 864e5, type: null }))
  writeFileSync(join(dir, 'orphan.com.img'), 'x')
  writeFileSync(join(dir, 'lost-picture.com.json'), JSON.stringify({ at: Date.now(), type: 'image/png' }))
  writeFileSync(join(dir, 'broken.com.json'), '{')
  writeFileSync(join(dir, 'left.com.json.123.tmp'), '{}')
  writeFileSync(join(dir, 'fresh.com.json'), JSON.stringify({ at: Date.now(), type: 'image/png' }))
  writeFileSync(join(dir, 'fresh.com.img'), 'x')
  // Past the entry cap: 2000 + the rest; the oldest go.
  for (let i = 0; i < 2010; i++) writeFileSync(join(dir, `bulk-${i}.com.json`), JSON.stringify({ at: Date.now() - 864e5 + i, type: null }))
  await sweep()
  const left = new Set(readdirSync(dir))
  check('expired entries go, with their picture', !left.has('expired-found.com.json') && !left.has('expired-found.com.img') && !left.has('expired-none.com.json'))
  check('a picture without its entry goes', !left.has('orphan.com.img'))
  check('an entry whose picture is missing goes', !left.has('lost-picture.com.json'))
  check('unreadable entries and temporary files go', !left.has('broken.com.json') && !left.has('left.com.json.123.tmp'))
  check('a fresh entry stays', left.has('fresh.com.json') && left.has('fresh.com.img'))
  const entries = [...left].filter((n) => n.endsWith('.json')).length
  check(`at most 2000 entries (${entries}), the oldest gone first`, entries <= 2000 && !left.has('bulk-0.com.json') && left.has('bulk-2009.com.json'))
}

// --- Live lookups (network) -----------------------------------------------------------------------
if (process.argv.includes('--network')) {
  // A public address that never answers: the 1.5 s limit (MAIL_ICON_LOOKUP_MS) stops it, and the
  // turn is held until it has.
  const t0 = Date.now()
  const slow = senderIcon(`203-0-114-${Date.now() % 250}.sslip.io`)
  await sleep(300)
  check('a slow lookup holds its turn while it runs', lookupLoad().running === 1, lookupLoad())
  await slow.catch(() => null)
  const took = Date.now() - t0
  check(`a slow lookup ends by its time limit (${took} ms)`, took < 2500 && lookupLoad().running === 0)
  process.env.MAIL_ICON_LOOKUP_MS = '15000'
  const anwb = await senderIcon('verzekeren.anwb.nl')
  check('verzekeren.anwb.nl gives the ANWB logo, from anwb.nl', !!anwb && inspect(anwb.bytes)!.size >= 96 && readdirSync(join(data, 'mail-icons')).includes('anwb.nl.json'))
}

rmSync(data, { recursive: true, force: true })
console.log(failed ? 'some checks failed' : 'all passed')
process.exit(failed ? 1 : 0)
