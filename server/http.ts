import type { IncomingMessage, ServerResponse } from 'node:http'

// Small request/response helpers shared by the API routes. No framework, just Node.

export const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
}

/** For file bytes passed through from Seafile: never rendered as a page of this site, even when
 * opened directly (a shared library's HTML or SVG would otherwise run with the owner's session). */
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

export function setCookie(req: IncomingMessage, name: string, value: string, opts: { maxAge: number; path?: string }) {
  const secure = publicOrigin(req).startsWith('https:') ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=${opts.path ?? '/'}; Max-Age=${opts.maxAge}; HttpOnly; SameSite=Lax${secure}`
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
