import { createHash, randomBytes } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { User } from './auth.ts'
import { database } from './db.ts'
import { fetchPinned, guardedFetch, isPrivate, resolveHost } from './egress.ts'
import { HttpError, SECURITY, UNTRUSTED } from './http.ts'
import { decodePng, encodePng, isPng } from './pngResize.ts'
import { headOf, tagsOf } from './preview.ts'
import { checkRoom } from './quota.ts'
import { loadSettings, webSearch } from './websearch.ts'

// The Agents app's find_image: real-world pictures (a product, a dish, a place) for the model to
// show in a visual list as image:<id>. Ollama's web search (the default) has no image search, so
// the server searches the web, reads the best few result pages and takes each page's own picture
// of the thing: its og:image, twitter:image, JSON-LD Product image, rel=image_src, else a big
// <img>. With SearXNG or Brave as the search provider, their image search goes first and the pages
// are the fallback. The chosen picture is downloaded by the server, checked, kept per account
// (agent_found_images) and served from GET /api/agents/images/<id>, so the browser never asks the
// other site (no tracking, no hotlinking, no mixed content).
//
// This fetches pages and pictures anyone can point a search result at, so every request:
// - goes to public addresses only, checked after DNS and again at every redirect (at most three),
//   connecting to exactly the checked addresses (no DNS rebinding), on web ports only, never to an
//   IP address written in the link, and with no credentials in it;
// - sends no cookies or credentials (a fresh request with a fixed User-Agent), whatever the user
//   is signed in to;
// - is capped in time (6 s a page, 8 s a picture, 30 s the whole call) and size (1.5 MB of a page,
//   5 MB a picture); a page is only read as text, with bounded scans (server/preview.ts helpers).
// Pictures must be PNG, JPEG, WebP or a still GIF by their bytes and by their Content-Type (never
// SVG or anything a browser could run), 120 to 8000 px a side and not a thin banner or sprite. A
// big PNG is scaled down to 768 px; other formats are kept as they came (there is no decoder for
// them here). They count toward the account's storage (server/quota.ts), and pictures not used for
// 90 days that no thread or note mentions any more are pruned.

const PAGE_BYTES = 1.5 * 1024 * 1024
const IMAGE_BYTES = 5 * 1024 * 1024
const PAGE_MS = 6000
const IMAGE_MS = 8000
const CALL_MS = 30_000
const MAX_HOPS = 3
const MIN_SIDE = 120
const MAX_SIDE = 8000
const SHRINK_TO = 768
/** PNGs up to this many pixels are decoded to be scaled down; bigger ones are kept as they are. */
const DECODE_PIXELS = 8_000_000
const PRUNE_AFTER = 90 * 86400_000
const UA = 'Mozilla/5.0 (compatible; mvlos find_image)'
const WEB_PORTS = new Set(['', '80', '443', '8080', '8443'])
export const ID = /^w[0-9a-f]{24}$/
const MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
type Mime = (typeof MIMES)[number]

/** Refused for where it points, not for a network failure. */
export class Blocked extends Error {}

// --- the network, replaceable in checks ---------------------------------------------------------
//
// scripts/find-image-fake-net.ts sets globalThis.__mvlFindImageNet when it is preloaded (only
// checks and local browser tests do that), so fake shops on 127.0.0.1 can stand in for the web
// while every address check here still runs on the names they pretend to be.

type Net = { resolve: (host: string, signal?: AbortSignal) => Promise<LookupAddress[]>; request: (url: URL, init: RequestInit, addresses: LookupAddress[]) => Promise<Response> }
const realNet: Net = { resolve: resolveHost, request: fetchPinned }
const net = (): Net => (globalThis as { __mvlFindImageNet?: Net }).__mvlFindImageNet ?? realNet

