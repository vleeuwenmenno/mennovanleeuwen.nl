import { mkdirSync } from 'node:fs'
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { fetchPinned } from './egress.ts'
import { HttpError, SECURITY, UNTRUSTED } from './http.ts'
import { fetchHead, iconLinks, websiteAddresses } from './preview.ts'
import { getDomain } from 'tldts'

// Senders' brand icons for Mail's avatars (src/apps/mail/parts.tsx): the logo a domain publishes
// for mail (BIMI, a DNS record pointing at an SVG), else the best of its web site's own icons
// (apple-touch-icon, <link rel=icon>, /favicon.ico), the largest square one. Only the
// organisation's domain is ever looked up (anwb.nl for service@verzekeren.anwb.nl), never anyone's
// address and never the full host: a sender who gave each recipient a host of their own
// (notice@recipient-9384.example.net) can't learn from the lookup who opened the mail, or when.
// Only the server looks: senders never see the reader's browser.
//
// The server fetches other sites here, so: signed-in users only (server/jmap.ts), each held to
// 60 new lookups a minute; public addresses only, also after redirects (server/egress.ts), the
// usual web ports; at most 256 KB per picture, 5 seconds per request and 15 per lookup (after
// which everything it was still fetching is cancelled); four lookups at once and 50 waiting (more
// get a 503, and the avatar keeps its initials). What was found, and what wasn't, is kept in
// DATA_DIR/mail-icons (30 and 3 days; at most 2000 domains and 100 MB, the oldest going first),
// and the browser keeps it for a week.

const DIR = join(resolve(process.env.DATA_DIR ?? 'data'), 'mail-icons')
const FOUND_TTL = 30 * 864e5
const NONE_TTL = 3 * 864e5
/** A lookup that ran out of time: tried again sooner. */
const TIMEOUT_TTL = 3600_000
const MAX_BYTES = 256 * 1024
const MIN_SIZE = 16
/** Big enough to stop looking further. */
const GOOD_SIZE = 96
const AT_ONCE = 4
const MAX_WAITING = 50
const LOOKUP_MS = Number(process.env.MAIL_ICON_LOOKUP_MS) || 15_000
const REQUEST_MS = 5000
/** How long a lookup may wait for its turn. */
const WAIT_MS = 20_000
const MAX_ENTRIES = 2000
const MAX_TOTAL = 100 * 1024 * 1024
const MISSES_PER_MINUTE = 60

type Found = { type: string; bytes: Buffer }
type Entry = { at: number; type: string | null; ttl?: number }

// ---------------------------------------------------------------------------------------------
// Domains

/**
 * The organisation's registrable domain (eTLD+1) by the Public Suffix List (tldts): anwb.nl for
 * verzekeren.anwb.nl, example.co.uk for a.b.example.co.uk, info.nl for victim-1.info.nl; null for
 * a bare public suffix (co.uk). Only ICANN suffixes count, not the list's private ones (github.io,
 * blogspot.com): x.github.io is github.io, so a sender can't mint a lookup per recipient there either.
 */
export function orgDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: false, validHosts: [] }) || null
}


/** A domain as asked for, or null when it isn't one (an address, a port, an IP, nonsense). */
export function cleanDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/\.$/, '')
  if (d.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || isIP(d) || /^\d+(\.\d+)*$/.test(d)) return null
  if (d.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null
  if (/\.(local|localhost|internal|lan|home|arpa|test|invalid|example)$/.test(d) || d === 'localhost') return null
  return d
}

// ---------------------------------------------------------------------------------------------
// Pictures: what they are and how big, from their bytes (never their Content-Type)

/**
 * Whether text starts as an SVG document: a BOM and white space, an optional <?xml …?>, then any
 * comments and one optional <!DOCTYPE …>, then `<svg` and a space or `>`. Answers the position
 * of `<svg`, or -1. One pass, no backtracking: what a server sends can't stall it.
 */
export function svgStart(text: string): number {
  let i = 0
  const n = text.length
  const space = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r' || text[i] === '﻿')) i++
  }
  const at = (s: string) => text.slice(i, i + s.length).toLowerCase() === s
  space()
  if (at('<?xml')) {
    const end = text.indexOf('?>', i)
    if (end < 0) return -1
    i = end + 2
  }
  let doctype = false
  for (;;) {
    space()
    if (at('<!--')) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) return -1
      i = end + 3
    } else if (!doctype && at('<!doctype')) {
      const end = text.indexOf('>', i)
      if (end < 0) return -1
      i = end + 1
      doctype = true
    } else break
  }
  if (!at('<svg')) return -1
  const next = text[i + 4]
  return next === '>' || next === ' ' || next === '\t' || next === '\n' || next === '\r' || next === '/' ? i : -1
}

