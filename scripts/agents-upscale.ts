// Real server lifecycle with synthetic owned images and mocked ComfyUI/Ollama only.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { upscaleWorkflow, upscaleDimensions, validateUpscaleGraph, type NodeInfo } from '../server/agentImageUpscale.ts'
import { applyComfyMessage, progressState } from '../server/comfyProgress.ts'
import { imageProgressLabel } from '../src/data/imageModels.ts'

const name = 'Restoration\\2x Test.safetensors'
const schemas: NodeInfo = {
  LoadImage: { input: { required: { image: [['existing.png']] } } },
  UpscaleModelLoader: { input: { required: { model_name: ['COMBO', { options: [name] }] } } },
  ImageUpscaleWithModel: { input: { required: { image: ['IMAGE'], upscale_model: ['UPSCALE_MODEL'] } } },
  ImageScale: { input: { required: { image: ['IMAGE'], upscale_method: [['lanczos']], crop: [['disabled']], width: ['INT', { min: 0, max: 16384 }], height: ['INT', { min: 0, max: 16384 }] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
}
const w = upscaleWorkflow({ width: 512, height: 768 }, { upscale_model: name }, 'uploaded.png')
validateUpscaleGraph(w.graph, schemas)
assert.deepEqual([w.width, w.height], [1024, 1536])
assert.deepEqual(w.graph.upscale.inputs.image, ['source', 0])
assert.equal(w.graph.model.inputs.model_name, name)
assert.equal(Object.values(w.graph).some(n => /Sampler|VAE|CLIP|Checkpoint|UNET/.test(n.class_type)), false)
assert.deepEqual(upscaleDimensions({ width: 100, height: 151 }, { width: 200 }), { width: 200, height: 302 })
for (const input of [{ scale: NaN }, { scale: 1 }, { scale: Infinity }, { scale: 5 }, { scale: 2, width: 512 }, { width: 100, height: 100 }, { width: 0 }, { width: 4097 }, { width: 200.5 }]) assert.throws(() => upscaleDimensions({ width: 100, height: 151 }, input))
assert.throws(() => upscaleWorkflow({ width: 3000, height: 2000 }, { upscale_model: name, width: 4000 }, 'source.png'), /never silently downsampled/)
assert.throws(() => upscaleDimensions({ width: 2048, height: 2048 }, { scale: 3 }), /4096/)
assert.deepEqual(upscaleDimensions({ width: 2048, height: 2048 }, { scale: 2 }), { width: 4096, height: 4096 })
for (const bad of [Object.fromEntries(Object.entries(schemas).filter(([key]) => key !== 'ImageUpscaleWithModel')), { ...schemas, ImageScale: { input: { required: { ...schemas.ImageScale.input!.required, crop: [['center']] } } } }, { ...schemas, SaveImage: { input: { required: { ...schemas.SaveImage.input!.required, new_required: ['STRING'] } } } }]) assert.throws(() => validateUpscaleGraph(w.graph, bad))
const state = progressState()
assert.equal(applyComfyMessage(state, { type: 'executing', data: { node: 'upscale', prompt_id: 'ours' } }, 'ours', 0, w.progress), true)
assert.equal(applyComfyMessage(state, { type: 'progress', data: { node: 'upscale', prompt_id: 'theirs', value: 2, max: 4 } }, 'ours', 0, w.progress), false)
assert.equal(applyComfyMessage(state, { type: 'progress', data: { node: 'size', prompt_id: 'ours', value: 2, max: 4 } }, 'ours', 0, w.progress), false)
assert.equal(applyComfyMessage(state, { type: 'progress', data: { node: 'upscale', prompt_id: 'ours', value: 2, max: 4 } }, 'ours', 0, w.progress), true)
assert.equal(imageProgressLabel(state.progress), 'Upscaling · 50%')
console.log('PASS upscale graph, schema capabilities, exact catalog names, bounds, original pixels and node-aware progress')

function png(width: number, height: number) {
  const chunk = (kind: string, body: Buffer) => {
    const payload = Buffer.concat([Buffer.from(kind), body]); let crc = 0xffffffff
    for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(body.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([head, payload, tail])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height, 0))), chunk('IEND', Buffer.alloc(0))])
}
const send = (res: ServerResponse, value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
let uploads = 0, submissions = 0, chats = 0, mode = 'ok', missing = '', outputWidth = 32, outputHeight = 24
const graphs: any[] = [], deleted: string[] = []
let args: Record<string, unknown> = {}, requestedTool = 'generate_image'
const comfy = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString(), path = new URL(req.url!, 'http://fixture').pathname
  assert.equal(req.headers.authorization, 'Bearer synthetic-token')
  if (path.startsWith('/object_info/')) { const node = path.slice(13); return send(res, node === missing ? {} : { [node]: schemas[node] }) }
  if (path.startsWith('/api/lm/')) return res.writeHead(404).end()
  if (path === '/upload/image') {
    uploads++
    const filename = /filename="([^"]+)"/.exec(raw)?.[1]
    assert.match(filename!, /^agents-source-[0-9a-f-]{36}\.png$/)
    assert.ok(raw.includes('name="overwrite"\r\n\r\nfalse'))
    return send(res, { name: mode === 'upload-path' ? '../other.png' : filename, type: 'input', subfolder: '' })
  }
  if (path === '/prompt') { const body = JSON.parse(raw); graphs.push(body.prompt); submissions++; return send(res, { prompt_id: `up-${submissions}` }) }
  if (path.startsWith('/history/')) {
    const id = path.split('/').at(-1)!
    if (mode === 'wait') return send(res, {})
    return send(res, { [id]: { status: { completed: true }, outputs: { output: { images: [{ filename: 'fixture.png', subfolder: '', type: 'output' }] } } } })
  }
  if (path === '/view') {
    if (mode === 'oversize') return res.writeHead(200, { 'Content-Length': 21 * 1024 * 1024 }).end()
    return res.end(mode === 'invalid' ? '<html>no</html>' : png(mode === 'dimensions' ? 1 : outputWidth, outputHeight))
  }
  if (path === '/queue') { if (req.method === 'POST') deleted.push(...JSON.parse(raw).delete); return send(res, {}) }
  if (path === '/interrupt') assert.fail('Never interrupt another ComfyUI job')
  return res.writeHead(404).end()
})
const ollama = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  if (req.url?.includes('/tags')) return send(res, { models: [{ name: 'test-model', model: 'test-model' }] })
  if (req.url?.includes('/show')) return send(res, { capabilities: ['completion', 'tools', 'vision'] })
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (!body.stream) return send(res, { message: { content: '{"title":"Upscale test"}' } })
  chats++
  const after = body.messages?.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1) ?? []
  const message = after.some((m: any) => m.role === 'tool') ? { content: 'Handled.' } : { content: '', tool_calls: [{ function: { name: requestedTool, arguments: args } }] }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(JSON.stringify({ message: { role: 'assistant', ...message }, done: true }) + '\n')
})
const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}` }
const comfyUrl = await listen(comfy), ollamaUrl = await listen(ollama)
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'synthetic', GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', ADMIN_GITHUB_IDS: '1' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sessions = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
for (let i = 1; i <= 2; i++) {
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, i, i === 1 ? 'upscale-admin' : 'other', encrypt('none'), Date.now(), Date.now())
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sessions[i - 1]), i, Date.now(), Date.now() + 86400000)
}
const api = async (method: string, path: string, body?: unknown, owner = 0) => fetch(server.origin + path, { method, headers: { Cookie: `mvlos_sid=${sessions[owner]}`, ...await asPage(sessions[owner]), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const json = async (method: string, path: string, body?: unknown, owner = 0) => { const res = await api(method, path, body, owner); assert.equal(res.status, 200, await res.clone().text()); return res.json() as Promise<any> }
const events = async (path: string, body?: unknown) => { const res = await api('POST', path, body); assert.equal(res.status, 200, await res.clone().text()); return (await res.text()).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) }
async function approvedTurn(id: string, allow: boolean, changeBackend = false) {
  const res = await api('POST', `/api/agents/threads/${id}/messages`, { text: 'Upscale the fixture' })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader(), out: any[] = []; let buffer = ''
  for (;;) {
    const { value, done } = await reader.read(); if (done) break
    buffer += new TextDecoder().decode(value)
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line) continue
      const event = JSON.parse(line); out.push(event)
      if (event.type === 'approval') {
        assert.match(event.summary.title, /Upscale/)
        assert.ok(event.summary.rows.some((r: string[]) => r[0] === 'Upscale model' && r[1] === name))
        assert.ok(event.summary.rows.some((r: string[]) => r[0] === 'Resources' && /native scale/.test(r[1])))
        if (changeBackend) await json('PUT', '/api/agents/images/settings', { token: 'changed-token' })
        await json('POST', `/api/agents/threads/${id}/approve`, { callId: event.callId, allow })
      }
    }
  }
  return out
}
const toolResult = (ev: any[]) => JSON.parse(ev.findLast(e => e.type === 'message' && e.message.role === 'tool').message.content)
try {
  await server.start()
  await json('PUT', '/api/agents/images/settings', { url: comfyUrl, token: 'synthetic-token' })
  const t = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  const other = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'] }, 1)
  const source = randomUUID(), foreign = randomUUID()
  for (const [id, thread] of [[source, t.id], [foreign, other.id]]) database().prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, thread, 'fixture.png', png(16, 12), Date.now())
  args = { operation: 'upscale', source_image_id: source, upscale_model: name, scale: 2 }
  const catalog = await json('GET', '/api/agents/images/catalog')
  assert.equal(catalog.upscale, true); assert.deepEqual(catalog.upscalers, [name]); assert.equal(catalog.schemas, undefined)
  const beforeChats = chats
  const ev = await events(`/api/agents/threads/${t.id}/messages`, { text: 'Upscale this image' })
  const result = toolResult(ev)
  assert.ok(result.image, JSON.stringify(ev))
  assert.equal(chats - beforeChats, 1, 'No learning review or post-success narration for pure upscale')
  assert.equal(result.image.seed, undefined); assert.equal(result.image.preset, undefined)
  assert.equal(result.image.settings.operation, 'upscale'); assert.equal(result.image.settings.source.id, source)
  assert.equal(result.image.settings.upscale_model, name)
  assert.equal(ev.some(e => e.type === 'imageGeneration'), true)
  assert.equal(ev.some(e => e.type === 'imageGenerationDone'), true)
  assert.equal(graphs.at(-1).output.class_type, 'SaveImage')
  requestedTool = 'save_image_learning'
  args = { image_id: result.image.id, source: 'suggestion', task: 'Explicitly requested upscale note', note: 'Synthetic observation, not a quality claim.' }
  const saved = toolResult(await events(`/api/agents/threads/${t.id}/messages`, { text: 'Save this synthetic observation as requested' }))
  assert.ok(saved.id, JSON.stringify(saved))
  requestedTool = 'read_image_learnings'; args = { all_models: true }
  const allNotes = toolResult(await events(`/api/agents/threads/${t.id}/messages`, { text: 'Read observations across operations' }))
  assert.ok(allNotes.notes.some((n: any) => n.id === saved.id && n.operation === 'upscale' && n.upscale_model === name))
  args = {}; assert.equal(toolResult(await events(`/api/agents/threads/${t.id}/messages`, { text: 'Read diffusion defaults only' })).notes.length, 0)
  args = { operation: 'upscale', upscale_model: name }
  assert.equal(toolResult(await events(`/api/agents/threads/${t.id}/messages`, { text: 'Read this upscale model observations' })).notes[0].id, saved.id)
  args = { operation: 'upscale', upscale_model: 'Other/model.pth' }
  assert.equal(toolResult(await events(`/api/agents/threads/${t.id}/messages`, { text: 'Read a different upscale model observations' })).notes.length, 0)
  requestedTool = 'generate_image'; args = { operation: 'upscale', source_image_id: source, upscale_model: name, scale: 2 }
  const beforeAgainChats = chats
  const again = toolResult(await events(`/api/agents/threads/${t.id}/images/${result.image.id}/again`))
  assert.equal(again.image.settings.source.id, source); assert.equal(again.image.settings.upscale_model, name)
  assert.equal(again.image.width, 32); assert.equal(chats - beforeAgainChats, 0, 'Again never invokes a chat model')
  assert.deepEqual(graphs.at(-1).upscale.inputs.image, ['source', 0])
  const meta = await json('GET', `${result.image.url}/metadata`); assert.ok(JSON.stringify(meta).includes(name.replaceAll('\\', '\\\\')))
  const u0 = uploads, s0 = submissions
  for (const bad of [{ source_image_id: foreign }, { source_image_id: 'https://example.test/source.png' }, { upscale_model: 'not-installed' }, { width: 4097, scale: undefined }, { prompt: 'unused' }, { graph: {} }, { operation: 'unknown' }]) {
    const badInput = { ...args, ...bad }
    const out = toolResult(await events(`/api/agents/threads/${t.id}/upscale`, badInput.operation === 'unknown' ? { ...badInput, operation: 'upscale', graph: {} } : badInput))
    assert.ok(out.error, JSON.stringify(out))
  }
  missing = 'ImageUpscaleWithModel'
  assert.ok(toolResult(await events(`/api/agents/threads/${t.id}/upscale`, args)).error)
  missing = ''
  schemas.SaveImage.input!.required!.unsupported = ['STRING']
  assert.ok(toolResult(await events(`/api/agents/threads/${t.id}/upscale`, args)).error)
  delete schemas.SaveImage.input!.required!.unsupported
  assert.equal(uploads, u0); assert.equal(submissions, s0, 'Preflight failures never upload or submit')
  assert.equal((await api('POST', `/api/agents/threads/${t.id}/upscale`, args, 1)).status, 404)
  for (const badMode of ['upload-path', 'dimensions', 'invalid', 'oversize']) {
    mode = badMode
    const out = toolResult(await events(`/api/agents/threads/${t.id}/upscale`, args))
    assert.ok(out.error, `${badMode}: ${JSON.stringify(out)}`)
  }
  mode = 'ok'
  const recovered = toolResult(await events(`/api/agents/threads/${t.id}/upscale`, args)); assert.ok(recovered.image)
  const retry = toolResult(await events(`/api/agents/threads/${t.id}/retry`, {})); assert.equal(retry.image.settings.operation, 'upscale')
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: true })
  const beforeDecline = submissions, uploadBeforeDecline = uploads
  assert.ok(toolResult(await approvedTurn(t.id, false)).error)
  assert.equal(submissions, beforeDecline); assert.equal(uploads, uploadBeforeDecline)
  assert.ok(toolResult(await approvedTurn(t.id, true)).image)
  const beforeChanged = submissions, uploadsBeforeChanged = uploads
  assert.match(toolResult(await approvedTurn(t.id, true, true)).error, /backend changed/)
  assert.equal(submissions, beforeChanged); assert.equal(uploads, uploadsBeforeChanged)
  await json('PUT', '/api/agents/images/settings', { token: 'synthetic-token', askBeforeGenerate: false })
  mode = 'wait'
  const beforeCancel = submissions
  const cancelled = events(`/api/agents/threads/${t.id}/upscale`, args)
  const until = Date.now() + 5000
  while (submissions === beforeCancel) { if (Date.now() > until) throw new Error('Mock submission timeout'); await new Promise(r => setTimeout(r, 10)) }
  await json('POST', `/api/agents/threads/${t.id}/stop`, {})
  const cancelledEvents = await cancelled
  assert.match(toolResult(cancelledEvents).error, /cancelled/)
  assert.ok(deleted.includes(`up-${submissions}`))
  mode = 'ok'
  assert.ok(toolResult(await events(`/api/agents/threads/${t.id}/upscale`, args)).image)
  console.log('PASS decline uploads nothing, frozen approval credentials, cancellation scoped to own prompt, and successful next operation')
  requestedTool = 'list_image_models'; args = { query: '2x test' }
  const discovered = toolResult(await events(`/api/agents/threads/${t.id}/messages`, { text: 'List installed upscale models' }))
  assert.deepEqual(discovered.options.upscalers.values, [name]); assert.equal(discovered.model_upscale.available, true)
  console.log('PASS no-prompt/no-diffusion upscale, silent agent success, direct UI lifecycle, repeat/retry, discovery, metadata, owner checks and preflight before uploads')
  console.log('PASS untrusted upload paths, oversized/invalid/wrong-size output, and operation slot recovery')
} finally {
  await server.dispose(); database().close()
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>(r => comfy.close(() => r())), new Promise<void>(r => ollama.close(() => r()))])
}