/** The addresses to connect to for `url`: public ones only, on web ports, no IP literals or credentials. */
export async function allowedAddresses(url: URL, signal?: AbortSignal): Promise<LookupAddress[]> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Blocked('Only web addresses')
  if (url.username || url.password) throw new Blocked('Addresses with credentials are refused')
  if (!WEB_PORTS.has(url.port)) throw new Blocked(`${url.host}: unusual port`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) throw new Blocked(`${url.host}: IP addresses are refused`)
  if (!host.includes('.') || /\.(localhost|local|internal|home\.arpa)$/i.test(host)) throw new Blocked(`${url.host} is not a public name`)
  const addresses = await net()
    .resolve(host, signal)
    .catch(() => [] as LookupAddress[])
  if (!addresses.length) throw new Error(`${url.host} does not exist`)
  if (addresses.some((a) => isPrivate(a.address))) throw new Blocked(`${url.host} is not a public address`)
  return addresses
}

/** A GET to a public address, redirects followed (each one checked again), no cookies sent. */
async function safeGet(start: URL, accept: string, signal: AbortSignal): Promise<{ url: URL; res: Response }> {
  let url = start
  for (let hop = 0; ; hop++) {
    const addresses = await allowedAddresses(url, signal)
    const res = await net().request(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en,ja;q=0.8,*;q=0.5' }, signal }, addresses)
    const location = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !location) return { url, res }
    await res.body?.cancel().catch(() => {})
    if (hop >= MAX_HOPS) throw new Error(`${url.host} redirected too often`)
    url = new URL(location, url)
  }
}

/** Up to `max` bytes of a body: past it, `truncate` keeps what came, else it is refused. */
async function readUpTo(res: Response, max: number, truncate: boolean): Promise<Buffer> {
  if (!truncate && Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => {})
    throw new Error('too big')
  }
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.length > max) {
        if (!truncate) throw new Error('too big')
        chunks.push(value.subarray(0, max - size))
        size = max
        break
      }
      chunks.push(value)
      size += value.length
    }
  } finally {
    await reader?.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

// --- reading a page -----------------------------------------------------------------------------

export type Candidate = { url: string; score: number; why: string; width?: number; height?: number; alt?: string }
export type PageImages = { url: string; title: string | null; product: boolean; candidates: Candidate[] }

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase())
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d{1,7});/g, (whole, n) => (Number(n) > 0 && Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : whole))
    .replace(/\s+/g, ' ')
    .trim()
/** One attribute of a tag (already at most 4 KB, from tagsOf). */
const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  const v = m?.[1] ?? m?.[2] ?? m?.[3]
  return v === undefined ? undefined : decode(v)
}
const intOf = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : undefined
}

/** Logos, sprites, icons, tracking pixels and the like, by the picture's address or its tag. */
const JUNK = /(?:^|[^a-z0-9])(?:logos?|sprites?|favicons?|icons?|placeholders?|blank|spacer|pixel|tracking|badges?|avatars?|loading|spinner|payments?|ratings?|stars?|social|share|buttons?|arrows?|1x1|transparent|brandmark|default|no[-_]?image|og[-_]default|header[-_]bg)(?=[^a-z0-9]|$)/i
const junkUrl = (u: string) => {
  try {
    const p = new URL(u)
    return JUNK.test(p.pathname.split('/').slice(-2).join('/')) || /\.svgz?$/i.test(p.pathname)
  } catch {
    return true
  }
}
const junkTag = (tag: string) => /\b(?:logo|icon|avatar|sprite|badge)\b/i.test(`${attr(tag, 'class') ?? ''} ${attr(tag, 'id') ?? ''} ${attr(tag, 'alt') ?? ''}`)

/** The biggest picture in a srcset ("a.jpg 300w, b.jpg 800w"), with its width. */
function fromSrcset(set: string | undefined): { url: string; w?: number } | null {
  if (!set || set.length > 4000) return null
  let best: { url: string; w?: number } | null = null
  for (const part of set.split(/,\s+/)) {
    const [url, size = ''] = part.trim().split(/\s+/)
    if (!url) continue
    const wide = /^(\d{1,5})w$/.exec(size)
    const dense = /^(\d(?:\.\d+)?)x$/.exec(size)
    // A density (2x) says nothing about pixels: guess 400 px a step.
    const w = wide ? Number(wide[1]) : dense ? Math.round(Number(dense[1]) * 400) : undefined
    if (!best || (w ?? 0) > (best.w ?? 0)) best = { url, w }
  }
  return best
}