/** The picture's type and its smaller side in pixels (SVG counts as big), or null when it isn't one. */
export function inspect(b: Buffer): { type: string; size: number; square: boolean } | null {
  const sq = (w: number, h: number) => ({ size: Math.min(w, h), square: Math.max(w, h) <= Math.min(w, h) * 1.25 })
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { type: 'image/png', ...sq(b.readUInt32BE(16), b.readUInt32BE(20)) }
  if (b.length > 6 && b.readUInt32LE(0) === 0x00010000) {
    const n = b.readUInt16LE(4)
    let best = 0
    for (let i = 0; i < n && 6 + 16 * i + 16 <= b.length; i++) best = Math.max(best, b[6 + 16 * i] || 256)
    return best ? { type: 'image/x-icon', size: best, square: true } : null
  }
  if (b.length > 10 && b.toString('latin1', 0, 4) === 'GIF8') return { type: 'image/gif', ...sq(b.readUInt16LE(6), b.readUInt16LE(8)) }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { type: 'image/webp', ...sq(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)) }
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { type: 'image/webp', ...sq(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)) }
    }
    if (kind === 'VP8 ') return { type: 'image/webp', ...sq(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff) }
    return null
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: 'image/jpeg', ...sq(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)) }
      i += 2 + b.readUInt16BE(i + 2)
    }
    return null
  }
  const text = b.toString('utf8', 0, Math.min(b.length, 4096))
  const start = svgStart(text)
  if (start < 0) return null
  const close = text.indexOf('>', start)
  const tag = close < 0 ? '' : text.slice(start, close + 1)
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag)
  return { type: 'image/svg+xml', size: 512, square: vb ? Math.max(+vb[1], +vb[2]) <= Math.min(+vb[1], +vb[2]) * 1.25 : true }
}

// ---------------------------------------------------------------------------------------------
// Fetching, all of it cancelled by the lookup's `signal`

type Sized = Found & { size: number; square: boolean }

/** One picture from a public address (following up to four redirects, each checked), or null. */
async function fetchPicture(start: URL, signal: AbortSignal): Promise<Sized | null> {
  let url = start
  for (let hop = 0; hop < 4; hop++) {
    if (signal.aborted || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null
    const addresses = await websiteAddresses(url, signal).catch(() => null)
    if (!addresses || signal.aborted) return null
    const res = await fetchPinned(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mvlos mail icons)', Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8' }, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) }, addresses).catch(() => null)
    if (!res) return null
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {})
      url = new URL(location, url)
      continue
    }
    if (!res.ok || Number(res.headers.get('content-length')) > MAX_BYTES) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body?.getReader()
    try {
      while (reader) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES || signal.aborted) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    } catch {
      await reader?.cancel().catch(() => {})
      return null
    }
    const bytes = Buffer.concat(chunks)
    const info = inspect(bytes)
    return info && info.size >= MIN_SIZE ? { bytes, ...info } : null
  }
  return null
}

