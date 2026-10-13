import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { guardedFetch, readCapped, rethrowEgress } from './egress.ts'
import { HttpError } from './http.ts'

// Immich, as the Photos app's second source (server/photos.ts): one server per account, linked
// with its URL and an API key (Immich: Account settings → API keys). The key is kept encrypted
// like the other secrets and only ever sent from here, in the x-api-key header; thumbnails,
// originals and video come through this server so it never reaches the browser.
//
// Immich indexes its own photos (EXIF, places, albums, favourites), so nothing is copied here:
// every request goes to its API. Written against Immich 2.x and 3.x, whose endpoints used here
// are the same (/api/timeline/buckets and /bucket, /api/assets/{id} and its /thumbnail, /original
// and /video/playback, /api/albums); other major versions are refused when linking.

const NAME = 'immich'
/** The Immich majors this was written against. */
const SUPPORTED = [2, 3]
/** The most a JSON answer may hold: a month's bucket of a big library is a few MB. */
const MAX_JSON = 32 * 1024 * 1024

type Link = { url: string; key: string; name: string | null; email: string | null; version: string }

/** What Settings and the Photos app see: never the key. */
export type ImmichInfo = { url: string; name: string | null; email: string | null; version: string }

function read(user: User): Link | null {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, NAME) as { secret: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(decrypt(row.secret)) as Link
  } catch {
    return null
  }
}

export function immichInfo(user: User): ImmichInfo | null {
  const link = read(user)
  return link && { url: link.url, name: link.name, email: link.email, version: link.version }
}

/** https://host or https://host/sub, without a trailing slash or the /api people sometimes paste. */
function normalizeUrl(input: string | undefined): string {
  const raw = input?.trim() ?? ''
  if (!raw) throw new HttpError(400, 'The Immich URL is required')
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new HttpError(400, 'That Immich URL does not look right')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'The Immich URL must be http(s)')
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}`
}

/**
 * A request to Immich's API. Redirects are not followed: the key travels in its own header, which
 * fetch would carry to any other host a redirect named.
 */
async function call(user: User, base: string, key: string | null, path: string, init: RequestInit & { timeout?: number; signal?: AbortSignal; stream?: boolean } = {}): Promise<Response> {
  const { timeout = 20_000, signal, stream, ...rest } = init
  const headers = new Headers(rest.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (key) headers.set('x-api-key', key)
  // A stream (a video playing) may take as long as it likes once it has started; the rest must be done in time.
  const late = new AbortController()
  const timer = setTimeout(() => late.abort(new Error('timeout')), timeout)
  timer.unref()
  const signals = [late.signal, ...(signal ? [signal] : [])]
  const res = await guardedFetch(user, `${base}/api${path}`, { ...rest, headers, redirect: 'manual', signal: AbortSignal.any(signals) })
    .catch((e) => (rethrowEgress(e), null))
    .finally(() => stream && clearTimeout(timer))
  if (!res) throw new HttpError(502, 'Immich did not answer')
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(502, 'Immich redirected: check the URL (https, and the sub-path if it has one)')
  }
  return res
}

const errorOf = async (res: Response) => {
  const body = (await readCapped(res, 64 * 1024).then((b) => JSON.parse(b.toString('utf8'))).catch(() => null)) as { message?: string | string[] } | null
  const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message
  return message || `Immich answered ${res.status}`
}

/** Fails with a message that says what to do, for an answer that is not 2xx. */
async function fail(res: Response): Promise<never> {
  const message = await errorOf(res)
  if (res.status === 401) throw new HttpError(409, 'Immich no longer accepts the API key: link it again')
  // A key made with only some permissions: Immich names the one that is missing.
  if (res.status === 403) throw new HttpError(403, `Immich refused: ${message}. The API key needs asset, album and timeline read access, asset.download and asset.update (and asset.delete for the trash, albumAsset.create for adding to albums).`)
  throw new HttpError(res.status === 404 || res.status === 400 ? res.status : 502, message)
}

function linked(user: User): Link {
  const link = read(user)
  if (!link) throw new HttpError(409, 'Immich is not linked')
  return link
}

/** A JSON request to Immich as the linked account. */
export async function immich<T>(user: User, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<T> {
  const link = linked(user)
  const res = await call(user, link.url, link.key, path, init)
  if (!res.ok) return fail(res)
  if (res.status === 204) return undefined as T
  return JSON.parse((await readCapped(res, MAX_JSON)).toString('utf8')) as T
}

/** A file from Immich (a thumbnail, an original, a video), not read here: the caller pipes it. */
export async function immichFile(user: User, path: string, init: { range?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const link = linked(user)
  const res = await call(user, link.url, link.key, path, { headers: { Accept: '*/*', ...(init.range ? { Range: init.range } : {}) }, signal: init.signal, timeout: 60_000, stream: true })
  if (res.ok || res.status === 206 || res.status === 416) return res
  return fail(res)
}

/**
 * Links Immich: its version first (public, and refused outside the supported majors), then the key
 * against the account and the timeline, so a key without the permissions the app needs says so now.
 */
export async function linkImmich(user: User, body: { url?: string; key?: string }): Promise<ImmichInfo> {
  const url = normalizeUrl(body.url)
  const key = body.key?.trim()
  if (!key) throw new HttpError(400, 'The API key is required')
  if (!/^[\w.~+/=-]{8,256}$/.test(key)) throw new HttpError(400, 'That does not look like an Immich API key')

  const v = await call(user, url, null, '/server/version', { timeout: 10_000 })
  if (v.status === 404) throw new HttpError(400, 'No Immich there: check the URL')
  if (!v.ok) throw new HttpError(400, `Immich answered ${v.status} when asked for its version`)
  const version = (await readCapped(v, 64 * 1024).then((b) => JSON.parse(b.toString('utf8'))).catch(() => null)) as { major?: number; minor?: number; patch?: number } | null
  if (typeof version?.major !== 'number') throw new HttpError(400, 'That server did not answer like Immich does: check the URL')
  const name = `${version.major}.${version.minor ?? 0}.${version.patch ?? 0}`
  if (!SUPPORTED.includes(version.major)) throw new HttpError(400, `Immich ${name} is not supported: Photos works with Immich ${SUPPORTED.join(' and ')} (major versions)`)

  const me = await call(user, url, key, '/users/me')
  if (me.status === 401) throw new HttpError(400, 'Immich did not accept that API key')
  if (!me.ok) throw new HttpError(400, me.status === 403 ? 'The API key needs the user.read permission (or All)' : await errorOf(me))
  const account = (await readCapped(me, 256 * 1024).then((b) => JSON.parse(b.toString('utf8'))).catch(() => null)) as { name?: string; email?: string } | null
  const timeline = await call(user, url, key, '/timeline/buckets?visibility=timeline')
  if (!timeline.ok) throw new HttpError(400, timeline.status === 403 ? 'The API key needs the timeline.read permission (or All)' : await errorOf(timeline))
  await timeline.body?.cancel().catch(() => {})

  const link: Link = { url, key, name: account?.name || null, email: account?.email || null, version: name }
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user.id, NAME, encrypt(JSON.stringify(link)), Date.now())
  return immichInfo(user)!
}

/** Forgets the key here. It stays valid on Immich until it is deleted there (Account settings → API keys). */
export const unlinkImmich = (user: User) => void database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, NAME)
