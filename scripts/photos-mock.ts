// Stand-ins for Seafile and Immich, for the Photos app: scripts/photos-check.ts starts them on
// free ports, and running this file starts both with a big made-up library for trying the app
// in a browser (Seafile on 8810, Immich on 8815, or the ports given):
//
//   node scripts/photos-mock.ts [count] [seafile port] [immich port]
//
// Seafile: libraries, folder listings (with folder ids that change when anything inside does,
// as Seafile's do), download links, a file server that honours Range in plain libraries and
// ignores it in encrypted ones (as Seafile's does), set-password, and thumbnails (a PNG in a
// colour of the file's own; none in encrypted libraries). Immich: the server version, the
// account, timeline buckets and their assets (in Immich 2's or 3's format), an asset's details,
// thumbnails, originals and video with Range, albums and favourites, all behind its x-api-key.

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
export type SfLib = { id: string; name: string; encrypted: boolean; files: Map<string, SfFile>; dirs?: Set<string> }
export type SeafileMock = {
  base: string
  server: Server
  libs: SfLib[]
  /** Every request, for the checks to count */
  log: { method: string; path: string; range: string | null; token: string | null }[]
  /** Bytes the file server sent per file path */
  sent: Map<string, number>
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

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
    log.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, range: typeof req.headers.range === 'string' ? req.headers.range : null, token: auth })
    const json = (status: number, body: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (path.startsWith('/api') && auth !== 'Token stand-in-token') return json(401, { detail: 'Invalid token' })

    if (path === '/api/v2.1/repos/') {
      return json(200, { repos: libs.map((l) => ({ repo_id: l.id, repo_name: l.name, type: 'mine', owner_email: 'me@example.com', encrypted: l.encrypted, permission: 'rw', size: 0, last_modified: new Date().toISOString() })) })
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
      return json(200, { user_perm: 'rw', dirent_list: list(lib(m[1])!, p.replace(/(.)\/$/, '$1')) })
    }
    m = /^\/api2\/repos\/([0-9a-f-]{36})\/file\/$/.exec(path)
    if (m && lib(m[1])) {
      const l = lib(m[1])!
      if (l.encrypted && !unlockedRepos.has(l.id)) return json(400, { error_msg: 'Library is encrypted.' })
      return json(200, `${base}/files/${m[1]}${encodeURI(url.searchParams.get('p') ?? '')}`)
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
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base,
    server,
    libs,
    log,
    sent,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

// --- Immich ---------------------------------------------------------------------------------------------

export type ImAsset = { id: string; name: string; video: boolean; taken: string; offsetHours: number; favourite: boolean; ratio: number; albums: string[]; bytes: Buffer }
export type ImmichMock = {
  base: string
  server: Server
  assets: ImAsset[]
  version: { major: number; minor: number; patch: number }
  key: string
  log: { method: string; path: string; key: string | null; body: string }[]
  close: () => void
}

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
    if (path === '/api/users/me') return json(200, { id: 'u1', name: 'Check Person', email: 'check@example.com' })

    const q = url.searchParams
    const v3 = mock.version.major >= 3
    const filtered = assets.filter((a) => (!q.get('albumId') || a.albums.includes(q.get('albumId')!)) && (q.get('isFavorite') !== 'true' || a.favourite))
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
