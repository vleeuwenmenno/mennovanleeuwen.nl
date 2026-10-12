// Checks /api/seafile/stream, which the music and video players play Seafile files from. Seafile's
// file server ignores Range for encrypted libraries (it always answers 200 with the whole file),
// and a browser that gets no 206 cannot seek: the route has to answer ranges itself then. It
// starts the real server (server/index.ts) on a free port with a scratch DATA_DIR, a signed-in
// admin and a linked stand-in for Seafile with three libraries holding the same files:
//
//   - "encrypted": ignores Range, answers 200 with the whole file and its Content-Length,
//   - "encrypted, no length": the same without Content-Length (the size comes from the file's
//     details instead),
//   - "plain": honours Range with 206 (or 416), as Seafile does for unencrypted libraries.
//
// For each it asks for no range, bytes=0-, bytes=100-199, bytes=1000-, bytes=-50 and a start past
// the end, and compares status, Content-Range, Content-Length, Content-Type and the exact bytes.
// It also checks that the request to Seafile goes when the browser hangs up halfway (and when a
// cut-out range is done), and that a locked library still answers 423.
//
//   node scripts/seafile-stream.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep, waitFor } from './empires-harness.ts'

// --- The files ------------------------------------------------------------------------------------

/** Byte i of every file here: no runs, so a range off by one shows. */
const byteAt = (i: number) => (Math.imul(i + 1, 2654435761) >>> 24) & 255
const bytes = (from: number, to: number) => Uint8Array.from({ length: to - from }, (_, k) => byteAt(from + k))

const SMALL = 300_000
const small = bytes(0, SMALL)
/** Too big to be read through before a hang-up arrives: made as it is sent, a chunk at a time. */
const BIG = 256 * 1024 * 1024
const CHUNK = 64 * 1024

const ENC = '11111111-1111-4111-8111-111111111111'
const NOLEN = '22222222-2222-4222-8222-222222222222'
const PLAIN = '33333333-3333-4333-8333-333333333333'
const LIBS = [
  { id: ENC, label: 'encrypted' },
  { id: NOLEN, label: 'encrypted, no length' },
  { id: PLAIN, label: 'plain' },
]

// --- The stand-in for Seafile ---------------------------------------------------------------------

type Download = { repo: string; file: string; range: string | null; sent: number; done: boolean; closed: boolean }
const downloads: Download[] = []
let detailAsked = 0
/** Seafile has forgotten the encrypted libraries' password (its hour is up). */
let forgotten = false

const seafile = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.pathname
  const json = (status: number, body: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  let m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/$/.exec(path)
  if (m) return json(200, { repo_id: m[1], encrypted: m[1] !== PLAIN })
  m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/set-password\/$/.exec(path)
  if (m && req.method === 'POST') return json(200, { success: true })
  m = /^\/api2\/repos\/([0-9a-f-]{36})\/file\/$/.exec(path)
  if (m) return json(200, `${base}/files/${m[1]}${url.searchParams.get('p')}`)
  m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/file\/detail\/$/.exec(path)
  if (m) {
    detailAsked++
    const p = url.searchParams.get('p') ?? ''
    return json(200, { name: p.slice(1), size: p === '/big.mp4' ? BIG : SMALL })
  }
  m = /^\/files\/([0-9a-f-]{36})\/(small\.mp4|big\.mp4|page\.html)$/.exec(path)
  if (m) return serve(m[1], m[2], req, res)
  res.writeHead(404).end()
})

/** A download from the file server, the way Seafile's fileop.go answers it. */
function serve(repo: string, file: string, req: IncomingMessage, res: ServerResponse) {
  const size = file === 'big.mp4' ? BIG : SMALL
  const range = typeof req.headers.range === 'string' ? req.headers.range : null
  const d: Download = { repo, file, range, sent: 0, done: false, closed: false }
  downloads.push(d)
  res.on('close', () => (d.closed = true))
  if (forgotten && repo !== PLAIN) return void res.writeHead(400).end('Repo is encrypted. Please provide password to view it.')
  const type = file === 'page.html' ? 'text/html' : 'video/mp4'
  let start = 0
  let end = size - 1
  let status = 200
  const headers: Record<string, string> = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }
  if (range && repo === PLAIN) {
    // parseRange in fileop.go: one range, a-, a-b or -n.
    const r = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(range)
    if (r) {
      start = r[3] ? Math.max(0, size - Number(r[3])) : Number(r[1])
      end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1
      if (start >= size || end < start) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      headers['Accept-Ranges'] = 'bytes'
    }
  }
  if (repo !== NOLEN) headers['Content-Length'] = String(end - start + 1)
  res.writeHead(status, headers)
  // Sent a chunk at a time, waiting for the other side, as a file server does.
  let at = start
  const pump = () => {
    while (at <= end && !d.closed) {
      const n = Math.min(CHUNK, end + 1 - at)
      const chunk = bytes(at, at + n)
      at += n
      d.sent += n
      if (at > end) {
        d.done = true
        res.end(chunk)
        return
      }
      if (!res.write(chunk)) return void res.once('drain', pump)
    }
  }
  pump()
}

