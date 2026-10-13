// Checks the Photos app's server side: the EXIF reader (server/exif.ts) against real files made by
// other tools (scripts/fixtures/photos, see make.py there), and the index and its routes
// (server/photos.ts) against stand-ins for Seafile and Immich (scripts/photos-mock.ts).
//
// It starts the real server (server/index.ts) on a free port with a scratch DATA_DIR and two
// signed-in accounts (one an admin, as the stand-ins are on 127.0.0.1), links the first to the
// Seafile stand-in, and checks:
//
//   - every fixture's date, size, orientation, camera, lens, exposure and place, also when only
//     the first bytes are read and the rest comes from a second, exact byte range (HEIC's Exif
//     item, a WebP's EXIF chunk, a MOV's moov box at the end),
//   - suggestions, choosing folders and the walk: what is indexed, months (in the viewer's time
//     zone for file dates), only ranged reads of at most 128 KB, hidden folders left out,
//   - thumbnails through the server with ETag and Cache-Control (304 without asking Seafile again),
//     and the camera's own preview for an encrypted library,
//   - walking again: nothing read when nothing changed, an unchanged folder not even listed; new,
//     changed and deleted files (and a deleted folder) found; favourites kept,
//   - encrypted libraries: skipped while locked (and their photos hidden), indexed once unlocked,
//   - another account seeing none of it, and linking another Seafile account starting over,
//   - the selection: favourites for many at once, trash into the library's trash (the index rows
//     gone at once) and undo (the files and rows back, ids and favourites kept), the undo token
//     good once and for its own account only, batch caps, locked and read-only libraries refused,
//     moving to another folder (the index following, a clash refused), and a streamed ZIP of the
//     selection read back with the app's own ZIP reader,
//   - Immich: an unsupported version and a wrong key refused, linking, months, a month's photos
//     (Immich 3's format and Immich 2's), thumbnails, details, albums, favourites, video with
//     Range, the original as a download, the trash (force: false, never for good) and undo,
//     someone else's photo refused, adding to an album, a ZIP; the key sent on every request
//     and never in an answer.
//
//   node scripts/photos-check.ts
//
// Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep } from './empires-harness.ts'
import { fixture, immichMock, jpegTaken, seafileMock, type ImAsset, type SfLib } from './photos-mock.ts'
import { HEAD, readMeta, readMore, type Meta } from '../server/exif.ts'
import { readEntry, readZip } from '../src/data/zip.ts'

// --- The EXIF reader --------------------------------------------------------------------------------

/** Reads a file the way the walk does: the first `head` bytes, then the second reads asked for. */
function parse(buf: Buffer, head = HEAD): { meta: Meta; reads: number } {
  let { meta, more } = readMeta(buf.subarray(0, head), buf.length)
  let reads = 1
  while (more && reads < 4) {
    more = readMore(buf.subarray(more.start, more.start + more.length), more, meta, buf.length)
    reads++
  }
  return { meta, reads }
}

const near = (a: number | null, b: number, eps = 1e-6) => a !== null && Math.abs(a - b) < eps
const CANON_TAKEN = Date.UTC(2023, 6, 14, 18, 32, 5)

function expectCanon(label: string, m: Meta, size: [number, number]) {
  check(`${label}: taken 2023-07-14 18:32:05 (got ${m.taken && new Date(m.taken).toISOString()})`, m.taken === CANON_TAKEN && m.takenSrc === 'exif')
  check(`${label}: offset +02:00 (got ${m.offset})`, m.offset === '+02:00')
  check(`${label}: ${size[0]}×${size[1]} (got ${m.width}×${m.height})`, m.width === size[0] && m.height === size[1])
  check(`${label}: Canon, Canon EOS R6 (got ${m.make}, ${m.model})`, m.make === 'Canon' && m.model === 'Canon EOS R6')
  check(`${label}: lens (got ${m.lens})`, m.lens === 'RF35mm F1.8 MACRO IS STM')
  check(`${label}: 1/250 s, f/2.8, ISO 200, 35 mm (got ${m.exposure}, ${m.fnumber}, ${m.iso}, ${m.focal})`, near(m.exposure, 1 / 250) && near(m.fnumber, 2.8) && m.iso === 200 && near(m.focal, 35))
  check(`${label}: 52.370094 N, 4.891683 E, 12 m (got ${m.lat}, ${m.lon}, ${m.alt})`, near(m.lat, 52.370094) && near(m.lon, 4.891683) && m.alt === 12)
}

/** A WebP with a big chunk before its EXIF chunk, so the EXIF lies past the first read. */
function paddedWebp(): Buffer {
  const src = fixture('photo.webp')
  let at = 12
  while (src.toString('latin1', at, at + 4) !== 'EXIF') at += 8 + src.readUInt32LE(at + 4) + (src.readUInt32LE(at + 4) & 1)
  const pad = Buffer.alloc(8 + 300_000)
  pad.write('PAD ', 0, 'latin1')
  pad.writeUInt32LE(300_000, 4)
  const out = Buffer.concat([src.subarray(0, at), pad, src.subarray(at)])
  out.writeUInt32LE(out.length - 8, 4)
  return out
}

/** A MOV whose media data is 300 KB longer, so its moov box (at the end) lies past the first read. */
function paddedMov(): Buffer {
  const src = fixture('clip-tail.mov')
  let at = 0
  while (src.toString('latin1', at + 4, at + 8) !== 'mdat') at += src.readUInt32BE(at)
  const len = src.readUInt32BE(at)
  const out = Buffer.concat([src.subarray(0, at + len), Buffer.alloc(300_000), src.subarray(at + len)])
  out.writeUInt32BE(len + 300_000, at)
  return out
}

/** A JPEG with 3 MB after it: only the first 128 KB may be read. */
const bigJpeg = () => Buffer.concat([fixture('canon.jpg'), Buffer.alloc(3 * 1024 * 1024, 7)])

