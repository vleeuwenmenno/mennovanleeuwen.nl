// Scratch-only image exports through real Agents turns and a fake Seafile binary upload server.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'

type J = Record<string, any>
const REPO = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('exact binary\0fixture\xff', 'latin1')])
const files = new Map<string, Buffer>()
const uploads: { name: string; path: string; bytes: Buffer; replace: string; mime: string }[] = []
let duplicate = false, readOnly = false, locked = false, unauth = false, quota = false, hold = false, cancelled = 0, mutations = 0
let renameOnUpload = false
let base = ''
const remote = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://test')
  const answer = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  if (url.pathname === '/upload') {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type']! } }).formData()
    const file = form.get('file') as File, dir = String(form.get('parent_dir'))
    const savedName = renameOnUpload ? 'picture (1).png' : file.name
    const entry = { name: savedName, path: `${dir}/${savedName}`, bytes: Buffer.from(await file.arrayBuffer()), replace: String(form.get('replace')), mime: file.type }
    uploads.push(entry)
    if (hold) { res.on('close', () => cancelled++); return }
    if (quota) { answer(507, { error: 'Quota exhausted' }); return }
    if (files.has(entry.path) && entry.replace !== '1') { answer(409, { error: 'File exists' }); return }
    files.set(entry.path, entry.bytes); mutations++
    answer(200, [{ name: savedName, size: file.size, id: 'remote-file' }]); return
  }
  assert.equal(req.headers.authorization, 'Token fixture-token')
  if (unauth) { answer(401, { detail: 'Token expired' }); return }
  if (url.pathname === '/api/v2.1/repos/') { answer(200, { repos: [REPO, ...(duplicate ? [OTHER] : [])].map((repo_id) => ({ repo_id, repo_name: 'Home', type: 'mine', encrypted: locked, permission: readOnly ? 'r' : 'rw' })) }); return }
  if (url.pathname === `/api/v2.1/repos/${REPO}/dir/`) {
    const path = url.searchParams.get('p')
    if (!['/', '/Desktop', '/Desktop/18+'].includes(path!)) { answer(404, { error_msg: 'Folder absent' }); return }
    const dirent_list = path === '/' ? [{ type: 'dir', name: 'Desktop', id: 'desktop' }] : path === '/Desktop' ? [{ type: 'dir', name: '18+', id: 'folder' }] : [...files].map(([p, data]) => ({ type: 'file', name: p.split('/').at(-1), id: 'file', size: data.length }))
    answer(200, { user_perm: readOnly ? 'r' : 'rw', dirent_list }); return
  }
  if (url.pathname === `/api2/repos/${REPO}/upload-link/`) { answer(200, `${base}/upload`); return }
  // No implicit folder creation, deletion, model generation or other writes are allowed.
  throw new Error(`Unexpected Seafile request: ${req.method} ${req.url}`)
})
const chats: J[] = []
const ollama = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part
  const answer = (value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  if (req.url === '/api/tags') { answer({ models: [{ name: 'file-test' }] }); return }
  if (req.url === '/api/show') { answer({ capabilities: ['tools'], model_info: { 'x.context_length': 131072 } }); return }
  assert.equal(req.url, '/api/chat')
  const body = JSON.parse(raw); chats.push(body)
  if (body.stream === false) { answer({ message: { content: '{"title":"File export"}' } }); return }
  const at = body.messages.findLastIndex((m: J) => m.role === 'user' && m.content.startsWith('RUN '))
  const args = JSON.parse(body.messages[at].content.slice(4))
  const content = body.messages.slice(at + 1).some((m: J) => m.role === 'tool') ? { content: 'Saved result handled.' } : { content: '', tool_calls: [{ function: { name: 'save_generated_image', arguments: args } }] }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.end(JSON.stringify({ message: { role: 'assistant', ...content }, done: true }) + '\n')
})
const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
base = await listen(remote)
const server = new Server({ OLLAMA_URL: await listen(ollama), OLLAMA_API_KEY: 'fake', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'image-save-one,image-save-two', NOTIFY_WATCH: 'off' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const { prepareImageFileSave } = await import('../server/agentImageFiles.ts')
const db = database(), sessions = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
db.exec('PRAGMA busy_timeout = 5000')
const stamp = Date.now()
for (const [index, token] of sessions.entries()) {
  db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(index + 1, index + 1, index ? 'image-save-two' : 'image-save-one', encrypt('none'), stamp, stamp)
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), index + 1, stamp, stamp + 86400_000)
}
function link() { db.prepare("INSERT OR REPLACE INTO integrations (user_id, name, secret, created_at) VALUES (1, 'seafile', ?, ?)").run(encrypt(JSON.stringify({ url: base, token: 'fixture-token', username: 'fixture' })), stamp) }
link()
const api = async (method: string, path: string, body?: unknown, who = 0): Promise<J> => {
  const response = await fetch(server.origin + path, { method, headers: { Cookie: `mvlos_sid=${sessions[who]}`, ...await asPage(sessions[who]), Origin: server.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.ok(response.ok, `${response.status}: ${response.ok ? '' : await response.text()}`)
  return response.json()
}
async function turn(id: string, args: J, allow = true, hook?: () => void) {
  const res = await fetch(`${server.origin}/api/agents/threads/${id}/messages`, { method: 'POST', headers: { Cookie: `mvlos_sid=${sessions[0]}`, ...await asPage(sessions[0]), Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `RUN ${JSON.stringify(args)}` }) })
  assert.equal(res.status, 200)
  let buffer = '', approvals = 0, summary: J | undefined
  const decoder = new TextDecoder()
  for await (const data of res.body!) {
    buffer += decoder.decode(data, { stream: true }); let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (!line) continue
      const e = JSON.parse(line)
      if (e.type === 'approval') { approvals++; summary = e; hook?.(); await api('POST', `/api/agents/threads/${id}/approve`, { callId: e.callId, allow }) }
    }
  }
  const view = await api('GET', `/api/agents/threads/${id}`)
  return { approvals, summary, view, result: JSON.parse(view.messages.findLast((m: J) => m.toolName === 'save_generated_image')?.content ?? '{}') as J }
}
const until = async (test: () => boolean) => { for (let i = 0; i < 300 && !test(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(test(), 'Timed out') }
try {
  await server.start()
  const makeThread = (who = 0, permission = 'default') => api('POST', '/api/agents/threads', { model: 'file-test', permission, tools: ['images', 'seafile', 'seafile_write'] }, who)
  const source = await makeThread(), current = await makeThread(), foreign = await makeThread(1)
  const image = randomUUID(), alien = randomUUID()
  for (const [id, owner] of [[image, source.id], [alien, foreign.id]]) db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(id, owner, 'fixture.png', PNG, stamp, '{}')
  const args = { image_id: image, library: REPO, path: '/Desktop/18+/picture.png' }
  const beforeRows = db.prepare('SELECT count(*) AS n FROM agent_images').get()!.n
  let r = await turn(current.id, args)
  assert.equal(r.approvals, 1); assert.equal(r.result.saved, true)
  assert.deepEqual(uploads.at(-1)!.bytes, PNG); assert.equal(uploads.at(-1)!.mime, 'image/png'); assert.equal(uploads.at(-1)!.replace, '0')
  assert.equal(r.result.path, args.path); assert.equal(r.result.library.id, REPO); assert.equal(r.result.bytes, PNG.length)
  assert.equal(r.result.url, `/api/seafile/stream?repo=${REPO}&p=${encodeURIComponent(args.path)}`)
  assert.ok(JSON.stringify(r.summary).includes(args.path) && JSON.stringify(r.summary).includes(image))
  assert.equal(r.view.messages.at(-1).role, 'assistant') // Saving permits a response; generation's silent rule is unchanged.
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_images').get()!.n, beforeRows)
  assert.deepEqual(Buffer.from(db.prepare('SELECT body FROM agent_images WHERE id = ?').get(image)!.body as Uint8Array), PNG)
  assert.ok(!JSON.stringify(chats).includes(PNG.toString('base64')) && !JSON.stringify(chats).includes('fixture-token'))
  console.log('PASS owner-wide exact PNG transfer, concrete approval/path/metadata, no model bytes, artifact unchanged and normal reply')
  const before = uploads.length
  for (const [bad, error] of [
    [{ ...args, image_id: alien }, /No generated image/],
    [{ ...args, path: '/Desktop/../escape.png' }, /absolute file path/],
    [{ ...args, path: '/Desktop\\escape.png' }, /absolute file path/],
    [{ ...args, path: '/Desktop//a.png' }, /absolute file path/],
    [{ ...args, path: '/Desktop/./a.png' }, /absolute file path/],
    [{ ...args, path: '/Desktop/18+/a\u0000.png' }, /absolute file path/],
    [{ ...args, path: '/Desktop/18+/AGENTS.md' }, /\.png/],
    [{ ...args, path: '/missing/picture.png' }, /does not exist/],
    [{ ...args, content: 'pretend PNG' }, /never supply/],
    [{ ...args, overwrite: 'yes' }, /optional boolean/],
    [args, /exists already/],
  ] as [J, RegExp][]) { r = await turn(current.id, bad); assert.match(r.result.error, error); assert.equal(r.approvals, 0) }
  assert.equal(uploads.length, before)
  r = await turn(current.id, { ...args, overwrite: true }); assert.equal(r.result.replaced, true); assert.equal(uploads.at(-1)!.replace, '1')
  const huge = randomUUID(); db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at) VALUES (?, ?, ?, zeroblob(?), ?)').run(huge, source.id, 'large.png', 20 * 1024 * 1024 + 1, stamp)
  r = await turn(current.id, { ...args, image_id: huge }); assert.match(r.result.error, /20 MiB/)
  db.prepare('DELETE FROM agent_images WHERE id = ?').run(huge)
  duplicate = true; r = await turn(current.id, { ...args, library: 'Home' }); assert.match(r.result.error, /ambiguous/); duplicate = false
  readOnly = true; r = await turn(current.id, args); assert.match(r.result.error, /read-only/); readOnly = false
  locked = true; r = await turn(current.id, args); assert.match(r.result.error, /locked/); locked = false
  unauth = true; r = await turn(current.id, args); assert.match(r.result.error, /no longer accepts the token/); unauth = false
  const beforeDenied = mutations
  r = await turn(current.id, { ...args, path: '/Desktop/18+/denied.png' }, false); assert.equal(r.approvals, 1); assert.match(r.result.error, /declined/); assert.equal(mutations, beforeDenied)
  const plan = await makeThread(0, 'plan'); r = await turn(plan.id, args); assert.match(r.result.error, /switched off|Plan mode/); assert.equal(r.approvals, 0); assert.equal(mutations, beforeDenied)
  const race = '/Desktop/18+/race.png'
  r = await turn(current.id, { ...args, path: race }, true, () => files.set(race, Buffer.from('keep'))); assert.match(r.result.error, /exists already/); assert.equal(files.get(race)!.toString(), 'keep')
  r = await turn(current.id, { ...args, path: '/Desktop/18+/changed-account.png' }, true, link); assert.match(r.result.error, /account changed/)
  quota = true; r = await turn(current.id, { ...args, path: '/Desktop/18+/quota.png' }); assert.match(r.result.error, /quota or space exhausted/); assert.ok(!files.has('/Desktop/18+/quota.png')); quota = false
  renameOnUpload = true; r = await turn(current.id, { ...args, path: '/Desktop/18+/concurrent.png' }); renameOnUpload = false
  assert.equal(r.result.path, '/Desktop/18+/picture (1).png'); assert.match(r.result.warning, /requested name became occupied/); assert.ok(!files.has('/Desktop/18+/concurrent.png'))
  console.log('PASS ownership, paths, missing folders, conflict/overwrite, race, approval denial, Plan, size, library ambiguity/permissions/lock/auth, quota and account binding')
  for (const tools of [['images', 'seafile'], ['seafile', 'seafile_write']]) {
    await api('PATCH', `/api/agents/threads/${current.id}`, { tools }); r = await turn(current.id, args); assert.match(r.result.error, /switched off/)
    const offered = chats.findLast((c) => c.tools)?.tools.map((t: J) => t.function.name)
    assert.ok(!offered?.includes('save_generated_image'))
  }
  await api('PATCH', `/api/agents/threads/${current.id}`, { tools: ['images', 'seafile', 'seafile_write'], permission: 'bypass' })
  db.prepare("DELETE FROM integrations WHERE user_id = 1 AND name = 'seafile'").run()
  r = await turn(current.id, args); assert.match(r.result.error, /switched off/)
  await assert.rejects(prepareImageFileSave({ id: 1, admin: true } as any, args, new AbortController().signal), /Link Seafile.*Browser-local/)
  link()
  hold = true
  const beforeHeld = uploads.length, pending = turn(current.id, { ...args, path: '/Desktop/18+/cancelled.png' })
  await until(() => uploads.length > beforeHeld)
  await api('POST', `/api/agents/threads/${current.id}/stop`, {})
  await pending; await until(() => cancelled > 0); hold = false
  assert.ok(!files.has('/Desktop/18+/cancelled.png'))
  const cancelledSignal = AbortSignal.abort()
  await assert.rejects(prepareImageFileSave({ id: 1, admin: true } as any, { ...args, path: '/Desktop/18+/pre-cancel.png' }, cancelledSignal), /abort/i)
  assert.equal((await fetch(`${server.origin}/api/agents/images/${image}`)).status, 401)
  assert.equal((await api('GET', `/api/agents/threads/${current.id}`)).thread.running, false)
  console.log('PASS disabled groups/integration, explicit local-storage limitation, cancellation and unauthenticated artifact access')
  console.log('All generated image file checks passed')
} finally { await server.stop(); ollama.closeAllConnections(); ollama.close(); remote.closeAllConnections(); remote.close() }