await new Promise<void>((r) => seafile.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(seafile.address() as { port: number }).port}`

// --- The site, with a signed-in admin and Seafile linked ------------------------------------------

const LOGIN = 'stream-check'
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: LOGIN })
// The account, its session and the Seafile link go straight into the scratch database (the link
// encrypted with the scratch key, as Settings would store it), before the server opens it.
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
database()
  .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (1, ?, ?, ?)')
  .run('seafile', encrypt(JSON.stringify({ url: base, username: 'check@example.com', token: 'stand-in-token', name: 'Check', version: '12.0.0' })), now)
await server.start()

const cookie = { Cookie: `mvlos_sid=${sid}` }
const post = (path: string, body: unknown) => fetch(`${server.origin}${path}`, { method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json', Origin: server.origin }, body: JSON.stringify(body) })
const stream = (repo: string, file: string, init: { range?: string; method?: string; signal?: AbortSignal } = {}) =>
  fetch(`${server.origin}/api/seafile/stream?repo=${repo}&p=${encodeURIComponent(`/${file}`)}`, { method: init.method ?? 'GET', signal: init.signal, headers: { ...cookie, ...(init.range ? { Range: init.range } : {}) } })
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b))
/** The newest download of `file` from the stand-in, once it has started. */
const lastDownload = async (file: string, since: number) => {
  for (let i = 0; i < 100; i++) {
    const d = downloads.slice(since).findLast((x) => x.file === file)
    if (d) return d
    await sleep(20)
  }
  throw new Error(`no download of ${file} reached Seafile`)
}

/** One request for the small file: status, headers and the exact bytes. */
async function expect(lib: { id: string; label: string }, range: string | undefined, want: { status: number; from?: number; to?: number }) {
  const label = `${lib.label}, ${range ?? 'no range'}`
  const res = await stream(lib.id, 'small.mp4', { range })
  const body = new Uint8Array(await res.arrayBuffer())
  check(`${label}: status ${want.status} (got ${res.status})`, res.status === want.status)
  if (want.status === 416) {
    check(`${label}: Content-Range bytes */${SMALL} (got ${res.headers.get('content-range')})`, res.headers.get('content-range') === `bytes */${SMALL}`)
    check(`${label}: no body`, body.length === 0)
    return
  }
  const from = want.from ?? 0
  const to = want.to ?? SMALL - 1
  check(`${label}: Content-Type video/mp4 (got ${res.headers.get('content-type')})`, res.headers.get('content-type') === 'video/mp4')
  check(`${label}: Accept-Ranges bytes`, res.headers.get('accept-ranges') === 'bytes')
  const length = res.headers.get('content-length')
  if (want.status === 206) {
    check(`${label}: Content-Range bytes ${from}-${to}/${SMALL} (got ${res.headers.get('content-range')})`, res.headers.get('content-range') === `bytes ${from}-${to}/${SMALL}`)
    check(`${label}: Content-Length ${to - from + 1} (got ${length})`, length === String(to - from + 1))
  } else {
    check(`${label}: no Content-Range`, !res.headers.has('content-range'))
    // Without a length from Seafile the whole file goes out chunked.
    check(`${label}: Content-Length ${lib.id === NOLEN ? 'none' : SMALL} (got ${length})`, length === (lib.id === NOLEN ? null : String(SMALL)))
  }
  check(`${label}: the exact bytes ${from}-${to} (got ${body.length} bytes)`, same(body, small.subarray(from, to + 1)))
}

/** Hangs up after the first chunks of a long answer: the download from Seafile must stop too. */
async function hangUp(lib: { id: string; label: string }, range: string | undefined) {
  const label = `${lib.label}, ${range ?? 'no range'}`
  const since = downloads.length
  const gone = new AbortController()
  const res = await stream(lib.id, 'big.mp4', { range, signal: gone.signal })
  const reader = res.body!.getReader()
  let got = 0
  while (got < 1024 * 1024) got += (await reader.read()).value?.length ?? 0
  gone.abort()
  await reader.cancel().catch(() => {})
  const d = await lastDownload('big.mp4', since)
  await waitFor(`${label}: hanging up halfway closes the download from Seafile`, () => d.closed)
  check(`${label}: ...before Seafile sent the whole file (sent ${(d.sent / 1024 / 1024).toFixed(1)} of ${BIG / 1024 / 1024} MB)`, !d.done && d.sent < BIG)
}

try {
  // A locked library: 423 before anything streams, as before.
  const locked = await stream(ENC, 'small.mp4', { range: 'bytes=0-' })
  check(`locked library: 423 (got ${locked.status})`, locked.status === 423)
  check('locked library: says it is locked', ((await locked.json().catch(() => ({}))) as { error?: string }).error === 'Locked')
  for (const id of [ENC, NOLEN]) check(`unlocking ${id.slice(0, 8)}`, (await post('/api/seafile/unlock', { repo: id, password: 'pw', minutes: 30 })).ok)

  for (const lib of LIBS) {
    await expect(lib, undefined, { status: 200 })
    await expect(lib, 'bytes=0-', { status: 206 })
    await expect(lib, 'bytes=100-199', { status: 206, from: 100, to: 199 })
    await expect(lib, 'bytes=1000-', { status: 206, from: 1000 })
    await expect(lib, 'bytes=-50', { status: 206, from: SMALL - 50 })
    await expect(lib, `bytes=${SMALL + 10}-`, { status: 416 })
    await expect(lib, `bytes=${SMALL - 10}-${SMALL + 500}`, { status: 206, from: SMALL - 10 })
  }
  check(`no length from Seafile: the size came from the file's details (asked ${detailAsked} times)`, detailAsked > 0)

  // HEAD: the headers of the range, no body.
  const head = await stream(ENC, 'small.mp4', { method: 'HEAD', range: 'bytes=100-199' })
  check(`encrypted, HEAD bytes=100-199: 206 bytes 100-199/${SMALL} (got ${head.status} ${head.headers.get('content-range')})`, head.status === 206 && head.headers.get('content-range') === `bytes 100-199/${SMALL}`)

  // Only audio and video pass as what they are.
  const html = await stream(PLAIN, 'page.html')
  await html.arrayBuffer()
  check(`an HTML file goes out as application/octet-stream (got ${html.headers.get('content-type')})`, html.headers.get('content-type') === 'application/octet-stream')

  // Hanging up halfway (the browser does, all the time, while scrubbing).
  for (const lib of LIBS) {
    await hangUp(lib, undefined)
    await hangUp(lib, 'bytes=50000000-')
  }
  // A small range cut out of a big encrypted file: the rest is not read.
  for (const lib of [LIBS[0], LIBS[1]]) {
    const since = downloads.length
    const res = await stream(lib.id, 'big.mp4', { range: 'bytes=100-199' })
    const body = new Uint8Array(await res.arrayBuffer())
    check(`${lib.label}, big file, bytes=100-199: 206 and the exact bytes`, res.status === 206 && same(body, bytes(100, 200)))
    const d = await lastDownload('big.mp4', since)
    await waitFor(`${lib.label}, big file, bytes=100-199: the download from Seafile closes once the range is out`, () => d.closed)
    check(`${lib.label}, big file, bytes=100-199: ...before Seafile sent the whole file (sent ${(d.sent / 1024 / 1024).toFixed(1)} MB)`, !d.done)
  }

  // Seafile forgot the password before this side's lock did: still 423, not a broken file.
  forgotten = true
  const forgot = await stream(ENC, 'small.mp4', { range: 'bytes=1000-' })
  check(`Seafile forgot the password: 423 (got ${forgot.status})`, forgot.status === 423)
  forgotten = false

  // Locked again: 423 again.
  check('locking again', (await post('/api/seafile/lock', { repo: ENC })).ok)
  const relocked = await stream(ENC, 'small.mp4', { range: 'bytes=1000-' })
  check(`locked again: 423 (got ${relocked.status})`, relocked.status === 423)
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  seafile.closeAllConnections()
  seafile.close()
}
finish()
