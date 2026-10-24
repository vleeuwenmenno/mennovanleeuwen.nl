import { randomBytes } from 'node:crypto'
import type { User } from './auth.ts'
import { database, decrypt, encrypt, onUserGone } from './db.ts'
import { guardedFetch, readCapped, rethrowEgress } from './egress.ts'

/** The most a Seahub answer may hold: listings, links and settings are small. */
const MAX_JSON = 16 * 1024 * 1024
import { HttpError } from './http.ts'

// Seafile, for the Files app: one account, linked in Settings → Integrations. Signing in once
// with the username and password (and a 2FA code when the account has one) gets an API token,
// made as a device ("mennovanleeuwen.nl") so it shows up in Seafile's Devices and can be revoked
// there. Only the token is kept, encrypted like the other secrets; the password never is.
//
// Seahub's API sends no CORS headers, so the browser talks to it through here. Uploads and
// downloads go straight to Seafile's file server (it does send CORS headers): this side only
// hands out the short-lived links.
//
// The OnlyOffice document server Seafile uses can be added too (its URL and JWT secret), for
// editing Office files in a window.

const NAME = 'seafile'
const OFFICE = 'onlyoffice'
const DEVICE_NAME = 'mennovanleeuwen.nl'

type Link = { url: string; username: string; token: string; name: string | null; version: string | null }
type Office = { url: string; secret: string }

/** What Settings (and /api/me) shows: never the token or the secret. */
export type SeafileInfo = { url: string; username: string; name: string | null; version: string | null; office: { url: string } | null }

function read<T>(user: User, name: string): T | null {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, name) as { secret: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(decrypt(row.secret)) as T
  } catch {
    return null
  }
}

function write(user: User, name: string, value: unknown) {
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user.id, name, encrypt(JSON.stringify(value)), Date.now())
}

const remove = (user: User, name: string) => database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, name)

export function seafileInfo(user: User): SeafileInfo | null {
  const link = read<Link>(user, NAME)
  if (!link) return null
  const office = read<Office>(user, OFFICE)
  return { url: link.url, username: link.username, name: link.name, version: link.version, office: office ? { url: office.url } : null }
}

