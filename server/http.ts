import type { IncomingMessage, ServerResponse } from 'node:http'

// Small request/response helpers shared by the API routes. No framework, just Node.

export const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  // Browsers ignore this over plain HTTP, so it only bites behind TLS. No includeSubDomains or preload: not every subdomain is known to be HTTPS.
  'Strict-Transport-Security': 'max-age=31536000',
  // Blocks injected script (inline, eval, other origins) and plugins; nothing else, because the app uses third-party fonts, public APIs, blob/data media and inline styles. Spread SECURITY first: UNTRUSTED and the share page's own policy replace it.
  'Content-Security-Policy': "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
}

/** The policy of the app's own HTML pages (index.html and its /cv and /play variants). Only the
 * boot script and the modulepreload links carry the per-response nonce; 'strict-dynamic' lets that
 * trusted script load the rest, so a script it adds on purpose (OnlyOffice's api.js from the
 * document server the user configured) runs while an injected inline script or a bare
 * <script src> in markup still does not. Browsers that don't know 'strict-dynamic' fall back to
 * 'self'. A nonce is only good for the response that carried it: never cache these pages shared. */
export function documentCsp(nonce: string) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic' 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`
}

/** For file bytes passed through from Seafile: never rendered as a page of this site, even when
 * opened directly (a shared library's HTML or SVG would otherwise run with the user's session). */
export const UNTRUSTED = {
  'Content-Security-Policy': "default-src 'none'; sandbox",
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY, ...headers }).end(JSON.stringify(body))
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...SECURITY, ...headers }).end()
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let bodyGuard: ((req: IncomingMessage) => void) | null = null
/** Registers what runs on a request once its body has been read (server/auth.ts: the session must still be good). */
export const guardBodies = (guard: (req: IncomingMessage) => void) => void (bodyGuard = guard)
/** Called when a request's body has been read in full, before anything is done with it. Throws when the guard says no. */
export const bodyRead = (req: IncomingMessage) => bodyGuard?.(req)

/** Reads a JSON body of at most `limit` bytes. Only `application/json` is accepted, which also
 * means a cross-site form can't post here without a CORS preflight the server never answers. */
export async function readJson<T>(req: IncomingMessage, limit = 512 * 1024): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Expected application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'Body too large')
    chunks.push(chunk as Buffer)
  }
  bodyRead(req)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const raw = part.slice(i + 1).trim()
    // A malformed escape (a stray "%") is kept as sent rather than failing the whole request.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw)
    } catch {
      out[part.slice(0, i).trim()] = raw
    }
  }
  return out
}

/** The origin visitors use, for OAuth redirects and the Secure cookie flag. PUBLIC_URL wins;
 * otherwise the Host header and X-Forwarded-Proto from the reverse proxy. Set PUBLIC_URL in
 * production: without it, whoever reaches the server directly chooses these headers. */
export function publicOrigin(req: IncomingMessage): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '')
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http'
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`
}

/** `readable`: the page's scripts may read it (never for anything secret). */
export function setCookie(req: IncomingMessage, name: string, value: string, opts: { maxAge: number; path?: string; readable?: boolean }) {
  const secure = publicOrigin(req).startsWith('https:') ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=${opts.path ?? '/'}; Max-Age=${opts.maxAge}${opts.readable ? '' : '; HttpOnly'}; SameSite=Lax${secure}`
}

/** Bump to purge every browser's HTTP cache once more on its next load. */
export const CACHE_PURGE_EPOCH = '1'
export const CACHE_PURGE_COOKIE = 'mvlos_cache_purge'

/**
 * The one-time HTTP cache purge of the security release that made account-scoped media `no-store`:
 * responses an older release let the browser keep for days could otherwise still be replayed
 * to another account on the same browser. Until the marker cookie (HttpOnly, never readable by the
 * page) holds this epoch, the response carries `Clear-Site-Data: "cache"` and sets the marker.
 * Only "cache": never cookies, storage or service workers. Browsers that block cookies get the
 * purge on every load, which is safe. Combine with other headers through `mergeHeaders`.
 */
export function cachePurge(req: IncomingMessage): Record<string, string | string[]> {
  if (cookies(req)[CACHE_PURGE_COOKIE] === CACHE_PURGE_EPOCH) return {}
  return {
    'Clear-Site-Data': '"cache"',
    'Set-Cookie': [setCookie(req, CACHE_PURGE_COOKIE, CACHE_PURGE_EPOCH, { maxAge: 400 * 86400 })],
  }
}

/** `base` plus `extra`, with Set-Cookie lists joined rather than replaced. */
export function mergeHeaders(base: Record<string, string | string[]>, extra: Record<string, string | string[]>): Record<string, string | string[]> {
  const out = { ...base, ...extra }
  const set = [base['Set-Cookie'] ?? [], extra['Set-Cookie'] ?? []].flat()
  if (set.length) out['Set-Cookie'] = set
  return out
}

/** State-changing requests must come from this site: a present Origin header has to match. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === (req.headers['x-forwarded-host'] ?? req.headers.host)
  } catch {
    return false
  }
}