/** A TXT record's strings, from DNS with its own deadline (2 s, one retry), cancelled for real when `signal` aborts. */
async function txtRecords(name: string, signal: AbortSignal): Promise<string[][]> {
  if (signal.aborted) return []
  const resolver = new Resolver({ timeout: 2000, tries: 2 })
  const stop = () => resolver.cancel()
  signal.addEventListener('abort', stop, { once: true })
  try {
    return await resolver.resolveTxt(name)
  } catch {
    return []
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** The BIMI logo a domain publishes for its mail (default._bimi TXT, "l=" an https SVG), if any. */
async function bimi(host: string, signal: AbortSignal): Promise<Found | null> {
  const records = await txtRecords(`default._bimi.${host}`, signal)
  for (const parts of records.slice(0, 10)) {
    const txt = parts.join('').slice(0, 2048)
    if (!/^\s*v\s*=\s*BIMI1\b/i.test(txt)) continue
    const l = /(?:^|;)\s*l\s*=\s*([^;\s]+)/i.exec(txt)?.[1]
    if (!l) continue
    try {
      const url = new URL(l)
      if (url.protocol !== 'https:') continue
      const got = await fetchPicture(url, signal)
      if (got?.type === 'image/svg+xml') return { type: got.type, bytes: got.bytes }
    } catch {
      /* not an address */
    }
  }
  return null
}

/** How good an icon is: its size, a third of it when it isn't square (a wordmark). */
const rank = (x: { size: number; square: boolean }) => (x.square ? x.size : x.size / 3)
const good = (x: Sized | null) => !!x && x.square && x.size >= GOOD_SIZE

/** The best of a site's own icons: the largest square one, looked for in its page's <head> and at the usual places. */
async function siteIcon(host: string, signal: AbortSignal): Promise<Sized | null> {
  const start = new URL(`https://${host}/`)
  const page = await fetchHead(start, signal).catch(() => null)
  if (signal.aborted) return null
  const base = page?.url ?? start
  const listed = page ? iconLinks(page.html, base) : []
  const tried = new Set<string>()
  const queue = [...listed, { href: new URL('/apple-touch-icon.png', base).href, size: 180 }, { href: new URL('/favicon.ico', base).href, size: 32 }].filter((c) => !tried.has(c.href) && tried.add(c.href))
  // Biggest promised first; a few tries at most.
  queue.sort((a, b) => b.size - a.size)
  let best: Sized | null = null
  for (const c of queue.slice(0, 5)) {
    if (signal.aborted) break
    let url: URL
    try {
      url = new URL(c.href)
    } catch {
      continue
    }
    const got = await fetchPicture(url, signal)
    if (got && (!best || rank(got) > rank(best))) best = got
    if (good(best)) break
  }
  return best
}

/** An organisation domain's icon: BIMI first (it is the logo meant for mail), then the site's own. */
async function find(domain: string, signal: AbortSignal): Promise<Found | null> {
  const mark = await bimi(domain, signal)
  if (mark) return mark
  const icon = await siteIcon(domain, signal).catch(() => null)
  return icon ? { type: icon.type, bytes: icon.bytes } : null
}

// ---------------------------------------------------------------------------------------------
// Turns: four lookups at once, fifty waiting, each waiting at most WAIT_MS

let running = 0
const waiting: { go: () => void; timer: ReturnType<typeof setTimeout> }[] = []

/** Runs `work` in a turn of its own; the turn is held until `work` has really finished. */
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) {
    if (waiting.length >= MAX_WAITING) throw new HttpError(503, 'Too many icon lookups at once')
    await new Promise<void>((go, no) => {
      const item = {
        go,
        timer: setTimeout(() => {
          const i = waiting.indexOf(item)
          if (i >= 0) waiting.splice(i, 1)
          no(new HttpError(503, 'Too many icon lookups at once'))
        }, WAIT_MS),
      }
      waiting.push(item)
    })
  }
  running++
  try {
    return await work()
  } finally {
    running--
    const next = waiting.shift()
    if (next) {
      clearTimeout(next.timer)
      next.go()
    }
  }
}

/** For checks: how many lookups are running and waiting. */
export const lookupLoad = () => ({ running, waiting: waiting.length })

// ---------------------------------------------------------------------------------------------
// A user's new lookups: at most 60 a minute (what is cached costs nothing)

const misses = new Map<number, number[]>()

function allowMiss(user: number) {
  const now = Date.now()
  const recent = (misses.get(user) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= MISSES_PER_MINUTE) {
    misses.set(user, recent)
    throw new HttpError(429, 'Too many new icons; try again in a minute')
  }
  recent.push(now)
  misses.set(user, recent)
  if (misses.size > 1000) for (const [k, v] of misses) if (!v.some((t) => now - t < 60_000)) misses.delete(k)
}

// ---------------------------------------------------------------------------------------------
// The cache: DATA_DIR/mail-icons/<domain>.json (when, and what type) and <domain>.img

let dirMade = false
const busy = new Map<string, Promise<Found | null>>()

const expired = (e: Entry, now = Date.now()) => now - e.at > (e.ttl ?? (e.type ? FOUND_TTL : NONE_TTL))

async function cached(domain: string): Promise<Found | null | undefined> {
  try {
    const entry = JSON.parse(await readFile(join(DIR, `${domain}.json`), 'utf8')) as Entry
    if (expired(entry)) return undefined
    if (!entry.type) return null
    return { type: entry.type, bytes: await readFile(join(DIR, `${domain}.img`)) }
  } catch {
    return undefined
  }
}

/**
 * One thing at a time touches the cache's files: a write (picture, then its entry by rename) and
 * a tidy-up never overlap, so the tidy-up can't take a fresh picture for an orphan or remove an
 * entry's temporary file before it is renamed.
 */
let cacheLock: Promise<unknown> = Promise.resolve()
function locked<T>(work: () => Promise<T>): Promise<T> {
  const run = cacheLock.then(work, work)
  cacheLock = run.catch(() => {})
  return run
}

export function store(domain: string, found: Found | null, ttl?: number) {
  return locked(() => storeNow(domain, found, ttl)).then(() => {
    // Every 50 new entries (and at startup, and hourly), the cache is tidied.
    if (writes >= 50) void sweep()
  })
}