function parserChecks() {
  expectCanon('canon.jpg', parse(fixture('canon.jpg')).meta, [64, 48])
  expectCanon('photo.png (eXIf)', parse(fixture('photo.png')).meta, [32, 24])
  expectCanon('photo.webp (EXIF chunk)', parse(fixture('photo.webp')).meta, [32, 24])
  expectCanon('photo.heic (Exif item)', parse(fixture('photo.heic')).meta, [64, 48])

  const be = parse(fixture('iphone-be.jpg')).meta
  check(`iphone-be.jpg (big-endian): taken 2021-12-31 23:59:58 (got ${be.taken && new Date(be.taken).toISOString()})`, be.taken === Date.UTC(2021, 11, 31, 23, 59, 58))
  check(`iphone-be.jpg: orientation 6, 48×32 stored (got ${be.orientation}, ${be.width}×${be.height})`, be.orientation === 6 && be.width === 48 && be.height === 32)
  check(`iphone-be.jpg: Apple iPhone 15 Pro, ISO 1250, f/1.78, 1/60 s (got ${be.make} ${be.model}, ${be.iso}, ${be.fnumber}, ${be.exposure})`, be.make === 'Apple' && be.model === 'iPhone 15 Pro' && be.iso === 1250 && near(be.fnumber, 1.78) && near(be.exposure, 1 / 60))
  check(`iphone-be.jpg: south and west are negative (got ${be.lat}, ${be.lon})`, near(be.lat, -33.859833) && near(be.lon, -151.208333))

  const plain = parse(fixture('plain.jpg')).meta
  check(`plain.jpg: no date, 40×30 from the frame header (got ${plain.taken}, ${plain.width}×${plain.height})`, plain.taken === null && plain.width === 40 && plain.height === 30)
  const vault = parse(fixture('vault.jpg')).meta
  check(`vault.jpg: the embedded preview is a JPEG (got ${vault.thumb?.length ?? 0} bytes)`, !!vault.thumb && vault.thumb[0] === 0xff && vault.thumb[1] === 0xd8)

  for (const f of ['clip.mp4', 'clip-tail.mov']) {
    const { meta, reads } = parse(fixture(f))
    check(`${f}: created 2022-05-01 10:20:30 UTC, a real instant (got ${meta.taken && new Date(meta.taken).toISOString()}, ${meta.takenSrc})`, meta.taken === Date.UTC(2022, 4, 1, 10, 20, 30) && meta.takenSrc === 'video')
    check(`${f}: 32×24 from tkhd, in one read (got ${meta.width}×${meta.height}, ${reads} reads)`, meta.width === 32 && meta.height === 24 && reads === 1)
  }

  // Only the first bytes read: the rest comes from a second, exact read.
  for (const [label, buf, want] of [
    ['photo.heic, first 300 bytes', fixture('photo.heic'), [64, 48]],
    ['photo.webp, first 300 bytes', fixture('photo.webp'), [32, 24]],
  ] as const) {
    const { meta, reads } = parse(buf, 300)
    check(`${label}: a second read (got ${reads} reads)`, reads === 2)
    expectCanon(label, meta, [...want])
  }
  const tail = parse(fixture('clip-tail.mov'), 300)
  check(`clip-tail.mov, first 300 bytes: the moov box from a second read (${tail.reads} reads, ${tail.meta.taken && new Date(tail.meta.taken).toISOString()})`, tail.reads === 2 && tail.meta.taken === Date.UTC(2022, 4, 1, 10, 20, 30))
  const webp = parse(paddedWebp())
  check(`WebP with its EXIF 300 KB in: found by a second read (${webp.reads} reads)`, webp.reads === 2 && webp.meta.taken === CANON_TAKEN)
  const mov = parse(paddedMov())
  check(`MOV with 300 KB of media first: moov found by a second read (${mov.reads} reads)`, mov.reads === 2 && mov.meta.taken === Date.UTC(2022, 4, 1, 10, 20, 30))

  // Nonsense never throws.
  let threw = false
  try {
    for (let i = 0; i < 200; i++) {
      const junk = randomBytes(64 + i * 37)
      if (i % 4 === 0) junk.set([0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0])
      if (i % 4 === 1) junk.write('\0\0\0\x18ftypheic', 0, 'latin1')
      if (i % 4 === 2) junk.write('RIFF\0\0\0\0WEBPVP8X', 0, 'latin1')
      parse(junk)
    }
    for (const f of ['canon.jpg', 'photo.heic', 'photo.webp', 'clip.mp4']) for (let n = 0; n < fixture(f).length; n += 7) parse(fixture(f).subarray(0, n), n)
  } catch (e) {
    threw = true
    console.error(e)
  }
  check('random bytes and every cut-off fixture: no exception', !threw)
}

// --- The server ---------------------------------------------------------------------------------------

const PHOTOS = '11111111-1111-4111-8111-111111111111'
const VAULT = '22222222-2222-4222-8222-222222222222'
const DOCS = '33333333-3333-4333-8333-333333333333'
const SHARED = '44444444-4444-4444-8444-444444444444'
const PLAIN_MTIME = Date.UTC(2020, 2, 31, 23, 30) // 31 March in UTC, 1 April in Amsterdam

const file = (bytes: Buffer, mtime = Date.UTC(2024, 0, 1)) => ({ bytes, mtime })
const libs: SfLib[] = [
  {
    id: PHOTOS,
    name: 'Photos',
    encrypted: false,
    files: new Map([
      ['/canon.jpg', file(fixture('canon.jpg'))],
      ['/plain.jpg', file(fixture('plain.jpg'), PLAIN_MTIME)],
      ['/notes.txt', file(Buffer.from('not a photo'))],
      ['/big.jpg', file(bigJpeg())],
      ['/big.webp', file(paddedWebp())],
      ['/big.mov', file(paddedMov())],
      ['/.hidden/secret.jpg', file(fixture('canon.jpg'))],
      ['/Trips/iphone-be.jpg', file(fixture('iphone-be.jpg'))],
      ['/Trips/photo.png', file(fixture('photo.png'))],
      ['/Trips/photo.webp', file(fixture('photo.webp'))],
      ['/Trips/photo.heic', file(fixture('photo.heic'))],
      ['/Trips/Deep/clip.mp4', file(fixture('clip.mp4'))],
      ['/Trips/Deep/clip-tail.mov', file(fixture('clip-tail.mov'))],
    ]),
  },
  { id: VAULT, name: 'Vault', encrypted: true, files: new Map([['/vault.jpg', file(fixture('vault.jpg'))]]) },
  { id: DOCS, name: 'Documents', encrypted: false, files: new Map([['/Camera Uploads/a.jpg', file(fixture('canon.jpg'))], ['/Work/x.jpg', file(fixture('plain.jpg'))]]) },
  { id: SHARED, name: 'Shared with me', encrypted: false, perm: 'r', files: new Map([['/Holiday/beach.jpg', file(fixture('canon.jpg'))]]) },
]
const sf = await seafileMock(libs)

const ADMIN = 'photos-check'
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: ADMIN })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const now = Date.now()
const sids: string[] = []
for (const [id, login] of [
  [1, ADMIN],
  [2, 'someone-else'],
] as const) {
  const sid = randomBytes(24).toString('hex')
  sids.push(sid)
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, login, encrypt('none'), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + 86400_000)
}
const linkSeafile = (user: number, username: string) =>
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user, 'seafile', encrypt(JSON.stringify({ url: sf.base, username, token: 'stand-in-token', name: 'Check', version: '12.0.0' })), Date.now())
linkSeafile(1, 'check@example.com')
await server.start()