/** The images in JSON-LD blocks: Product (and a few other things worth a picture) first. */
function jsonLdImages(html: string, lower: string): { url: string; product: boolean; width?: number; height?: number }[] {
  const out: { url: string; product: boolean; width?: number; height?: number }[] = []
  let blocks = 0
  for (let at = lower.indexOf('<script'); at >= 0 && blocks < 12; at = lower.indexOf('<script', at + 7)) {
    const open = lower.indexOf('>', at)
    if (open < 0 || open - at > 1000) break
    if (!lower.slice(at, open).includes('ld+json')) continue
    const close = lower.indexOf('</script', open)
    if (close < 0) break
    blocks++
    if (close - open > 400_000) continue
    let data: unknown
    try {
      data = JSON.parse(html.slice(open + 1, close).trim())
    } catch {
      continue
    }
    let seen = 0
    const walk = (v: unknown, depth: number) => {
      if (depth > 6 || ++seen > 600 || out.length > 12 || !v || typeof v !== 'object') return
      if (Array.isArray(v)) return void v.slice(0, 50).forEach((x) => walk(x, depth + 1))
      const o = v as Record<string, unknown>
      const types = ([] as unknown[]).concat(o['@type'] ?? []).map((t) => String(t).toLowerCase())
      const product = types.some((t) => t === 'product' || t === 'productgroup' || t === 'individualproduct' || t === 'productmodel')
      const thing = product || types.some((t) => ['recipe', 'menuitem', 'place', 'touristattraction', 'restaurant', 'foodestablishment', 'landmarksorhistoricalbuildings', 'book', 'movie', 'videogame', 'softwareapplication', 'vehicle', 'car'].includes(t))
      if (thing) {
        const images = ([] as unknown[]).concat(o.image ?? []).slice(0, 3)
        for (const img of images) {
          if (typeof img === 'string') out.push({ url: img, product })
          else if (img && typeof img === 'object') {
            const io = img as Record<string, unknown>
            const url = typeof io.contentUrl === 'string' ? io.contentUrl : typeof io.url === 'string' ? io.url : null
            if (url) out.push({ url, product, width: intOf(io.width), height: intOf(io.height) })
          }
        }
      }
      for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant', 'offers']) if (o[k]) walk(o[k], depth + 1)
    }
    walk(data, 0)
  }
  return out
}

/**
 * The pictures a page offers for its subject, best first. Exported for the checks. `terms` are
 * the search's words, which a picture's address or alt text matching makes likelier.
 */
