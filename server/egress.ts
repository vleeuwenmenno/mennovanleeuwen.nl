import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { User } from './auth.ts'
import { HttpError } from './http.ts'

// Requests the server makes to addresses its users chose: their Gitea/Forgejo, CalDAV, Seafile,
// OnlyOffice and search servers, and whatever links those servers hand back. Anyone with a GitHub
// account can sign up, so none of these may reach the server's own network (other containers,
// the host, a cloud metadata service): every address, also after each redirect, must be public.
// Admins may use internal addresses (their own Seafile on the LAN, say).
//
// A host whose DNS answer changes between this check and the request itself can still slip
// through; the container's firewall (README, "Open sign-up") is the backstop for that.

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

/** Refuses anything but http(s) to a host whose every address is public. */
export async function assertPublic(url: URL) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressError(400, 'Only web addresses')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address)
  if (!addresses.length) throw new EgressError(404, `${url.host} does not exist`)
  if (addresses.some(isPrivate)) throw new EgressError(400, `${url.host} is not a public address`)
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
    if (user?.admin) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressError(400, 'Only web addresses')
    } else await assertPublic(url)
    const res = await fetch(url, opts)
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
