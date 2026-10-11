import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { User } from './auth.ts'
import { HttpError } from './http.ts'

// Requests the server makes to addresses its users chose: their Gitea/Forgejo, CalDAV, Seafile,
// OnlyOffice and search servers, and whatever links those servers hand back. Anyone with a GitHub
// account can sign up, so none of these may reach the server's own network (other containers,
// the host, a cloud metadata service): every address, also after each redirect, must be public.
// Admins may use internal addresses (their own Seafile on the LAN, say).
//
// The request goes to exactly the addresses that were checked (fetchPinned), so a host whose DNS
// answer changes between the check and the request (DNS rebinding) cannot slip through to them.

const MAX_HOPS = 5

/** Thrown for an address that isn't allowed; callers that swallow network errors let this one through. */
export class EgressError extends HttpError {}

/** Loopback, private, link-local, CGNAT (Tailscale), multicast and other non-public addresses. */
export function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7))
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff')
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224
}

/** A host's addresses, for http(s) only and when every one of them is public; refuses otherwise. */
export async function publicAddresses(url: URL): Promise<LookupAddress[]> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressError(400, 'Only web addresses')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses: LookupAddress[] = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => [])
  if (!addresses.length) throw new EgressError(404, `${url.host} does not exist`)
  if (addresses.some((a) => isPrivate(a.address))) throw new EgressError(400, `${url.host} is not a public address`)
  return addresses
}

/** Refuses anything but http(s) to a host whose every address is public. */
export async function assertPublic(url: URL) {
  await publicAddresses(url)
}

/**
 * One request (no redirects followed) that connects only to `addresses`: the ones that were just
 * checked, not whatever the host's DNS answers a moment later. TLS still checks the certificate
 * against the host name. Answers a fetch Response; the body is not decompressed, so none is asked
 * for.
 */
export async function fetchPinned(url: URL, init: RequestInit, addresses: LookupAddress[]): Promise<Response> {
  // Request turns any body fetch takes (text, bytes, FormData, URLSearchParams) into bytes with
  // the right Content-Type.
  const req = new Request(url, { method: init.method, headers: init.headers, body: init.body, ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit)
  const body = init.body == null ? null : Buffer.from(await req.arrayBuffer())
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    if (k !== 'accept-encoding') headers[k] = v
  })
  if (body) headers['content-length'] = String(body.length)
  const pinned = (_host: string, opts: { all?: boolean }, done: (err: Error | null, address: string | LookupAddress[], family?: number) => void) =>
    opts?.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family)
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const r = send(url, { method: req.method, headers, lookup: pinned as never, signal: init.signal ?? undefined }, (res: IncomingMessage) => {
      const h = new Headers()
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      const status = res.statusCode && res.statusCode >= 200 ? res.statusCode : 502
      const empty = status === 204 || status === 205 || status === 304 || req.method === 'HEAD'
      if (empty) res.resume()
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: h }))
    })
    r.on('error', reject)
    r.end(body ?? undefined)
  })
}

/** Lets an EgressError through a `.catch()` that turns network failures into null or a message. */
export function rethrowEgress(e: unknown) {
  if (e instanceof EgressError) throw e
}

/**
 * fetch() for an address a user chose: checked before the request and again at every redirect
 * (followed here, at most five, unless the caller asks for `redirect: 'manual'`). Like fetch,
 * a redirect to another origin drops the Authorization header, and a 303 (or a 301/302 after a
 * POST) continues as a GET without the body.
 */
export async function guardedFetch(user: User | null, input: string | URL, init: RequestInit = {}): Promise<Response> {
  const follow = init.redirect !== 'manual'
  let url = new URL(input)
  let opts: RequestInit = { ...init, redirect: 'manual' }
  for (let hop = 0; ; hop++) {
    let res: Response
    if (user?.admin) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressError(400, 'Only web addresses')
      res = await fetch(url, opts)
    } else res = await fetchPinned(url, opts, await publicAddresses(url))
    const location = res.headers.get('location')
    if (!follow || res.status < 300 || res.status >= 400 || !location) return res
    if (hop >= MAX_HOPS) throw new HttpError(502, `${url.host} redirected too often`)
    await res.body?.cancel().catch(() => {})
    const next = new URL(location, url)
    const headers = new Headers(opts.headers)
    if (next.origin !== url.origin) headers.delete('authorization')
    const method = (opts.method ?? 'GET').toUpperCase()
    const asGet = res.status === 303 ? method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST'
    opts = asGet ? { ...opts, headers, method: 'GET', body: undefined } : { ...opts, headers }
    url = next
  }
}

/**
 * A response body as bytes, refusing to hold more than `max`: a server a user chose can answer
 * with anything, Content-Length or not, for as long as it likes.
 */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(413, 'That is too big to read here')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body?.getReader()
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new HttpError(413, 'That is too big to read here')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