/** https://host or https://host/seafile (a sub-path install), without the trailing slash. */
function normalizeUrl(input: string | undefined, what: string): string {
  const raw = input?.trim() ?? ''
  if (!raw) throw new HttpError(400, `${what} URL is required`)
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new HttpError(400, `That ${what} URL does not look right`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, `${what} URL must be http(s)`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** A request to Seahub at the address `user` linked: public addresses only, for anyone but an admin (server/egress.ts). */
async function call(user: User, base: string, path: string, init: RequestInit & { token?: string; timeout?: number } = {}): Promise<Response> {
  const { token, timeout = 15_000, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set('Accept', 'application/json')
  if (token) headers.set('Authorization', `Token ${token}`)
  const res = await guardedFetch(user, `${base}${path}`, { ...rest, headers, redirect: 'manual', signal: rest.signal ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, 'Seafile did not answer')
  return res
}

const errorOf = async (res: Response) => {
  const body = (await res.json().catch(() => null)) as { error_msg?: string; detail?: string; non_field_errors?: string[] } | null
  return body?.error_msg || body?.detail || body?.non_field_errors?.[0] || `Seafile answered ${res.status}`
}

/**
 * Signs in for a token. Answers { otp: true } when Seafile wants a 2FA code first: the form asks
 * for one and sends everything again with it.
 */
export async function linkSeafile(user: User, body: { url?: string; username?: string; password?: string; otp?: string }): Promise<SeafileInfo | { otp: true }> {
  const url = normalizeUrl(body.url, 'Seafile')
  const username = body.username?.trim()
  const password = body.password
  if (!username || !password) throw new HttpError(400, 'Username and password are required')

  // Seahub only makes device tokens for its own clients' platforms; a desktop one needs a 40-hex
  // device id (a sync client's peer id). Empty versions would fail its validation, so they say what this is.
  const form = new URLSearchParams({ username, password, platform: 'linux', device_id: randomBytes(20).toString('hex'), device_name: DEVICE_NAME, client_version: '1.0', platform_version: 'web' })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (body.otp?.trim()) headers['X-SEAFILE-OTP'] = body.otp.trim()
  const res = await call(user, url, '/api2/auth-token/', { method: 'POST', headers, body: form })
  if (res.status >= 300 && res.status < 400) throw new HttpError(400, 'Seafile redirected: check the URL (https, and the sub-path if it has one)')
  if (res.headers.get('x-seafile-otp') === 'required') {
    if (body.otp?.trim()) throw new HttpError(400, 'That 2FA code did not work')
    return { otp: true }
  }
  if (!res.ok) {
    const message = await errorOf(res)
    throw new HttpError(400, res.status === 404 ? 'No Seafile there: check the URL' : res.status === 429 ? 'Seafile says too many tries: wait a minute' : message)
  }
  const token = ((await res.json().catch(() => null)) as { token?: string } | null)?.token
  if (!token) throw new HttpError(502, 'Seafile signed in but sent no token')

  const [account, server] = await Promise.all([
    call(user, url, '/api2/account-info/', { token }).then((r) => (r.ok ? (r.json() as Promise<{ name?: string; email?: string }>) : null)).catch(() => null),
    call(user, url, '/api2/server-info/').then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null)).catch(() => null),
  ])

  // Linking again (a new password, or another account): sign the old device out first.
  const old = read<Link>(user, NAME)
  if (old) await revoke(user, old)
  write(user, NAME, { url, username, token, name: account?.name || null, version: server?.version || null } satisfies Link)
  return seafileInfo(user)!
}

/** Signs this device out on Seafile (removing it from Devices), as far as Seafile lets it. */
async function revoke(user: User, link: Link) {
  await call(user, link.url, '/api2/logout-device/', { method: 'POST', token: link.token, timeout: 5000 }).catch(() => null)
}

export async function unlinkSeafile(user: User) {
  const link = read<Link>(user, NAME)
  if (link) await revoke(user, link)
  remove(user, NAME)
  remove(user, OFFICE)
}

/** The OnlyOffice document server Seafile uses: checked by loading its api.js, then stored. */
export async function setOffice(user: User, body: { url?: string; secret?: string }) {
  if (!read<Link>(user, NAME)) throw new HttpError(409, 'Link Seafile first')
  const url = normalizeUrl(body.url, 'OnlyOffice')
  const secret = body.secret?.trim()
  if (!secret) throw new HttpError(400, 'The JWT secret is required (Seafile has needed one since version 12)')
  const res = await guardedFetch(user, `${url}/web-apps/apps/api/documents/api.js`, { signal: AbortSignal.timeout(10_000) }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(400, 'OnlyOffice did not answer at that URL')
  if (!res.ok) throw new HttpError(400, `No OnlyOffice there (api.js answered ${res.status})`)
  write(user, OFFICE, { url, secret } satisfies Office)
}

export const removeOffice = (user: User) => void remove(user, OFFICE)

/** The OnlyOffice server and its JWT secret, for server/office.ts; null when not set up. */
export const officeServer = (user: User): Office | null => (read<Link>(user, NAME) ? read<Office>(user, OFFICE) : null)

// ---------------------------------------------------------------------------------------------
// The API, for the Files app

export type Library = { id: string; name: string; type: 'mine' | 'shared' | 'group' | 'public'; owner: string | null; encrypted: boolean; permission: 'r' | 'rw'; size: number; mtime: number }

function linked(user: User): Link {
  const link = read<Link>(user, NAME)
  if (!link) throw new HttpError(409, 'Seafile is not linked')
  return link
}

/** A JSON request to Seahub's API as the linked account. */
export async function seafile<T>(user: User, path: string, init: RequestInit = {}): Promise<T> {
  const link = linked(user)
  const res = await call(user, link.url, path, { ...init, token: link.token })
  if (res.ok) return JSON.parse((await readCapped(res, MAX_JSON)).toString('utf8')) as T
  const message = await errorOf(res)
  if (res.status === 401) throw new HttpError(409, 'Seafile no longer accepts the token: link it again in Settings')
  // An encrypted library that is not unlocked (or no longer: Seafile forgets after an hour).
  if (res.status === 440 || /encrypted|password/i.test(message)) throw new HttpError(423, 'Locked')
  throw new HttpError(res.status === 403 || res.status === 404 ? res.status : 502, message)
}

type ApiRepo = { repo_id: string; repo_name: string; type: string; owner_email?: string; owner_name?: string; encrypted: boolean; permission: string; size: number; last_modified: string }

export async function libraries(user: User, signal?: AbortSignal): Promise<Library[]> {
  const { repos } = await seafile<{ repos: ApiRepo[] }>(user, '/api/v2.1/repos/?type=mine&type=shared&type=group&type=public', { signal })
  for (const r of repos) encryptedRepos.set(`${user.id}:${r.repo_id}`, !!r.encrypted)
  const seen = new Set<string>()
  return repos
    .filter((r) => !seen.has(r.repo_id) && seen.add(r.repo_id))
    .map((r) => ({
      id: r.repo_id,
      name: r.repo_name,
      type: (['mine', 'shared', 'group', 'public'].includes(r.type) ? r.type : 'shared') as Library['type'],
      owner: r.owner_name || r.owner_email || null,
      encrypted: !!r.encrypted,
      permission: r.permission === 'rw' ? 'rw' : 'r',
      size: r.size ?? 0,
      mtime: Date.parse(r.last_modified) || 0,
    }))
}

// ---------------------------------------------------------------------------------------------
// Folders and files. Paths are Seafile's: absolute within the library ("/Documents/a.txt").

export const repoId = (v: unknown) => {
  const id = String(v ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Bad library id')
  return id
}

export const seafPath = (v: unknown) => {
  const p = String(v ?? '/')
  if (!p.startsWith('/') || p.split('/').some((part) => part === '..') || p.includes('\0')) throw new HttpError(400, 'Bad path')
  return p
}

export type Entry = { name: string; dir: boolean; size: number; mtime: number; id: string; locked?: boolean }
type ApiDirent = { type: 'dir' | 'file'; name: string; id: string; size?: number; mtime: number; is_locked?: boolean }

// Encrypted libraries. Seafile encrypts file contents only: their folders list fine without the
// password, and Seafile keeps an unlocked library open for an hour after the password is given.
// So the lock is kept here: an encrypted library shows nothing until it is unlocked, and only for
// as long as asked for at unlock time (at most 55 minutes, inside Seafile's hour).

const encryptedRepos = new Map<string, boolean>() // `${user}:${repo}`
const unlockedUntil = new Map<string, number>()
onUserGone((id) => {
  for (const m of [encryptedRepos, unlockedUntil]) for (const k of m.keys()) if (k.startsWith(`${id}:`)) m.delete(k)
})

async function isEncrypted(user: User, id: string, signal?: AbortSignal): Promise<boolean> {
  const key = `${user.id}:${id}`
  if (!encryptedRepos.has(key)) encryptedRepos.set(key, !!(await seafile<{ encrypted?: boolean }>(user, `/api/v2.1/repos/${id}/`, { signal })).encrypted)
  return encryptedRepos.get(key)!
}

/** Throws 423 for an encrypted library that is locked (here; Seafile may still hold it open). */
export async function guard(user: User, id: string, signal?: AbortSignal) {
  if (!(await isEncrypted(user, id, signal))) return
  if ((unlockedUntil.get(`${user.id}:${id}`) ?? 0) > Date.now()) return
  throw new HttpError(423, 'Locked')
}

/** Encrypted libraries unlocked right now, with when they lock again, for the Files app. */
export const unlocked = (user: User) =>
  Object.fromEntries(
    [...unlockedUntil]
      .filter(([k, until]) => k.startsWith(`${user.id}:`) && until > Date.now())
      .map(([k, until]) => [k.slice(k.indexOf(':') + 1), until]),
  )

export const lock = (user: User, repo: unknown) => void unlockedUntil.delete(`${user.id}:${repoId(repo)}`)

/** A folder's contents, and whether the account may change things in it. */
export async function listDir(user: User, repo: unknown, path: unknown, signal?: AbortSignal): Promise<{ perm: 'r' | 'rw'; entries: Entry[] }> {
  const id = repoId(repo)
  const p = seafPath(path)
  await guard(user, id, signal)
  const body = await seafile<{ user_perm?: string; dirent_list: ApiDirent[] }>(user, `/api/v2.1/repos/${id}/dir/?p=${encodeURIComponent(p)}`, { signal })
  return {
    perm: body.user_perm === 'rw' ? 'rw' : 'r',
    entries: body.dirent_list.map((d) => ({ name: d.name, dir: d.type === 'dir', size: d.size ?? 0, mtime: (d.mtime ?? 0) * 1000, id: d.id, ...(d.is_locked ? { locked: true } : {}) })),
  }
}

/**
 * A short-lived link on Seafile's file server, which the browser uses directly (it answers with
 * CORS headers): download (reusable for an hour), upload into a folder, or update (overwrite) a file.
 */
export async function fileLink(user: User, repo: unknown, path: unknown, op: unknown, signal?: AbortSignal): Promise<{ url: string }> {
  const id = repoId(repo)
  const p = seafPath(path)
  const q = encodeURIComponent(p)
  await guard(user, id, signal)
  if (op === 'download') return { url: await seafile<string>(user, `/api2/repos/${id}/file/?p=${q}&reuse=1`, { signal }) }
  if (op === 'upload') return { url: await seafile<string>(user, `/api2/repos/${id}/upload-link/?p=${q}`, { signal }) }
  if (op === 'update') return { url: await seafile<string>(user, `/api2/repos/${id}/update-link/?p=${q}`, { signal }) }
  throw new HttpError(400, 'Unknown link')
}

/** Unlocks an encrypted library for `minutes` (5 to 55). Answers when it locks again. */
export async function unlock(user: User, body: { repo?: string; password?: string; minutes?: number }): Promise<{ until: number }> {
  const id = repoId(body.repo)
  if (!body.password) throw new HttpError(400, 'The password is required')
  try {
    await seafile(user, `/api/v2.1/repos/${id}/set-password/`, { method: 'POST', body: new URLSearchParams({ password: body.password }) })
  } catch (e) {
    if (e instanceof HttpError && (e.status === 423 || e.status === 502)) throw new HttpError(400, 'Wrong password')
    throw e
  }
  encryptedRepos.set(`${user.id}:${id}`, true)
  const until = Date.now() + Math.min(55, Math.max(5, Number(body.minutes) || 55)) * 60_000
  unlockedUntil.set(`${user.id}:${id}`, until)
  return { until }
}

/** A new folder; Seafile picks "name (1)" when the name is taken. Answers the folder's path. */
export async function mkdir(user: User, body: { repo?: string; path?: string }): Promise<{ path: string }> {
  const id = repoId(body.repo)
  const p = seafPath(body.path)
  if (p === '/') throw new HttpError(400, 'Bad path')
  await guard(user, id)
  const res = await seafile<{ obj_name?: string; parent_dir?: string } | string>(user, `/api/v2.1/repos/${id}/dir/?p=${encodeURIComponent(p)}`, { method: 'POST', body: new URLSearchParams({ operation: 'mkdir' }) })
  const made = typeof res === 'object' && res.obj_name ? `${(res.parent_dir ?? '/').replace(/\/$/, '')}/${res.obj_name}` : p
  return { path: made }
}

// ---------------------------------------------------------------------------------------------
// Changing things

const fileName = (v: unknown) => {
  const name = String(v ?? '').trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || name.length > 255) throw new HttpError(400, 'That name will not do')
  return name
}
const names = (v: unknown) => {
  if (!Array.isArray(v) || !v.length || v.length > 1000) throw new HttpError(400, 'Nothing to do')
  return v.map(fileName)
}
const form = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields) })
const jsonBody = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/') || '/'