export function extractImages(html: string, base: URL, terms: string[] = []): PageImages {
  const head = headOf(html)
  const lower = asciiLower(html)
  const metas = new Map<string, string>()
  for (const tag of tagsOf(head, 'meta')) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop'))?.toLowerCase()
    const content = attr(tag, 'content')
    if (key && content && !metas.has(key)) metas.set(key, content)
  }
  const out = new Map<string, Candidate>()
  const relevant = (s: string) => terms.filter((t) => t.length > 2 && s.toLowerCase().includes(t)).length
  const add = (raw: string | undefined, score: number, why: string, extra: Partial<Candidate> = {}) => {
    if (!raw || raw.startsWith('data:') || raw.length > 2000) return
    let url: string
    try {
      const u = new URL(raw, base)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return
      u.hash = ''
      url = u.href
    } catch {
      return
    }
    if (junkUrl(url)) score -= 60
    let readable = url
    try {
      readable = decodeURIComponent(url)
    } catch {
      /* kept as it is */
    }
    score += Math.min(2, relevant(`${readable} ${extra.alt ?? ''}`)) * 8
    const had = out.get(url)
    if (!had || had.score < score) out.set(url, { url, score, why, ...extra })
  }
  const ld = jsonLdImages(html, lower)
  for (const l of ld) add(l.url, l.product ? 100 : 85, l.product ? 'json-ld product' : 'json-ld', { width: l.width, height: l.height })
  const ogType = metas.get('og:type')?.toLowerCase() ?? ''
  const product = ld.some((l) => l.product) || ogType.includes('product')
  const ogW = intOf(metas.get('og:image:width'))
  const ogH = intOf(metas.get('og:image:height'))
  add(metas.get('og:image:secure_url') ?? metas.get('og:image') ?? metas.get('og:image:url'), product ? 90 : 80, 'og:image', { width: ogW, height: ogH })
  add(metas.get('twitter:image') ?? metas.get('twitter:image:src'), 70, 'twitter:image')
  for (const tag of tagsOf(head, 'link')) if (/\bimage_src\b/i.test(attr(tag, 'rel') ?? '')) add(attr(tag, 'href'), 60, 'image_src')
  let n = 0
  for (const tag of tagsOf(html, 'img')) {
    if (++n > 400) break
    if (junkTag(tag)) continue
    const set = fromSrcset(attr(tag, 'srcset') ?? attr(tag, 'data-srcset'))
    const src = set?.url ?? attr(tag, 'data-src') ?? attr(tag, 'data-original') ?? attr(tag, 'data-lazy-src') ?? attr(tag, 'src')
    const w = intOf(attr(tag, 'width')) ?? set?.w
    const h = intOf(attr(tag, 'height'))
    // Small by its own word: an icon, a thumbnail strip, a tracking pixel.
    if ((w !== undefined && w < 150) || (h !== undefined && h < 150)) continue
    const big = Math.min(w ?? 300, h ?? w ?? 300)
    add(src, 30 + (big >= 400 ? 20 : big >= 250 ? 10 : 0), 'img', { width: w, height: h, alt: attr(tag, 'alt') })
  }
  const title = metas.get('og:title') ?? metas.get('twitter:title') ?? titleOf(head)
  return { url: base.href, title: title ? title.slice(0, 200) : null, product, candidates: [...out.values()].filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 8) }
}

function titleOf(head: string): string | null {
  const lower = asciiLower(head)
  const start = lower.indexOf('<title')
  const open = start < 0 ? -1 : lower.indexOf('>', start)
  const close = open < 0 ? -1 : lower.indexOf('</title>', open)
  return close < 0 ? null : decode(head.slice(open + 1, Math.min(close, open + 2001))) || null
}

/** Pages that look like they are about one thing for sale, by their address. */
const PRODUCTISH = /\/(products?|item|items|p|dp|shop|store|goods|catalog|detail)\b|[?&](product|item|sku)=/i

/** A page's pictures, from a short-lived cache when it was read in the last half hour. */
const pageCache = new Map<string, { at: number; value: Promise<PageImages | null> }>()
async function pageImages(raw: string, terms: string[], signal: AbortSignal): Promise<PageImages | null> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  url.hash = ''
  const key = url.href
  const hit = pageCache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value
  const value = (async () => {
    const { url: final, res } = await safeGet(url, 'text/html,application/xhtml+xml', AbortSignal.any([signal, AbortSignal.timeout(PAGE_MS)]))
    if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const html = (await readUpTo(res, PAGE_BYTES, true)).toString('utf8')
    return extractImages(html, final, terms)
  })()
  pageCache.set(key, { at: Date.now(), value })
  // A failure is not kept: the next call may find the site up again.
  value.then((v) => v ?? pageCache.delete(key), () => pageCache.delete(key))
  if (pageCache.size > 500) for (const [k, v] of pageCache) if (Date.now() - v.at > 30 * 60_000) pageCache.delete(k)
  return value
}

// --- checking a picture -------------------------------------------------------------------------

export type Inspected = { mime: Mime; width: number; height: number; animated: boolean }

