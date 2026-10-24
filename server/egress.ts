import type { LookupAddress } from 'node:dns'
import { Resolver } from 'node:dns/promises'
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

/** An IPv4 address's four numbers, or null when it isn't one. */
function v4Parts(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null
  return parts.map(Number)
}

/** Loopback, private, link-local, CGNAT (Tailscale), benchmark, documentation, multicast and other non-public IPv4. */
function privateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

/**
 * An IPv6 address as its eight 16-bit groups, `::` expanded and a dotted IPv4 tail
 * (::ffff:127.0.0.1) turned into two groups; null when it isn't one.
 */
export function v6Groups(raw: string): number[] | null {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (tail) {
    const v4 = v4Parts(tail[1])
    if (!v4) return null
    ip = `${ip.slice(0, -tail[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const side = (s: string) => (s ? s.split(':') : [])
  const head = side(halves[0])
  const rest = halves.length === 2 ? side(halves[1]) : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return all.map((g) => parseInt(g, 16))
}

/** The IPv4 address in the last 32 bits of eight groups. */
const lowV4 = (g: number[]) => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]

/** Non-public IPv6, including IPv6 forms that carry an IPv4 address inside (judged by that address). */
function privateV6(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  // ::a.b.c.d (IPv4-compatible, and :: and ::1 with it), ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT).
  if (zero(0, 6) || (zero(0, 5) && g[5] === 0xffff) || (zero(0, 4) && g[4] === 0xffff && g[5] === 0)) return privateV4(lowV4(g))
  // NAT64, the well-known prefix 64:ff9b::/96 (the IPv4 inside), and the local-use 64:ff9b:1::/48.
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || (zero(2, 6) ? privateV4(lowV4(g)) : true)
  // 6to4, 2002:AABB:CCDD::/48 for a.b.c.d.
  if (g[0] === 0x2002) return privateV4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255])
  // Teredo (2001::/32, its IPv4 hidden), documentation (2001:db8::/32), discard (100::/64).
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true
  if (g[0] === 0x100 && zero(1, 4)) return true
  // Unique local fc00::/7, link-local fe80::/10, old site-local fec0::/10, multicast ff00::/8.
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00
}

/**
 * Loopback, private, link-local, CGNAT (Tailscale), multicast and other non-public addresses, in
 * IPv4 or IPv6 (whose IPv4-carrying forms count as the IPv4 inside them). Anything that doesn't
 * parse counts as private.
 */
export function isPrivate(ip: string): boolean {
  const v4 = v4Parts(ip)
  if (v4) return privateV4(v4)
  const v6 = v6Groups(ip)
  return v6 ? privateV6(v6) : true
}

/**
 * A host name's addresses (IPv4 and IPv6) from DNS, with a deadline of its own (2.5 s a try, two
 * tries) and cancelled for real when `signal` aborts, so a stalled resolver can't hold anything up.
 * Not the system's getaddrinfo, which can be neither cancelled nor timed and ties up one of the
 * few threads Node has for it. localhost (and *.localhost) is 127.0.0.1, as the system says.
 */
export async function resolveHost(host: string, signal?: AbortSignal): Promise<LookupAddress[]> {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (name === 'localhost' || name.endsWith('.localhost')) return [{ address: '127.0.0.1', family: 4 }]
  if (signal?.aborted) return []
  const resolver = new Resolver({ timeout: 2500, tries: 2 })
  const stop = () => resolver.cancel()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)])
    return [...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []), ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : [])]
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}

/** A host's addresses, for http(s) only and when every one of them is public; refuses otherwise. */
export async function publicAddresses(url: URL, signal?: AbortSignal): Promise<LookupAddress[]> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressError(400, 'Only web addresses')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses: LookupAddress[] = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveHost(host, signal).catch(() => [])
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
  const pinned = pinnedLookup(addresses)
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

/** A `lookup` for http.request that answers only `addresses`. */
export const pinnedLookup = (addresses: LookupAddress[]) => (_host: string, opts: { all?: boolean }, done: (err: Error | null, address: string | LookupAddress[], family?: number) => void) =>
  opts?.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family)

/**
 * For a raw http(s) request to an address a user chose (a WebSocket upgrade, which fetch cannot
 * make): the same check guardedFetch makes, as a `lookup` that connects only to the checked
 * addresses. Admins may reach any host (their LAN too), so they get the system resolver (undefined).
 */
export async function guardedLookup(user: User | null, url: URL, signal?: AbortSignal) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressError(400, 'Only web addresses')
  if (user?.admin) return undefined
  return pinnedLookup(await publicAddresses(url, signal))
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
    } else res = await fetchPinned(url, opts, await publicAddresses(url, opts.signal ?? undefined))
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
