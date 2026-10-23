// Real Agents HTTP/streaming integration against mocked Ollama and ComfyUI. No GPU or real data.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { modelAssets, modelFolders, visibleModelAssets, resolveImageAssets, recommendedImageSampling, type ImageAssetCatalog } from '../src/data/imageModels.ts'

// Deterministic recommendation fixtures: exact identifiers survive every decision.
const automaticCatalog: ImageAssetCatalog = {
  checkpoints: ['SDXL/studio.safetensors', 'SD15/portrait.safetensors'],
  diffusionModels: ['Krea2/Raw/base.safetensors', 'Krea2/Turbo/custom.safetensors', 'Z-Image/base.safetensors', 'Z-Image-Turbo/fast.safetensors', 'Wan2.2/video.safetensors', 'Flux/other.safetensors', 'Anima/other.safetensors'],
  clips: ['nested\\qwen3-vl-4b.safetensors', 'encoders/qwen_3_4b.safetensors', 'minimax/qwen3vl_32b.safetensors'],
  vaes: ['nested/qwen_image_vae.safetensors', 'other/ae.safetensors', 'Wan2.2/vae.safetensors'],
}
for (const preset of ['sd15', 'sdxl', 'z_image', 'z_image_turbo', 'krea2_raw', 'krea2_turbo'] as const) {
  const resolved = resolveImageAssets({ preset, model: '', clip: '', vae: '' }, automaticCatalog)
  assert.deepEqual(resolved.errors, [])
  assert.ok(resolved.effective.model)
  if (preset.startsWith('krea2')) {
    assert.equal(resolved.effective.clip, 'nested\\qwen3-vl-4b.safetensors')
    assert.equal(resolved.effective.vae, 'nested/qwen_image_vae.safetensors')
  }
  if (preset.startsWith('z_image')) assert.equal(resolved.effective.vae, 'other/ae.safetensors')
}
const autoKrea = { preset: 'krea2_turbo' as const, model: '', clip: '', vae: '' }
const ambiguousCatalog = { ...automaticCatalog, diffusionModels: [...automaticCatalog.diffusionModels, 'Krea2/Turbo/second.safetensors'] }
assert.equal(resolveImageAssets(autoKrea, ambiguousCatalog).effective.model, '')
assert.equal(resolveImageAssets(autoKrea, ambiguousCatalog).selection.model.candidates.length, 2)
const manual = { ...autoKrea, model: 'Krea2/Turbo/custom.safetensors' }
assert.equal(resolveImageAssets(manual, ambiguousCatalog).effective.model, manual.model)
assert.equal(resolveImageAssets(manual, ambiguousCatalog).selection.model.automatic, false)
assert.match(resolveImageAssets({ ...autoKrea, vae: 'other/ae.safetensors' }, automaticCatalog).errors.join(' '), /different workflow/)
assert.match(resolveImageAssets({ ...manual, preset: 'z_image' }, automaticCatalog).errors.join(' '), /different workflow/)
assert.match(resolveImageAssets(manual, { ...automaticCatalog, diffusionModels: [] }).errors.join(' '), /not installed/)
assert.equal(resolveImageAssets(autoKrea, { ...automaticCatalog, diffusionModels: [] }).effective.model, '')
const metadataCatalog: ImageAssetCatalog = { ...automaticCatalog, diffusionModels: ['studio\\custom.safetensors'], modelHints: [{ name: 'studio/custom.safetensors', category: 'diffusionModels', baseModel: 'Krea 2 Turbo' }] }
assert.equal(resolveImageAssets(autoKrea, metadataCatalog).effective.model, 'studio\\custom.safetensors')
assert.equal(resolveImageAssets(autoKrea, { ...metadataCatalog, modelHints: [{ name: 'other/custom.safetensors', category: 'diffusionModels', baseModel: 'Krea 2 Turbo' }] }).effective.model, '')
assert.equal(resolveImageAssets(autoKrea, { ...automaticCatalog, diffusionModels: ['Krea2/unknown-variant.safetensors'] }).effective.model, '')
assert.equal(resolveImageAssets(autoKrea, { ...automaticCatalog, vaes: ['other/ae.safetensors'] }).effective.vae, '')
assert.equal(resolveImageAssets(autoKrea, { ...automaticCatalog, clips: [...automaticCatalog.clips, 'other/qwen3-vl-4b.safetensors'] }).effective.clip, '')
assert.equal(recommendedImageSampling('krea2_raw', '', { samplers: ['dpmpp_2m'], schedulers: ['beta'] }).sampler, '')
assert.equal(recommendedImageSampling('z_image_turbo', '', { samplers: ['euler_ancestral', 'dpmpp_2m'], schedulers: ['simple'] }).sampler, 'euler_ancestral')
assert.deepEqual(recommendedImageSampling('sd15', ''), { steps: 20, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras' })
assert.deepEqual(recommendedImageSampling('sdxl', 'Pony/model.safetensors'), { steps: 12, cfg: 5.5, sampler: 'dpmpp_2m', scheduler: 'karras' })
assert.equal(recommendedImageSampling('sdxl', '', { samplers: ['euler'], schedulers: ['simple'] }).sampler, 'euler')
console.log('PASS automatic family/variant matching, nested exact paths, metadata identity, ambiguity, manual preservation, backend/family changes and missing assets')

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
const send = (res: ServerResponse, data: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
const info = Object.fromEntries(['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'ConditioningZeroOut'].map((name) => [name, { input: { required: {} } }])) as Record<string, any>
info.CheckpointLoaderSimple.input.required.ckpt_name = [['test.safetensors']]
info.UNETLoader.input.required.unet_name = [['z-test.safetensors', 'krea-raw.safetensors', 'krea-turbo.safetensors']]
info.CLIPLoader.input.required = { clip_name: [['encoder.safetensors']], type: [['lumina2', 'krea2']] }
info.VAELoader.input.required.vae_name = [['vae.safetensors']]
info.KSampler.input.required = { sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_3m_sde', 'dpmpp_sde']], scheduler: [['simple', 'beta', 'karras', 'normal', 'sgm_uniform']] }
let catalogBehavior: 'ok' | 'oversize' | 'aggregate' | 'invalid' | 'missing' = 'ok'
const discoveryRequests: string[] = []
const irrelevantCatalog = JSON.stringify({ ...info, IrrelevantCustomNode: { description: 'x'.repeat(9 * 1024 * 1024) } })
let fullCatalogRequests = 0
let previewMode: 'ok' | 'missing' | 'wrong-category' | 'unsafe-path' | 'oversize' | 'mime' | 'invalid' | 'duplicate' | 'mislabeled' = 'ok'
let behavior: 'ok' | 'wait' | 'error' | 'invalid' | 'oversize' = 'ok'
let submissions = 0
let historyReads = 0
let interrupts = 0
const deletions: string[] = []
let submitted: Record<string, any> = {}
let requestedTool = 'generate_image'
let extraToolCalls: { name: string; arguments: Record<string, unknown> }[] = []
let providerChats = 0
const visionRequests: any[] = []
let holdVision = false
let cancelledVision = 0
const streamEvents: any[] = []
let generationArgs: Record<string, unknown> = { prompt: 'A small blue bird', seed: 42 }
const comfy = createServer((req, res) => {
  let raw = ''
  req.on('data', (b) => raw += b)
  req.on('end', () => {
    const path = new URL(req.url!, 'http://test').pathname
    if (path === '/object_info') { fullCatalogRequests++; return res.end(irrelevantCatalog) }
    if (path.startsWith('/object_info/')) {
      const node = path.slice('/object_info/'.length)
      discoveryRequests.push(node)
      if (catalogBehavior === 'oversize') {
        // Chunked response: enforce limits even without a Content-Length header.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"padding":"')
        return res.end('x'.repeat(1024 * 1024) + '"}')
      }
      if (catalogBehavior === 'invalid') return res.end('not JSON')
      if (catalogBehavior === 'missing' && node === 'SaveImage') return send(res, {})
      return send(res, { [node]: info[node], ...(catalogBehavior === 'aggregate' ? { padding: 'x'.repeat(900 * 1024) } : {}) })
    }
    if (path === '/api/lm/checkpoints/list') {
      if (previewMode === 'missing') return res.writeHead(404).end()
      const item = { model_name: 'Test model', file_name: 'test', folder: '', file_path: '/models/test.safetensors', sub_type: previewMode === 'wrong-category' ? 'diffusion_model' : 'checkpoint', file_size: 12345, base_model: 'SDXL', tags: ['test'], preview_url: previewMode === 'unsafe-path' ? '/api/lm/previews?path=/private/secret.png' : '/api/lm/previews?path=%2Fmodels%2Ftest.png' }
      return send(res, { items: previewMode === 'duplicate' ? [item, item] : [item], total_pages: 1 })
    }
    if (path === '/api/lm/previews') {
      assert.equal(req.headers.authorization, 'Bearer test-secret')
      assert.equal(new URL(req.url!, 'http://test').searchParams.get('path'), '/models/test.png')
      if (previewMode === 'oversize') return res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 6 * 1024 * 1024 }).end()
      return res.writeHead(200, { 'Content-Type': previewMode === 'mime' ? 'image/svg+xml' : previewMode === 'mislabeled' ? 'image/jpeg' : 'image/png' }).end(previewMode === 'invalid' ? Buffer.from('bad') : png)
    }
    if (path === '/prompt') {
      assert.equal(req.headers.authorization, 'Bearer test-secret')
      submitted = JSON.parse(raw).prompt
      return send(res, { prompt_id: `job-${++submissions}` })
    }
    if (path.startsWith('/history/')) {
      historyReads++
      const id = path.split('/').pop()!
      if (behavior === 'wait') return send(res, {})
      if (behavior === 'error') return send(res, { [id]: { status: { status_str: 'error' } } })
      return send(res, { [id]: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'test.png', subfolder: '', type: 'output' }] } } } })
    }
    if (path === '/view') {
      if (behavior === 'oversize') return res.writeHead(200, { 'Content-Length': 21 * 1024 * 1024 }).end()
      return res.writeHead(200, { 'Content-Type': 'image/png' }).end(behavior === 'invalid' ? Buffer.from('<html>bad</html>') : png)
    }
    if (path === '/queue') { deletions.push(...JSON.parse(raw).delete); return send(res, {}) }
    if (path === '/interrupt') interrupts++
    res.writeHead(404).end()
  })
})
const ollama = createServer((req, res) => {
  let raw = ''
  req.on('data', (b) => raw += b)
  req.on('end', () => {
    if (req.url === '/api/tags') return send(res, { models: [{ name: 'test-model' }, { name: 'text-model' }] })
    if (req.url === '/api/show') return send(res, { capabilities: JSON.parse(raw).model === 'text-model' ? ['tools'] : ['tools', 'vision'], model_info: { 'test.context_length': 131072 } })
    if (req.url !== '/api/chat') return res.writeHead(404).end()
    const body = JSON.parse(raw)
    if (!body.stream) return send(res, { message: { content: '{"title":"Image test"}' } })
    providerChats++
    if (body.messages.some((m: any) => m.images?.length)) {
      visionRequests.push(body)
      if (holdVision) { res.on('close', () => cancelledVision++); return }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'The image shows a small fixture. Quality observations are uncertain at this size.' }, done: true }) + '\n')
    }
    const after = body.messages.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1)
    const message = after.some((m: any) => m.role === 'tool') ? { content: 'Image request handled.' } : { content: '', tool_calls: [{ function: { name: requestedTool, arguments: generationArgs } }, ...extraToolCalls.map((call) => ({ function: call }))] }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { role: 'assistant', ...message }, done: false }) + '\n')
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n')
  })
})
const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}` }
const comfyUrl = await listen(comfy), ollamaUrl = await listen(ollama)
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'image-admin' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sessions = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
for (let i = 1; i <= 2; i++) {
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, i, i === 1 ? 'image-admin' : 'image-member', encrypt('none'), Date.now(), Date.now())
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sessions[i - 1]), i, Date.now(), Date.now() + 86400_000)
}
const api = async (method: string, path: string, body?: unknown, account = 0) => fetch(server.origin + path, { method, headers: { Cookie: `mvlos_sid=${sessions[account]}`, ...await asPage(sessions[account]), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const json = async (method: string, path: string, body?: unknown, account = 0) => {
  const res = await api(method, path, body, account)
  assert.equal(res.status, 200, await res.clone().text())
  return res.json() as Promise<any>
}
const thread = (permission = 'bypass') => json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', permission })
const approvalSummaries: any[] = []
let approvalHook: (() => Promise<void>) | undefined
const turn = async (id: string, approve?: boolean) => {
  const response = await api('POST', `/api/agents/threads/${id}/messages`, { text: 'Generate a bird image' })
  const reader = response.body!.getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += new TextDecoder().decode(value)
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      if (!line) continue
      const event = JSON.parse(line)
      streamEvents.push(event)
      if (event.type === 'approval') { approvalSummaries.push(event.summary); await approvalHook?.(); await json('POST', `/api/agents/threads/${id}/approve`, { callId: event.callId, allow: approve ?? false }) }
    }
  }
  return json('GET', `/api/agents/threads/${id}`)
}
const result = (t: any) => JSON.parse(t.messages.findLast((m: any) => m.role === 'tool' && m.toolName === 'generate_image').content)
const until = async (test: () => boolean) => {
  const end = Date.now() + 5000
  while (!test()) { if (Date.now() > end) throw new Error('Timed out waiting for mock request'); await new Promise((r) => setTimeout(r, 20)) }
}
try {
  const paths = ['studio/portraits/same.safetensors', 'other\\same.safetensors', 'root.safetensors', 'studio/portraits/same.safetensors', 'studio/more/deep/Long Model Name.gguf']
  const assets = modelAssets(paths)
  assert.equal(assets.length, 4)
  assert.equal(assets.find((a) => a.folder === 'other')!.value, 'other\\same.safetensors')
  assert.equal(modelFolders(assets).children.find((f) => f.path === 'studio')!.count, 2)
  assert.deepEqual(visibleModelAssets(assets, 'studio/portraits', '').map((a) => a.value), [paths[0]])
  assert.deepEqual(visibleModelAssets(assets, '', 'STUDIO long').map((a) => a.value), [paths[4]])
  assert.equal(visibleModelAssets(assets, '', 'same').length, 2)
  assert.equal(visibleModelAssets(assets, '', 'absent').length, 0)
  console.log('PASS model browser paths, folder counts, duplicate basenames, exact backslash identifiers and global search')
  await server.start()
  const { imageWorkflow, saveImageSettings, generateImage } = await import('../server/agentImages.ts')
  const { decide } = await import('../server/agents.ts')
  const { usedBytes } = await import('../server/quota.ts')
  const settings = { url: comfyUrl, token: 'test-secret', preset: 'sdxl' as const, model: 'test.safetensors', clip: '', vae: '' }
  const saved = await json('PUT', '/api/agents/images/settings', settings)
  assert.equal(saved.token, true)
  assert.ok(!JSON.stringify(saved).includes('test-secret'))
  assert.ok(!String((database().prepare("SELECT secret FROM integrations WHERE name = 'agents-comfyui'").get() as any).secret).includes('test-secret'))
  assert.equal((await json('GET', '/api/agents/images/settings', undefined, 1)).url, '')
  const catalog = await json('GET', '/api/agents/images/catalog')
  assert.deepEqual(catalog.checkpoints, ['test.safetensors'])
  assert.deepEqual(catalog.diffusionModels, ['z-test.safetensors', 'krea-raw.safetensors', 'krea-turbo.safetensors'])
  assert.deepEqual(catalog.clips, ['encoder.safetensors'])
  assert.deepEqual(catalog.vaes, ['vae.safetensors'])
  assert.deepEqual(catalog.clipTypes, ['lumina2', 'krea2'])
  assert.deepEqual(catalog.samplers, ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_3m_sde', 'dpmpp_sde'])
  assert.deepEqual(catalog.schedulers, ['simple', 'beta', 'karras', 'normal', 'sgm_uniform'])
  assert.deepEqual(new Set(catalog.nodes), new Set(Object.keys(info)))
  assert.deepEqual(discoveryRequests, Object.keys(info))
  assert.ok(Buffer.byteLength(irrelevantCatalog) > 8 * 1024 * 1024)
  assert.equal(fullCatalogRequests, 0)
  for (const [mode, error] of [['oversize', /CheckpointLoaderSimple.*1 MiB/], ['aggregate', /4 MiB total/], ['invalid', /invalid JSON.*CheckpointLoaderSimple/]] as const) {
    catalogBehavior = mode
    const start = discoveryRequests.length
    const response = await api('GET', '/api/agents/images/catalog')
    assert.equal(response.status, 502)
    assert.match((await response.json()).error, error)
    assert.equal(discoveryRequests.length - start, mode === 'aggregate' ? 5 : 1)
  }
  catalogBehavior = 'missing'
  const missing = await thread()
  assert.match(result(await turn(missing.id)).error, /missing nodes/)
  assert.equal(submissions, 0)
  catalogBehavior = 'ok'
  console.log('PASS targeted discovery ignores a >8 MiB catalog; per-node streaming and aggregate limits, invalid JSON and missing required nodes are handled')
  for (const preset of ['sd15', 'sdxl', 'z_image', 'z_image_turbo', 'krea2_raw', 'krea2_turbo'] as const) {
    const graph = imageWorkflow({ ...settings, preset, clip: 'encoder.safetensors', vae: 'vae.safetensors' }, { prompt: 'test', seed: 0 })
    assert.equal(graph.graph['7'].inputs.seed, 0)
    assert.equal(graph.graph['1'].class_type, !['sd15', 'sdxl'].includes(preset) ? 'UNETLoader' : 'CheckpointLoaderSimple')
    assert.equal(graph.graph['9'].class_type, 'SaveImage')
    if (preset === 'z_image_turbo' || preset === 'krea2_turbo') {
      assert.equal(graph.graph['7'].inputs.cfg, 1)
      assert.throws(() => imageWorkflow({ ...settings, preset, clip: 'encoder.safetensors', vae: 'vae.safetensors' }, { prompt: 'test', negative_prompt: 'blur' }), /positive prompt only/)
    }
  }
  assert.throws(() => imageWorkflow(settings, { prompt: 'test', width: 513 }))
  assert.throws(() => imageWorkflow(settings, { prompt: 'test', width: 1536, height: 1536 }))
  assert.throws(() => imageWorkflow(settings, { prompt: 'test', seed: -1 }))
  assert.equal(decide('test', 'plan', { name: 'generate_image', arguments: {} }), 'refuse')
  assert.equal(decide('test', 'default', { name: 'generate_image', arguments: {} }), 'ask')
  assert.equal(decide('test', 'acceptEdits', { name: 'generate_image', arguments: {} }), 'ask')
  console.log('PASS encrypted per-account settings, catalog, preset graphs, limits and permissions')

  const t = await thread('default')
  const before = usedBytes(1)
  const chatsBeforeImage = providerChats
  const eventsBeforeImage = streamEvents.length
  const completedImageTurn = await turn(t.id, true)
  const made = result(completedImageTurn)
  assert.equal(providerChats - chatsBeforeImage, 1)
  assert.equal(completedImageTurn.messages.at(-1).role, 'tool')
  assert.equal(completedImageTurn.thread.running, false)
  const generationEvents = streamEvents.slice(eventsBeforeImage)
  const pendingImage = generationEvents.find((e) => e.type === 'imageGeneration')
  assert.equal(pendingImage.width, made.image.width)
  assert.equal(pendingImage.height, made.image.height)
  assert.ok(generationEvents.findIndex((e) => e.type === 'approved') < generationEvents.indexOf(pendingImage))
  assert.ok(generationEvents.some((e) => e.type === 'imageGenerationDone'))
  assert.equal(submissions, 1)
  assert.equal(made.image.seed, 42)
  assert.equal(submitted['7'].inputs.seed, 42)
  assert.equal(submitted['1'].inputs.ckpt_name, 'test.safetensors')
  const image = await api('GET', made.image.url)
  assert.equal(image.status, 200)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await api('HEAD', made.image.url)).headers.get('content-length'), String(png.length))
  assert.equal((await api('GET', made.image.url, undefined, 1)).status, 404)
  assert.equal((await fetch(server.origin + made.image.url)).status, 401)
  assert.ok(usedBytes(1) >= before + png.length)
  await server.stop(); await server.start()
  assert.equal((await api('GET', made.image.url)).status, 200)
  assert.deepEqual((await json('GET', made.image.url + '/metadata')).settings, made.image.settings)
  database().prepare('UPDATE agent_images SET metadata = NULL WHERE id = ?').run(made.image.id)
  assert.equal((await json('GET', made.image.url + '/metadata')).settings, null)
  assert.equal(result(await json('GET', `/api/agents/threads/${t.id}`)).image.url, made.image.url)
  console.log('PASS streamed tool generation, approved prompt, PNG retrieval, ownership, quota and restart durability')

  const declined = await thread('default')
  await turn(declined.id, false)
  assert.equal(submissions, 1)
  const disabled = await thread()
  await json('PATCH', `/api/agents/threads/${disabled.id}`, { tools: ['web'] })
  assert.ok(result(await turn(disabled.id)).error)
  assert.equal(submissions, 1)
  for (const state of ['error', 'invalid', 'oversize'] as const) {
    behavior = state
    const bad = await thread()
    assert.ok(result(await turn(bad.id)).error, state)
    assert.equal((database().prepare('SELECT COUNT(*) AS n FROM agent_images WHERE thread_id = ?').get(bad.id) as any).n, 0)
  }
  console.log('PASS declined and disabled tools do not submit; backend errors and invalid/oversized images do not persist')

  behavior = 'wait'
  const waiting = await thread()
  const reads = historyReads
  const running = turn(waiting.id)
  await until(() => historyReads > reads)
  const queued = `job-${submissions}`
  const competing = await thread()
  assert.match(result(await turn(competing.id)).error, /already generating/)
  await json('POST', `/api/agents/threads/${waiting.id}/stop`)
  await running
  await until(() => deletions.includes(queued))
  assert.equal(interrupts, 0)
  assert.equal((database().prepare('SELECT COUNT(*) AS n FROM agent_images WHERE thread_id = ?').get(waiting.id) as any).n, 0)
  behavior = 'ok'
  assert.ok(result(await turn((await thread()).id)).image)
  console.log('PASS cancellation removes only its prompt, no global interrupt, no artifact, concurrent account job blocked and slot released')

  await json('PUT', '/api/agents/images/settings', settings, 1)
  const denied = await api('GET', '/api/agents/images/catalog', undefined, 1)
  assert.equal(denied.status, 400)
  const admin = { id: 1, admin: true, login: 'image-admin', name: null, avatar: null, githubToken: '', githubScopes: [] }
  await assert.rejects(generateImage({ ...admin, id: 2 }, t.id, { prompt: 'test' }, new AbortController().signal), /No such thread/)
  assert.throws(() => saveImageSettings(admin, { url: 'file:///etc/passwd' }))
  assert.throws(() => saveImageSettings(admin, { url: 'https://user:password@example.com' }))
  await json('PUT', '/api/agents/images/settings', { token: '', model: 'missing.safetensors' })
  const count = submissions
  assert.match(result(await turn((await thread()).id)).error, /not installed/)
  assert.equal(submissions, count)
  await json('DELETE', `/api/agents/threads/${t.id}`)
  assert.equal((await api('GET', made.image.url)).status, 404)
  console.log('PASS private-network egress denied for non-admin, cross-account generation denied, URL validation, missing-model refusal and cascade deletion')
  await json('PUT', '/api/agents/images/settings', settings)
  const first = await thread(), second = await thread()
  const endpoint = (id: string) => `/api/agents/images/threads/${id}`
  const initial = await json('GET', endpoint(first.id))
  assert.deepEqual(initial.overrides, {})
  assert.equal(initial.effective.model, settings.model)
  assert.equal(initial.effective.width, 1024)
  for (const bad of [{ url: 'https://example.com' }, { token: 'secret' }, { preset: 'anima' }, { width: 513 }, { seed: -1 }, { seed: 1.5 }, { model: 'unknown.safetensors' }, { width: 1536, height: 1536 }]) {
    assert.equal((await api('PUT', endpoint(first.id), bad)).status, 400)
  }
  assert.equal((await api('GET', endpoint(first.id), undefined, 1)).status, 404)
  assert.equal((await api('PUT', endpoint(first.id), { width: 768 }, 1)).status, 404)
  assert.equal((await api('DELETE', endpoint(first.id), undefined, 1)).status, 404)
  const exactModel = 'studio\\portraits\\test.safetensors'
  info.CheckpointLoaderSimple.input.required.ckpt_name[0].push(exactModel)
  const overrides = { preset: 'sd15', model: exactModel, width: 768, height: 512, seed: 123 }
  const custom = await json('PUT', endpoint(first.id), overrides)
  assert.deepEqual(custom.overrides, overrides)
  assert.equal((await json('GET', endpoint(second.id))).effective.model, settings.model)
  assert.equal((await json('GET', '/api/agents/images/settings')).model, settings.model)
  assert.ok(!JSON.stringify(custom).includes('test-secret'))
  assert.ok(!JSON.stringify(custom).includes(comfyUrl))
  const rawThread = await json('GET', `/api/agents/threads/${first.id}`)
  assert.equal(rawThread.thread.image_config, undefined)
  await server.stop(); await server.start()
  assert.deepEqual((await json('GET', endpoint(first.id))).overrides, overrides)
  generationArgs = { prompt: 'Use session settings' }
  const fromSession = result(await turn(first.id)).image
  assert.equal(fromSession.seed, 123)
  assert.equal(fromSession.width, 768)
  assert.equal(fromSession.height, 512)
  assert.equal(submitted['1'].inputs.ckpt_name, exactModel)
  generationArgs = { prompt: 'Use per-call settings', seed: 77, width: 512 }
  const once = result(await turn(first.id)).image
  assert.equal(once.seed, 77)
  assert.equal(once.width, 512)
  assert.deepEqual((await json('GET', endpoint(first.id))).overrides, overrides)
  await json('PUT', '/api/agents/images/settings', { preset: 'sd15' })
  assert.equal((await json('GET', endpoint(second.id))).effective.width, 512)
  await json('PUT', '/api/agents/images/settings', { url: '' })
  assert.deepEqual((await json('DELETE', endpoint(first.id))).overrides, {})
  await json('PUT', '/api/agents/images/settings', settings)
  const z = await json('PUT', endpoint(second.id), { preset: 'z_image_turbo', model: 'z-test.safetensors', clip: 'encoder.safetensors', vae: 'vae.safetensors', seed: null })
  assert.equal(z.effective.seed, null)
  generationArgs = { prompt: 'Turbo session' }
  assert.equal(result(await turn(second.id)).image.preset, 'z_image_turbo')
  assert.equal(submitted['1'].class_type, 'UNETLoader')
  assert.equal(submitted['2'].inputs.type, 'lumina2')
  for (const preset of ['krea2_raw', 'krea2_turbo'] as const) {
    const selection = { preset, model: preset === 'krea2_raw' ? 'krea-raw.safetensors' : 'krea-turbo.safetensors', clip: 'encoder.safetensors', vae: 'vae.safetensors' }
    info.CLIPLoader.input.required.type = [['lumina2']]
    assert.equal((await api('PUT', endpoint(second.id), selection)).status, 400)
    info.CLIPLoader.input.required.type = [['lumina2', 'krea2']]
    await json('PUT', endpoint(second.id), selection)
    generationArgs = { prompt: 'Krea session', ...(preset === 'krea2_raw' ? { negative_prompt: 'blurry' } : {}) }
    assert.equal(result(await turn(second.id)).image.preset, preset)
    assert.equal(submitted['2'].inputs.type, 'krea2')
    assert.equal(submitted['3'].class_type, 'VAELoader')
    assert.equal(submitted['5'].class_type, preset === 'krea2_raw' ? 'CLIPTextEncode' : 'ConditioningZeroOut')
    assert.equal(submitted['7'].inputs.steps, preset === 'krea2_raw' ? 52 : 8)
    assert.equal(submitted['7'].inputs.cfg, preset === 'krea2_raw' ? 3.5 : 1)
    assert.equal(submitted['7'].inputs.sampler_name, preset === 'krea2_raw' ? 'euler' : 'euler_ancestral')
    assert.equal(submitted['7'].inputs.scheduler, preset === 'krea2_raw' ? 'simple' : 'beta')
    if (preset === 'krea2_raw') assert.equal(submitted['5'].inputs.text, 'blurry')
    else assert.deepEqual(submitted['5'].inputs.conditioning, ['4', 0])
  }
  console.log('PASS session ownership, strict field validation, exact model identifiers, default fallback, restart persistence, per-call precedence, secret exclusion and offline reset')
  info.UNETLoader.input.required.unet_name[0].push('Krea2/Turbo/auto.safetensors')
  info.CLIPLoader.input.required.clip_name[0].push('qwen3vl_4b.safetensors')
  info.VAELoader.input.required.vae_name[0].push('qwen_image_vae.safetensors', 'ae.safetensors')
  await json('PUT', '/api/agents/images/settings', { preset: 'krea2_turbo', model: '', clip: '', vae: '' })
  const automaticThread = await thread()
  const inherited = await json('GET', endpoint(automaticThread.id))
  assert.equal(inherited.defaults.model, '')
  assert.equal(inherited.effective.model, 'Krea2/Turbo/auto.safetensors')
  assert.equal(inherited.effective.vae, 'qwen_image_vae.safetensors')
  assert.equal(inherited.selection.vae.automatic, true)
  const explicitAuto = await json('PUT', endpoint(automaticThread.id), { model: '', clip: '', vae: '' })
  assert.deepEqual(explicitAuto.overrides, { model: '', clip: '', vae: '' })
  generationArgs = { prompt: 'Automatic assets' }
  assert.equal(result(await turn(automaticThread.id)).image.preset, 'krea2_turbo')
  assert.equal(submitted['1'].inputs.unet_name, 'Krea2/Turbo/auto.safetensors')
  assert.equal(submitted['2'].inputs.clip_name, 'qwen3vl_4b.safetensors')
  assert.equal(submitted['3'].inputs.vae_name, 'qwen_image_vae.safetensors')
  assert.equal((await api('PUT', endpoint(automaticThread.id), { vae: 'ae.safetensors' })).status, 400)
  info.UNETLoader.input.required.unet_name[0].push('Krea2/Turbo/another.safetensors')
  assert.equal((await json('GET', endpoint(automaticThread.id))).effective.model, '')
  const beforeAmbiguous = submissions
  assert.match(result(await turn(automaticThread.id)).error, /recommended model candidates/)
  assert.equal(submissions, beforeAmbiguous)
  await json('PUT', endpoint(automaticThread.id), { model: 'Krea2/Turbo/auto.safetensors' })
  assert.equal((await json('GET', endpoint(automaticThread.id))).effective.model, 'Krea2/Turbo/auto.safetensors')
  await json('PUT', '/api/agents/images/settings', settings)
  assert.equal((await json('GET', endpoint(automaticThread.id))).effective.model, 'Krea2/Turbo/auto.safetensors')
  console.log('PASS automatic account/session inheritance, resolved generation, explicit automatic intent, ambiguity refusal and manual persistence')
  requestedTool = 'list_image_models'
  generationArgs = { limit: 1, preset: 'krea2_turbo' }
  const discoveryThread = await thread()
  const discoveryTurn = await turn(discoveryThread.id)
  const discovered = JSON.parse(discoveryTurn.messages.findLast((m: any) => m.toolName === 'list_image_models').content)
  assert.equal(discovered.options.diffusionModels.values.length, 1)
  assert.equal(discovered.options.diffusionModels.truncated, true)
  assert.equal(discovered.recommendations.length, 1)
  assert.ok(!JSON.stringify(discovered).includes('test-secret') && !JSON.stringify(discovered).includes(comfyUrl))
  requestedTool = 'generate_image'
  // Per-call controls resolve before approval, and never write account or session settings.
  const tuningThread = await thread('default')
  const beforeAccount = await json('GET', '/api/agents/images/settings')
  const beforeSession = (await json('GET', endpoint(tuningThread.id))).overrides
  generationArgs = { prompt: 'Tuned image', preset: 'krea2_raw', model: 'krea-raw.safetensors', clip: 'qwen3vl_4b.safetensors', vae: 'qwen_image_vae.safetensors', steps: 32, cfg: 4.5, sampler: 'dpmpp_2m', scheduler: 'karras', width: 768, height: 1024, seed: 321, negative_prompt: 'blurry' }
  const tuned = result(await turn(tuningThread.id, true)).image
  assert.equal(tuned.settings.steps, 32)
  assert.equal(tuned.settings.cfg, 4.5)
  assert.equal(tuned.settings.model, generationArgs.model)
  assert.equal(tuned.settings.seed, 321)
  assert.equal(submitted['7'].inputs.sampler_name, 'dpmpp_2m')
  const review = approvalSummaries.at(-1)
  assert.equal(review.body, 'Tuned image')
  assert.ok(review.rows.some(([label, value]: string[]) => label === 'Sampling' && value.includes('32 steps') && value.includes('4.5')))
  assert.ok(review.rows.some(([label, value]: string[]) => label === 'VAE' && value === 'qwen_image_vae.safetensors'))
  assert.deepEqual(await json('GET', '/api/agents/images/settings'), beforeAccount)
  assert.deepEqual((await json('GET', endpoint(tuningThread.id))).overrides, beforeSession)
  assert.deepEqual((await json('GET', tuned.url + '/metadata')).settings, tuned.settings)
  assert.equal((await api('GET', tuned.url + '/metadata', undefined, 1)).status, 404)
  const tuningBypass = await thread()
  for (const patch of [{ steps: 0 }, { steps: 81 }, { steps: 2.5 }, { cfg: -1 }, { cfg: 21 }, { cfg: null }, { sampler: 'arbitrary' }, { scheduler: 'arbitrary' }, { preset: 'krea2_turbo', cfg: 2 }, { model: 'not-installed.safetensors' }, { vae: 'ae.safetensors' }, { url: comfyUrl }, { token: 'secret' }, { graph: {} }, { denoise: 0.5 }, { batch_size: 2 }, { preset: 'sdxl', model: 'test.safetensors', clip: 'qwen3vl_4b.safetensors' }]) {
    const before = submissions
    generationArgs = { prompt: 'Invalid tuning', preset: 'krea2_raw', model: 'krea-raw.safetensors', clip: 'qwen3vl_4b.safetensors', vae: 'qwen_image_vae.safetensors', ...patch }
    assert.ok(result(await turn(tuningBypass.id)).error, JSON.stringify(patch))
    assert.equal(submissions, before)
  }
  const installedSamplers = info.KSampler.input.required.sampler_name[0]
  info.KSampler.input.required.sampler_name[0] = ['euler']
  generationArgs = { prompt: 'Missing installed sampler', sampler: 'dpmpp_2m' }
  const beforeMissingSampler = submissions
  assert.match(result(await turn(tuningBypass.id)).error, /sampler options/)
  assert.equal(submissions, beforeMissingSampler)
  info.KSampler.input.required.sampler_name[0] = installedSamplers
  generationArgs = { prompt: 'Frozen defaults', seed: 44 }
  approvalHook = async () => { await json('PUT', '/api/agents/images/settings', { preset: 'sd15' }) }
  const frozen = result(await turn(tuningThread.id, true)).image
  assert.equal(frozen.settings.preset, 'sdxl')
  assert.equal(frozen.settings.sampler, 'dpmpp_2m')
  assert.equal(frozen.settings.steps, 25)
  approvalHook = undefined
  await json('PUT', '/api/agents/images/settings', settings)
  approvalHook = async () => { await json('PUT', '/api/agents/images/settings', { token: 'changed-after-approval' }) }
  const beforeBackendChange = submissions
  assert.match(result(await turn(tuningThread.id, true)).error, /backend changed/)
  assert.equal(submissions, beforeBackendChange)
  approvalHook = undefined
  await json('PUT', '/api/agents/images/settings', settings)
  generationArgs = { prompt: 'Original Krea session' }
  console.log('PASS per-call tuning, complete frozen approval summary, strict bounds and backend-field refusal, no persistence and private reproducibility metadata')
  const zeroNode = info.ConditioningZeroOut
  delete info.ConditioningZeroOut
  const beforeMissingZero = submissions
  assert.match(result(await turn(second.id)).error, /missing nodes/)
  assert.equal(submissions, beforeMissingZero)
  info.ConditioningZeroOut = zeroNode
  // A later turn may inspect actual bytes, but successful generation never follows up itself.
  const visionThread = await thread()
  generationArgs = { prompt: 'First vision fixture' }
  const firstVisionImage = result(await turn(visionThread.id)).image
  generationArgs = { prompt: 'Second vision fixture', seed: 88 }
  const lastVisionImage = result(await turn(visionThread.id)).image
  requestedTool = 'view_generated_image'
  generationArgs = { instruction: 'Inspect visible quality issues' }
  const beforeVision = visionRequests.length
  const inspectedThread = await turn(visionThread.id)
  const inspected = JSON.parse(inspectedThread.messages.findLast((m: any) => m.toolName === 'view_generated_image').content)
  assert.equal(inspected.image_id, lastVisionImage.id)
  assert.equal(inspected.inspected, true)
  assert.equal(visionRequests.length, beforeVision + 1)
  assert.equal(visionRequests.at(-1).messages.at(-1).images[0], png.toString('base64'))
  generationArgs = { image_id: firstVisionImage.id }
  assert.equal(JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content).image_id, firstVisionImage.id)
  generationArgs = { image_id: tuned.id }
  const beforeForeign = visionRequests.length
  assert.match(JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content).error, /No generated image/)
  assert.equal(visionRequests.length, beforeForeign)
  const textThread = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'text-model', permission: 'bypass' })
  generationArgs = {}
  assert.match(JSON.parse((await turn(textThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content).error, /vision-capable/)
  assert.equal(visionRequests.length, beforeForeign)
  generationArgs = { image_id: lastVisionImage.id }
  holdVision = true
  const beforeHeldVision = visionRequests.length
  const heldVision = await api('POST', `/api/agents/threads/${visionThread.id}/messages`, { text: 'Inspect then cancel' })
  await until(() => visionRequests.length > beforeHeldVision)
  await json('POST', `/api/agents/threads/${visionThread.id}/stop`, {})
  await heldVision.text()
  await until(() => cancelledVision > 0)
  holdVision = false
  assert.equal((await json('GET', `/api/agents/threads/${visionThread.id}`)).thread.running, false)
  await json('PUT', '/api/agents/images/settings', { url: '' })
  const disconnectedInspection = await turn(visionThread.id)
  assert.equal(JSON.parse(disconnectedInspection.messages.findLast((m: any) => m.toolName === 'view_generated_image').content).inspected, true)
  await json('PUT', '/api/agents/images/settings', settings)
  const { generatedImageForVision } = await import('../server/agentImages.ts')
  assert.throws(() => generatedImageForVision({ id: 2 } as any, visionThread.id), /No such thread/)
  database().prepare('UPDATE agent_images SET body = ? WHERE id = ?').run(Buffer.alloc(8 * 1024 * 1024 + 1), firstVisionImage.id)
  generationArgs = { image_id: firstVisionImage.id }
  assert.match(JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content).error, /8 MiB/)
  requestedTool = 'generate_image'
  generationArgs = { prompt: 'Silent batch' }
  extraToolCalls = [{ name: 'view_generated_image', arguments: {} }, { name: 'generate_image', arguments: { prompt: 'Must be skipped' } }]
  const batchThread = await thread()
  const beforeBatch = submissions, chatsBeforeBatch = providerChats, visionBeforeBatch = visionRequests.length
  database().prepare('UPDATE agent_threads SET todos = ? WHERE id = ?').run(JSON.stringify([{ text: 'Future work', status: 'pending' }]), batchThread.id)
  const batch = await turn(batchThread.id)
  const batchResults = batch.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content))
  assert.equal(batchResults.length, 3)
  assert.ok(batchResults[0].image)
  assert.ok(batchResults[1].skipped && batchResults[2].skipped)
  assert.equal(submissions, beforeBatch + 1)
  assert.equal(providerChats, chatsBeforeBatch + 1)
  assert.equal(visionRequests.length, visionBeforeBatch)
  assert.equal(batch.thread.todos[0].status, 'pending')
  extraToolCalls = []
  behavior = 'error'
  const errorChats = providerChats
  await turn((await thread()).id)
  assert.equal(providerChats, errorChats + 2)
  behavior = 'ok'
  console.log('PASS silent generation, complete tool batches and todos, exact pending dimensions, actual vision bytes, latest/current-thread ownership, unsupported models and payload limit')
  const metadataPath = '/api/agents/images/model-metadata?category=checkpoints&name=test.safetensors'
  const metadata = await json('GET', metadataPath)
  assert.equal(metadata.source, 'LoRA Manager')
  assert.equal(metadata.size, 12345)
  assert.ok(metadata.preview.startsWith('/api/agents/images/model-previews/'))
  assert.ok(!JSON.stringify(metadata).includes('/models/') && !JSON.stringify(metadata).includes('test-secret'))
  assert.equal((await api('GET', metadata.preview, undefined, 1)).status, 404)
  assert.equal((await fetch(server.origin + metadata.preview)).status, 401)
  assert.deepEqual(Buffer.from(await (await api('GET', metadata.preview)).arrayBuffer()), png)
  for (const name of ['../test.safetensors', '/test.safetensors', 'folder/../test.safetensors', 'http://test', 'a\\..\\b']) assert.equal((await api('GET', '/api/agents/images/model-metadata?' + new URLSearchParams({ category: 'checkpoints', name }))).status, 400)
  assert.equal((await api('GET', '/api/agents/images/model-metadata?category=__proto__&name=test')).status, 400)
  assert.equal((await api('GET', '/api/agents/images/model-metadata?category=checkpoints&name=unknown.safetensors')).status, 404)
  for (const mode of ['missing', 'wrong-category', 'duplicate'] as const) { previewMode = mode; assert.equal((await json('GET', metadataPath)).available, false) }
  previewMode = 'mislabeled'
  assert.equal((await api('GET', metadata.preview)).headers.get('content-type'), 'image/png')
  previewMode = 'unsafe-path'
  assert.equal((await json('GET', metadataPath)).preview, undefined)
  for (const mode of ['oversize', 'mime', 'invalid'] as const) { previewMode = mode; assert.ok((await api('GET', metadata.preview)).status >= 400) }
  previewMode = 'ok'
  await json('PUT', '/api/agents/images/settings', { token: 'changed' })
  assert.equal((await api('GET', metadata.preview)).status, 404)
  console.log('PASS private exact-identity previews, optional backend fallback, category/path validation, credential binding, MIME/signature/size limits')
  assert.equal(fullCatalogRequests, 0)
  console.log('All image generation checks passed')
} finally {
  await server.dispose()
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>((r) => comfy.close(() => r())), new Promise<void>((r) => ollama.close(() => r()))])
}