/** What a picture is by its bytes: PNG, JPEG, WebP or GIF with its size, or null for anything else. */
export function inspectImage(b: Buffer): Inspected | null {
  if (isPng(b) && b.toString('ascii', 12, 16) === 'IHDR') {
    // An APNG has an acTL chunk before its first IDAT.
    let animated = false
    for (let at = 8; at + 8 <= b.length; ) {
      const len = b.readUInt32BE(at)
      const type = b.toString('ascii', at + 4, at + 8)
      if (type === 'acTL') animated = true
      if (type === 'IDAT' || type === 'IEND') break
      at += 12 + len
    }
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), animated }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    for (let at = 2; at + 9 < b.length; ) {
      if (b[at] !== 0xff) return null
      const marker = b[at + 1]
      if (marker === 0xff) {
        at++
        continue
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2
        continue
      }
      const len = b.readUInt16BE(at + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mime: 'image/jpeg', width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5), animated: false }
      if (len < 2) return null
      at += 2 + len
    }
    return null
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16)
    if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, animated: false }
    if (kind === 'VP8L' && b[20] === 0x2f) return { mime: 'image/webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)), animated: false }
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), animated: (b[20] & 0x02) !== 0 }
    return null
  }
  if (b.length > 13 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) {
    // Count the frames: more than one is an animation.
    let at = 13 + (b[10] & 0x80 ? 3 * 2 ** ((b[10] & 7) + 1) : 0)
    let frames = 0
    const skipBlocks = () => {
      while (at < b.length && b[at] !== 0) at += b[at] + 1
      at++
    }
    while (at < b.length && frames < 2) {
      const t = b[at]
      if (t === 0x3b) break
      if (t === 0x21) {
        at += 2
        skipBlocks()
      } else if (t === 0x2c) {
        frames++
        const flags = b[at + 9]
        at += 10 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1
        skipBlocks()
      } else break
    }
    return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), animated: frames > 1 }
  }
  return null
}

/** Why a picture is not kept, or null when it is fine. */
export function refuseImage(i: Inspected | null): string | null {
  if (!i) return 'not a PNG, JPEG, WebP or GIF picture'
  if (i.animated && i.mime !== 'image/png') return 'an animation'
  if (i.width < MIN_SIDE || i.height < MIN_SIDE) return `too small (${i.width}×${i.height})`
  if (i.width > MAX_SIDE || i.height > MAX_SIDE) return `too large (${i.width}×${i.height})`
  if (Math.max(i.width / i.height, i.height / i.width) > 4) return 'a banner or strip, not a picture of one thing'
  return null
}

/** A PNG scaled down to at most SHRINK_TO a side (also an APNG's first frame), or the bytes unchanged. */
function shrinkPng(bytes: Buffer, i: Inspected): { bytes: Buffer; width: number; height: number } {
  const same = { bytes, width: i.width, height: i.height }
  if ((Math.max(i.width, i.height) <= SHRINK_TO && !i.animated) || i.width * i.height > DECODE_PIXELS) return same
  try {
    const src = decodePng(bytes)
    const k = Math.min(1, SHRINK_TO / Math.max(src.width, src.height))
    const w = Math.max(1, Math.round(src.width * k))
    const h = Math.max(1, Math.round(src.height * k))
    const data = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor((y * src.height) / h)
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h))
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor((x * src.width) / w)
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w))
        let r = 0, g = 0, bl = 0, a = 0, n = 0
        for (let sy = y0; sy < y1; sy++)
          for (let sx = x0; sx < x1; sx++) {
            const s = (sy * src.width + sx) * 4
            const al = src.data[s + 3]
            r += src.data[s] * al
            g += src.data[s + 1] * al
            bl += src.data[s + 2] * al
            a += al
            n++
          }
        const d = (y * w + x) * 4
        if (a) data.set([Math.round(r / a), Math.round(g / a), Math.round(bl / a), Math.round(a / n)], d)
      }
    }
    const out = encodePng({ width: w, height: h, data })
    return out.length < bytes.length || i.animated || k < 1 ? { bytes: out, width: w, height: h } : same
  } catch {
    // A PNG this reader can't decode (16-bit, interlaced) is kept as it came.
    return same
  }
}

