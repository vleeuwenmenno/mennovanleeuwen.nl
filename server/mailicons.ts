import { mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolveTxt } from 'node:dns/promises'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { fetchPinned } from './egress.ts'
import { HttpError, SECURITY, UNTRUSTED } from './http.ts'
import { fetchHead, iconLinks, websiteAddresses } from './preview.ts'

// Senders' brand icons for Mail's avatars (src/apps/mail/parts.tsx): the logo a domain publishes
// for mail (BIMI, a DNS record pointing at an SVG), else the best of its web site's own icons
// (apple-touch-icon, <link rel=icon>, /favicon.ico), the largest square one. Only the domain is
// ever looked up, never anyone's address, and only by the server: the browser asks this site, so
// senders don't learn who looked at their logo or when.
//
// The server fetches other sites here, so: signed-in users only (server/jmap.ts), public
// addresses only, also after redirects (server/egress.ts), the usual web ports, at most 256 KB per
// picture and a few seconds per request, a handful of lookups at once. What was found (and what
// wasn't) is kept in DATA_DIR/mail-icons for weeks, and the browser keeps it for a week.

const DIR = join(resolve(process.env.DATA_DIR ?? 'data'), 'mail-icons')
const FOUND_TTL = 30 * 864e5
const NONE_TTL = 3 * 864e5
const MAX_BYTES = 256 * 1024
const MIN_SIZE = 16
/** Big enough to stop looking further. */
const GOOD_SIZE = 96
const AT_ONCE = 4

type Found = { type: string; bytes: Buffer }
type Entry = { at: number; type: string | null }

/** Country domains sold one level down (example.co.uk): the organisation is a level further in. */
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'gov.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'co.za', 'com.tr', 'com.cn', 'co.in', 'co.kr', 'com.sg', 'com.hk', 'com.tw', 'co.il', 'com.ar', 'co.id', 'com.my', 'com.ph'])
/** Host names that send mail rather than serve a site: skipped on the way to the organisation's domain. */
const MAILER = /^(e?mails?\d*|em\d*|e|m|t|news(letters?)?|nieuwsbrief|notifications?|notify|noreply|no-reply|bounces?|mailer|mg|mkt|marketing|updates?|send|smtp|out|mta\d*|click|links?|reply|alerts?|messages?|info|mailings?|post|outbound|delivery|transactional|comms?)$/i

/** The organisation's domain: example.com for mail.example.com, example.co.uk for a.example.co.uk. */
export function orgDomain(host: string): string {
  const parts = host.split('.')
  return parts.slice(SECOND_LEVEL.has(parts.slice(-2).join('.')) ? -3 : -2).join('.')
}

/**
 * Where to look, most specific first, at most two: the sender's own host when it looks like a
 * site (verzekeren.anwb.nl), then the organisation's domain (anwb.nl). Mail-sending hosts
 * (mail.…, notifications.…, em123.…) go straight to the organisation.
 */
export function candidates(domain: string): string[] {
  const org = orgDomain(domain)
  let parts = domain.split('.')
  const depth = org.split('.').length
  while (parts.length > depth && MAILER.test(parts[0])) parts = parts.slice(1)
  const own = parts.join('.')
  return own === org ? [org] : [own, org]
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
  const text = b.toString('utf8', 0, Math.min(b.length, 4096)).replace(/^﻿/, '').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
    const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag)
    return { type: 'image/svg+xml', size: 512, square: vb ? Math.max(+vb[1], +vb[2]) <= Math.min(+vb[1], +vb[2]) * 1.25 : true }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Fetching

/** One picture from a public address (following up to four redirects, each checked), or null. */
async function fetchPicture(start: URL): Promise<Found & { size: number; square: boolean } | null> {
  let url = start
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const addresses = await websiteAddresses(url).catch(() => null)
    if (!addresses) return null
    const res = await fetchPinned(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mvlos mail icons)', Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8' }, signal: AbortSignal.timeout(5000) }, addresses).catch(() => null)
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
        if (size > MAX_BYTES) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    } catch {
      return null
    }
    const bytes = Buffer.concat(chunks)
    const info = inspect(bytes)
    return info && info.size >= MIN_SIZE ? { bytes, ...info } : null
  }
  return null
}

/** The BIMI logo a domain publishes for its mail (default._bimi TXT, "l=" an https SVG), if any. */
async function bimi(host: string): Promise<Found | null> {
  const records = await Promise.race([resolveTxt(`default._bimi.${host}`), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 3000))]).catch(() => [] as string[][])
  for (const parts of records) {
    const txt = parts.join('')
    if (!/^\s*v\s*=\s*BIMI1\b/i.test(txt)) continue
    const l = /(?:^|;)\s*l\s*=\s*([^;\s]+)/i.exec(txt)?.[1]
    if (!l) continue
    try {
      const url = new URL(l)
      if (url.protocol !== 'https:') continue
      const got = await fetchPicture(url)
      if (got?.type === 'image/svg+xml') return { type: got.type, bytes: got.bytes }
    } catch {
      /* not an address */
    }
  }
  return null
}

