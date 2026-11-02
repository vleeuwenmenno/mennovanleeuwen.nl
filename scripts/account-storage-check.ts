// Settings → Sync's storage (GET /api/account/storage, server/quota.ts) against a scratch server:
// the breakdown adds up to exactly what the quota counts (usedBytes, Settings → Users, checkRoom),
// with SQLite's own length rules (text in characters, blobs in bytes, base64 as stored), only for
// the session's own account, and never shows what is stored. Synthetic accounts only.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server } from './empires-harness.ts'

const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1', NOTIFY_WATCH: 'off' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256, setAppSetting } = await import('../server/db.ts')
const { checkRoom, usedBytes } = await import('../server/quota.ts')

/** SQLite's LENGTH of a TEXT: characters (code points), not bytes or UTF-16 units. */
const chars = (s: string) => [...s].length
const ok = (name: string) => console.log(`ok  ${name}`)
const db = database(), now = Date.now()
db.exec('PRAGMA busy_timeout = 5000')
const sid = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
type Report = { used: number | null; limit: number; remaining: number | null; over: boolean; complete: boolean; parts: { id: string; label: string; purpose: string; unit: string; bytes: number | null; count: number | null }[] }
try {
  await server.start()
  for (const [i, s] of sid.entries()) {
    db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(i + 1, i + 1, `storage-${i + 1}`, encrypt('none'), now, now)
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(s), i + 1, now, now + 86400_000)
  }
  const expired = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(expired), now - 10, now - 5)
  const call = async (path: string, who: string | null = sid[0], headers: Record<string, string> = {}) => {
    const r = await fetch(server.origin + path, { headers: { ...(who ? { Cookie: `mvlos_sid=${who}` } : {}), ...headers } })
    return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) as any }
  }

  // An empty account: every part zero, nothing over.
  const empty = (await call('/api/account/storage')).body as Report
  assert.equal(empty.used, 0); assert.equal(empty.complete, true); assert.ok(empty.parts.every((p) => p.bytes === 0 && p.count === 0))
  assert.equal(empty.remaining, empty.limit); assert.equal(empty.limit, 2048 * 1024 * 1024)
  ok('empty account: zero everywhere, the default 2 GB limit, all of it left')

  // One of everything, with text that is not ASCII and a picture kept as base64.
  const secret = 'SECRET-🔑-do-not-show'
  const expect: Record<string, { bytes: number; count: number }> = {}
  const add = (id: string, bytes: number, count = 1) => { expect[id] = { bytes: (expect[id]?.bytes ?? 0) + bytes, count: (expect[id]?.count ?? 0) + count } }
  const stateRows: [string, string][] = [['xq-private-notes', JSON.stringify({ text: `Ünïcödé 🎉 ${secret}` })], ['xq-private-dock', '["files","agents"]']]
  for (const [k, v] of stateRows) { db.prepare('INSERT INTO state (user_id, key, value, updated_at) VALUES (1, ?, ?, ?)').run(k, v, now); add('settings', chars(k) + chars(v)) }
  const thread = randomUUID()
  db.prepare('INSERT INTO agent_threads (id, user_id, title, mode, model, archived, created_at, updated_at) VALUES (?, 1, ?, ?, ?, 0, ?, ?)').run(thread, `Title ${secret}`, 'quick', 'x', now, now)
  const picture = randomBytes(3000).toString('base64')
  const attachments = JSON.stringify([{ name: 'p.png', source: 'Sent', kind: 'image', mime: 'image/png', size: 3000, data: picture }])
  const m1 = db.prepare('INSERT INTO agent_messages (thread_id, role, content, thinking, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(thread, 'assistant', 'Héllo 👋🏽 wörld', 'ponder ✓', '[{"id":"c"}]', now).lastInsertRowid
  add('messages', chars('Héllo 👋🏽 wörld') + chars('ponder ✓') + chars('[{"id":"c"}]'))
  const m2 = db.prepare('INSERT INTO agent_messages (thread_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)').run(thread, 'user', 'look', attachments, now).lastInsertRowid
  add('messages', chars('look')); add('files', chars(attachments))
  expect.messages.count = 2; expect.files.count = 1
  db.prepare('INSERT INTO agent_image_source_aliases (source_id, message_id) VALUES (?, ?)').run('attachment:1:0', m2); add('references', chars('attachment:1:0') + 16)
  void m1
  const maskBody = randomBytes(700), details = JSON.stringify({ note: 'ünï ✂' })
  db.prepare('INSERT INTO agent_image_masks (id, thread_id, source_id, body, width, height, created_at, details) VALUES (?, ?, ?, ?, 8, 8, ?, ?)').run(randomUUID(), thread, 's', maskBody, now, details)
  add('masks', maskBody.length + Buffer.byteLength(details))
  const imageBody = randomBytes(5000), metadata = JSON.stringify({ prompt: 'a ☕ cup' })
  db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), thread, 'i.png', imageBody, now, metadata); add('images', imageBody.length + chars(metadata))
  const icon = randomBytes(900)
  db.prepare('INSERT INTO agent_icons (user_id, slug, prompt, body, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)').run('cup', 'a cup ☕', icon, now, now); add('icons', icon.length + chars('a cup ☕') + chars('cup'))
  const found = randomBytes(1200)
  db.prepare('INSERT INTO agent_found_images (user_id, id, source_url, page_url, title, mime, width, height, hash, body, created_at, used_at) VALUES (1, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)').run('w1', 'https://example.test/a.png', null, 'Tïtle', 'image/png', 'h', found, now, now)
  add('found', found.length + chars('https://example.test/a.png') + chars('Tïtle'))
  db.prepare('INSERT INTO agent_memories (user_id, text, category, created_at) VALUES (1, ?, ?, ?)').run('likes ☕ and 🎉', 'taste', now); add('memories', chars('likes ☕ and 🎉') + chars('taste'))
  const projectData = JSON.stringify({ clips: ['ü'] })
  db.prepare('INSERT INTO agent_video_projects (id, user_id, title, data, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)').run(randomUUID(), 'Fïlm', projectData, now, now); add('projects', chars('Fïlm') + chars(projectData))
  const frame = randomBytes(2500)
  db.prepare('INSERT INTO agent_video_sources (id, user_id, name, mime, body, width, height, created_at) VALUES (?, 1, ?, ?, ?, 1, 1, ?)').run(randomUUID(), 'k.png', 'image/png', frame, now); add('keyframes', frame.length)
  db.prepare('INSERT INTO agent_videos (id, user_id, name, bytes, width, height, frames, fps, settings, created_at) VALUES (?, 1, ?, ?, 1, 1, 1, 1, ?, ?)').run(randomUUID(), 'v.mp4', 123456, '{"é":1}', now); add('videos', 123456 + chars('{"é":1}'))
  // The other account has a little of its own.
  db.prepare('INSERT INTO state (user_id, key, value, updated_at) VALUES (2, ?, ?, ?)').run('notes', 'theirs', now)

  const res = await call('/api/account/storage')
  assert.equal(res.status, 200); assert.equal(res.cache, 'private, no-store')
  const report = res.body as Report
  const total = Object.values(expect).reduce((n, e) => n + e.bytes, 0)
  for (const p of report.parts) assert.deepEqual({ bytes: p.bytes, count: p.count }, expect[p.id] ?? { bytes: 0, count: 0 }, `${p.id}`)
  assert.equal(report.used, total, 'the parts add up to the total')
  assert.equal(report.parts.reduce((n, p) => n + p.bytes!, 0), report.used)
  assert.equal(usedBytes(1), report.used, 'the same as the quota (usedBytes, checkRoom)')
  assert.equal(report.remaining, report.limit - total)
  ok(`breakdown = usedBytes = ${total} B: Unicode text in characters, blobs in bytes, mask details as bytes, references +16, base64 as stored, recorded video size`)

  const admin = await call('/api/admin/users')
  assert.equal(admin.status, 200)
  const listed = (admin.body.users ?? admin.body).find((u: { id: number }) => u.id === 1)
  assert.equal(listed.storageBytes, report.used, 'Settings → Users shows the same figure')
  ok('Settings → Users (admin) shows the same total')

  const text = JSON.stringify(report)
  for (const leak of ['SECRET', secret, 'xq-private', 'attachment:1:0', 'example.test', 'cup', picture.slice(0, 40), 'Title']) assert.ok(!text.includes(leak), `does not show ${leak}`)
  assert.deepEqual(Object.keys(report).sort(), ['complete', 'limit', 'over', 'parts', 'remaining', 'used'])
  for (const p of report.parts) assert.deepEqual(Object.keys(p).sort(), ['bytes', 'count', 'id', 'label', 'purpose', 'unit'])
  ok('only fixed labels, purposes, units and numbers: no keys, values, titles, URLs or picture data')

  // Only the session's account, whatever is asked.
  const theirs = (await call('/api/account/storage?user=1&userId=1&id=1', sid[1])).body as Report
  assert.equal(theirs.used, chars('notes') + chars('theirs')); assert.equal(usedBytes(2), theirs.used)
  assert.equal((await call('/api/account/storage', null)).status, 401, 'signed out')
  assert.equal((await call('/api/account/storage', expired)).status, 401, 'expired session')
  assert.equal((await call('/api/account/storage', sid[0], { 'X-MvL-Account': '2' })).status, 409, 'a page of another account')
  ok('own account only (query parameters ignored); signed-out, expired and other-account pages refused')

  // checkRoom refuses exactly past the limit; over the limit the real figure still shows.
  setAppSetting('user_storage_mb', '1')
  const limit = 1024 * 1024, user = { id: 1 } as Parameters<typeof checkRoom>[0]
  assert.doesNotThrow(() => checkRoom(user, limit - total))
  assert.throws(() => checkRoom(user, limit - total + 1), /storage is full/)
  db.prepare('INSERT INTO agent_video_sources (id, user_id, name, mime, body, width, height, created_at) VALUES (?, 1, ?, ?, ?, 1, 1, ?)').run(randomUUID(), 'big.png', 'image/png', randomBytes(limit), now)
  const over = (await call('/api/account/storage')).body as Report
  assert.equal(over.over, true); assert.equal(over.remaining, 0); assert.equal(over.used, total + limit); assert.equal(over.limit, limit)
  assert.equal(over.used, usedBytes(1))
  ok('checkRoom boundary unchanged; over the limit: used stays real, remaining clamps to 0')

  // A store that can't be read is unknown, not zero; the quota itself still refuses to guess.
  db.exec('DROP TABLE agent_icons')
  const partial = (await call('/api/account/storage')).body as Report
  assert.equal(partial.complete, false); assert.equal(partial.used, null); assert.equal(partial.remaining, null); assert.equal(partial.over, false)
  assert.equal(partial.parts.find((p) => p.id === 'icons')!.bytes, null)
  assert.equal(partial.parts.find((p) => p.id === 'images')!.bytes, expect.images.bytes)
  assert.throws(() => usedBytes(1), /no such table/)
  ok('a missing store: that part and the total are unknown (null), others still shown; usedBytes still throws as before')
} finally {
  await server.dispose()
}