/** Renames a file or folder in place. Answers its new path. */
export async function rename(user: User, body: { repo?: string; path?: string; dir?: boolean; name?: string }): Promise<{ path: string }> {
  const id = repoId(body.repo)
  const p = seafPath(body.path)
  if (p === '/') throw new HttpError(400, 'Bad path')
  const name = fileName(body.name)
  await guard(user, id)
  const res = await seafile<{ obj_name?: string }>(user, `/api/v2.1/repos/${id}/${body.dir ? 'dir' : 'file'}/?p=${encodeURIComponent(p)}`, form({ operation: 'rename', newname: name }))
  return { path: `${parentOf(p) === '/' ? '' : parentOf(p)}/${res.obj_name ?? name}` }
}

/** An empty file (Office files get Seafile's blank template). Answers its path, renamed if the name was taken. */
export async function createFile(user: User, body: { repo?: string; path?: string }): Promise<{ path: string }> {
  const id = repoId(body.repo)
  const p = seafPath(body.path)
  fileName(p.split('/').pop())
  await guard(user, id)
  const res = await seafile<{ obj_name?: string; parent_dir?: string }>(user, `/api/v2.1/repos/${id}/file/?p=${encodeURIComponent(p)}`, form({ operation: 'create' }))
  const dir = res.parent_dir ?? parentOf(p)
  return { path: res.obj_name ? `${dir === '/' ? '' : dir.replace(/\/$/, '')}/${res.obj_name}` : p }
}

