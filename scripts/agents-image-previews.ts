// Picture previews (server/imagePreview.ts) against a scratch server: originals stay byte for byte,
// previews keep shape and alpha, odd PNGs fall back to the original once, and only the signed-in
// owner gets either. Synthetic pictures and accounts only.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { Server } from './empires-harness.ts'
import { decodePng } from '../server/pngResize.ts'
import { previewPng } from '../server/imagePreviewWorker.ts'

const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', NOTIFY_WATCH: 'off' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0)
  return Buffer.concat([head, body, crc])
}
type Opts = { color?: number; depth?: number; interlace?: number; extra?: Buffer[]; pixel?: (x: number, y: number) => number[]; truncate?: boolean; claim?: [number, number] }
/** A PNG of `w`×`h`; `pixel` gives each pixel's samples for the colour type. */
function png(w: number, h: number, o: Opts = {}) {
  const color = o.color ?? 2, depth = o.depth ?? 8
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color as 0 | 2 | 3 | 4 | 6]
  const bytesPer = (depth / 8) * channels
  const raw = Buffer.alloc((w * bytesPer + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * bytesPer + 1)
    for (let x = 0; x < w; x++) {
      const px = o.pixel?.(x, y) ?? [(x * 255) / w, (y * 255) / h, 128, 255].slice(0, channels)
      for (let c = 0; c < channels; c++) {
        if (depth === 16) raw.writeUInt16BE(Math.round(px[c]) * 257, row + 1 + (x * channels + c) * 2)
        else raw[row + 1 + x * channels + c] = Math.round(px[c])
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(o.claim?.[0] ?? w, 0); ihdr.writeUInt32BE(o.claim?.[1] ?? h, 4)
  ihdr[8] = depth; ihdr[9] = color; ihdr[12] = o.interlace ?? 0
  let idat = deflateSync(raw, { level: 1 })
  if (o.truncate) idat = idat.subarray(0, idat.length >> 1)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(o.extra ?? []), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}
/** An eXIf chunk saying the picture is turned (6: 90° clockwise). */
const exif = (orientation: number) => {
  const b = Buffer.alloc(26)
  b.write('MM', 0, 'latin1'); b.writeUInt16BE(42, 2); b.writeUInt32BE(8, 4); b.writeUInt16BE(1, 8)
  b.writeUInt16BE(0x0112, 10); b.writeUInt16BE(3, 12); b.writeUInt32BE(1, 14); b.writeUInt16BE(orientation, 18)
  return chunk('eXIf', b)
}
/** A small but valid ICC v2 display profile for 'GRAY' (white point, grey curve) or 'RGB ' (plus colorants and curves). */
function icc(space: 'GRAY' | 'RGB ') {
  const xyz = (x: number, y: number, z: number) => { const b = Buffer.alloc(20); b.write('XYZ ', 0, 'latin1'); [x, y, z].forEach((v, i) => b.writeInt32BE(Math.round(v * 65536), 8 + i * 4)); return b }
  const curv = Buffer.alloc(16); curv.write('curv', 0, 'latin1'); curv.writeUInt32BE(1, 8); curv.writeUInt16BE(0x0233, 12) // gamma 2.2
  const tags: [string, Buffer][] = space === 'GRAY'
    ? [['wtpt', xyz(0.9642, 1, 0.8249)], ['kTRC', curv]]
    : [['wtpt', xyz(0.9642, 1, 0.8249)], ['rXYZ', xyz(0.4361, 0.2225, 0.0139)], ['gXYZ', xyz(0.3851, 0.7169, 0.0971)], ['bXYZ', xyz(0.1431, 0.0606, 0.7141)], ['rTRC', curv], ['gTRC', curv], ['bTRC', curv]]
  const table = Buffer.alloc(4 + tags.length * 12); table.writeUInt32BE(tags.length, 0)
  let offset = 128 + table.length
  const bodies: Buffer[] = []
  tags.forEach(([sig, body], i) => { table.write(sig, 4 + i * 12, 'latin1'); table.writeUInt32BE(offset, 8 + i * 12); table.writeUInt32BE(body.length, 12 + i * 12); bodies.push(body); offset += body.length })
  const head = Buffer.alloc(128)
  head.writeUInt32BE(offset, 0); head.writeUInt32BE(0x02100000, 8); head.write('mntr', 12, 'latin1'); head.write(space, 16, 'latin1'); head.write('XYZ ', 20, 'latin1'); head.write('acsp', 36, 'latin1')
  ;[0.9642, 1, 0.8249].forEach((v, i) => head.writeInt32BE(Math.round(v * 65536), 68 + i * 4))
  return Buffer.concat([head, table, ...bodies])
}
const iccp = (profile: Buffer) => chunk('iCCP', Buffer.concat([Buffer.from('bench profile\0\0', 'latin1'), deflateSync(profile)]))
/** The PNG with one byte of chunk `type`'s CRC flipped. */
function badCrc(bytes: Buffer, type: string) {
  const out = Buffer.from(bytes)
  for (let at = 8; at + 12 <= out.length;) {
    const length = out.readUInt32BE(at)
    if (out.toString('latin1', at + 4, at + 8) === type) { out[at + 8 + length + 3] ^= 0xff; return out }
    at += 12 + length
  }
  throw new Error(`no ${type}`)
}
const noise = (seed: number) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }

const db = database(), now = Date.now()
db.exec('PRAGMA busy_timeout = 5000')
const sessions = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
const results: string[] = []
const pass = (name: string) => { results.push(name); console.log(`ok  ${name}`) }
try {
  await server.start()
  for (const [i, sid] of sessions.entries()) {
    const user = i === 2 ? 1 : i + 1
    if (i < 2) db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(user, user, `preview-${user}`, encrypt('none'), now, now)
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), user, now, now + 86400_000)
  }
  const expired = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(expired), now - 10, now - 5)
  const thread = (user: number, quick = 0) => {
    const id = randomUUID()
    db.prepare('INSERT INTO agent_threads (id, user_id, title, mode, model, archived, created_at, updated_at, quick) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)').run(id, user, 'Preview check', 'quick', 'x', now, now, quick)
    return id
  }
  const mine = thread(1), theirs = thread(2), studio = thread(1, 2)
  const image = (t: string, bytes: Buffer) => {
    const id = randomUUID()
    db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, t, `${id}.png`, bytes, now)
    return id
  }
  const get = async (path: string, who: string | null = sessions[0], method = 'GET') => {
    const t0 = performance.now()
    const r = await fetch(server.origin + path, { method, headers: who ? { Cookie: `mvlos_sid=${who}` } : {} })
    const body = Buffer.from(await r.arrayBuffer())
    return { status: r.status, body, ms: performance.now() - t0, mark: r.headers.get('x-preview'), cache: r.headers.get('cache-control'), type: r.headers.get('content-type'), length: r.headers.get('content-length') }
  }

  // 1. Shape, alpha and colour keys survive; the original is untouched.
  const r = noise(7)
  const wide = png(1536, 1024, { pixel: (x, y) => [(x * 255) / 1536, (y * 255) / 1024, r() * 255] })
  const wideId = image(mine, wide)
  const orig = await get(`/api/agents/images/${wideId}`)
  assert.equal(orig.status, 200); assert.equal(hash(orig.body), hash(wide), 'the original is sent byte for byte'); assert.equal(orig.cache, 'private, no-store')
  const head = await get(`/api/agents/images/${wideId}`, sessions[0], 'HEAD')
  assert.equal(head.status, 200); assert.equal(head.length, String(wide.length)); assert.equal(head.body.length, 0)
  pass('original GET is byte-identical and no-store; HEAD gives its length without a body')
  for (const size of [384, 768]) {
    const p = await get(`/api/agents/images/${wideId}/preview/${size}`)
    assert.equal(p.status, 200); assert.equal(p.mark, String(size)); assert.equal(p.cache, 'private, no-store'); assert.equal(p.type, 'image/png')
    const d = decodePng(p.body)
    assert.deepEqual([d.width, d.height], [size, Math.round((size * 1024) / 1536)], 'the longer side is the size, the shape kept')
    assert.ok(p.body.length < wide.length / 4, `a ${size} preview is far smaller (${p.body.length} of ${wide.length} bytes)`)
  }
  const again = await get(`/api/agents/images/${wideId}/preview/384`)
  assert.equal(again.mark, '384'); assert.equal(hash(again.body), hash((await get(`/api/agents/images/${wideId}/preview/384`)).body))
  assert.equal(hash((await get(`/api/agents/images/${wideId}`)).body), hash(wide), 'the original is unchanged after previews were made')
  pass('previews: 384 and 768 on the longer side, aspect kept, no-store, repeat loads identical')

  const alpha = png(800, 400, { color: 6, pixel: (x) => [200, 30, 30, x < 400 ? 0 : 255] })
  const ad = decodePng((await get(`/api/agents/images/${image(mine, alpha)}/preview/384`)).body)
  assert.equal(ad.data[3], 0, 'the transparent half stays transparent'); assert.equal(ad.data[(ad.width - 1) * 4 + 3], 255)
  const greyKey = png(800, 800, { color: 0, extra: [chunk('tRNS', Buffer.from([0, 0]))], pixel: (x) => [x < 400 ? 0 : 180] })
  const gd = decodePng((await get(`/api/agents/images/${image(mine, greyKey)}/preview/384`)).body)
  assert.equal(gd.data[3], 0, 'grey tRNS key becomes transparent'); assert.equal(gd.data[(gd.width - 1) * 4 + 3], 255); assert.equal(gd.data[(gd.width - 1) * 4], 180)
  const rgbKey = png(800, 800, { color: 2, extra: [chunk('tRNS', Buffer.from([0, 1, 0, 2, 0, 3]))], pixel: (x) => (x < 400 ? [1, 2, 3] : [90, 90, 90]) })
  const rd = decodePng((await get(`/api/agents/images/${image(mine, rgbKey)}/preview/384`)).body)
  assert.equal(rd.data[3], 0, 'RGB tRNS key becomes transparent'); assert.equal(rd.data[(rd.width - 1) * 4 + 3], 255)
  const palette = png(600, 600, { color: 3, extra: [chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])), chunk('tRNS', Buffer.from([128]))], pixel: (x) => [x < 300 ? 0 : 1] })
  const pd = decodePng((await get(`/api/agents/images/${image(mine, palette)}/preview/384`)).body)
  assert.deepEqual([...pd.data.subarray(0, 4)], [255, 0, 0, 128], 'palette colours and their alpha'); assert.deepEqual([...pd.data.subarray((pd.width - 1) * 4, pd.width * 4)], [0, 0, 255, 255])
  const srgb = png(800, 800, { extra: [chunk('sRGB', Buffer.from([0])), chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]))] })
  const sp = (await get(`/api/agents/images/${image(mine, srgb)}/preview/384`)).body
  assert.ok(sp.includes(Buffer.from('sRGB')) && sp.includes(Buffer.from('gAMA')), 'colour-space chunks are kept')
  const text = png(800, 800, { extra: [chunk('tEXt', Buffer.from('prompt\0a private prompt'))] })
  assert.ok(!(await get(`/api/agents/images/${image(mine, text)}/preview/384`)).body.includes(Buffer.from('private prompt')), 'text metadata is not copied')
  const rgbProfile = iccp(icc('RGB '))
  const withProfile = await get(`/api/agents/images/${image(mine, png(800, 800, { extra: [rgbProfile] }))}/preview/384`)
  assert.equal(withProfile.mark, '384'); assert.ok(withProfile.body.includes(rgbProfile), 'an RGB picture keeps its ICC profile, byte for byte')
  pass('alpha, grey and RGB tRNS keys, palettes, colour chunks and RGB ICC profiles kept; text chunks dropped')

  // 2. What it can't shrink faithfully gets the original, once (no redirect, no retry).
  const odd: [string, Buffer][] = [
    ['EXIF-rotated', png(800, 600, { extra: [exif(6)] })],
    ['16-bit', png(800, 600, { depth: 16 })],
    ['interlaced', png(800, 600, { interlace: 1 })],
    ['animated', png(800, 600, { extra: [chunk('acTL', Buffer.alloc(8))] })],
    ['truncated', png(800, 600, { truncate: true })],
    ['header claims 20000² pixels', png(64, 64, { claim: [20000, 20000] })],
    ['header claims 6000×4000 (over the pixel cap)', png(64, 64, { claim: [6000, 4000] })],
    ['already small', png(300, 200)],
    ['damaged IHDR CRC', badCrc(png(800, 600), 'IHDR')],
    ['damaged IDAT CRC', badCrc(png(800, 600), 'IDAT')],
    ['an unknown critical chunk', png(800, 600, { extra: [chunk('BLOB', Buffer.from('?'))] })],
    ['PLTE in a grey picture', png(800, 600, { color: 0, extra: [chunk('PLTE', Buffer.from([1, 2, 3]))] })],
    ['grey with a GRAY ICC profile', png(800, 600, { color: 0, extra: [iccp(icc('GRAY'))] })],
    ['grey + alpha with a GRAY ICC profile', png(800, 600, { color: 4, extra: [iccp(icc('GRAY'))] })],
    ['not a PNG', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(5000)])],
  ]
  for (const [name, bytes] of odd) {
    const id = image(mine, bytes)
    const p = await get(`/api/agents/images/${id}/preview/384`)
    assert.equal(p.status, 200, name); assert.equal(p.mark, 'original', name); assert.equal(hash(p.body), hash(bytes), `${name}: the original bytes`)
    assert.equal(p.cache, 'private, no-store')
  }
  // Each is declined for its own reason, not by accident (the worker's function, in this process).
  const reasons: Record<string, string> = { 'damaged IHDR CRC': 'crc', 'damaged IDAT CRC': 'crc', 'an unknown critical chunk': 'unknown critical chunk', 'PLTE in a grey picture': 'malformed', 'grey with a GRAY ICC profile': 'grey profile', 'grey + alpha with a GRAY ICC profile': 'grey profile', 'EXIF-rotated': 'orientation', 'animated': 'animated' }
  for (const [name, bytes] of odd) if (reasons[name]) assert.throws(() => previewPng(bytes, 384, 4096 * 4096, 2 << 20), (e: Error) => e.message === reasons[name], name)
  assert.ok(previewPng(png(800, 600, { color: 0 }), 384, 4096 * 4096, 2 << 20).png.length > 0, 'the same grey picture without a profile is shrunk')
  assert.equal((await get(`/api/agents/images/${wideId}/preview/500`)).status, 404, 'only the two sizes')
  pass(`falls back to the exact original once: ${odd.map(([n]) => n).join(', ')}`)

  // 3. Only the signed-in owner, also from the cache; a deleted picture is gone from it.
  const wp = `/api/agents/images/${wideId}/preview/384`
  assert.equal((await get(wp, sessions[1])).status, 404, 'another account (after the owner warmed the cache)')
  assert.equal((await get(`/api/agents/images/${wideId}`, sessions[1])).status, 404)
  assert.equal((await get(wp, null)).status, 401, 'signed out')
  assert.equal((await get(wp, expired)).status, 401, 'expired session')
  const studioId = image(studio, wide)
  assert.equal((await get(`/api/agents/images/${studioId}/preview/384`)).mark, '384', 'Image Studio pictures too')
  const theirId = image(theirs, wide)
  assert.equal((await get(`/api/agents/images/${theirId}/preview/384`)).status, 404)
  assert.equal((await get(`/api/agents/images/${theirId}/preview/384`, sessions[1])).mark, '384')
  db.prepare('DELETE FROM agent_images WHERE id = ?').run(wideId)
  assert.equal((await get(wp)).status, 404, 'deleted: the cached preview is not served')
  pass('owner only (cache hits rechecked), signed-out and expired denied, deleted pictures 404')

  // 4. Pictures kept with messages: a gpt-image PNG gets previews; a JPEG gets the original exactly.
  const gptBytes = png(1024, 1536, { pixel: (x, y) => [x % 256, y % 256, 99] })
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(4000), Buffer.from([0xff, 0xd9])])
  const files = [
    { name: 'drawn.png', source: 'Made with gpt-image', kind: 'image', mime: 'image/png', size: gptBytes.length, data: gptBytes.toString('base64'), ref: 'gpt:abc' },
    { name: 'photo.jpg', source: 'Sent', kind: 'image', mime: 'image/jpeg', size: jpeg.length, data: jpeg.toString('base64') },
    { name: 'notes.txt', source: 'Sent', kind: 'text', mime: 'text/plain', size: 5, text: 'hello' },
  ]
  const msg = Number(db.prepare('INSERT INTO agent_messages (thread_id, role, content, tool_name, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(mine, 'tool', '{}', 'gpt_image', JSON.stringify(files), now).lastInsertRowid)
  const at = (i: number) => `/api/agents/threads/${mine}/messages/${msg}/attachments/${i}`
  assert.equal(hash((await get(at(0))).body), hash(gptBytes), 'the attachment original byte for byte')
  const gp = await get(`${at(0)}/preview/768`)
  assert.equal(gp.mark, '768'); const gd2 = decodePng(gp.body); assert.deepEqual([gd2.width, gd2.height], [512, 768])
  const jp = await get(`${at(1)}/preview/384`)
  assert.equal(jp.mark, 'original'); assert.equal(hash(jp.body), hash((await get(at(1))).body)); assert.equal(jp.type, 'image/jpeg')
  assert.equal((await get(`${at(2)}/preview/384`)).status, 404, 'a text file has no picture')
  assert.equal((await get(`${at(5)}/preview/384`)).status, 404)
  assert.equal((await get(`${at(0)}/preview/384`, sessions[1])).status, 404, 'another account')
  const view = JSON.parse((await get(`/api/agents/threads/${mine}`)).body.toString())
  assert.ok(!JSON.stringify(view).includes(files[0].data.slice(0, 200)), 'the thread JSON still carries no picture bytes')
  db.prepare('DELETE FROM agent_messages WHERE id = ?').run(msg)
  assert.equal((await get(`${at(0)}/preview/768`)).status, 404, 'deleted message: not from the cache')
  pass('message pictures: PNG previews, JPEG and others fall back to the exact original, owner only')

  // 5. A full queue: the requests past it get the original at once (no waiting, no error).
  const many = Array.from({ length: 24 }, (_, i) => image(mine, png(1600, 1600, { pixel: (x, y) => [(x * (i + 1)) % 256, y % 256, i * 9] })))
  const flood = await Promise.all(many.map((id) => get(`/api/agents/images/${id}/preview/384`)))
  const turned = flood.filter((f) => f.mark === 'original'), made = flood.filter((f) => f.mark === '384')
  assert.ok(flood.every((f) => f.status === 200), 'every request is answered')
  assert.ok(turned.length > 0 && made.length >= 12, `past 12 jobs the rest get the original (${made.length} previews, ${turned.length} originals)`)
  pass(`a full queue answers with the original at once: ${made.length} previews, ${turned.length} originals for 24 at the same moment`)

  // 6. Deleted while it is being decoded: 404, and nothing is cached for it.
  const slow = image(mine, png(3000, 3000, { pixel: (x, y) => [x % 256, (x + y) % 256, y % 256] }))
  const deleting = get(`/api/agents/images/${slow}/preview/384`)
  await new Promise((r) => setTimeout(r, 60))
  db.prepare('DELETE FROM agent_images WHERE id = ?').run(slow)
  const gone = await deleting
  assert.equal(gone.status, 404, 'deleted during its decode')
  assert.equal((await get(`/api/agents/images/${slow}/preview/384`)).status, 404)
  pass(`deleted during decoding: 404 after the job (${gone.ms.toFixed(0)} ms), not cached`)

  // 7. Signing out cancels the session's queued and running jobs; someone else's is not held up.
  const big = Array.from({ length: 10 }, (_, i) => image(mine, png(2600, 2600, { pixel: (x, y) => [(x + i) % 256, y % 256, (x ^ y) % 256] })))
  const solo = await get(`/api/agents/images/${big[0]}/preview/384`, sessions[2])
  assert.equal(solo.mark, '384')
  const each = solo.ms
  const pending = big.slice(1).map((id) => get(`/api/agents/images/${id}/preview/384`, sessions[2]).catch(() => ({ status: 0, mark: null, ms: 0 })))
  await new Promise((r) => setTimeout(r, Math.min(150, each / 2)))
  const out = await fetch(`${server.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: `mvlos_sid=${sessions[2]}`, Origin: server.origin } })
  assert.equal(out.status, 200)
  const t0 = performance.now()
  const other = await get(`/api/agents/images/${image(theirs, png(800, 800))}/preview/384`, sessions[1])
  const waited = performance.now() - t0
  const ended = await Promise.all(pending)
  assert.equal(other.mark, '384')
  assert.ok(ended.every((e) => e.status !== 200 || e.mark === null), `no signed-out job answered with a preview: ${ended.map((e) => e.status)}`)
  assert.ok(waited < each * 4, `the other account waited ${waited.toFixed(0)} ms, not the ~${(each * 9).toFixed(0)} ms of the cancelled queue`)
  pass(`sign-out cancels queued and running decodes (one decode ${each.toFixed(0)} ms; next account waited ${waited.toFixed(0)} ms)`)

  // 8. Past its deadline a job is stopped with its worker and the original is sent; the worker
  // comes back for the next job. (The server restarts with lower limits; sessions stay in its database.)
  const restart = async (env: Record<string, string>) => { await server.stop(); (server as unknown as { env: Record<string, string> }).env = { GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', NOTIFY_WATCH: 'off', ...env }; await server.start() }
  await restart({ IMAGE_PREVIEW_DEADLINE_MS: '30' })
  const late = image(mine, png(3000, 3000, { pixel: (x, y) => [y % 256, x % 256, 50] }))
  const overdue = await get(`/api/agents/images/${late}/preview/384`)
  assert.equal(overdue.mark, 'original', 'past the deadline: the original'); assert.ok(overdue.body.length > 1_000_000)
  const tiny = await get(`/api/agents/images/${image(mine, png(400, 400))}/preview/384`)
  assert.equal(tiny.status, 200, 'the next job is answered after the worker was stopped')
  pass(`deadline: a 3000² decode past 30 ms gets the original (${overdue.ms.toFixed(0)} ms) and the worker is replaced`)

  // 9. The cache holds what fits and drops the least recently used.
  const sample = png(800, 800, { pixel: (x, y) => [x % 256, y % 256, 77] })
  await restart({})
  const one = (await get(`/api/agents/images/${image(mine, sample)}/preview/384`)).body.length
  await restart({ IMAGE_PREVIEW_CACHE_BYTES: String(Math.floor(one * 1.5)) })
  const [a, bId] = [image(mine, sample), image(mine, sample)]
  const cacheOf = async (id: string) => (await fetch(`${server.origin}/api/agents/images/${id}/preview/384`, { headers: { Cookie: `mvlos_sid=${sessions[0]}` } })).headers.get('x-preview-cache')
  assert.deepEqual([await cacheOf(a), await cacheOf(a), await cacheOf(bId), await cacheOf(bId), await cacheOf(a)], ['miss', 'hit', 'miss', 'hit', 'miss'], 'room for one preview: the older one is dropped')
  pass(`cache bytes bounded: with room for one ${one}-byte preview, the second evicts the first`)

  console.log(`\n${results.length} groups passed`)
} finally {
  await server.dispose()
}
