import type { User } from './auth.ts'
import { guardedFetch, readCapped, rethrowEgress } from './egress.ts'
import { HttpError } from './http.ts'

// WebDAV for CardDAV (server/carddav.ts): requests with the account's Basic login through the
// egress guard, and reading the few elements of a multistatus answer that are needed. No XML
// library: the elements are found by their local name, whatever namespace prefix the server uses.
// server/caldav.ts has its own copy of these, from before; new DAV code shares this one.

/** Whom to sign in as, and who asked (the server only reaches public addresses for them, server/egress.ts). */
export type DavLogin = { username: string; password: string; user: User }

/** One request with the account's login; a server that does not answer at all is a 502. */
export async function davRequest(login: DavLogin, method: string, url: string, init: { headers?: Record<string, string>; body?: string; timeout?: number } = {}): Promise<Response> {
  const res = await guardedFetch(login.user, url, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`, 'User-Agent': 'mvlos', ...init.headers },
    body: init.body,
    signal: AbortSignal.timeout(init.timeout ?? 15_000),
  }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, `${new URL(url).host} did not answer`)
  return res
}

/** A PROPFIND or REPORT, answering the multistatus text (16 MB at most). */
export async function davXml(login: DavLogin, method: 'PROPFIND' | 'REPORT', url: string, depth: '0' | '1', body: string): Promise<string> {
  const res = await davRequest(login, method, url, { headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body, timeout: 30_000 })
  if (res.status === 401 || res.status === 403) throw new Error(`${new URL(url).host} refused the username or app password`)
  if (res.status !== 207 && !res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  return (await readCapped(res, 16 * 1024 * 1024)).toString('utf8')
}

export const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The responses of a multistatus, each with its href and its body to read properties from. */
export function responses(xml: string): { href: string; body: string }[] {
  const out: { href: string; body: string }[] = []
  const re = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g
  for (let m; (m = re.exec(xml)); ) {
    const href = /<(?:[\w-]+:)?href\b[^>]*>([^<]*)</.exec(m[1])?.[1]
    if (href) out.push({ href: unescapeXml(href.trim()), body: m[1] })
  }
  return out
}

/** The text inside the first element with this local name (any namespace prefix); '' for an empty one, null when there is none. */
export function prop(body: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`).exec(body)
  return m ? (m[1] ?? '') : null
}

/** Whether a response's propstat for this property says 200 (a 404 propstat holds the empty element too). */
export function found(body: string, name: string): boolean {
  const re = /<(?:[\w-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/g
  for (let m; (m = re.exec(body)); ) if (prop(m[1], name) !== null) return /\b200\b/.test(prop(m[1], 'status') ?? '200')
  return prop(body, name) !== null
}

/** The href inside an element such as current-user-principal or addressbook-home-set. */
export const hrefIn = (body: string, name: string) => {
  const inner = prop(body, name)
  return inner ? (/<(?:[\w-]+:)?href\b[^>]*>([^<]*)</.exec(inner)?.[1]?.trim() ?? null) : null
}

export const resolveHref = (base: string, href: string) => new URL(unescapeXml(href), base).href

/** A URL the user typed: https unless it says otherwise, no login inside it, ending in a slash. */
export function normalizeDavUrl(input: string): string {
  let raw = input.trim()
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'That is not a URL')
  }
  if (url.username || url.password) throw new HttpError(400, 'Leave credentials out of the URL')
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

/** Turns a failed write's status into what the user is told. */
export function davRefused(res: Response, url: string, what: string): never {
  const host = new URL(url).host
  if (res.status === 401 || res.status === 403) throw new HttpError(403, `${host} refused the change; an app password that can write is needed`)
  if (res.status === 404 || res.status === 410) throw new HttpError(404, `That ${what} is gone from the server`)
  if (res.status === 412) throw new HttpError(409, 'It changed somewhere else meanwhile; try again')
  throw new HttpError(502, `${host} answered ${res.status}`)
}
