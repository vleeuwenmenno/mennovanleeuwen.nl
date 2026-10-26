import { createHash, randomUUID } from 'node:crypto'
import { database } from './db.ts'
import { bindPrivateAccess, requirePrivateRequest, privateSignal, withProviderGuard } from './privateRequest.ts'
import type { User } from './auth.ts'
import { guardedFetch, readCapped, rethrowEgress } from './egress.ts'
import { HttpError } from './http.ts'

// WebDAV for CalDAV and CardDAV: requests with the captured account's Basic login through the
// egress guard, and reading the few elements of a multistatus answer that are needed. No XML
// library: the elements are found by their local name, whatever namespace prefix the server uses.
// CalDAV keeps its older XML/ICS readers but shares this guarded transport.

/** A captured link, never a lookup by a reusable numeric account ID. Checks are deliberately
 * required by the shared transport, including candidate logins during discovery. */
export type DavAuthority = { retain?: boolean; key: string; check: () => void; subscribe: (end: () => void) => () => void }
export type DavLogin = { username: string; password: string; user: User; authority: DavAuthority }
export type DavRecord = { id: number; base_url: string; username: string; password: string }

/** The encrypted record contains a fresh random nonce on every link/password write. Its sealed
 * fingerprint survives restart, changes on replacement, and includes the owner and endpoint. No
 * migration is needed for existing records. The epoch also invalidates remove-while-absent races. */
export function davAuthority(user: User, table: 'caldav' | 'carddav', row: DavRecord | undefined, epoch: DavAuthority): DavAuthority {
  const fingerprint = (r: DavRecord) => createHash('sha256').update(JSON.stringify([user.id, r.id, r.base_url, r.username, r.password])).digest('hex')
  const sealed = row && fingerprint(row)
  return {
    retain: !!row,
    key: `${epoch.key}:${sealed ?? randomUUID()}`,
    check() {
      epoch.check()
      if (!row) return
      const current = database().prepare(`SELECT id, base_url, username, password FROM ${table} WHERE user_id = ? AND id = ?`).get(user.id, row.id) as DavRecord | undefined
      if (!current || fingerprint(current) !== sealed) throw new HttpError(409, 'The DAV account changed: try again')
    },
    subscribe: epoch.subscribe,
  }
}

export function assertDavLogin(login: DavLogin) {
  requirePrivateRequest(login.user)
  login.authority.check()
  if (login.authority.retain !== false) bindPrivateAccess(login.authority.check, login.authority.subscribe, login.authority.key)
}

/** All DAV dispatches retain their captured authority through redirects, headers and body reads.
 * Callers cannot provide credentials without the corresponding link authority. */
export async function davRequest(login: DavLogin, method: string, url: string, init: { headers?: Record<string, string>; body?: string; timeout?: number } = {}): Promise<Response> {
  assertDavLogin(login)
  const gone = new AbortController()
  const off = login.authority.subscribe(() => gone.abort(new HttpError(409, 'The DAV account changed: try again')))
  const signal = privateSignal(AbortSignal.any([gone.signal, AbortSignal.timeout(init.timeout ?? 15_000)]))!
  const check = () => { signal.throwIfAborted(); assertDavLogin(login) }
  let res: Response | null = null
  try {
    res = await withProviderGuard(login.authority.check, () => guardedFetch(login.user, url, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`, 'User-Agent': 'mvlos', ...init.headers },
      body: init.body,
      signal,
    })).catch((e) => (rethrowEgress(e), null))
    check()
    if (!res) throw new HttpError(502, `${new URL(url).host} did not answer`)
    // None of our write/error callers use these bodies. Discard centrally, so a missed caller
    // cleanup cannot keep a global link subscription or socket alive.
    if (!res.ok || !['GET', 'PROPFIND', 'REPORT'].includes(method)) {
      await res.body?.cancel().catch(() => {})
      check(); off(); return res
    }
  } catch (e) { gone.abort(e); off(); void res?.body?.cancel(e).catch(() => {}); throw e }
  if (!res.body) { off(); return res }
  const reader = res.body.getReader()
  let stopped = false
  const stop = () => { if (!stopped) { stopped = true; off(); signal.removeEventListener('abort', aborted) } }
  let controller: ReadableStreamDefaultController<Uint8Array>
  const aborted = () => { if (stopped) return; stop(); void reader.cancel(signal.reason).catch(() => {}); controller.error(signal.reason) }
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted() },
    async pull(c) {
      if (stopped) return
      try {
        check()
        const part = await reader.read()
        check()
        if (part.done) { stop(); c.close() } else c.enqueue(part.value)
      } catch (e) { stop(); void reader.cancel(e).catch(() => {}); try { c.error(e) } catch { /* already aborted */ } }
    },
    async cancel(reason) { stop(); gone.abort(reason); await reader.cancel(reason).catch(() => {}) },
  }, { highWaterMark: 0 })
  const guarded = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  for (const name of ['url', 'redirected', 'type'] as const) Object.defineProperty(guarded, name, { value: res[name] })
  return guarded
}

/** A PROPFIND or REPORT, answering the multistatus text (16 MB at most). */
export async function davXml(login: DavLogin, method: 'PROPFIND' | 'REPORT', url: string, depth: '0' | '1', body: string): Promise<string> {
  const res = await davRequest(login, method, url, { headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body, timeout: 30_000 })
  if (res.status === 401 || res.status === 403) throw new Error(`${new URL(url).host} refused the username or app password`)
  if (res.status !== 207 && !res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  const text = (await readCapped(res, 16 * 1024 * 1024)).toString('utf8')
  assertDavLogin(login)
  return text
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