/** The best of a site's own icons: the largest square one, looked for in its page's <head> and at the usual places. */
type Sized = Found & { size: number; square: boolean }
/** How good an icon is: its size, a third of it when it isn't square (a wordmark). */
const rank = (x: { size: number; square: boolean }) => (x.square ? x.size : x.size / 3)
const good = (x: Sized | null) => !!x && x.square && x.size >= GOOD_SIZE

async function siteIcon(host: string): Promise<Sized | null> {
  const start = new URL(`https://${host}/`)
  const page = await fetchHead(start).catch(() => null)
  const base = page?.url ?? start
  const listed = page ? iconLinks(page.html, base) : []
  const tried = new Set<string>()
  const queue = [...listed, { href: new URL('/apple-touch-icon.png', base).href, size: 180 }, { href: new URL('/favicon.ico', base).href, size: 32 }].filter((c) => !tried.has(c.href) && tried.add(c.href))
  // Biggest promised first; a few tries at most.
  queue.sort((a, b) => b.size - a.size)
  let best: Sized | null = null
  for (const c of queue.slice(0, 5)) {
    let url: URL
    try {
      url = new URL(c.href)
    } catch {
      continue
    }
    const got = await fetchPicture(url)
    if (got && (!best || rank(got) > rank(best))) best = got
    if (good(best)) break
  }
  return best
}

/** A domain's icon: BIMI first (it is the logo meant for mail), then the site's own, for each candidate host. */
async function find(domain: string): Promise<Found | null> {
  const hosts = candidates(domain)
  const marks = await Promise.all(hosts.map((h) => bimi(h)))
  const mark = marks.find(Boolean)
  if (mark) return mark
  // The sender's own host first; a small favicon there still lets the organisation's site try.
  let best: Sized | null = null
  for (const h of hosts) {
    const icon = await siteIcon(h).catch(() => null)
    if (icon && (!best || rank(icon) > rank(best))) best = icon
    if (good(best)) break
  }
  return best ? { type: best.type, bytes: best.bytes } : null
}

// ---------------------------------------------------------------------------------------------
// The cache: DATA_DIR/mail-icons/<domain>.json (when, and what type) and <domain>.img

let dirMade = false
const busy = new Map<string, Promise<Found | null>>()
let running = 0
const waiting: (() => void)[] = []

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

async function cached(domain: string): Promise<Found | null | undefined> {
  try {
    const entry = JSON.parse(await readFile(join(DIR, `${domain}.json`), 'utf8')) as Entry
    if (Date.now() - entry.at > (entry.type ? FOUND_TTL : NONE_TTL)) return undefined
    if (!entry.type) return null
    return { type: entry.type, bytes: await readFile(join(DIR, `${domain}.img`)) }
  } catch {
    return undefined
  }
}

async function store(domain: string, found: Found | null) {
  try {
    if (!dirMade) mkdirSync(DIR, { recursive: true })
    dirMade = true
    if (found) await writeFile(join(DIR, `${domain}.img`), found.bytes)
    const tmp = join(DIR, `${domain}.json.${process.pid}`)
    await writeFile(tmp, JSON.stringify({ at: Date.now(), type: found?.type ?? null } satisfies Entry))
    await rename(tmp, join(DIR, `${domain}.json`))
  } catch (e) {
    console.error('mail icons: could not cache', (e as Error).message)
  }
}

/** A domain's icon, from the cache or looked up now (once at a time per domain, a few domains at once). */
export async function senderIcon(raw: string): Promise<Found | null> {
  const domain = cleanDomain(raw)
  if (!domain) throw new HttpError(400, 'Not a domain')
  const hit = await cached(domain)
  if (hit !== undefined) return hit
  let job = busy.get(domain)
  if (!job) {
    job = slot(() => Promise.race([find(domain), new Promise<null>((done) => setTimeout(() => done(null), 15_000))]))
      .catch(() => null)
      .then(async (found) => {
        await store(domain, found)
        return found
      })
      .finally(() => busy.delete(domain))
    busy.set(domain, job)
  }
  return job
}

/** GET /api/mail/icon/<domain>: the picture, or 404 when the domain has none (both kept by the browser). */
export async function serveSenderIcon(res: ServerResponse, raw: string, head: boolean) {
  const found = await senderIcon(raw)
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
