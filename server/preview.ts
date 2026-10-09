import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { HttpError } from './http.ts'

// Link previews for Spotlight's "Go to example.com": the page's title, description, share image
// and icon, read from the first part of its HTML. The server fetches arbitrary sites here, so
// only for the signed-in owner, never private or internal addresses (also after redirects), at
// most 512 KB, and cached for a day.

export type LinkPreview = { url: string; host: string; title: string | null; description: string | null; image: string | null; icon: string | null; siteName: string | null }

const MAX_BYTES = 512 * 1024
const OK_TTL = 24 * 3600_000
const FAIL_TTL = 10 * 60_000
const cache = new Map<string, { at: number; ttl: number; value: Promise<LinkPreview> }>()

/** Loopback, private, link-local, CGNAT (Tailscale), multicast and other non-public addresses. */
function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7))
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff')
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224
}

async function assertPublic(url: URL) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Only web addresses')
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new HttpError(400, 'Unusual port')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address)
  if (!addresses.length) throw new HttpError(404, 'That site does not exist')
  if (addresses.some(isPrivate)) throw new HttpError(400, 'Not a public address')
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()

/** A <meta> tag's content by property or name, whichever order the attributes come in. */
function meta(head: string, key: string): string | null {
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0]
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
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
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

async function fetchHead(start: URL): Promise<{ url: URL; html: string }> {
  let url = start
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url)
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mvlos link preview)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(6000),
    }).catch(() => null)
    if (!res) throw new HttpError(502, 'The site did not answer')
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url)
      continue
    }
    if (!res.ok) throw new HttpError(502, `The site answered ${res.status}`)
    if (!/html/i.test(res.headers.get('content-type') ?? '')) return { url, html: '' }
    // Only the start of the page: the <head> is near the top.
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (reader && size < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
      if (Buffer.concat(chunks).toString('latin1').includes('</head>')) break
    }
    await reader?.cancel().catch(() => {})
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
    const head = /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? html.slice(0, 100_000)
    const abs = (href: string | null) => {
      if (!href) return null
      try {
        const u = new URL(href, url)
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
      } catch {
        return null
      }
    }
    const title = meta(head, 'og:title') ?? meta(head, 'twitter:title') ?? (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ? decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)![1]) : null)
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