/** Deletes files and folders in one folder (into the library's own trash on Seafile). */
export async function removeItems(user: User, body: { repo?: string; parent?: string; names?: string[] }) {
  const id = repoId(body.repo)
  const parent = seafPath(body.parent)
  const dirents = names(body.names)
  await guard(user, id)
  await seafile(user, '/api/v2.1/repos/batch-delete-item/', jsonBody('DELETE', { repo_id: id, parent_dir: parent, dirents }))
}

/**
 * Moves or copies files and folders from one folder to another, in the same library or another
 * one. Names that are taken get " (1)" from Seafile. Between libraries Seafile works in the
 * background: this waits for it (up to two minutes) so the caller can list both folders again.
 */
export async function transfer(user: User, body: { op?: string; from?: { repo?: string; parent?: string }; names?: string[]; to?: { repo?: string; parent?: string } }) {
  const op = body.op === 'copy' ? 'copy' : body.op === 'move' ? 'move' : null
  if (!op) throw new HttpError(400, 'Move or copy?')
  const src = repoId(body.from?.repo)
  const srcParent = seafPath(body.from?.parent)
  const dst = repoId(body.to?.repo)
  const dstParent = seafPath(body.to?.parent)
  const dirents = names(body.names)
  if (src === dst) {
    if (op === 'move' && srcParent === dstParent) return
    // A folder into itself, or into a folder inside it.
    for (const n of dirents) {
      const moved = `${srcParent === '/' ? '' : srcParent}/${n}`
      if (dstParent === moved || dstParent.startsWith(moved + '/')) throw new HttpError(400, `${n} cannot go inside itself`)
    }
  }
  await guard(user, src)
  if (dst !== src) await guard(user, dst)
  const payload = { src_repo_id: src, src_parent_dir: srcParent, src_dirents: dirents, dst_repo_id: dst, dst_parent_dir: dstParent }
  if (src === dst) return void (await seafile(user, `/api/v2.1/repos/sync-batch-${op}-item/`, jsonBody('POST', payload)))
  const { task_id } = await seafile<{ task_id?: string }>(user, `/api/v2.1/repos/async-batch-${op}-item/`, jsonBody('POST', payload))
  if (!task_id) return
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700))
    const p = await seafile<{ done?: boolean; failed?: boolean; failed_reason?: string; canceled?: boolean }>(user, `/api/v2.1/query-copy-move-progress/?task_id=${encodeURIComponent(task_id)}`)
    if (p.failed) throw new HttpError(502, p.failed_reason || `Seafile could not ${op} that`)
    if (p.canceled) throw new HttpError(409, `The ${op} was canceled`)
    if (p.done) return
  }
  throw new HttpError(504, `Seafile is still busy with the ${op}; look again in a minute`)
}