async function storeNow(domain: string, found: Found | null, ttl?: number) {
  try {
    if (!dirMade) mkdirSync(DIR, { recursive: true })
    dirMade = true
    if (found) await writeFile(join(DIR, `${domain}.img`), found.bytes)
    else await unlink(join(DIR, `${domain}.img`)).catch(() => {})
    const tmp = join(DIR, `${domain}.json.${process.pid}.tmp`)
    await writeFile(tmp, JSON.stringify({ at: Date.now(), type: found?.type ?? null, ...(ttl ? { ttl } : {}) } satisfies Entry))
    await rename(tmp, join(DIR, `${domain}.json`))
    writes++
  } catch (e) {
    console.error('mail icons: could not cache', (e as Error).message)
  }
}

let writes = 0
let sweeping: Promise<void> | null = null

/**
 * Tidies the cache: expired entries and files without their other half (and left-over temporary
 * files) go; then, while there are more than MAX_ENTRIES domains or MAX_TOTAL bytes, the oldest.
 */
export function sweep(): Promise<void> {
  if (sweeping) return sweeping
  writes = 0
  sweeping = locked(async () => {
    let names: string[]
    try {
      names = await readdir(DIR)
    } catch {
      return
    }
    const now = Date.now()
    const drop = (name: string) => unlink(join(DIR, name)).catch(() => {})
    const jsons = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)))
    const imgs = new Set(names.filter((n) => n.endsWith('.img')).map((n) => n.slice(0, -4)))
    for (const n of names) if (!n.endsWith('.json') && !n.endsWith('.img')) await drop(n)
    const live: { domain: string; at: number; bytes: number }[] = []
    for (const domain of jsons) {
      let entry: Entry | null = null
      try {
        entry = JSON.parse(await readFile(join(DIR, `${domain}.json`), 'utf8')) as Entry
      } catch {
        /* unreadable: dropped */
      }
      if (!entry || typeof entry.at !== 'number' || expired(entry, now) || (entry.type && !imgs.has(domain))) {
        await drop(`${domain}.json`)
        continue
      }
      if (!entry.type && imgs.has(domain)) await drop(`${domain}.img`)
      const bytes = entry.type ? await stat(join(DIR, `${domain}.img`)).then((s) => s.size, () => 0) : 0
      live.push({ domain, at: entry.at, bytes })
    }
    const kept = new Set(live.map((l) => l.domain))
    for (const domain of imgs) if (!kept.has(domain)) await drop(`${domain}.img`)
    live.sort((a, b) => a.at - b.at)
    let total = live.reduce((n, l) => n + l.bytes, 0)
    let count = live.length
    for (const l of live) {
      if (count <= MAX_ENTRIES && total <= MAX_TOTAL) break
      await drop(`${l.domain}.json`)
      await drop(`${l.domain}.img`)
      count--
      total -= l.bytes
    }
  }).finally(() => (sweeping = null))
  return sweeping
}

let swept = false
function sweepNowAndHourly() {
  if (swept) return
  swept = true
  void sweep()
  setInterval(() => void sweep(), 3600_000).unref()
}

/**
 * A sender domain's icon, from the cache or looked up now: by its organisation's domain only,
 * once at a time per domain, a few domains at once, and (for a `user`) within their minute's
 * allowance of new lookups.
 */
export async function senderIcon(raw: string, user?: number): Promise<Found | null> {
  const asked = cleanDomain(raw)
  const domain = asked && orgDomain(asked)
  if (!domain) throw new HttpError(400, 'Not a domain')
  sweepNowAndHourly()
  const hit = await cached(domain)
  if (hit !== undefined) return hit
  let job = busy.get(domain)
  if (!job) {
    if (user !== undefined) allowMiss(user)
    job = slot(async () => {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), LOOKUP_MS)
      try {
        const found = await find(domain, deadline.signal).catch(() => null)
        await store(domain, found, deadline.signal.aborted && !found ? TIMEOUT_TTL : undefined)
        return found
      } finally {
        clearTimeout(timer)
      }
    }).finally(() => busy.delete(domain))
    busy.set(domain, job)
  }
  return job
}

/** GET /api/mail/icon/<domain>: the picture, or 404 when the domain has none (both kept by the browser). */
export async function serveSenderIcon(res: ServerResponse, raw: string, head: boolean, user: number) {
  const found = await senderIcon(raw, user)
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, max-age=86400', ...SECURITY, ...UNTRUSTED }).end(head ? undefined : 'No icon')
    return
  }
  // Another site's bytes from this one: never a page here (an SVG opened directly runs nothing).
  res
    .writeHead(200, {
      'Content-Type': found.type,
      'Content-Length': String(found.bytes.length),
      'Cache-Control': 'private, max-age=604800',
      'Content-Disposition': 'inline; filename="icon"',
      ...SECURITY,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    })
    .end(head ? undefined : found.bytes)
}
