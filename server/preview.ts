import { fetchPinned, publicAddresses } from './egress.ts'
import { HttpError } from './http.ts'

// Link previews for Spotlight's "Go to example.com": the page's title, description, share image
// and icon, read from the first part of its HTML. The server fetches arbitrary sites here, so
// only for signed-in users, never private or internal addresses (also after redirects), at
// most 512 KB, and cached for a day.

export type LinkPreview = { url: string; host: string; title: string | null; description: string | null; image: string | null; icon: string | null; siteName: string | null }

const MAX_BYTES = 512 * 1024
const OK_TTL = 24 * 3600_000
const FAIL_TTL = 10 * 60_000
const cache = new Map<string, { at: number; ttl: number; value: Promise<LinkPreview> }>()

/** Public addresses only (server/egress.ts), on the usual web ports: the ones to connect to. */
export async function websiteAddresses(url: URL, signal?: AbortSignal) {
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new HttpError(400, 'Unusual port')
  return publicAddresses(url, signal)
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d{1,7});/g, (whole, n) => (Number(n) > 0 && Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : whole))
    .replace(/\s+/g, ' ')
    .trim()

// The page is another site's to write, so it is read with indexOf and short, bounded regexes only:
// nothing here may scan the page again from every position (an unclosed <head>, <link> or
// <title> repeated a hundred thousand times would otherwise stall the server).

/** ASCII letters lowered and nothing else, so positions in it are positions in the original. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase())
/** Tags longer than this are skipped rather than read. */
const MAX_TAG = 4096

/** The page's <head>…</head>, or its first 100 000 characters when it has none. */
export function headOf(html: string): string {
  const lower = asciiLower(html)
  const start = lower.indexOf('<head')
  const end = start < 0 ? -1 : lower.indexOf('</head>', start)
  return start >= 0 && end >= 0 ? html.slice(start, end + 7) : html.slice(0, 100_000)
}

/** Every `<name …>` tag in `html`, in order, each at most MAX_TAG long; stops at one never closed. */
export function* tagsOf(html: string, name: string): Generator<string> {
  const lower = asciiLower(html)
  const open = `<${name}`
  for (let at = lower.indexOf(open); at >= 0; at = lower.indexOf(open, at + 1)) {
    const next = lower[at + open.length]
    if (next !== undefined && !/[\s/>]/.test(next)) continue
    const end = lower.indexOf('>', at)
    if (end < 0) return
    if (end - at <= MAX_TAG) yield html.slice(at, end + 1)
    at = end
  }
}

/** The page's <title> text, or null. */
function titleOf(head: string): string | null {
  const lower = asciiLower(head)
  const start = lower.indexOf('<title')
  if (start < 0) return null
  const open = lower.indexOf('>', start)
  const close = open < 0 ? -1 : lower.indexOf('</title>', open)
  return close < 0 ? null : decode(head.slice(open + 1, Math.min(close, open + 1 + 2000))) || null
}

/** The biggest size in a `sizes` attribute ("16x16 32x32", "any"), or null. */
export function biggestSize(sizes: string | undefined): number | null {
  if (!sizes || sizes.length > 64) return null
  let best: number | null = null
  for (const token of sizes.trim().split(/\s+/)) {
    const m = /^(\d{1,5})x(\d{1,5})$/i.exec(token)
    if (m) best = Math.max(best ?? 0, Math.min(Number(m[1]), Number(m[2])))
  }
  return best
}

/** A <meta> tag's content by property or name, whichever order the attributes come in. */
function meta(head: string, key: string): string | null {
  for (const tag of tagsOf(head, 'meta')) {
    const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (name?.toLowerCase() !== key) continue
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag)
    const value = content?.[1] ?? content?.[2]
    if (value) return decode(value)
  }
  return null
}

function iconHref(head: string): string | null {
  let best: { href: string; score: number } | null = null
  for (const tag of tagsOf(head, 'link')) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    // Not Safari's monochrome pinned-tab "mask-icon".
    if (!/\bicon\b/.test(rel) || rel.includes('mask')) continue
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (!href) continue
    // Prefer an apple-touch-icon or a big PNG/SVG over a 16px .ico.
    const score = (rel.includes('apple') ? 3 : 0) + (/\.svg/i.test(href) ? 2 : 0) + (/(?:192|180|152|128|96)/.test(tag) ? 1 : 0)
    if (!best || score > best.score) best = { href: decode(href), score }
  }
  return best?.href ?? null
}