/**
 * A picture's thumbnail (Seafile makes them; there are none for encrypted libraries), for Files'
 * grid and the picture viewer's sidebar. Answers the image bytes and their type.
 */
export async function thumbnail(user: User, repo: unknown, path: unknown, size: unknown): Promise<{ type: string; body: Buffer }> {
  const id = repoId(repo)
  const p = seafPath(path)
  const px = Math.min(1024, Math.max(48, Math.round(Number(size) || 256)))
  await guard(user, id)
  const link = linked(user)
  const res = await call(user, link.url, `/api2/repos/${id}/thumbnail/?p=${encodeURIComponent(p)}&size=${px}`, { token: link.token, timeout: 20_000 })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || !type.startsWith('image/')) throw new HttpError(404, 'No thumbnail')
  return { type, body: await readCapped(res, 16 * 1024 * 1024) }
}

/** The most one range read may ask for (a ZIP's table of contents is rarely more than a few MB). */
const MAX_RANGE = 32 * 1024 * 1024

/**
 * A byte range of a file, read through this server: Seafile's file server leaves its CORS headers
 * off 206 answers, so a page cannot read ranges from it directly (the ZIP viewer needs them).
 * Only single ranges, at most MAX_RANGE, so no whole file streams through here.
 */
export async function rangeRead(user: User, repo: unknown, path: unknown, range: string | undefined): Promise<{ type: string; contentRange: string; body: Buffer }> {
  const m = /^bytes=(?:(\d+)-(\d+)|-(\d+))$/.exec(range ?? '')
  if (!m) throw new HttpError(416, 'Ask for one byte range (Range: bytes=from-to or bytes=-n)')
  const span = m[3] ? Number(m[3]) : Number(m[2]) - Number(m[1]) + 1
  if (!(span > 0) || span > MAX_RANGE) throw new HttpError(416, `Ranges go up to ${MAX_RANGE / 1024 / 1024} MB`)
  const { url } = await fileLink(user, repo, path, 'download')
  const res = await guardedFetch(user, url, { headers: { Range: range! }, signal: AbortSignal.timeout(60_000) }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, 'Seafile\'s file server did not answer')
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(res.status === 416 ? 416 : 502, `Seafile's file server answered ${res.status} to a range`)
  }
  return { type: res.headers.get('content-type') ?? 'application/octet-stream', contentRange: res.headers.get('content-range') ?? '', body: await readCapped(res, span) }
}