/** Downloads and checks one picture; throws with the reason it is not usable. */
export async function downloadImage(raw: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: Mime; width: number; height: number }> {
  const { res } = await safeGet(new URL(raw), 'image/webp,image/png,image/jpeg,image/gif;q=0.8', AbortSignal.any([signal, AbortSignal.timeout(IMAGE_MS)]))
  const type = (res.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim()
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`answered ${res.status}`)
  }
  // The type it says and the type its bytes are must both be a raster picture we serve.
  if (!/^image\/(png|jpe?g|pjpeg|webp|gif)$/.test(type)) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`not a picture we keep (${type || 'no type'})`)
  }
  let bytes: Buffer
  try {
    bytes = await readUpTo(res, IMAGE_BYTES, false)
  } catch {
    throw new Error('over 5 MB')
  }
  const info = inspectImage(bytes)
  const why = refuseImage(info)
  if (why) throw new Error(why)
  const shrunk = info!.mime === 'image/png' ? shrinkPng(bytes, info!) : { bytes, width: info!.width, height: info!.height }
  return { bytes: shrunk.bytes, mime: info!.mime, width: shrunk.width, height: shrunk.height }
}

// --- storing ------------------------------------------------------------------------------------

export type FoundImage = { id: string; reference: string; title: string; page: string | null; site: string | null; width: number; height: number; reused: boolean }
type Row = { id: string; source_url: string; page_url: string | null; title: string; width: number; height: number }