/** Every answer's text, to look for the Immich key in at the end. */
const answers: string[] = []
type Answer = { status: number; headers: Headers; text: string; json: any; bytes: Buffer }
async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; as?: number } = {}): Promise<Answer> {
  const res = await fetch(`${server.origin}${path}`, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: { Cookie: `mvlos_sid=${sids[(init.as ?? 1) - 1]}`, Origin: server.origin, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  const text = bytes.toString('utf8')
  answers.push(text, JSON.stringify([...res.headers]))
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json, bytes }
}
const files = () => sf.log.filter((l) => l.path.startsWith('/files/'))
const buckets = async (q = '') => Object.fromEntries(((await call(`/api/photos/seafile/buckets?tz=0${q}`)).json as { month: string; count: number }[]).map((b) => [b.month, b.count]))
async function waitScan(label: string) {
  const end = Date.now() + 20_000
  for (;;) {
    const s = (await call('/api/photos/status')).json
    const job = s.seafile?.job
    if (job && (job.state === 'done' || job.state === 'failed')) {
      check(`${label}: the walk finished (${job.state}${job.errors.length ? `: ${job.errors.join('; ')}` : ''})`, job.state === 'done' && !job.errors.length)
      return job
    }
    if (Date.now() > end) {
      check(`${label}: the walk finished (timed out at ${JSON.stringify(job)})`, false)
      return job
    }
    await sleep(50)
  }
}
/** A photo's id, by its path. */
const idOf = (repo: string, path: string) => String((database().prepare('SELECT id FROM photos WHERE user_id = 1 AND repo = ? AND path = ?').get(repo, path) as { id: number } | undefined)?.id ?? '')

/** A ZIP's files by name, read with the app's own reader. */
async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const blob = new Blob([bytes])
  const index = await readZip(blob)
  const out = new Map<string, Buffer>()
  for (const e of index.entries) out.set(e.path, Buffer.from(await readEntry(e, async (from, to) => new Uint8Array(await blob.slice(from, to + 1).arrayBuffer()))))
  return out
}

