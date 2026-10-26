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
let renameOnUpload = false, flowMode = false, folderCreated = true
const flowCalls: string[] = []
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
  if (url.pathname === '/api/v2.1/repos/') { answer(200, { repos: [REPO, ...(duplicate || flowMode ? [OTHER] : [])].map((repo_id) => ({ repo_id, repo_name: flowMode && repo_id === OTHER ? 'Vault' : 'Home', type: 'mine', encrypted: locked || flowMode && repo_id === OTHER, permission: readOnly ? 'r' : 'rw' })) }); return }
  if (url.pathname === `/api/v2.1/repos/${REPO}/dir/`) {
    const path = url.searchParams.get('p')
    if (req.method === 'POST') {
      assert.ok(flowMode); assert.equal(path, '/Desktop/18+'); assert.equal(folderCreated, false)
      let body = ''; for await (const part of req) body += part
      assert.equal(new URLSearchParams(body).get('operation'), 'mkdir'); folderCreated = true; mutations++
      answer(200, { obj_name: '18+', parent_dir: '/Desktop' }); return
    }
    if (path === '/Desktop/18+' && !folderCreated) { answer(404, { error_msg: 'Folder absent' }); return }
    if (!['/', '/Desktop', '/Desktop/18+'].includes(path!)) { answer(404, { error_msg: 'Folder absent' }); return }
    const dirent_list = path === '/' ? [{ type: 'dir', name: 'Desktop', id: 'desktop' }] : path === '/Desktop' ? (folderCreated ? [{ type: 'dir', name: '18+', id: 'folder' }] : []) : [...files].map(([p, data]) => ({ type: 'file', name: p.split('/').at(-1), id: 'file', size: data.length }))
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
  if (flowMode) {
    const at = body.messages.findLastIndex((m: J) => m.role === 'user' && m.content === 'Can you save these on my Desktop under 18+ folder?')
    assert.ok(at >= 0)
    const after = body.messages.slice(at + 1), results = after.filter((m: J) => m.role === 'tool')
    const offered = new Set((body.tools ?? []).map((t: J) => t.function.name))
    assert.ok(offered.has('list_generated_images') && offered.has('save_generated_image'), 'Eligible legacy thread must receive discovery and save tool definitions in every working round')
    const system = body.messages[0].content
    assert.match(system, /current thread ID: [0-9a-f-]{36}/)
    assert.match(system, /save_generated_image: enabled for this thread/)
    assert.match(system, /do not scan unrelated or locked libraries/)
    assert.match(system, /create it with seafile_mkdir, then save/)
    let calls: J[] = []
    const inventory = results.find((m: J) => m.tool_name === 'list_generated_images')
    const listings = results.filter((m: J) => m.tool_name === 'seafile_list')
    const made = results.find((m: J) => m.tool_name === 'seafile_mkdir')
    const saved = results.filter((m: J) => m.tool_name === 'save_generated_image')
    if (!inventory) calls = [{ name: 'list_generated_images', arguments: {} }]
    else if (!listings.length) calls = [{ name: 'seafile_list', arguments: {} }]
    else {
      const libraries = JSON.parse(listings[0].content).filter((l: J) => !l.encrypted)
      assert.equal(libraries.length, 1)
      const library = libraries[0].id
      if (listings.length === 1) calls = [{ name: 'seafile_list', arguments: { library, path: '/Desktop' } }]
      else if (!made && !JSON.parse(listings[1].content).some((f: J) => f.name === '18+' && f.folder)) calls = [{ name: 'seafile_mkdir', arguments: { library, path: '/Desktop/18+' } }]
      else if (!saved.length) {
        const discovered = JSON.parse(inventory.content)
        assert.equal(discovered.images.length, 4)
        assert.ok(system.includes(`current thread ID: ${discovered.thread_id}`))
        calls = discovered.images.map((i: J) => ({ name: 'save_generated_image', arguments: { image_id: i.image_id, library, path: `/Desktop/18+/${i.name}` } }))
      }
    }
    for (const c of calls) { assert.ok(offered.has(c.name)); flowCalls.push(c.name) }
    const message = calls.length ? { content: '', tool_calls: calls.map((c) => ({ function: c })) } : { content: saved.map((m: J) => { const r = JSON.parse(m.content); assert.equal(r.saved, true); return r.path }).join('\n') }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.end(JSON.stringify({ message: { role: 'assistant', ...message }, done: true }) + '\n'); return
  }
  const at = body.messages.findLastIndex((m: J) => m.role === 'user' && m.content.startsWith('RUN '))
  const args = JSON.parse(body.messages[at].content.slice(4))
  let content: J = body.messages.slice(at + 1).some((m: J) => m.role === 'tool') ? { content: 'Saved result handled.' } : { content: '', tool_calls: [{ function: { name: 'save_generated_image', arguments: args } }] }
  if (args.budget_probe) {
    if (body.tools?.length) content = { content: '', tool_calls: [{ function: { name: 'list_generated_images', arguments: {} } }] }
    else {
      assert.match(body.messages[0].content, /tool-round budget for this turn is exhausted/)
      assert.match(body.messages[0].content, /does not mean enabled tools are missing or switched off/)
      assert.match(body.messages[0].content, /save_generated_image: enabled for this thread/)
      content = { content: 'Turn limit reached. Saving remains enabled; continue in this thread.' }
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.end(JSON.stringify({ message: { role: 'assistant', ...content }, done: true }) + '\n')
})
const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
base = await listen(remote)
const server = new Server({ OLLAMA_URL: await listen(ollama), OLLAMA_API_KEY: 'fake', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1,2', NOTIFY_WATCH: 'off' })
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
async function turn(id: string, args: J, allow = true, hook?: () => void, text = `RUN ${JSON.stringify(args)}`) {
  const res = await fetch(`${server.origin}/api/agents/threads/${id}/messages`, { method: 'POST', headers: { Cookie: `mvlos_sid=${sessions[0]}`, ...await asPage(sessions[0]), Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
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
    assert.match(r.result.error, tools.includes('images') ? /Seafile changes.*Tools/ : /Images.*Tools/)
    assert.ok(chats.findLast((c) => c.stream === true)!.messages[0].content.includes(r.result.error))
  }
  await api('PATCH', `/api/agents/threads/${current.id}`, { tools: ['images', 'seafile', 'seafile_write'], permission: 'bypass' })
  db.prepare("DELETE FROM integrations WHERE user_id = 1 AND name = 'seafile'").run()
  r = await turn(current.id, args); assert.match(r.result.error, /Seafile is not linked.*Settings/); assert.match(chats.findLast((c) => c.stream === true)!.messages[0].content, /save_generated_image: unavailable: Seafile is not linked/)
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
  // The model receives a plain save request, not image IDs or a hand-built save call.
  const legacy = await makeThread(0, 'auto')
  db.prepare('UPDATE agent_threads SET tools = ? WHERE id = ?').run(JSON.stringify(['seafile', 'seafile_write']), legacy.id)
  const imageIds: string[] = []
  for (let i = 0; i < 4; i++) {
    const id = randomUUID(); imageIds.push(id)
    db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(id, legacy.id, `saved-${i}.png`, PNG, stamp + i, JSON.stringify({ prompt: `Fixture scene ${i}`, width: 512, height: 512 }))
  }
  db.prepare('INSERT INTO agent_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(legacy.id, 'compact', 'Earlier pictures were generated. Exact IDs were omitted from this summary.', stamp + 10)
  files.clear(); flowMode = true; folderCreated = false
  const beforeFlow = uploads.length
  const completed = await turn(legacy.id, {}, true, undefined, 'Can you save these on my Desktop under 18+ folder?')
  flowMode = false
  assert.equal(completed.approvals, 5, 'Folder creation and all four saves retain normal approval')
  assert.deepEqual(flowCalls, ['list_generated_images', 'seafile_list', 'seafile_list', 'seafile_mkdir', ...Array(4).fill('save_generated_image')])
  assert.equal(uploads.length, beforeFlow + 4)
  for (let i = 0; i < 4; i++) { assert.deepEqual(files.get(`/Desktop/18+/saved-${i}.png`), PNG); assert.ok(completed.view.messages.at(-1).content.includes(`saved-${i}.png`)) }
  assert.ok(!flowCalls.some((n) => ['ask_user', 'read_thread', 'seafile_search'].includes(n)))
  const { listGeneratedImages } = await import('../server/agentImages.ts')
  const owner = { id: 1, admin: true } as any
  const firstPage = listGeneratedImages(owner, legacy.id, { limit: 2 }), nextPage = listGeneratedImages(owner, legacy.id, { limit: 2, before: firstPage.next_before })
  assert.deepEqual([...firstPage.images, ...nextPage.images].map((i) => i.image_id), imageIds.toReversed())
  assert.equal(nextPage.next_before, null)
  assert.throws(() => listGeneratedImages(owner, foreign.id), /No such thread/)
  assert.throws(() => listGeneratedImages(owner, legacy.id, { before: alien }), /not an image in this thread/)
  assert.throws(() => listGeneratedImages(owner, legacy.id, { limit: 11 }), /limit from 1 to 10/)
  assert.throws(() => listGeneratedImages(owner, legacy.id, { thread_id: foreign.id }), /no thread ID/)
  const branch = await makeThread()
  db.prepare('INSERT INTO agent_messages (thread_id, role, tool_name, content, created_at) VALUES (?, ?, ?, ?, ?)').run(branch.id, 'tool', 'generate_image', JSON.stringify({ image: { id: imageIds[0] } }), stamp)
  assert.equal(listGeneratedImages(owner, branch.id).images[0].image_id, imageIds[0])
  const crowded = await makeThread()
  for (let i = 0; i < 12; i++) db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), crowded.id, '\"'.repeat(200), PNG, stamp, JSON.stringify({ prompt: '\"'.repeat(2000) + 'hidden tail', width: 512, height: 512 }))
  const bounded = listGeneratedImages(owner, crowded.id)
  assert.equal(bounded.images.length, 10); assert.ok(bounded.next_before); assert.ok(JSON.stringify(bounded).length <= 6000); assert.ok(!JSON.stringify(bounded).includes('hidden tail'))
  console.log('PASS legacy eligible thread: current images after compaction -> unambiguous Desktop -> requested mkdir -> four exact binary saves within Quick rounds, with approvals and no extra questions/locked-library probes')
  console.log('PASS current-image pagination, ownership, branch references and bounded metadata; explicit off groups and integration blockers stay off')
  const exhausted = await turn(legacy.id, { budget_probe: true })
  assert.match(exhausted.view.messages.at(-1).content, /Saving remains enabled; continue in this thread/)
  assert.equal(exhausted.view.messages.filter((m: J) => m.role === 'tool').slice(-6).filter((m: J) => m.toolName === 'list_generated_images').length, 6)
  console.log('PASS exhausted Quick round budget is explained separately from disabled tools; no new thread required')
  console.log('All generated image file checks passed')
} finally { await server.stop(); ollama.closeAllConnections(); ollama.close(); remote.closeAllConnections(); remote.close() }