const hostOf = (u: string | null) => {
  if (!u) return null
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
const asFound = (r: Row, reused: boolean): FoundImage => ({ id: r.id, reference: `image:${r.id}`, title: r.title, page: r.page_url, site: hostOf(r.page_url ?? r.source_url), width: r.width, height: r.height, reused })

/** A picture already kept for this source address, marked as used again. */
function keptFor(user: User, source: string): FoundImage | null {
  const row = database().prepare('SELECT id, source_url, page_url, title, width, height FROM agent_found_images WHERE user_id = ? AND source_url = ? LIMIT 1').get(user.id, source) as Row | undefined
  if (!row) return null
  database().prepare('UPDATE agent_found_images SET used_at = ? WHERE user_id = ? AND id = ?').run(Date.now(), user.id, row.id)
  return asFound(row, true)
}

/** Downloads (or reuses) one candidate and keeps it for the account. */
async function keep(user: User, c: { url: string; page: string | null; title: string }, signal: AbortSignal): Promise<FoundImage> {
  const have = keptFor(user, c.url)
  if (have) return have
  const got = await downloadImage(c.url, signal)
  const hash = createHash('sha256').update(got.bytes).digest('hex')
  // The same picture from another address: the one already kept.
  const same = database().prepare('SELECT id, source_url, page_url, title, width, height FROM agent_found_images WHERE user_id = ? AND hash = ? LIMIT 1').get(user.id, hash) as Row | undefined
  if (same) return asFound(same, true)
  const title = c.title.slice(0, 200)
  checkRoom(user, got.bytes.length + c.url.length + (c.page?.length ?? 0) + title.length)
  const id = `w${randomBytes(12).toString('hex')}`
  const now = Date.now()
  database()
    .prepare('INSERT INTO agent_found_images (user_id, id, source_url, page_url, title, mime, width, height, hash, body, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, id, c.url, c.page, title, got.mime, got.width, got.height, hash, got.bytes, now, now)
  prune(user)
  return { id, reference: `image:${id}`, title, page: c.page, site: hostOf(c.page ?? c.url), width: got.width, height: got.height, reused: false }
}

const lastPrune = new Map<number, number>()
/**
 * Drops pictures unused for 90 days that no answer or message in a thread, and no synced state
 * (notes), of the account mentions any more (find_image's own results don't count: they are only
 * shown as thumbnails in the step). At most every six hours per account, after a new picture is kept.
 */
export function prune(user: User, force = false) {
  const now = Date.now()
  if (!force && now - (lastPrune.get(user.id) ?? 0) < 6 * 3600_000) return
  lastPrune.set(user.id, now)
  const db = database()
  const old = db.prepare('SELECT id FROM agent_found_images WHERE user_id = ? AND used_at < ? LIMIT 500').all(user.id, now - PRUNE_AFTER) as { id: string }[]
  if (!old.length) return
  const mentioned = new Set<string>()
  const scan = (text: string) => {
    for (const m of text.matchAll(/image:(w[0-9a-f]{24})/g)) mentioned.add(m[1])
  }
  for (const r of db.prepare("SELECT m.content AS t FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.role IN ('assistant', 'user') AND m.content LIKE '%image:w%'").iterate(user.id) as Iterable<{ t: string }>) scan(r.t)
  for (const r of db.prepare("SELECT value AS t FROM state WHERE user_id = ? AND value LIKE '%image:w%'").iterate(user.id) as Iterable<{ t: string }>) scan(r.t)
  const drop = db.prepare('DELETE FROM agent_found_images WHERE user_id = ? AND id = ?')
  const touch = db.prepare('UPDATE agent_found_images SET used_at = ? WHERE user_id = ? AND id = ?')
  for (const { id } of old) (mentioned.has(id) ? touch.run(now, user.id, id) : drop.run(user.id, id))
}

// --- searching ----------------------------------------------------------------------------------

type Pick = { url: string; page: string | null; title: string; score: number }

/** Image search of SearXNG (categories=images) or Brave, when one of them is the provider. */
async function providerImages(user: User, query: string, signal: AbortSignal): Promise<Pick[]> {
  const s = loadSettings(user)
  const limit = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (s.provider === 'searxng' && s.searxng.url) {
    const base = s.searxng.url.replace(/\/+$/, '').replace(/\/search$/, '')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (s.searxng.auth) headers.Authorization = s.searxng.auth
    // The instance lives where the user says: the same egress rules as the web search.
    const res = await guardedFetch(user, `${base}/search?${new URLSearchParams({ q: query, format: 'json', categories: 'images' })}`, { headers, signal: limit })
    if (!res.ok) throw new Error(`SearXNG answered ${res.status}`)
    const body = JSON.parse((await readUpTo(res, 4 * 1024 * 1024, false)).toString('utf8')) as { results?: Record<string, unknown>[] }
    return (body.results ?? []).slice(0, 12).map((r, i) => ({ url: str(r.img_src), page: str(r.url) || null, title: str(r.title), score: 150 - i * 5 })).filter((r) => r.url)
  }
  if (s.provider === 'brave' && s.brave.key) {
    const BRAVE_IMAGES = process.env.WEBSEARCH_BRAVE_IMAGES_URL || 'https://api.search.brave.com/res/v1/images/search'
    const res = await fetch(`${BRAVE_IMAGES}?${new URLSearchParams({ q: query.slice(0, 400), count: '12', safesearch: 'strict' })}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': s.brave.key }, signal: limit })
    if (!res.ok) throw new Error(`Brave Search answered ${res.status}`)
    const body = JSON.parse((await readUpTo(res, 4 * 1024 * 1024, false)).toString('utf8')) as { results?: { url?: unknown; title?: unknown; properties?: { url?: unknown } }[] }
    return (body.results ?? []).slice(0, 12).map((r, i) => ({ url: str(r.properties?.url), page: str(r.url) || null, title: str(r.title), score: 150 - i * 5 })).filter((r) => r.url)
  }
  return []
}

/** The best pictures of the top result pages (or of `pages` already known). */
async function fromPages(pages: { url: string; title: string; bonus: number }[], terms: string[], signal: AbortSignal, notes: string[]): Promise<Pick[]> {
  const read = await Promise.all(
    pages.map((p) =>
      pageImages(p.url, terms, signal).then(
        (v) => ({ p, v }),
        (e: Error) => {
          notes.push(`${hostOf(p.url) ?? p.url}: ${e instanceof Blocked ? `refused (${e.message})` : e.message}`)
          return { p, v: null }
        },
      ),
    ),
  )
  const picks: Pick[] = []
  for (const { p, v } of read) {
    if (!v) continue
    const pageScore = p.bonus + (v.product ? 20 : 0) + (PRODUCTISH.test(new URL(v.url).pathname + new URL(v.url).search) ? 10 : 0)
    // At most two from a page, so the answer offers different sites' pictures.
    v.candidates.slice(0, 2).forEach((c, i) => picks.push({ url: c.url, page: v.url, title: v.title ?? p.title, score: c.score + pageScore - i * 25 }))
  }
  return picks
}

const running = new Map<number, number>()

/**
 * find_image: up to `count` pictures of `query` (a page the agent already found goes first),
 * each kept for the account and returned as image:<id>. `pageAllowed` is false when the page came
 * from the model itself in a thread holding private data (server/agents.ts): it is then not read.
 */
export async function findImages(user: User, ollamaKey: string, input: { query: string; page?: string; count?: number }, signal: AbortSignal): Promise<{ images: FoundImage[]; notes: string[] }> {
  const query = input.query.trim().slice(0, 300)
  if (!query) throw new HttpError(400, 'A query is required')
  const count = Math.min(4, Math.max(1, Math.round(Number(input.count) || 1)))
  if ((running.get(user.id) ?? 0) >= 3) throw new HttpError(429, 'Three picture searches are already running for this account; wait for them')
  running.set(user.id, (running.get(user.id) ?? 0) + 1)
  const limit = AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)])
  const notes: string[] = []
  const terms = query.toLowerCase().split(/[\s,.;:/()"'-]+/).filter(Boolean)
  const images: FoundImage[] = []
  const tried = new Set<string>()
  /** Downloads picks, best first, until `count` are kept; a few at a time. */
  const take = async (picks: Pick[]) => {
    const order = picks.filter((p) => !tried.has(p.url)).sort((a, b) => b.score - a.score)
    while (images.length < count && order.length && tried.size < 10 && !limit.aborted) {
      const batch = order.splice(0, Math.min(3, count - images.length + 1))
      batch.forEach((p) => tried.add(p.url))
      const got = await Promise.all(
        batch.map((p) =>
          keep(user, p, limit).catch((e: Error) => {
            if (e instanceof HttpError && e.status === 413) throw e
            notes.push(`${hostOf(p.url) ?? 'a picture'}: ${e instanceof Blocked ? `refused (${e.message})` : e.message}`)
            return null
          }),
        ),
      )
      for (const g of got) if (g && images.length < count && !images.some((i) => i.id === g.id)) images.push(g)
    }
  }
  try {
    if (input.page) await take(await fromPages([{ url: input.page, title: query, bonus: 200 }], terms, limit, notes))
    if (images.length < count) {
      const fromProvider = await providerImages(user, query, limit).catch((e: Error) => {
        notes.push(`image search: ${e.message}`)
        return []
      })
      await take(fromProvider)
    }
    if (images.length < count && !limit.aborted) {
      const { results } = await webSearch(user, ollamaKey, query, 6, limit)
      const pages = results.filter((r) => r.url !== input.page).slice(0, 5).map((r, i) => ({ url: r.url, title: r.title, bonus: (5 - i) * 3 }))
      await take(await fromPages(pages, terms, limit, notes))
    }
  } finally {
    running.set(user.id, (running.get(user.id) ?? 1) - 1)
  }
  return { images, notes: notes.slice(0, 8) }
}

// --- serving ------------------------------------------------------------------------------------

/** GET /api/agents/images/w…: a kept picture, to its own account only. */
export function handleFoundImageApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: User): boolean {
  const m = /^\/api\/agents\/images\/(w[0-9a-f]{24})$/.exec(path)
  if (!m || (method !== 'GET' && method !== 'HEAD')) return false
  const row = database().prepare('SELECT mime, body FROM agent_found_images WHERE user_id = ? AND id = ?').get(user.id, m[1]) as { mime: string; body: Uint8Array } | undefined
  if (!row || !(MIMES as readonly string[]).includes(row.mime)) throw new HttpError(404, 'No such picture')
  // A picture never changes under its id.
  const tag = `"${m[1]}"`
  const headers = { ETag: tag, 'Cache-Control': 'private, max-age=604800, immutable', ...SECURITY, ...UNTRUSTED }
  if (req.headers['if-none-match'] === tag) return res.writeHead(304, headers).end(), true
  const body = Buffer.from(row.body)
  res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': String(body.length), ...headers }).end(method === 'HEAD' ? undefined : body)
  return true
}
