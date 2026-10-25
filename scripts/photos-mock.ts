// Stand-ins for Seafile and Immich, for the Photos app: scripts/photos-check.ts starts them on
// free ports, and running this file starts both with a big made-up library for trying the app
// in a browser (Seafile on 8810, Immich on 8815, or the ports given):
//
//   node scripts/photos-mock.ts [count] [seafile port] [immich port]
//
// Seafile: libraries, folder listings (with folder ids that change when anything inside does,
// as Seafile's do), download links, a file server that honours Range in plain libraries and
// ignores it in encrypted ones (as Seafile's does), set-password, and thumbnails (a PNG in a
// colour of the file's own; none in encrypted libraries), deleting into a library's trash, its
// trash listing and restoring from it, moving and copying, and read-only libraries. Immich: the server version, the
// account, timeline buckets and their assets (in Immich 2's or 3's format), an asset's details,
// thumbnails, originals and video with Range, albums and favourites, its trash (and restoring
// from it), adding to albums, and assets that belong to someone else, all behind its x-api-key.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { deflateSync } from 'node:zlib'

export const FIXTURES = new URL('./fixtures/photos/', import.meta.url)
export const fixture = (name: string) => readFileSync(new URL(name, FIXTURES))

// --- Pictures -------------------------------------------------------------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A PNG of `size` square, a soft gradient in a colour of `seed`'s own, with a darker sun in it. */
export function png(seed: string, size: number): Buffer {
  const h = createHash('sha1').update(seed).digest()
  const hue = (h[0] / 255) * 360
  const rgb = (l: number) => {
    const s = 0.55
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
    const m = l - c / 2
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
  }
  const cx = size * (0.25 + (h[1] / 255) * 0.5)
  const cy = size * (0.25 + (h[2] / 255) * 0.3)
  const rad = size * 0.12
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3)
    const sky = rgb(0.75 - (y / size) * 0.4)
    const sun = rgb(0.92)
    for (let x = 0; x < size; x++) {
      const inSun = (x - cx) ** 2 + (y - cy) ** 2 < rad * rad
      const ground = y > size * (0.7 + 0.08 * Math.sin((x / size) * 6 + h[3]))
      const [r, g, b] = inSun ? sun : ground ? rgb(0.3) : sky
      row[1 + x * 3] = r
      row[2 + x * 3] = g
      row[3 + x * 3] = b
    }
    rows.push(row)
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(size, 0)
  head.writeUInt32BE(size, 4)
  head[8] = 8
  head[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

/** canon.jpg with another capture time ("YYYY:MM:DD HH:MM:SS"), for libraries of many photos. */
export function jpegTaken(when: Date): Buffer {
  const buf = Buffer.from(fixture('canon.jpg'))
  const stamp = when.toISOString().slice(0, 19).replace(/-/g, ':').replace('T', ' ')
  for (const old of ['2023:07:14 18:32:05', '2023:07:15 09:00:00']) {
    const at = buf.indexOf(old, 0, 'latin1')
    if (at >= 0) buf.write(stamp, at, 'latin1')
  }
  return buf
}

// --- Seafile ----------------------------------------------------------------------------------------

export type SfFile = { bytes: Buffer; mtime: number }
export type SfLib = { id: string; name: string; encrypted: boolean; files: Map<string, SfFile>; dirs?: Set<string>; /** Read-only for the account ('r'), as a library shared for viewing is */ perm?: 'r' | 'rw'; /** What was deleted, newest last */ trash?: { path: string; file: SfFile; deleted: number; commit: string }[] }
export type SeafileMock = {
  base: string
  server: Server
  libs: SfLib[]
  /** Every request, for the checks to count */
  log: { method: string; path: string; range: string | null; token: string | null }[]
  /** Bytes the file server sent per file path */
  sent: Map<string, number>
  /** Answer the library listing (and each library's details) with 503 */
  down: boolean
  close: () => void
}

const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex')

export async function seafileMock(libs: SfLib[], port = 0): Promise<SeafileMock> {
  const log: SeafileMock['log'] = []
  const sent = new Map<string, number>()
  const unlockedRepos = new Set<string>()
  const lib = (id: string) => libs.find((l) => l.id === id)

  /** A folder's entries, with Seafile-like ids: a file's is its content's hash, a folder's its contents'. */
  function list(l: SfLib, dir: string) {
    const prefix = dir === '/' ? '/' : `${dir}/`
    const names = new Map<string, { dir: boolean; file?: SfFile }>()
    for (const [p, f] of l.files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const i = rest.indexOf('/')
      if (i < 0) names.set(rest, { dir: false, file: f })
      else names.set(rest.slice(0, i), { dir: true })
    }
    for (const d of l.dirs ?? []) if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/') && d.length > prefix.length) names.set(d.slice(prefix.length), { dir: true })
    return [...names].map(([name, e]) =>
      e.dir
        ? { type: 'dir', name, id: dirId(l, `${prefix}${name}`), mtime: 0 }
        : { type: 'file', name, id: sha1(e.file!.bytes), size: e.file!.bytes.length, mtime: Math.floor(e.file!.mtime / 1000) },
    )
  }
  const dirId = (l: SfLib, dir: string): string => sha1(JSON.stringify(list(l, dir)))

  let commits = 0
  const out: SeafileMock = {
    base: '',
    server: null as unknown as Server,
    libs,
    log,
    sent,
    down: false,
    close: () => {
      out.server.closeAllConnections()
      out.server.close()
    },
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const pieces: Buffer[] = []
    for await (const c of req) pieces.push(c as Buffer)
    const bytes = Buffer.concat(pieces)
    const raw = bytes.toString('utf8')
    const body = () => JSON.parse(raw || '{}')
    const form = () => new URLSearchParams(raw)
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
    log.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, range: typeof req.headers.range === 'string' ? req.headers.range : null, token: auth })
    const json = (status: number, body: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (path.startsWith('/api') && auth !== 'Token stand-in-token') return json(401, { detail: 'Invalid token' })

    if (out.down && /^\/api\/v2\.1\/repos\//.test(path) && !path.includes('/set-password/')) return json(503, { detail: 'down' })
    if (path === '/api/v2.1/repos/') {
      return json(200, { repos: libs.map((l) => ({ repo_id: l.id, repo_name: l.name, type: 'mine', owner_email: 'me@example.com', encrypted: l.encrypted, permission: l.perm ?? 'rw', size: 0, last_modified: new Date().toISOString() })) })
    }
    let m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/$/.exec(path)
    if (m && lib(m[1])) return json(200, { repo_id: m[1], encrypted: lib(m[1])!.encrypted })
    m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/set-password\/$/.exec(path)
    if (m && req.method === 'POST') {
      unlockedRepos.add(m[1])
      return json(200, { success: true })
    }
    m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/dir\/$/.exec(path)
    if (m && lib(m[1])) {
      const p = url.searchParams.get('p') ?? '/'
      return json(200, { user_perm: lib(m[1])!.perm ?? 'rw', dirent_list: list(lib(m[1])!, p.replace(/(.)\/$/, '$1')) })
    }
    // Deleting goes into the library's trash, each call one commit; restoring puts files back from it.
    if (path === '/api/v2.1/repos/batch-delete-item/' && req.method === 'DELETE') {
      const b = body() as { repo_id: string; parent_dir: string; dirents: string[] }
      const l = lib(b.repo_id)
      if (!l) return json(404, { error_msg: 'Library not found' })
      if (l.perm === 'r') return json(403, { error_msg: 'Permission denied.' })
      const commit = sha1(`commit ${++commits}`)
      for (const n of b.dirents) {
        const p = `${b.parent_dir === '/' ? '' : b.parent_dir}/${n}`
        const f = l.files.get(p)
        if (!f) continue
        ;(l.trash ??= []).push({ path: p, file: f, deleted: Date.now(), commit })
        l.files.delete(p)
      }
      return json(200, { success: true })
    }
    m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/trash\/$/.exec(path)
    if (m && lib(m[1]) && req.method === 'GET') {
      const p = url.searchParams.get('path') ?? '/'
      const list = [...(lib(m[1])!.trash ?? [])].reverse().filter((t) => p === '/' || t.path.startsWith(`${p}/`))
      return json(200, { data: list.map((t) => ({ obj_name: t.path.split('/').pop(), parent_dir: `${t.path.split('/').slice(0, -1).join('/')}/`, is_dir: false, size: t.file.bytes.length, deleted_time: new Date(t.deleted).toISOString(), commit_id: t.commit })), more: false, scan_stat: null })
    }
    m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/trash\/revert-dirents\/$/.exec(path)
    if (m && lib(m[1]) && req.method === 'POST') {
      const l = lib(m[1])!
      const f = form()
      const success: { path: string }[] = []
      const failed: { path: string; error_msg: string }[] = []
      for (const p of f.getAll('path')) {
        const at = (l.trash ?? []).findIndex((t) => t.path === p && t.commit === f.get('commit_id'))
        if (at < 0 || l.files.has(p)) {
          failed.push({ path: p, error_msg: 'Not in the trash' })
          continue
        }
        l.files.set(p, l.trash![at].file)
        l.trash!.splice(at, 1)
        success.push({ path: p })
      }
      return json(200, { success, failed })
    }
    if (path === '/api/v2.1/query-copy-move-progress/') return json(200, { done: true, failed: false, canceled: false })
    m = /^\/api\/v2\.1\/repos\/(sync|async)-batch-(move|copy)-item\/$/.exec(path)
    if (m && req.method === 'POST') {
      const b = body() as { src_repo_id: string; src_parent_dir: string; src_dirents: string[]; dst_repo_id: string; dst_parent_dir: string }
      const from = lib(b.src_repo_id)
      const to = lib(b.dst_repo_id)
      if (!from || !to) return json(404, { error_msg: 'Library not found' })
      if (from.perm === 'r' || to.perm === 'r') return json(403, { error_msg: 'Permission denied.' })
      for (const n of b.src_dirents) {
        const p = `${b.src_parent_dir === '/' ? '' : b.src_parent_dir}/${n}`
        const f = from.files.get(p)
        if (!f) continue
        if (m[2] === 'move') from.files.delete(p)
        to.files.set(`${b.dst_parent_dir === '/' ? '' : b.dst_parent_dir}/${n}`, m[2] === 'move' ? f : { ...f })
      }
      return json(200, m[1] === 'async' ? { task_id: `task-${Date.now()}` } : { success: true })
    }
    // Uploads (a drop of Immich photos on Files, say): a link, then a multipart POST to it.
    m = /^\/api2\/repos\/([0-9a-f-]{36})\/upload-link\/$/.exec(path)
    if (m && lib(m[1])) return json(200, `${out.base}/upload-api/${m[1]}`)
    m = /^\/upload-api\/([0-9a-f-]{36})$/.exec(path)
    // The browser posts there itself, from the site's origin (as to Seafile's file server).
    if (m) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', '*')
    }
    if (m && req.method === 'OPTIONS') return void res.writeHead(204).end()
    if (m && lib(m[1]) && req.method === 'POST') {
      const parts = await new Request('http://x', { method: 'POST', headers: { 'content-type': String(req.headers['content-type']) }, body: bytes }).formData()
      const f = parts.get('file') as File | null
      if (!f) return json(400, { error: 'no file' })
      const dir = String(parts.get('parent_dir') ?? '/')
      lib(m[1])!.files.set(`${dir === '/' ? '' : dir.replace(/\/$/, '')}/${f.name}`, { bytes: Buffer.from(await f.arrayBuffer()), mtime: Date.now() })
      return json(200, [{ name: f.name, size: f.size }])
    }
    m = /^\/api2\/repos\/([0-9a-f-]{36})\/file\/$/.exec(path)
    if (m && lib(m[1])) {
      const l = lib(m[1])!
      if (l.encrypted && !unlockedRepos.has(l.id)) return json(400, { error_msg: 'Library is encrypted.' })
      return json(200, `${out.base}/files/${m[1]}${encodeURI(url.searchParams.get('p') ?? '')}`)
    }
    m = /^\/api2\/repos\/([0-9a-f-]{36})\/thumbnail\/$/.exec(path)
    if (m && lib(m[1])) {
      const l = lib(m[1])!
      const p = url.searchParams.get('p') ?? ''
      // Seafile makes no thumbnails in encrypted libraries, nor (by default) of videos.
      if (l.encrypted || !l.files.has(p) || /\.(mp4|mov)$/i.test(p)) return json(400, { error_msg: 'Failed to create thumbnail.' })
      const size = Math.min(1024, Number(url.searchParams.get('size')) || 256)
      return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(png(p, Math.min(size, 512)))
    }
    m = /^\/files\/([0-9a-f-]{36})(\/.*)$/.exec(path)
    if (m && lib(m[1])) {
      const l = lib(m[1])!
      const p = decodeURI(m[2])
      const f = l.files.get(p)
      if (!f) return void res.writeHead(404).end()
      const size = f.bytes.length
      let start = 0
      let end = size - 1
      let status = 200
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' }
      const r = req.headers.range && !l.encrypted ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null
      if (r) {
        start = Number(r[1])
        end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1
        if (start >= size) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
        status = 206
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      }
      headers['Content-Length'] = String(end - start + 1)
      res.writeHead(status, headers)
      // Sent in pieces, so a reader that stops early really does save the rest.
      let at = start
      const pump = () => {
        while (at <= end && !res.destroyed) {
          const n = Math.min(16 * 1024, end + 1 - at)
          sent.set(p, (sent.get(p) ?? 0) + n)
          const piece = f.bytes.subarray(at, at + n)
          at += n
          if (at > end) return void res.end(piece)
          if (!res.write(piece)) return void res.once('drain', pump)
        }
      }
      res.on('close', () => (at = end + 1))
      pump()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  out.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  out.server = server
  return out
}

// --- Immich ---------------------------------------------------------------------------------------------

export type ImAsset = { id: string; name: string; video: boolean; taken: string; offsetHours: number; favourite: boolean; ratio: number; albums: string[]; bytes: Buffer; /** Someone else's (a partner's, or in a shared album): the account's own when left out */ owner?: string; trashed?: boolean }
export type ImmichMock = {
  base: string
  server: Server
  assets: ImAsset[]
  version: { major: number; minor: number; patch: number }
  key: string
  log: { method: string; path: string; key: string | null; body: string }[]
  close: () => void
}

/** The account's own id in the Immich stand-in. */
export const ME = 'eeeeeeee-0000-4000-8000-000000000001'

export async function immichMock(assets: ImAsset[], opts: { key: string; version?: { major: number; minor: number; patch: number }; albums?: { id: string; name: string }[]; port?: number }): Promise<ImmichMock> {
  const mock = { assets, version: opts.version ?? { major: 3, minor: 3, patch: 1 }, key: opts.key, log: [] as ImmichMock['log'] }
  const albums = opts.albums ?? []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const key = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null
    let body = ''
    for await (const c of req) body += c
    mock.log.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, key, body })
    const json = (status: number, b: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(b))
    if (path === '/api/server/version') return json(200, { ...mock.version, prerelease: 0 })
    if (!path.startsWith('/api/')) return void res.writeHead(404).end()
    if (key !== mock.key) return json(401, { message: 'Invalid API key', error: 'Unauthorized', statusCode: 401 })
    if (path === '/api/users/me') return json(200, { id: ME, name: 'Check Person', email: 'check@example.com' })
    if (path === '/api/server/config') return json(200, { trashDays: 30, userDeleteDelay: 7 })
    // The trash: DELETE /api/assets ({ ids, force }) and POST /api/trash/restore/assets ({ ids }).
    if (path === '/api/assets' && req.method === 'DELETE') {
      const b = JSON.parse(body || '{}') as { ids?: string[]; force?: boolean }
      const list = (b.ids ?? []).map((id) => assets.find((a) => a.id === id))
      if (list.some((a) => !a || (a.owner ?? ME) !== ME)) return json(400, { message: 'Not found or no asset.delete access', error: 'Bad Request', statusCode: 400 })
      if (b.force) {
        for (const a of list) assets.splice(assets.indexOf(a!), 1)
      } else for (const a of list) a!.trashed = true
      return void res.writeHead(204).end()
    }
    if (path === '/api/trash/restore/assets' && req.method === 'POST') {
      const b = JSON.parse(body || '{}') as { ids?: string[] }
      let count = 0
      for (const a of assets) if (b.ids?.includes(a.id) && a.trashed && (a.owner ?? ME) === ME) (a.trashed = false), count++
      return json(200, { count })
    }
    if (path === '/api/assets' && req.method === 'PUT') {
      const b = JSON.parse(body || '{}') as { ids?: string[]; isFavorite?: boolean }
      for (const a of assets) if (b.ids?.includes(a.id) && typeof b.isFavorite === 'boolean') a.favourite = b.isFavorite
      return void res.writeHead(204).end()
    }
    const albumAdd = /^\/api\/albums\/([0-9a-f-]{36})\/assets$/.exec(path)
    if (albumAdd && req.method === 'PUT') {
      if (!albums.some((al) => al.id === albumAdd[1])) return json(404, { message: 'Not found' })
      const b = JSON.parse(body || '{}') as { ids?: string[] }
      return json(200, (b.ids ?? []).map((id) => {
        const a = assets.find((x) => x.id === id)
        if (!a) return { id, success: false, error: 'not_found' }
        if (a.albums.includes(albumAdd[1])) return { id, success: false, error: 'duplicate' }
        a.albums.push(albumAdd[1])
        return { id, success: true }
      }))
    }

    const q = url.searchParams
    const v3 = mock.version.major >= 3
    const filtered = assets.filter((a) => !a.trashed && (!q.get('albumId') || a.albums.includes(q.get('albumId')!)) && (q.get('isFavorite') !== 'true' || a.favourite))
    /** The month a photo's bucket is (by its UTC time, as Immich groups). */
    const bucketOf = (a: ImAsset) => (v3 ? `${a.taken.slice(0, 7)}-01T00:00:00.000Z` : `${a.taken.slice(0, 7)}-01`)
    if (path === '/api/timeline/buckets') {
      const counts = new Map<string, number>()
      for (const a of filtered) counts.set(bucketOf(a), (counts.get(bucketOf(a)) ?? 0) + 1)
      return json(200, [...counts].sort((a, b) => b[0].localeCompare(a[0])).map(([timeBucket, count]) => ({ timeBucket, count })))
    }
    if (path === '/api/timeline/bucket') {
      const list = filtered.filter((a) => bucketOf(a) === q.get('timeBucket'))
      const ms = (a: ImAsset) => (a.video ? 12_000 : null)
      return json(200, {
        id: list.map((a) => a.id),
        fileCreatedAt: list.map((a) => (v3 ? a.taken : a.taken.replace(/Z$/, ''))),
        localOffsetHours: list.map((a) => a.offsetHours),
        isImage: list.map((a) => !a.video),
        isFavorite: list.map((a) => a.favourite),
        isTrashed: list.map(() => false),
        ratio: list.map((a) => a.ratio),
        duration: list.map((a) => (v3 ? ms(a) : a.video ? '0:00:12.000000' : null)),
        ownerId: list.map(() => 'u1'),
        thumbhash: list.map(() => null),
        city: list.map(() => null),
        country: list.map(() => null),
        livePhotoVideoId: list.map(() => null),
        projectionType: list.map(() => null),
        visibility: list.map(() => 'timeline'),
        createdAt: list.map((a) => a.taken),
      })
    }
    if (path === '/api/albums') return json(200, albums.map((al) => ({ id: al.id, albumName: al.name, assetCount: assets.filter((a) => a.albums.includes(al.id)).length, albumThumbnailAssetId: assets.find((a) => a.albums.includes(al.id))?.id ?? null, shared: false })))
    const m = /^\/api\/assets\/([0-9a-f-]{36})(\/thumbnail|\/original|\/video\/playback)?$/.exec(path)
    const a = m && assets.find((x) => x.id === m[1])
    if (!m || !a) return json(404, { message: 'Not found' })
    if (!m[2] && req.method === 'PUT') {
      const change = JSON.parse(body || '{}') as { isFavorite?: boolean }
      if (typeof change.isFavorite === 'boolean') a.favourite = change.isFavorite
      return json(200, { id: a.id, isFavorite: a.favourite })
    }
    if (!m[2]) {
      const local = new Date(Date.parse(a.taken) + a.offsetHours * 3600_000).toISOString()
      return json(200, {
        id: a.id,
        ownerId: a.owner ?? ME,
        type: a.video ? 'VIDEO' : 'IMAGE',
        originalFileName: a.name,
        fileCreatedAt: a.taken,
        localDateTime: local,
        isFavorite: a.favourite,
        duration: a.video ? (v3 ? 12_000 : '0:00:12.000000') : v3 ? null : '0:00:00.00000',
        exifInfo: { make: 'FUJIFILM', model: 'X100V', lensModel: null, exposureTime: '1/500', fNumber: 5.6, iso: 160, focalLength: 23, exifImageWidth: 6240, exifImageHeight: 4160, orientation: '1', latitude: 48.8584, longitude: 2.2945, city: 'Paris', state: 'Île-de-France', country: 'France', fileSizeInByte: a.bytes.length, timeZone: 'Europe/Paris' },
      })
    }
    if (m[2] === '/thumbnail') {
      const size = q.get('size') === 'preview' ? 512 : 160
      return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(png(a.id, size))
    }
    // The original and the video, with one byte range at most.
    const bytes = a.bytes
    const r = typeof req.headers.range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null
    const type = a.video ? 'video/mp4' : 'image/jpeg'
    const disposition = { 'Content-Disposition': `attachment; filename="${a.name}"` }
    if (!r) return void res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(bytes.length), ...disposition }).end(bytes)
    const start = Number(r[1])
    const end = r[2] ? Math.min(Number(r[2]), bytes.length - 1) : bytes.length - 1
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1), ...disposition }).end(bytes.subarray(start, end + 1))
  })
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r))
  return Object.assign(mock, {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    server,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  })
}