/** What /api/seafile/stream answers: the status, its headers and the body to pipe (none for a 416). */
export type Stream = { status: 200 | 206 | 416; type: string; length: string | null; contentRange: string | null; body: ReadableStream<Uint8Array> | null }

/**
 * A file streamed through this server, for the music player and the video player: the browser
 * asks for open ranges while it plays (and for new ones when it seeks), and the page's audio
 * graph (the spectrum, the equalizer) only hears media from its own origin. The answer is piped,
 * never held in memory. `signal` is the browser's connection: when it goes, so does the request
 * to Seafile.
 *
 * Seafile's file server ignores Range for encrypted libraries (it decrypts block by block and
 * always answers 200 with the whole file: see `!repo.IsEncrypted && len(byteRanges) != 0` in
 * seafile-server's fileserver/fileop.go). A browser that gets no 206 cannot seek, and snaps back
 * to the start. So then the range is cut out here: the bytes before it are read and dropped,
 * the ones in it piped, and the rest not asked for. Seeking far into a big encrypted file
 * therefore reads everything before that point through this server, each time.
 */
export async function streamFile(user: User, repo: unknown, path: unknown, range: string | undefined, signal?: AbortSignal): Promise<Stream> {
  const m = range === undefined ? null : /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(range)
  if (range !== undefined && !m) throw new HttpError(416, 'Ask for one byte range')
  const { url } = await fileLink(user, repo, path, 'download')
  const res = await guardedFetch(user, url, { headers: range ? { Range: range } : {}, signal }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, 'Seafile\'s file server did not answer')
  const type = res.headers.get('content-type') ?? ''
  const unsatisfiable = (contentRange: string | null): Stream => ({ status: 416, type, length: null, contentRange, body: null })
  if (res.status === 416) {
    await res.body?.cancel().catch(() => {})
    return unsatisfiable(res.headers.get('content-range'))
  }
  if (res.status !== 200 && res.status !== 206) {
    const text = (await readCapped(res, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8')
    // Seafile forgot the library's password (after its hour) before this side's lock did.
    if (/encrypted|password/i.test(text)) throw new HttpError(423, 'Locked')
    throw new HttpError(502, `Seafile's file server answered ${res.status}`)
  }
  const passed = (): Stream => ({ status: res.status as 200 | 206, type, length: res.headers.get('content-length'), contentRange: res.headers.get('content-range'), body: res.body })
  // No range asked for, or Seafile honoured it: as it is.
  if (!m || res.status === 206) return passed()

  // Seafile sends the size along (fileop.go's doFile); should a proxy drop it, its listing knows it.
  let total = Number(res.headers.get('content-length') ?? NaN)
  if (!Number.isSafeInteger(total) || total < 0) total = await fileSize(user, repo, path).catch(() => NaN)
  if (!Number.isSafeInteger(total) || total < 0) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(502, 'Seafile did not say how big the file is')
  }
  const [, from, to, suffix] = m
  const start = suffix !== undefined ? Math.max(0, total - Number(suffix)) : Number(from)
  const end = suffix !== undefined ? total - 1 : to ? Math.min(Number(to), total - 1) : total - 1
  if (start >= total || end < start || (suffix !== undefined && Number(suffix) === 0)) {
    await res.body?.cancel().catch(() => {})
    return unsatisfiable(`bytes */${total}`)
  }
  return { status: 206, type, length: String(end - start + 1), contentRange: `bytes ${start}-${end}/${total}`, body: res.body && slice(res.body, start, end) }
}

/** A file's size from Seafile's API (for when the file server's answer has no Content-Length). */
async function fileSize(user: User, repo: unknown, path: unknown): Promise<number> {
  const id = repoId(repo)
  const p = seafPath(path)
  const detail = await seafile<{ size?: number }>(user, `/api/v2.1/repos/${id}/file/detail/?p=${encodeURIComponent(p)}`)
  return Number(detail.size)
}

/**
 * Bytes `start` to `end` (inclusive) of a whole file's stream: what comes before is dropped, and
 * once the range is out the rest is cancelled, which closes the connection to Seafile.
 */
function slice(body: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let pos = 0 // bytes of the whole file read so far
  return new ReadableStream<Uint8Array>({
    async pull(out) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return out.error(new Error('The file ended before the range did'))
        const at = pos
        pos += value.length
        if (pos <= start) continue
        out.enqueue(value.subarray(Math.max(0, start - at), Math.min(value.length, end + 1 - at)))
        if (pos > end) {
          out.close()
          await reader.cancel().catch(() => {})
        }
        return
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

/** How much of a file a resumable upload has stored so far, to carry on from there. */
export async function uploadedBytes(user: User, repo: unknown, parent: unknown, name: unknown): Promise<{ bytes: number }> {
  const id = repoId(repo)
  const dir = seafPath(parent)
  const file = fileName(name)
  await guard(user, id)
  const res = await seafile<{ uploadedBytes?: number }>(user, `/api/v2.1/repos/${id}/file-uploaded-bytes/?parent_dir=${encodeURIComponent(dir)}&file_name=${encodeURIComponent(file)}`).catch((e) => {
    if (e instanceof HttpError && e.status === 404) return { uploadedBytes: 0 }
    throw e
  })
  return { bytes: Number(res.uploadedBytes) || 0 }
}

// ---------------------------------------------------------------------------------------------
// A library's trash: what was deleted (Seafile keeps it in the library's history), restoring,
// what was in a deleted folder, and emptying it of what is older than so many days.

export type TrashItem = { name: string; parent: string; dir: boolean; size: number; deleted: number; commit: string }
type ApiTrash = { parent_dir: string; obj_name: string; deleted_time: string; commit_id: string; is_dir: boolean; size: number | '' }

const commitId = (v: unknown) => {
  const c = String(v ?? '')
  if (!/^[0-9a-f]{40}$/.test(c)) throw new HttpError(400, 'Bad commit')
  return c
}

/** What was deleted in a library (or a folder of it), newest first; `more` pages on with `scan`. */
export async function trash(user: User, repo: unknown, path: unknown, scan: unknown): Promise<{ items: TrashItem[]; more: boolean; scan: string | null }> {
  const id = repoId(repo)
  const p = seafPath(path ?? '/')
  await guard(user, id)
  const q = new URLSearchParams({ path: p, show_days: '0' })
  if (typeof scan === 'string' && scan) q.set('scan_stat', scan)
  const body = await seafile<{ data: ApiTrash[]; more: boolean; scan_stat: string | null }>(user, `/api/v2.1/repos/${id}/trash/?${q}`)
  return {
    items: body.data.map((t) => ({ name: t.obj_name, parent: t.parent_dir, dir: t.is_dir, size: Number(t.size) || 0, deleted: Date.parse(t.deleted_time) || 0, commit: t.commit_id })),
    more: !!body.more,
    scan: body.scan_stat ?? null,
  }
}

/** Puts deleted files and folders back where they were (all from one deletion, by its commit). */
export async function restore(user: User, body: { repo?: string; commit?: string; paths?: string[] }): Promise<{ restored: string[]; failed: { path: string; error: string }[] }> {
  const id = repoId(body.repo)
  const commit = commitId(body.commit)
  if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 500) throw new HttpError(400, 'Nothing to restore')
  const paths = body.paths.map(seafPath)
  await guard(user, id)
  const form = new URLSearchParams({ commit_id: commit })
  for (const p of paths) form.append('path', p)
  const res = await seafile<{ success: { path: string }[]; failed: { path: string; error_msg?: string }[] }>(user, `/api/v2.1/repos/${id}/trash/revert-dirents/`, { method: 'POST', body: form })
  return { restored: res.success.map((s) => s.path), failed: res.failed.map((f) => ({ path: f.path, error: f.error_msg ?? 'Could not restore it' })) }
}

/** What was in a deleted folder, as it was when it went. */
export async function trashDir(user: User, repo: unknown, commit: unknown, path: unknown): Promise<Entry[]> {
  const id = repoId(repo)
  const c = commitId(commit)
  const p = seafPath(path)
  await guard(user, id)
  const body = await seafile<{ dirent_list: { type: string; name: string; size?: number }[] }>(user, `/api/v2.1/repos/${id}/commits/${c}/dir/?path=${encodeURIComponent(p)}`)
  return body.dirent_list.map((d) => ({ name: d.name, dir: d.type === 'dir', size: d.size ?? 0, mtime: 0, id: '' }))
}

/** Empties the trash of what was deleted more than `days` ago (0: all of it). For good. */
export async function cleanTrash(user: User, body: { repo?: string; days?: number }) {
  const id = repoId(body.repo)
  const days = Math.max(0, Math.min(3650, Math.round(Number(body.days) || 0)))
  await guard(user, id)
  await seafile(user, `/api/v2.1/repos/${id}/trash/`, { method: 'DELETE', body: new URLSearchParams({ keep_days: String(days) }) })
}

/**
 * How long a library keeps its history, which is also how long deleted things stay in its trash:
 * days, -1 for ever, 0 for not at all (then a delete is for good). Only its owner can see or change it.
 */
/** The account's storage: what its own libraries take, and its quota (null: no quota, which
 * Seafile sends as a negative number). */
export async function quota(user: User): Promise<{ used: number; total: number | null }> {
  const info = await seafile<{ usage?: number; total?: number }>(user, '/api2/account/info/')
  const total = Number(info.total)
  return { used: Number(info.usage) || 0, total: Number.isFinite(total) && total >= 0 ? total : null }
}

export async function history(user: User, repo: unknown): Promise<{ days: number }> {
  const id = repoId(repo)
  const res = await seafile<{ keep_days: number }>(user, `/api2/repos/${id}/history-limit/`)
  return { days: Number(res.keep_days) }
}

export async function setHistory(user: User, body: { repo?: string; days?: number }): Promise<{ days: number }> {
  const id = repoId(body.repo)
  const days = Math.round(Number(body.days))
  if (!Number.isFinite(days) || days < -1 || days > 36500) throw new HttpError(400, 'Bad number of days')
  const res = await seafile<{ keep_days: number }>(user, `/api2/repos/${id}/history-limit/`, { method: 'PUT', body: new URLSearchParams({ keep_days: String(days) }) })
  return { days: Number(res.keep_days ?? days) }
}

/** A share link for a file or folder: the one it already has, or a new one (no password, no expiry). */
export async function shareLink(user: User, body: { repo?: string; path?: string }): Promise<{ url: string; made: boolean }> {
  const id = repoId(body.repo)
  const p = seafPath(body.path)
  await guard(user, id)
  const existing = await seafile<{ link: string; path: string }[]>(user, `/api/v2.1/share-links/?repo_id=${id}&path=${encodeURIComponent(p)}`).catch(() => [])
  const same = existing.find((l) => l.path.replace(/\/$/, '') === p.replace(/\/$/, ''))
  if (same) return { url: same.link, made: false }
  const made = await seafile<{ link: string }>(user, '/api/v2.1/share-links/', jsonBody('POST', { repo_id: id, path: p }))
  return { url: made.link, made: true }
}