async function selectionChecks(vaultId: string) {
  const photos = libs[0]
  const july = (await call('/api/photos/seafile/bucket?tz=0&key=2023-07')).json as unknown[][]
  const webp = july.find((i) => i[0] === idOf(PHOTOS, '/Trips/photo.webp'))
  check(`a month's photos say where they are (got ${webp?.[6]})`, webp?.[6] === `${PHOTOS}/Trips/photo.webp`)

  // Favourites for many at once.
  const a = idOf(PHOTOS, '/big.jpg')
  const b = idOf(PHOTOS, '/Trips/photo.webp')
  const favs = await call('/api/photos/seafile/favourite', { method: 'PUT', body: { ids: [a, b], on: true } })
  const both = (database().prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = 1 AND favourite = 1 AND id IN (?, ?)').get(Number(a), Number(b)) as { n: number }).n
  check(`favourites for two at once (got ${favs.status}, ${both} favourites)`, favs.status === 200 && both === 2)
  await call('/api/photos/seafile/favourite', { method: 'PUT', body: { ids: [a], on: false } })

  // Into the trash: two photos in two folders, gone from the library and the index at once.
  const before = await buckets()
  const trash = await call('/api/photos/seafile/trash', { method: 'POST', body: { ids: [a, b] } })
  check(`trash: 200, both taken, an undo token (got ${trash.status} ${trash.text.slice(0, 120)})`, trash.status === 200 && trash.json.trashed.length === 2 && typeof trash.json.undo === 'string' && trash.json.error === null)
  check("trash: the files are in the library's trash on Seafile", !photos.files.has('/big.jpg') && !photos.files.has('/Trips/photo.webp') && (photos.trash ?? []).length === 2)
  check('trash: deleted with batch-delete-item, one call per folder', sf.log.filter((l) => l.path === '/api/v2.1/repos/batch-delete-item/' && l.method === 'DELETE').length === 2)
  const after = await buckets()
  check(`trash: the index lost them at once, no walk needed (2023-07 ${before['2023-07']} → ${after['2023-07']})`, !idOf(PHOTOS, '/big.jpg') && !idOf(PHOTOS, '/Trips/photo.webp') && after['2023-07'] === before['2023-07'] - 2)

  // Undo: only its own account, only once.
  const stranger = await call('/api/photos/seafile/restore', { method: 'POST', body: { undo: trash.json.undo }, as: 2 })
  check(`another account cannot use the undo (got ${stranger.status})`, stranger.status === 404 && !photos.files.has('/big.jpg'))
  const undo = await call('/api/photos/seafile/restore', { method: 'POST', body: { undo: trash.json.undo } })
  check(`undo: both restored from the library's trash (got ${undo.status} ${undo.text})`, undo.status === 200 && undo.json.restored.length === 2 && !undo.json.failed.length && photos.files.has('/big.jpg') && photos.files.has('/Trips/photo.webp'))
  check(`undo: the index rows are back with their ids, the favourite kept (got ${idOf(PHOTOS, '/big.jpg')}, ${idOf(PHOTOS, '/Trips/photo.webp')})`, idOf(PHOTOS, '/big.jpg') === a && idOf(PHOTOS, '/Trips/photo.webp') === b && (database().prepare('SELECT favourite FROM photos WHERE id = ?').get(Number(b)) as { favourite: number }).favourite === 1)
  check(`undo: the months are as before (got ${JSON.stringify(await buckets())})`, JSON.stringify(await buckets()) === JSON.stringify(before))
  const twice = await call('/api/photos/seafile/restore', { method: 'POST', body: { undo: trash.json.undo } })
  check(`an undo token works once (got ${twice.status})`, twice.status === 404)

  // Caps and refusals.
  const many = Array.from({ length: 201 }, (_, i) => String(i + 1))
  const capped = await call('/api/photos/seafile/trash', { method: 'POST', body: { ids: many } })
  const cappedFav = await call('/api/photos/seafile/favourite', { method: 'PUT', body: { ids: many, on: true } })
  const cappedZip = await call('/api/photos/seafile/zip', { method: 'POST', body: { ids: Array.from({ length: 2001 }, (_, i) => String(i + 1)) } })
  check(`batch caps: 201 to trash, 201 favourites, 2001 in a ZIP refused (got ${capped.status}, ${cappedFav.status}, ${cappedZip.status})`, capped.status === 413 && cappedFav.status === 413 && cappedZip.status === 413)
  const empty = await call('/api/photos/seafile/trash', { method: 'POST', body: { ids: [] } })
  check(`no ids: 400 (got ${empty.status})`, empty.status === 400)
  const unknown = await call('/api/photos/seafile/trash', { method: 'POST', body: { ids: [a, '999999'] } })
  check(`an id not in the index refuses the batch whole (got ${unknown.status})`, unknown.status === 404 && photos.files.has('/big.jpg'))
  const deletes = () => sf.log.filter((l) => l.path === '/api/v2.1/repos/batch-delete-item/').length
  const d0 = deletes()
  const locked = await call('/api/photos/seafile/trash', { method: 'POST', body: { ids: [vaultId] } })
  check(`a locked library refuses, and says to unlock it (got ${locked.status} ${locked.json?.error})`, locked.status === 423 && /unlock/i.test(locked.json?.error ?? '') && deletes() === d0 && libs[1].files.has('/vault.jpg'))

  // A read-only library (shared for viewing): its photos show, but nothing in it changes.
  await call('/api/photos/sources', { method: 'PUT', body: { sources: [{ repo: PHOTOS, path: '/' }, { repo: VAULT, path: '/' }, { repo: SHARED, path: '/' }] } })
  await waitScan('walk with the read-only library')
  const beach = idOf(SHARED, '/Holiday/beach.jpg')
  const ro = await call('/api/photos/seafile/trash', { method: 'POST', body: { ids: [beach] } })
  const roMove = await call('/api/photos/seafile/move', { method: 'POST', body: { ids: [beach], to: { repo: PHOTOS, path: '/Trips' } } })
  const roInto = await call('/api/photos/seafile/move', { method: 'POST', body: { ids: [a], to: { repo: SHARED, path: '/Holiday' } } })
  check(`read-only: trash and moves out or in refused, and say why (got ${ro.status}, ${roMove.status}, ${roInto.status}: ${ro.json?.error})`, !!beach && ro.status === 403 && roMove.status === 403 && roInto.status === 403 && /read-only/.test(ro.json?.error ?? '') && libs[3].files.has('/Holiday/beach.jpg') && deletes() === d0)
  const roZip = await call('/api/photos/seafile/zip', { method: 'POST', body: { ids: [beach] } })
  check(`read-only: downloading still works (got ${roZip.status})`, roZip.status === 200)

  // Moving to another folder: the index follows (same id); a name already there is refused.
  const plain = idOf(PHOTOS, '/plain.jpg')
  const moved = await call('/api/photos/seafile/move', { method: 'POST', body: { ids: [plain], to: { repo: PHOTOS, path: '/Trips' } } })
  check(`move: plain.jpg into /Trips, the index row follows (got ${moved.status} ${moved.text}, ${idOf(PHOTOS, '/Trips/plain.jpg')})`, moved.status === 200 && moved.json.moved === 1 && moved.json.kept === true && idOf(PHOTOS, '/Trips/plain.jpg') === plain && photos.files.has('/Trips/plain.jpg') && !photos.files.has('/plain.jpg'))
  photos.files.set('/plain.jpg', file(Buffer.from('not the same')))
  const clash = await call('/api/photos/seafile/move', { method: 'POST', body: { ids: [plain], to: { repo: PHOTOS, path: '/' } } })
  check(`move: a name already there is refused (got ${clash.status} ${clash.json?.error})`, clash.status === 409 && /plain\.jpg/.test(clash.json?.error ?? '') && photos.files.has('/Trips/plain.jpg'))
  photos.files.delete('/plain.jpg')
  const back = await call('/api/photos/seafile/move', { method: 'POST', body: { ids: [plain], to: { repo: PHOTOS, path: '/' } } })
  check(`move back (got ${back.status})`, back.status === 200 && idOf(PHOTOS, '/plain.jpg') === plain)

  // A ZIP of the selection, streamed: each file as it is in Seafile.
  const zip = await call('/api/photos/seafile/zip', { method: 'POST', body: { ids: [a, plain, b] } })
  check(`zip: a download address (got ${zip.status} ${zip.text})`, zip.status === 200 && /^\/api\/photos\/zip\?t=/.test(zip.json?.url ?? ''))
  const got = await call(zip.json.url)
  check(`zip: 200 application/zip as an attachment (got ${got.status} ${got.headers.get('content-type')} ${got.headers.get('content-disposition')})`, got.status === 200 && got.headers.get('content-type') === 'application/zip' && /attachment/.test(got.headers.get('content-disposition') ?? ''))
  const files = await unzip(got.bytes).catch((e) => (console.error(e), new Map<string, Buffer>()))
  check(`zip: the three files, byte for byte (got ${[...files.keys()].join(', ')})`, files.size === 3 && !!files.get('big.jpg')?.equals(photos.files.get('/big.jpg')!.bytes) && !!files.get('plain.jpg')?.equals(photos.files.get('/plain.jpg')!.bytes) && !!files.get('photo.webp')?.equals(photos.files.get('/Trips/photo.webp')!.bytes))
  const strangerZip = await call(zip.json.url, { as: 2 })
  check(`zip: another account's session cannot fetch it (got ${strangerZip.status})`, strangerZip.status === 404)

  // Back to the folders (and favourites) the rest of the checks expect.
  await call('/api/photos/seafile/favourite', { method: 'PUT', body: { ids: [b], on: false } })
  await call('/api/photos/sources', { method: 'PUT', body: { sources: [{ repo: PHOTOS, path: '/' }, { repo: VAULT, path: '/' }] } })
  await waitScan('walk after the selection checks')
}

async function seafileChecks() {
  // Nothing chosen yet; suggestions.
  const first = await call('/api/photos/status')
  check(`status: Seafile linked, no folders yet (got ${first.status} ${first.text.slice(0, 120)})`, first.status === 200 && first.json.seafile?.sources.length === 0 && first.json.immich === null)
  const suggest = await call('/api/photos/suggest')
  const named = (suggest.json as { repo: string; path: string }[]).map((s) => `${s.repo.slice(0, 4)}${s.path}`)
  check(`suggestions: the Photos library and Documents/Camera Uploads (got ${named.join(', ')})`, named.includes('1111/') && named.includes('3333/Camera Uploads') && !named.some((n) => n.includes('Work')))

  // Choose the Photos library and the (locked) Vault: the walk starts.
  const set = await call('/api/photos/sources', { method: 'PUT', body: { sources: [{ repo: PHOTOS, path: '/' }, { repo: VAULT, path: '/' }, { repo: PHOTOS, path: '/Trips' }] } })
  check(`choosing folders: 200, a folder inside another left out (got ${set.status}, ${set.json?.seafile?.sources.length} folders)`, set.status === 200 && set.json.seafile.sources.length === 2)
  const job = await waitScan('first walk')
  check(`first walk: 11 photos and videos (got ${job.added})`, job.added === 11)
  check(`first walk: the locked Vault skipped, and said why (got ${JSON.stringify(job.skipped)})`, job.skipped.length === 1 && job.skipped[0].repo === VAULT && /locked/i.test(job.skipped[0].why))
  check('first walk: the hidden folder left out', !idOf(PHOTOS, '/.hidden/secret.jpg'))
  const ranged = files().filter((l) => l.path.includes(PHOTOS))
  check(`every read was a byte range (${ranged.length} reads, ${ranged.filter((l) => !l.range).length} without)`, ranged.length > 0 && ranged.every((l) => l.range))
  check(`big.jpg: bytes=0-131071 asked, at most 128 KB sent (got ${files().find((l) => l.path.endsWith('/big.jpg'))?.range}, ${sf.sent.get('/big.jpg')} bytes)`, files().find((l) => l.path.endsWith('/big.jpg'))?.range === 'bytes=0-131071' && (sf.sent.get('/big.jpg') ?? 0) <= 131072)
  const movReads = files().filter((l) => l.path.endsWith('/big.mov'))
  check(`big.mov: a second read where moov starts (got ${movReads.map((l) => l.range).join(', ')})`, movReads.length === 2 && movReads[1].range!.startsWith(`bytes=${fixture('clip-tail.mov').indexOf('moov') - 4 + 300_000}-`))

  const b = await buckets()
  check(`months: 2023-07 ×6, 2022-05 ×3, 2021-12 ×1, 2020-03 ×1 (got ${JSON.stringify(b)})`, JSON.stringify(b) === JSON.stringify({ '2023-07': 6, '2022-05': 3, '2021-12': 1, '2020-03': 1 }))
  const inAmsterdam = Object.fromEntries(((await call('/api/photos/seafile/buckets?tz=-120')).json as { month: string; count: number }[]).map((x) => [x.month, x.count]))
  check(`a file's date is the viewer's: plain.jpg is in April at UTC+2 (got ${JSON.stringify(inAmsterdam)})`, inAmsterdam['2020-04'] === 1 && !inAmsterdam['2020-03'] && inAmsterdam['2023-07'] === 6)
  const month = (await call('/api/photos/seafile/bucket?tz=0&key=2022-05')).json as [string, number, number, number, number | null][]
  check(`2022-05: three videos, flagged as such (got ${month.map((i) => i[2]).join(',')})`, month.length === 3 && month.every((i) => (i[2] & 1) === 1))
  const july = (await call('/api/photos/seafile/bucket?tz=0&key=2023-07')).json as [string, number, number, number][]
  check(`2023-07: newest first, canon.jpg at 18:32:05 and ratio 1.333 (got ${july.find((i) => i[0] === idOf(PHOTOS, '/canon.jpg'))?.slice(1).join(', ')})`, july.some((i) => i[0] === idOf(PHOTOS, '/canon.jpg') && i[1] === CANON_TAKEN && i[3] === 1.333))

  const info = (await call(`/api/photos/seafile/info?id=${idOf(PHOTOS, '/canon.jpg')}`)).json
  check(`info: camera, lens, exposure, place and library (got ${info.make} ${info.model}, ${info.lens}, ${info.exposure}, ${info.lat},${info.lon}, ${info.library})`, info.make === 'Canon' && info.lens === 'RF35mm F1.8 MACRO IS STM' && near(info.exposure, 0.004) && near(info.lat, 52.370094) && info.library === 'Photos' && info.path === '/canon.jpg')
  const turned = (await call(`/api/photos/seafile/info?id=${idOf(PHOTOS, '/Trips/iphone-be.jpg')}`)).json
  check(`info: a photo turned by its orientation shows 32×48 (got ${turned.width}×${turned.height})`, turned.width === 32 && turned.height === 48)

  // Thumbnails, with ETag and Cache-Control.
  const canonId = idOf(PHOTOS, '/canon.jpg')
  const thumbsAsked = () => sf.log.filter((l) => l.path.includes('/thumbnail/')).length
  const t1 = await call(`/api/photos/seafile/thumb?id=${canonId}&size=small&v=1`)
  check(`thumbnail: 200 image/png, ETag, kept by the browser (got ${t1.status} ${t1.headers.get('content-type')} ${t1.headers.get('etag')} ${t1.headers.get('cache-control')})`, t1.status === 200 && t1.headers.get('content-type') === 'image/png' && !!t1.headers.get('etag') && /max-age=\d{5,}/.test(t1.headers.get('cache-control') ?? '') && t1.bytes[1] === 0x50)
  check(`thumbnail: asked Seafile at 256 px (got ${sf.log.findLast((l) => l.path.includes('/thumbnail/'))?.path})`, !!sf.log.findLast((l) => l.path.includes('/thumbnail/'))?.path.includes('size=256'))
  const before = thumbsAsked()
  const t2 = await call(`/api/photos/seafile/thumb?id=${canonId}&size=small&v=1`, { headers: { 'If-None-Match': t1.headers.get('etag')! } })
  check(`thumbnail again with If-None-Match: 304, Seafile not asked (got ${t2.status}, ${thumbsAsked() - before} asks)`, t2.status === 304 && thumbsAsked() === before)

  // Favourites.
  const fav = await call('/api/photos/seafile/favourite', { method: 'PUT', body: { id: canonId, on: true } })
  check(`favourite: 200 (got ${fav.status})`, fav.status === 200)
  check(`favourites: one, in 2023-07 (got ${JSON.stringify(await buckets('&fav=1'))})`, JSON.stringify(await buckets('&fav=1')) === '{"2023-07":1}')
  const albums = (await call('/api/photos/seafile/albums')).json as { id: string; name: string; count: number; cover: string | null }[]
  check(`albums: the chosen folders, the locked Vault left out (got ${albums.map((a) => `${a.name}:${a.count}`).join(', ')})`, albums.length === 1 && albums[0].name === 'Photos' && albums[0].count === 11 && !!albums[0].cover)
  const tripsOnly = (await call(`/api/photos/seafile/buckets?tz=0&album=${PHOTOS}/Trips`)).json as { count: number }[]
  check(`an album of a subfolder: only what is in it (got ${tripsOnly.reduce((n, x) => n + x.count, 0)})`, tripsOnly.reduce((n, x) => n + x.count, 0) === 6)

  // Walking again with nothing changed: no file read, the unchanged folder not even listed.
  const mark = sf.log.length
  await call('/api/photos/scan', { method: 'POST' })
  const again = await waitScan('second walk')
  const since = sf.log.slice(mark)
  check(`second walk, nothing changed: no file read (got ${since.filter((l) => l.path.startsWith('/files/')).length})`, !since.some((l) => l.path.startsWith('/files/')) && again.added === 0 && again.removed === 0)
  check(`second walk: /Trips (unchanged) not listed, the root was (got ${since.filter((l) => l.path.includes('/dir/')).map((l) => decodeURIComponent(l.path.split('p=')[1])).join(', ')})`, !since.some((l) => l.path.includes('/dir/') && l.path.includes('Trips')) && since.some((l) => l.path.includes(`${PHOTOS}/dir/?p=%2F`)))

  // New, changed and deleted files deep down.
  const photos = libs[0].files
  photos.set('/Trips/Deep/new.jpg', file(jpegTaken(new Date(Date.UTC(2024, 1, 2, 12)))))
  photos.delete('/Trips/photo.png')
  photos.set('/canon.jpg', file(jpegTaken(new Date(Date.UTC(2018, 0, 1, 8))), Date.UTC(2024, 5, 1)))
  const mark2 = sf.log.length
  await call('/api/photos/scan', { method: 'POST' })
  const third = await waitScan('third walk')
  const read3 = sf.log.slice(mark2).filter((l) => l.path.startsWith('/files/')).map((l) => decodeURI(l.path.slice('/files/'.length + 36)))
  check(`third walk: only the new and the changed file read (got ${read3.join(', ')})`, read3.length === 2 && read3.includes('/Trips/Deep/new.jpg') && read3.includes('/canon.jpg'))
  check(`third walk: one added, one removed (got ${third.added}, ${third.removed})`, third.added === 1 && third.removed === 1)
  const b3 = await buckets()
  check(`third walk: canon.jpg moved to 2018-01, new.jpg in 2024-02, photo.png gone (got ${JSON.stringify(b3)})`, b3['2018-01'] === 1 && b3['2024-02'] === 1 && b3['2023-07'] === 4)
  check(`third walk: canon.jpg is still a favourite (same id: ${idOf(PHOTOS, '/canon.jpg') === canonId})`, JSON.stringify(await buckets('&fav=1')) === '{"2018-01":1}')
  const t3 = await call(`/api/photos/seafile/thumb?id=${canonId}&size=small&v=2`, { headers: { 'If-None-Match': t1.headers.get('etag')! } })
  check(`a changed file's thumbnail has a new ETag: 200, not 304 (got ${t3.status})`, t3.status === 200 && t3.headers.get('etag') !== t1.headers.get('etag'))

  // A whole folder deleted.
  for (const p of [...photos.keys()]) if (p.startsWith('/Trips/Deep/')) photos.delete(p)
  await call('/api/photos/scan', { method: 'POST' })
  const fourth = await waitScan('fourth walk')
  check(`a deleted folder: its three files removed (got ${fourth.removed})`, fourth.removed === 3 && !idOf(PHOTOS, '/Trips/Deep/clip.mp4'))

  // The encrypted library: indexed once unlocked, hidden again when locked.
  check('unlocking the Vault', (await call('/api/seafile/unlock', { method: 'POST', body: { repo: VAULT, password: 'pw', minutes: 30 } })).status === 200)
  await call('/api/photos/scan', { method: 'POST' })
  const fifth = await waitScan('walk with the Vault unlocked')
  const vaultId = idOf(VAULT, '/vault.jpg')
  check(`the Vault's photo indexed (added ${fifth.added}, skipped ${fifth.skipped.length})`, !!vaultId && fifth.added === 1 && fifth.skipped.length === 0)
  const vaultReads = files().filter((l) => l.path.includes(VAULT))
  check(`the Vault's photo read with a range through the server (got ${vaultReads.map((l) => l.range).join(', ')})`, vaultReads.length === 1 && vaultReads[0].range === `bytes=0-${fixture('vault.jpg').length - 1}`)
  const thumbs = thumbsAsked()
  const vt = await call(`/api/photos/seafile/thumb?id=${vaultId}&size=small&v=1`)
  check(`the Vault's thumbnail: the camera's preview, Seafile not asked (got ${vt.status} ${vt.headers.get('content-type')}, ${thumbsAsked() - thumbs} asks)`, vt.status === 200 && vt.headers.get('content-type') === 'image/jpeg' && vt.bytes[0] === 0xff && thumbsAsked() === thumbs)
  check(`unlocked: the Vault's photo is on the timeline (got ${JSON.stringify(await buckets())})`, (await buckets())['2023-07'] === 5)
  check('locking the Vault', (await call('/api/seafile/lock', { method: 'POST', body: { repo: VAULT } })).status === 200)
  check(`locked: the Vault's photo is hidden again (got ${JSON.stringify(await buckets())})`, (await buckets())['2023-07'] === 4)
  const st = (await call('/api/photos/status')).json
  check(`status: the Vault says it is locked (got ${JSON.stringify(st.seafile.sources.map((s: { name: string; locked: boolean }) => [s.name, s.locked]))})`, st.seafile.sources.some((s: { repo: string; locked: boolean }) => s.repo === VAULT && s.locked))

  await selectionChecks(vaultId)

  // Another account sees none of it.
  const other = await call(`/api/photos/seafile/info?id=${canonId}`, { as: 2 })
  check(`another account without Seafile: 409 (got ${other.status})`, other.status === 409)
  linkSeafile(2, 'someone@example.com')
  const otherInfo = await call(`/api/photos/seafile/info?id=${canonId}`, { as: 2 })
  const otherThumb = await call(`/api/photos/seafile/thumb?id=${canonId}&size=small`, { as: 2 })
  const otherBuckets = await call('/api/photos/seafile/buckets?tz=0', { as: 2 })
  check(`another account with Seafile: not this one's photos (info ${otherInfo.status}, thumbnail ${otherThumb.status}, ${otherBuckets.json?.length} months)`, otherInfo.status === 404 && otherThumb.status === 404 && otherBuckets.json?.length === 0)
  const otherFav = await call('/api/photos/seafile/favourite', { method: 'PUT', body: { id: canonId, on: false }, as: 2 })
  check(`another account cannot unfavourite it (got ${otherFav.status})`, otherFav.status === 404 && JSON.stringify(await buckets('&fav=1')) === '{"2018-01":1}')
  const otherTrash = await call('/api/photos/seafile/trash', { method: 'POST', body: { ids: [canonId] }, as: 2 })
  const otherZip = await call('/api/photos/seafile/zip', { method: 'POST', body: { ids: [canonId] }, as: 2 })
  const otherMove = await call('/api/photos/seafile/move', { method: 'POST', body: { ids: [canonId], to: { repo: PHOTOS, path: '/Trips' } }, as: 2 })
  check(`another account cannot trash, zip or move it (got ${otherTrash.status}, ${otherZip.status}, ${otherMove.status})`, otherTrash.status === 404 && otherZip.status === 404 && otherMove.status === 404 && libs[0].files.has('/canon.jpg') && !!idOf(PHOTOS, '/canon.jpg'))
  const signedOut = await fetch(`${server.origin}/api/photos/seafile/buckets?tz=0`)
  check(`signed out: 401 (got ${signedOut.status})`, signedOut.status === 401)

  // Linking another Seafile account starts over.
  linkSeafile(1, 'another@example.com')
  const fresh = (await call('/api/photos/status')).json
  check(`another Seafile account: no folders, no photos (got ${fresh.seafile.sources.length} folders, ${JSON.stringify(await buckets())})`, fresh.seafile.sources.length === 0 && JSON.stringify(await buckets()) === '{}')
}

// --- Immich -----------------------------------------------------------------------------------------------

const KEY = 'immich-check-key-7fA9xQ2LmZ0pR4tV'
const aid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const assets: ImAsset[] = [
  { id: aid(1), name: 'DSCF0001.JPG', video: false, taken: '2025-08-03T16:00:00.000Z', offsetHours: 2, favourite: false, ratio: 1.5, albums: ['bbbbbbbb-0000-4000-8000-000000000001'], bytes: fixture('canon.jpg') },
  { id: aid(2), name: 'DSCF0002.JPG', video: false, taken: '2025-08-01T23:30:00.000Z', offsetHours: -5, favourite: true, ratio: 0.667, albums: [], bytes: fixture('plain.jpg') },
  { id: aid(3), name: 'clip.mp4', video: true, taken: '2025-07-20T09:00:00.000Z', offsetHours: 0, favourite: false, ratio: 1.333, albums: [], bytes: fixture('clip.mp4') },
]

async function immichSelectionChecks(im: Awaited<ReturnType<typeof immichMock>>) {
  const months = async () => ((await call('/api/photos/immich/buckets?tz=0')).json as { month: string; count: number }[]).map((m) => `${m.month}×${m.count}`).join(',')
  const before = await months()

  // Into Immich's trash, never for good, and back.
  const trash = await call('/api/photos/immich/trash', { method: 'POST', body: { ids: [aid(1)] } })
  const del = im.log.findLast((l) => l.method === 'DELETE' && l.path === '/api/assets')
  check(`Immich trash: DELETE /api/assets with force: false (got ${trash.status}, ${del?.body})`, trash.status === 200 && !!del && JSON.parse(del.body).force === false && JSON.parse(del.body).ids[0] === aid(1) && assets[0].trashed === true && assets.length === 3)
  check(`Immich trash: gone from the timeline (got ${await months()})`, (await months()) === '2025-08×1,2025-07×1')
  const stranger = await call('/api/photos/immich/restore', { method: 'POST', body: { undo: trash.json.undo }, as: 2 })
  check(`Immich undo: not for another account (got ${stranger.status})`, stranger.status === 404 && assets[0].trashed === true)
  const wrongSource = await call('/api/photos/seafile/restore', { method: 'POST', body: { undo: trash.json.undo } })
  check(`Immich undo: not through the other source (got ${wrongSource.status})`, wrongSource.status === 404)
  const undo = await call('/api/photos/immich/restore', { method: 'POST', body: { undo: trash.json.undo } })
  const post = im.log.findLast((l) => l.path === '/api/trash/restore/assets')
  check(`Immich undo: POST /api/trash/restore/assets (got ${undo.status} ${undo.text}, ${post?.body})`, undo.status === 200 && JSON.parse(post?.body ?? '{}').ids?.[0] === aid(1) && !assets[0].trashed && (await months()) === before)

  // Someone else's photo (a partner's, a shared album's) is refused before Immich is asked to delete.
  assets[1].owner = 'ffffffff-0000-4000-8000-000000000009'
  const deletes = im.log.filter((l) => l.method === 'DELETE').length
  const others = await call('/api/photos/immich/trash', { method: 'POST', body: { ids: [aid(1), aid(2)] } })
  check(`Immich: a batch with someone else's photo refused whole (got ${others.status} ${others.json?.error})`, others.status === 403 && /someone else/.test(others.json?.error ?? '') && im.log.filter((l) => l.method === 'DELETE').length === deletes && !assets[0].trashed && !assets[1].trashed)
  delete assets[1].owner
  const bad = await call('/api/photos/immich/trash', { method: 'POST', body: { ids: ['../../users/me'] } })
  const capped = await call('/api/photos/immich/trash', { method: 'POST', body: { ids: Array.from({ length: 201 }, (_, i) => aid(100 + i)) } })
  check(`Immich: a bad id and 201 ids refused (got ${bad.status}, ${capped.status})`, bad.status === 400 && capped.status === 413)
  const days = await call('/api/photos/immich/trashinfo')
  check(`Immich: how long its trash keeps things (got ${days.text})`, days.status === 200 && days.json.days === 30)

  // Favourites for many, in one request; adding to an album.
  const favs = await call('/api/photos/immich/favourite', { method: 'PUT', body: { ids: [aid(2), aid(3)], on: true } })
  const put = im.log.findLast((l) => l.method === 'PUT' && l.path === '/api/assets')
  check(`Immich favourites for two: one PUT /api/assets (got ${favs.status}, ${put?.body})`, favs.status === 200 && !!put && assets[1].favourite && assets[2].favourite)
  await call('/api/photos/immich/favourite', { method: 'PUT', body: { ids: [aid(3)], on: false } })
  const album = 'bbbbbbbb-0000-4000-8000-000000000001'
  const add = await call('/api/photos/immich/album', { method: 'POST', body: { album, ids: [aid(1), aid(2)] } })
  check(`Immich: adding to an album, one already in it (got ${add.status} ${add.text})`, add.status === 200 && add.json.added === 1 && add.json.already === 1 && assets[1].albums.includes(album))
  assets[1].albums = []

  // A ZIP, with the names Immich gives.
  const zip = await call('/api/photos/immich/zip', { method: 'POST', body: { ids: [aid(1), aid(3)] } })
  const got = await call(zip.json.url)
  const files = await unzip(got.bytes).catch((e) => (console.error(e), new Map<string, Buffer>()))
  check(`Immich zip: DSCF0001.JPG and clip.mp4, byte for byte (got ${got.status}, ${[...files.keys()].join(', ')})`, got.status === 200 && !!files.get('DSCF0001.JPG')?.equals(assets[0].bytes) && !!files.get('clip.mp4')?.equals(assets[2].bytes))
}

async function immichChecks() {
  const im = await immichMock(assets, { key: KEY, version: { major: 1, minor: 140, patch: 1 }, albums: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', name: 'Summer' }] })
  try {
    const old = await call('/api/integrations/immich', { method: 'POST', body: { url: im.base, key: KEY } })
    check(`Immich 1.140: refused as unsupported (got ${old.status} ${old.json?.error})`, old.status === 400 && /not supported/.test(old.json?.error ?? ''))
    im.version = { major: 3, minor: 3, patch: 1 }
    const wrong = await call('/api/integrations/immich', { method: 'POST', body: { url: im.base, key: 'not-the-right-key-123' } })
    check(`a wrong key: refused (got ${wrong.status} ${wrong.json?.error})`, wrong.status === 400 && /did not accept/.test(wrong.json?.error ?? ''))
    const link = await call('/api/integrations/immich', { method: 'POST', body: { url: `${im.base}/api/`, key: KEY } })
    check(`linking Immich 3.3.1 (the /api pasted along is dropped): 200 (got ${link.status} ${link.text})`, link.status === 200 && link.json.version === '3.3.1' && link.json.url === im.base && link.json.name === 'Check Person')
    const status = (await call('/api/photos/status')).json
    check(`status: both sources (got seafile ${!!status.seafile}, immich ${status.immich?.url})`, !!status.seafile && status.immich?.url === im.base)
    await call('/api/me')

    const months = (await call('/api/photos/immich/buckets?tz=0')).json as { key: string; month: string; count: number }[]
    check(`Immich months: 2025-08 ×2, 2025-07 ×1 (got ${months.map((m) => `${m.month}×${m.count}`).join(', ')})`, months.length === 2 && months[0].month === '2025-08' && months[0].count === 2 && months[1].count === 1)
    const aug = (await call(`/api/photos/immich/bucket?tz=0&key=${encodeURIComponent(months[0].key)}`)).json as [string, number, number, number, number | null][]
    check(`Immich month: newest first (got ${aug.map((i) => new Date(i[1]).toISOString()).join(', ')})`, aug.length === 2 && aug[0][0] === aid(1) && aug[1][0] === aid(2))
    const byId = Object.fromEntries(aug.map((i) => [i[0], i]))
    // The photographer's clock: 16:00 UTC at +2 is 18:00, 23:30 UTC at -5 is 18:30.
    check(`Immich month: wall clocks, favourite flag, ratio (got ${JSON.stringify(aug)})`, byId[aid(1)][1] === Date.UTC(2025, 7, 3, 18) && byId[aid(2)][1] === Date.UTC(2025, 7, 1, 18, 30) && (byId[aid(2)][2] & 2) === 2 && byId[aid(1)][3] === 1.5)
    const jul = (await call(`/api/photos/immich/bucket?tz=0&key=${encodeURIComponent(months[1].key)}`)).json as [string, number, number, number, number | null][]
    check(`Immich 3: a video flagged, 12 s long (got ${JSON.stringify(jul[0])})`, (jul[0][2] & 1) === 1 && jul[0][4] === 12)
    im.version = { major: 2, minor: 7, patch: 5 }
    const v2 = (await call('/api/photos/immich/buckets?tz=0')).json as { key: string; count: number }[]
    const v2jul = (await call(`/api/photos/immich/bucket?tz=0&key=${encodeURIComponent(v2[1].key)}`)).json as [string, number, number, number, number | null][]
    check(`Immich 2's format (dates without Z, "0:00:12" durations): same answers (got ${v2[1].key}, ${JSON.stringify(v2jul[0])})`, v2jul[0][1] === Date.UTC(2025, 6, 20, 9) && v2jul[0][4] === 12)
    im.version = { major: 3, minor: 3, patch: 1 }

    const asked = im.log.length
    const t1 = await call(`/api/photos/immich/thumb?id=${aid(1)}&size=small`)
    check(`Immich thumbnail: 200 image/png with ETag (got ${t1.status} ${t1.headers.get('content-type')} ${t1.headers.get('etag')})`, t1.status === 200 && t1.headers.get('content-type') === 'image/png' && !!t1.headers.get('etag'))
    check(`Immich thumbnail: size=thumbnail asked, with the key (got ${im.log.at(-1)?.path})`, im.log.length === asked + 1 && im.log.at(-1)!.path.includes('size=thumbnail') && im.log.at(-1)!.key === KEY)
    const t2 = await call(`/api/photos/immich/thumb?id=${aid(1)}&size=small`, { headers: { 'If-None-Match': t1.headers.get('etag')! } })
    check(`Immich thumbnail again: 304, Immich not asked (got ${t2.status})`, t2.status === 304 && im.log.length === asked + 1)
    const large = await call(`/api/photos/immich/thumb?id=${aid(1)}&size=large`)
    check(`Immich large: the preview size (got ${large.status}, ${im.log.at(-1)?.path})`, large.status === 200 && im.log.at(-1)!.path.includes('size=preview'))

    const info = (await call(`/api/photos/immich/info?id=${aid(1)}`)).json
    check(`Immich info: camera, exposure, place, link to Immich (got ${info.make} ${info.model}, ${info.exposure}, ${info.place}, ${info.web})`, info.make === 'FUJIFILM' && near(info.exposure, 0.002) && info.place === 'Paris, Île-de-France, France' && info.web === `${im.base}/photos/${aid(1)}` && info.taken === Date.UTC(2025, 7, 3, 18))
    const albums = (await call('/api/photos/immich/albums')).json as { id: string; name: string; count: number }[]
    check(`Immich albums (got ${JSON.stringify(albums)})`, albums.length === 1 && albums[0].name === 'Summer' && albums[0].count === 1)
    const inAlbum = (await call(`/api/photos/immich/buckets?tz=0&album=${albums[0].id}`)).json as { count: number }[]
    check(`Immich album: its photos only (got ${inAlbum.map((b) => b.count)})`, inAlbum.length === 1 && inAlbum[0].count === 1 && im.log.at(-1)!.path.includes(`albumId=${albums[0].id}`))
    const fav = await call('/api/photos/immich/favourite', { method: 'PUT', body: { id: aid(1), on: true } })
    check(`Immich favourite: PUT /api/assets/{id} with isFavorite (got ${fav.status}, ${im.log.at(-1)?.method} ${im.log.at(-1)?.body})`, fav.status === 200 && im.log.at(-1)!.method === 'PUT' && JSON.parse(im.log.at(-1)!.body).isFavorite === true && assets[0].favourite)
    const favs = (await call('/api/photos/immich/buckets?tz=0&fav=1')).json as { count: number }[]
    check(`Immich favourites (got ${favs.map((b) => b.count)})`, favs.reduce((n, b) => n + b.count, 0) === 2)

    await immichSelectionChecks(im)

    const video = await call(`/api/photos/immich/video?id=${aid(3)}`, { headers: { Range: 'bytes=0-99' } })
    check(`Immich video with Range: 206, the exact bytes (got ${video.status} ${video.headers.get('content-range')}, ${video.bytes.length} bytes)`, video.status === 206 && video.headers.get('content-range') === `bytes 0-99/${fixture('clip.mp4').length}` && video.bytes.equals(fixture('clip.mp4').subarray(0, 100)) && video.headers.get('content-type') === 'video/mp4')
    const original = await call(`/api/photos/immich/original?id=${aid(1)}&download=1`)
    check(`Immich original as a download (got ${original.status} ${original.headers.get('content-disposition')})`, original.status === 200 && /attachment; filename\*=UTF-8''DSCF0001\.JPG/.test(original.headers.get('content-disposition') ?? '') && original.bytes.equals(fixture('canon.jpg')))

    const keyed = im.log.filter((l) => l.path.startsWith('/api/') && l.path !== '/api/server/version')
    check(`the key went with every request to Immich (${keyed.length}, ${keyed.filter((l) => l.key !== KEY).length} without; the wrong one only at linking)`, keyed.filter((l) => l.key !== KEY).every((l) => l.key === 'not-the-right-key-123'))
    check(`the key never in an answer to the browser (${answers.length} answers)`, !answers.some((a) => a.includes(KEY)))
    const unlink = await call('/api/integrations/immich', { method: 'DELETE' })
    check(`unlinking Immich (got ${unlink.status}, then ${(await call('/api/photos/status')).json.immich})`, unlink.status === 200 && (await call('/api/photos/status')).json.immich === null)
    const gone = await call('/api/photos/immich/buckets?tz=0')
    check(`unlinked: 409 (got ${gone.status})`, gone.status === 409)
  } finally {
    im.close()
  }
}

try {
  parserChecks()
  await seafileChecks()
  await immichChecks()
} catch (e) {
  check(`ran to the end (${(e as Error).stack})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  sf.close()
}
finish()
