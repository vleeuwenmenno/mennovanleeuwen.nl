// Real Agents HTTP/streaming integration against mocked Ollama and ComfyUI. No GPU or real data.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { modelAssets, modelFolders, visibleModelAssets } from '../src/data/imageModels.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
const send = (res: ServerResponse, data: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
const info = Object.fromEntries(['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'ConditioningZeroOut'].map((name) => [name, { input: { required: {} } }])) as Record<string, any>
info.CheckpointLoaderSimple.input.required.ckpt_name = [['test.safetensors']]
info.UNETLoader.input.required.unet_name = [['z-test.safetensors']]
info.CLIPLoader.input.required = { clip_name: [['encoder.safetensors']], type: [['lumina2', 'krea2']] }
info.VAELoader.input.required.vae_name = [['vae.safetensors']]
info.KSampler.input.required = { sampler_name: [['euler', 'euler_ancestral']], scheduler: [['simple', 'beta']] }
let catalogBehavior: 'ok' | 'oversize' | 'aggregate' | 'invalid' | 'missing' = 'ok'
const discoveryRequests: string[] = []
const irrelevantCatalog = JSON.stringify({ ...info, IrrelevantCustomNode: { description: 'x'.repeat(9 * 1024 * 1024) } })
let fullCatalogRequests = 0
let behavior: 'ok' | 'wait' | 'error' | 'invalid' | 'oversize' = 'ok'
let submissions = 0
let historyReads = 0
let interrupts = 0
const deletions: string[] = []
let submitted: Record<string, any> = {}
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
    if (req.url === '/api/tags') return send(res, { models: [{ name: 'test-model' }] })
    if (req.url === '/api/show') return send(res, { capabilities: ['tools'], model_info: { 'test.context_length': 131072 } })
    if (req.url !== '/api/chat') return res.writeHead(404).end()
    const body = JSON.parse(raw)
    if (!body.stream) return send(res, { message: { content: '{"title":"Image test"}' } })
    const after = body.messages.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1)
    const message = after.some((m: any) => m.role === 'tool') ? { content: 'Image request handled.' } : { content: '', tool_calls: [{ function: { name: 'generate_image', arguments: generationArgs } }] }
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
      if (event.type === 'approval') await json('POST', `/api/agents/threads/${id}/approve`, { callId: event.callId, allow: approve ?? false })
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
  assert.deepEqual(catalog.diffusionModels, ['z-test.safetensors'])
  assert.deepEqual(catalog.clips, ['encoder.safetensors'])
  assert.deepEqual(catalog.vaes, ['vae.safetensors'])
  assert.deepEqual(catalog.clipTypes, ['lumina2', 'krea2'])
  assert.deepEqual(catalog.samplers, ['euler', 'euler_ancestral'])
  assert.deepEqual(catalog.schedulers, ['simple', 'beta'])
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
    if (preset === 'z_image_turbo') assert.equal(graph.graph['7'].inputs.cfg, 1)
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
  const made = result(await turn(t.id, true))
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
    const selection = { preset, model: 'z-test.safetensors', clip: 'encoder.safetensors', vae: 'vae.safetensors' }
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
  assert.equal(fullCatalogRequests, 0)
  console.log('All image generation checks passed')
} finally {
  await server.dispose()
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>((r) => comfy.close(() => r())), new Promise<void>((r) => ollama.close(() => r()))])
}