/**
 * Every icon a page's <head> lists, as absolute web addresses with the size each promises (its
 * `sizes`, else a guess: 180 for an apple-touch-icon, 150 for SVG (after a raster apple-touch-icon: SVG favicons often turn white for dark tabs), small otherwise). Mail's sender
 * icons (server/mailicons.ts) pick from these.
 */
export function iconLinks(html: string, base: URL): { href: string; size: number }[] {
  const head = headOf(html)
  const out: { href: string; size: number }[] = []
  for (const tag of tagsOf(head, 'link')) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    if (!/\bicon\b/.test(rel) || rel.includes('mask')) continue
    const raw = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (!raw) continue
    let href: URL
    try {
      href = new URL(decode(raw), base)
    } catch {
      continue
    }
    if (href.protocol !== 'https:' && href.protocol !== 'http:') continue
    const declared = biggestSize(/\bsizes\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1])
    const size = declared ?? (/\.svg(\?|$)/i.test(href.pathname) || /image\/svg/i.test(tag) ? 150 : rel.includes('apple') ? 180 : 32)
    out.push({ href: href.href, size })
  }
  return out
}

export async function fetchHead(start: URL, cancel?: AbortSignal): Promise<{ url: URL; html: string }> {
  let url = start
  for (let hop = 0; hop < 4; hop++) {
    const addresses = await websiteAddresses(url, cancel)
    // To the checked addresses only, so a DNS answer that changes meanwhile can't redirect it inside.
    const res = await fetchPinned(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mvlos link preview)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
      signal: cancel ? AbortSignal.any([cancel, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
    }, addresses).catch(() => null)
    if (!res) throw new HttpError(502, 'The site did not answer')
    // Every answer not read is cancelled, so its connection doesn't stay open in the background.
    const drop = () => res.body?.cancel().catch(() => {})
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await drop()
      url = new URL(res.headers.get('location')!, url)
      continue
    }
    if (!res.ok) {
      await drop()
      throw new HttpError(502, `The site answered ${res.status}`)
    }
    if (!/html/i.test(res.headers.get('content-type') ?? '')) {
      await drop()
      return { url, html: '' }
    }
    // Only the start of the page: the <head> is near the top.
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (reader && size < MAX_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.length
        // Only the last bit can newly hold it (a tag split between two pieces included).
        if (asciiLower(Buffer.concat(chunks.slice(-2)).toString('latin1')).includes('</head>')) break
      }
    } finally {
      await reader?.cancel().catch(() => {})
    }
    return { url, html: Buffer.concat(chunks).toString('utf8') }
  }
  throw new HttpError(502, 'Too many redirects')
}

export function linkPreview(raw: string): Promise<LinkPreview> {
  let start: URL
  try {
    start = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return Promise.reject(new HttpError(400, 'Not a web address'))
  }
  const key = start.href
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value
  const value = (async () => {
    const { url, html } = await fetchHead(start)
    // Sent to another domain (a cookie wall, a login page): that page isn't the site. Keep only
    // the site's own icon.
    const base = (h: string) => h.replace(/^www\./, '').split('.').slice(-2).join('.')
    if (base(url.hostname) !== base(start.hostname))
      return { url: start.href, host: start.host.replace(/^www\./, ''), title: null, description: null, image: null, icon: `${start.origin}/favicon.ico`, siteName: null }
    const head = headOf(html)
    const abs = (href: string | null) => {
      if (!href) return null
      try {
        const u = new URL(href, url)
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
      } catch {
        return null
      }
    }
    const title = meta(head, 'og:title') ?? meta(head, 'twitter:title') ?? titleOf(head)
    return {
      url: url.href,
      host: url.host.replace(/^www\./, ''),
      title: title?.slice(0, 200) || null,
      description: (meta(head, 'og:description') ?? meta(head, 'description') ?? meta(head, 'twitter:description'))?.slice(0, 400) || null,
      image: abs(meta(head, 'og:image') ?? meta(head, 'twitter:image')),
      icon: abs(iconHref(head)) ?? `${url.origin}/favicon.ico`,
      siteName: meta(head, 'og:site_name'),
    }
  })()
  cache.set(key, { at: Date.now(), ttl: OK_TTL, value })
  value.catch(() => cache.set(key, { at: Date.now(), ttl: FAIL_TTL, value }))
  if (cache.size > 2000) for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k)
  return value
}