// --- A big library, for the browser ---------------------------------------------------------------------

const id = (n: number, k: number) => `${k.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Number(process.argv[2]) || 5000
  // Photos every few hours, back from now, in bursts (days out, then many in one day).
  const files = new Map<string, SfFile>()
  let t = Date.UTC(2026, 9, 10, 18, 0, 0)
  for (let i = 0; i < count; i++) {
    t -= (i % 7 === 0 ? 2.5 * 86400_000 : 37 * 60_000) * (1 + (i % 3))
    const when = new Date(t)
    const year = when.getUTCFullYear()
    const name = `IMG_${String(i).padStart(5, '0')}.jpg`
    files.set(`/Camera Uploads/${year}/${name}`, { bytes: jpegTaken(when), mtime: t })
  }
  files.set('/Camera Uploads/clip.mp4', { bytes: fixture('clip.mp4'), mtime: Date.UTC(2022, 4, 1) })
  files.set('/Camera Uploads/iphone-be.jpg', { bytes: fixture('iphone-be.jpg'), mtime: Date.UTC(2022, 0, 1) })
  const sf = await seafileMock(
    [
      { id: id(1, 1), name: 'My Library', encrypted: false, files, dirs: new Set(['/Documents']) },
      { id: id(2, 2), name: 'Vault', encrypted: true, files: new Map([['/Photos/vault.jpg', { bytes: fixture('vault.jpg'), mtime: Date.UTC(2023, 6, 14) }]]) },
    ],
    Number(process.argv[3]) || 8810,
  )
  const assets: ImAsset[] = []
  let u = Date.UTC(2026, 9, 1, 12)
  for (let i = 0; i < Math.min(count, 3000); i++) {
    u -= (i % 5 === 0 ? 3 * 86400_000 : 52 * 60_000) * (1 + (i % 2))
    assets.push({ id: id(i, 3), name: `DSCF${String(i).padStart(4, '0')}.JPG`, video: i % 23 === 0, taken: new Date(u).toISOString(), offsetHours: 2, favourite: i % 17 === 0, ratio: i % 4 === 0 ? 0.667 : 1.5, albums: i % 9 === 0 ? [id(1, 9)] : [], bytes: i % 23 === 0 ? fixture('clip.mp4') : jpegTaken(new Date(u)) })
  }
  const im = await immichMock(assets, { key: 'mock-immich-key-0123456789', albums: [{ id: id(1, 9), name: 'Paris' }], port: Number(process.argv[4]) || 8815 })
  console.log(`Seafile stand-in on ${sf.base} (token "stand-in-token"), ${count} photos in My Library/Camera Uploads; Vault is encrypted (any password)`)
  console.log(`Immich stand-in on ${im.base}, API key "${im.key}", ${assets.length} assets`)
}
