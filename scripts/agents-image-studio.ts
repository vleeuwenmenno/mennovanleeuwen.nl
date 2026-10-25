// The Image Studio (server/agentImageStudio.ts, src/data/imageStudio.ts): the shared family rules,
// the form's request and validation, and the direct generation endpoint against the real server
// with a synthetic ComfyUI that records each graph. No GPU, no real data.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { applyPresetRules, bucketSize, presetRules, promptTokens, sizeBuckets, SIZE_LIMITS, variantFor } from '../src/data/modelFamilies.ts'
import { applyRecipe, defaultStudioForm, formFromSettings, normalizeStudioForm, promptWithEmbeddings, sourceSize, studioProblems, studioRecipe, studioRunInput, variantPreset, type StudioCatalog } from '../src/data/imageStudio.ts'
import type { ImagePreset } from '../src/data/imageModels.ts'

const PRESETS: ImagePreset[] = ['sd15', 'sdxl', 'z_image', 'z_image_turbo', 'krea2_raw', 'krea2_turbo']

// --- the shared rules ------------------------------------------------------------------------------
{
  for (const preset of PRESETS) {
    const r = presetRules(preset), diffusion = !preset.startsWith('sd')
    assert.equal(r.encoder, diffusion, `${preset} encoder`)
    assert.equal(r.vae, diffusion ? 'required' : 'builtin')
    assert.equal(r.negative, !preset.endsWith('turbo'), `${preset} negative`)
    assert.equal(r.fixedCfg, preset.endsWith('turbo') ? 1 : null)
    assert.equal(r.clipSkip, !diffusion); assert.equal(r.embeddings, !diffusion); assert.equal(r.loraClip, !diffusion)
    assert.equal(r.counter, diffusion ? 'chars' : 'tokens')
    for (const b of sizeBuckets(preset)) {
      assert.ok(b.width % 64 === 0 && b.height % 64 === 0 && b.width >= SIZE_LIMITS.min && b.height <= SIZE_LIMITS.max && b.width * b.height <= SIZE_LIMITS.area, `${preset} ${b.label} ${b.width}x${b.height}`)
    }
  }
  assert.deepEqual(presetRules('krea2_turbo').variants, ['krea2_raw', 'krea2_turbo'])
  assert.deepEqual(presetRules('z_image').variants, ['z_image', 'z_image_turbo'])
  assert.equal(presetRules('sdxl').variants, null)
  assert.deepEqual(bucketSize(1024, 1, 1), { width: 1024, height: 1024 })
  assert.deepEqual(bucketSize(512, 1, 1), { width: 512, height: 512 })
  assert.ok(bucketSize(1024, 21, 9).width > bucketSize(1024, 21, 9).height)
  assert.equal(variantFor('krea2', 'krea2_raw'), 'krea2_raw')
  // Turbo: no negative prompt, CFG 1 (the hires pass too), no clip skip, no checkpoint VAE.
  const turbo = applyPresetRules({ preset: 'krea2_turbo', negative_prompt: 'blur', cfg: 5, clip_skip: 2, checkpoint_vae: 'v.safetensors', clip: 'c', vae: 'v', hires: { scale: 1.5, cfg: 4 } })
  assert.deepEqual(turbo, { preset: 'krea2_turbo', cfg: 1, clip: 'c', vae: 'v', hires: { scale: 1.5, cfg: 1 } })
  // Checkpoints: their own encoder, no workflow encoder or VAE fields.
  assert.deepEqual(applyPresetRules({ preset: 'sdxl', negative_prompt: 'blur', cfg: 6, clip_skip: 2, clip: 'c', vae: 'v', checkpoint_vae: 'cv' }), { preset: 'sdxl', negative_prompt: 'blur', cfg: 6, clip_skip: 2, checkpoint_vae: 'cv' })
  assert.deepEqual(applyPresetRules({ preset: 'nonsense', cfg: 9 }), { preset: 'nonsense', cfg: 9 }, 'unknown presets are left for the server to refuse')
  assert.ok(promptTokens('masterpiece, best quality, 1girl') >= 6 && promptTokens('') === 0)
  console.log('PASS shared family rules: encoder/VAE, negatives and CFG 1, clip skip, embeddings, model-only LoRAs, variants, size buckets, token estimate')
}

// --- the form ------------------------------------------------------------------------------------
const catalog: StudioCatalog = {
  checkpoints: ['SDXL/studio.safetensors'], diffusionModels: ['Krea2/Turbo/fast.safetensors', 'Z-Image-Turbo/zit.safetensors'],
  clips: ['enc/qwen3-vl-4b.safetensors', 'enc/qwen_3_4b.safetensors'], vaes: ['vae/qwen_image_vae.safetensors', 'vae/ae.safetensors', 'vae/sdxl_vae.safetensors'],
  loras: ['style.safetensors'], samplers: ['euler', 'euler_ancestral', 'dpmpp_2m'], schedulers: ['simple', 'beta', 'karras', 'normal'], upscalers: ['4x.pth'],
  nodes: ['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoader', 'LoraLoaderModelOnly', 'CLIPSetLastLayer'], clipTypes: ['krea2', 'lumina2'], img2img: true,
}
{
  const d = defaultStudioForm()
  assert.deepEqual(normalizeStudioForm(null), d)
  const odd = normalizeStudioForm({ preset: 'flux', width: 5000, height: 100, steps: 900, batch: 99, seed: -7, loras: [{ name: 'a', weight: 9 }, 'junk', { weight: 1 }], source: { id: 'x', url: 'https://evil.test/a.png' } })
  assert.equal(odd.preset, 'sdxl'); assert.equal(odd.width, 1536); assert.equal(odd.height, 256); assert.equal(odd.steps, 80); assert.equal(odd.batch, 8); assert.equal(odd.seed, -1)
  assert.deepEqual(odd.loras, [{ name: 'a', weight: 2 }]); assert.equal(odd.source, null, 'only this server’s own picture addresses')
  assert.equal(variantPreset('krea2_raw', 'auto', 'Krea2/Turbo/fast.safetensors'), 'krea2_turbo')
  assert.equal(variantPreset('krea2_turbo', 'raw', 'x'), 'krea2_raw')
  assert.equal(variantPreset('sdxl', 'turbo', 'x'), 'sdxl')
  // Problems, most basic first; an empty list means Generate can run.
  assert.deepEqual(studioProblems(d, { configured: false, catalog: null }), ['Connect ComfyUI in Settings → Agents → Images first.'])
  assert.match(studioProblems(d, { configured: true, catalog: null, catalogError: 'offline' })[0], /could not be read: offline/)
  assert.match(studioProblems(d, { configured: true, catalog })[0], /Write a prompt/)
  const ready = { ...d, prompt: 'a lighthouse', sampler: 'dpmpp_2m', scheduler: 'karras' }
  assert.deepEqual(studioProblems(ready, { configured: true, catalog }), [])
  assert.match(studioProblems({ ...ready, sampler: 'lms' }, { configured: true, catalog }).join(' '), /sampler/)
  assert.match(studioProblems({ ...ready, width: 1536, height: 1536 }, { configured: true, catalog }).join(' '), /limit/)
  const krea = { ...defaultStudioForm('krea2_turbo'), prompt: 'x', loras: [{ name: 'style.safetensors', weight: 1 }] }
  assert.deepEqual(studioProblems(krea, { configured: true, catalog }), [])
  assert.match(studioProblems({ ...krea, clip: '' }, { configured: true, catalog: { ...catalog, clips: [] } }).join(' '), /text encoder/)
  assert.match(studioProblems(krea, { configured: true, catalog: { ...catalog, nodes: ['LoraLoader'] } }).join(' '), /model-only LoRA loader/)
  assert.match(studioProblems({ ...ready, checkpointVae: 'gone.safetensors' }, { configured: true, catalog }).join(' '), /custom VAE/)
  assert.match(studioProblems({ ...ready, hires: { on: true, scale: 2, denoise: 0.3, steps: 10, upscaleModel: '' }, width: 1536, height: 1024 }, { configured: true, catalog }).join(' '), /upscaled size/)
  // The request: embeddings written in, family rules applied.
  assert.equal(promptWithEmbeddings('cat', [{ name: 'good', weight: 1, negative: false }, { name: 'bad', weight: 0.8, negative: true }], false), 'cat, embedding:good')
  assert.equal(promptWithEmbeddings('', [{ name: 'bad', weight: 0.8, negative: true }], true), '(embedding:bad:0.8)')
  const sent = studioRunInput({ ...ready, seed: 5, clipSkip: 2, checkpointVae: 'vae/sdxl_vae.safetensors', embeddings: [{ name: 'neg', weight: 1, negative: true }], negative: 'blur', clip: 'stale', vae: 'stale' })
  assert.equal(sent.negative_prompt, 'blur, embedding:neg'); assert.equal(sent.clip_skip, 2); assert.equal(sent.checkpoint_vae, 'vae/sdxl_vae.safetensors'); assert.equal(sent.seed, 5)
  assert.ok(!('clip' in sent) && !('vae' in sent), 'checkpoints send no workflow encoder or VAE')
  const sentTurbo = studioRunInput({ ...krea, negative: 'blur', cfg: 7, clipSkip: 3, embeddings: [{ name: 'neg', weight: 1, negative: false }], seed: -1 })
  assert.ok(!('negative_prompt' in sentTurbo) && !('clip_skip' in sentTurbo) && !('seed' in sentTurbo)); assert.equal(sentTurbo.cfg, 1); assert.equal(sentTurbo.prompt, 'x', 'no embeddings outside CLIP checkpoints')
  const img2img = studioRunInput({ ...ready, source: { id: 'abc', name: 's.png', url: '/api/agents/images/abc', width: 800, height: 600 }, denoise: 0.6 })
  assert.equal(img2img.source_image_id, 'abc'); assert.equal(img2img.denoise, 0.6)
  assert.deepEqual(sourceSize({ width: 800, height: 600 }, 1024), { width: 832, height: 576 })
  assert.ok(sourceSize({ width: 4000, height: 3000 }, 1024).width * sourceSize({ width: 4000, height: 3000 }, 1024).height <= SIZE_LIMITS.area)
  // Recipes: the model's own when it is for this preset, else the family default; Turbo CFG 1.
  const civitai = studioRecipe('sdxl', 'SDXL/studio.safetensors', catalog, { preset: 'sdxl', sampler: 'euler_ancestral', scheduler: 'normal', steps: 30, cfg: 5.5, clip_skip: 2, width: 832, height: 1216, source: 'civitai_examples', agree: '4 of 5' })
  assert.equal(civitai.source, 'civitai_examples'); assert.match(civitai.label, /Civitai recipe \(4 of 5 agree\)/); assert.equal(civitai.clipSkip, 2); assert.equal(civitai.height, 1216)
  const fallback = studioRecipe('krea2_turbo', 'Krea2/Turbo/fast.safetensors', catalog, { preset: 'krea2_raw', sampler: 'euler', scheduler: 'simple', steps: 52, cfg: 3.5, source: 'family_default' })
  assert.equal(fallback.source, 'family_default'); assert.equal(fallback.steps, 8); assert.equal(fallback.cfg, 1); assert.equal(fallback.sampler, 'euler_ancestral'); assert.equal(fallback.clipSkip, 1)
  assert.equal(studioRecipe('sdxl', '', { ...catalog, samplers: ['euler'] }, null).sampler, 'euler', 'only installed samplers')
  const applied = applyRecipe({ ...ready, edited: true }, civitai, 'SDXL/studio.safetensors')
  assert.equal(applied.edited, false); assert.equal(applied.steps, 30); assert.equal(applied.recipe?.model, 'SDXL/studio.safetensors'); assert.equal(applied.recipe?.source, 'civitai_examples')
  // Use these settings: the recorded generation back in the form; the seed stays when locked.
  const restored = formFromSettings({ ...d, seed: 9, seedLock: true }, { preset: 'krea2_turbo', model: 'm', clip: 'c', vae: 'v', loras: [], steps: 8, cfg: 1, sampler: 'euler', scheduler: 'beta', width: 1024, height: 768, seed: 77, prompt: 'p', negative_prompt: '', denoise: 1 })
  assert.equal(restored.preset, 'krea2_turbo'); assert.equal(restored.variant, 'turbo'); assert.equal(restored.height, 768); assert.equal(restored.seed, 9); assert.equal(restored.prompt, 'p')
  assert.equal(formFromSettings(d, { operation: 'upscale' } as never), d)
  console.log('PASS Studio form: saved copies normalized, variants, validation reasons, request with embeddings and family rules, recipes with their source, Use these settings')
}

// --- the endpoint, against the real server and a synthetic ComfyUI -----------------------------------
const png = readFileSync(new URL('./fixtures/agent-image-sources/source.png', import.meta.url))
const options: Record<string, Record<string, unknown>> = {
  CheckpointLoaderSimple: { ckpt_name: [['SDXL/studio.safetensors']] }, UNETLoader: { unet_name: [['Krea2/Turbo/fast.safetensors', 'Z-Image-Turbo/zit.safetensors']] },
  CLIPLoader: { clip_name: [['enc/qwen3-vl-4b.safetensors', 'enc/qwen_3_4b.safetensors']], type: [['krea2', 'lumina2']] }, VAELoader: { vae_name: [['vae/qwen_image_vae.safetensors', 'vae/ae.safetensors', 'vae/sdxl_vae.safetensors']] },
  KSampler: { sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m']], scheduler: [['simple', 'beta', 'karras', 'normal']] },
  LoraLoader: { lora_name: [['style.safetensors']] }, LoraLoaderModelOnly: { lora_name: [['style.safetensors']] },
  ImageScale: { upscale_method: [['lanczos']], crop: [['center', 'disabled']] }, LoadImage: { image: [[]] },
}
const NODES = ['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'ConditioningZeroOut', 'LoraLoader', 'LoraLoaderModelOnly', 'LoadImage', 'ImageScale', 'VAEEncode', 'CLIPSetLastLayer', 'ModelSamplingDiscrete']
const graphs: any[] = []
let jobs = 0
const comfy = createServer((req, res) => {
  let raw = ''
  req.on('data', (b) => (raw += b))
  req.on('end', () => {
    const path = new URL(req.url!, 'http://fixture').pathname
    const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    if (path.startsWith('/object_info/')) {
      const node = path.slice(13)
      return send(NODES.includes(node) ? { [node]: { input: { required: options[node] ?? {} } } } : {})
    }
    if (path === '/embeddings') return send(['EasyNegative', 'good-hands'])
    if (path === '/upload/image') return send({ name: /filename="([^"]+)"/.exec(raw)![1], subfolder: '', type: 'input' })
    if (path === '/prompt') { graphs.push(JSON.parse(raw).prompt); return send({ prompt_id: `job-${++jobs}` }) }
    if (path.startsWith('/history/')) { const id = path.split('/').pop()!; return send({ [id]: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }) }
    if (path === '/view') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png)
    if (path === '/queue') return send({ queue_running: [], queue_pending: [] })
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => comfy.listen(0, '127.0.0.1', r))
const comfyUrl = `http://127.0.0.1:${(comfy.address() as { port: number }).port}`
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'studio-owner', OLLAMA_API_KEY: 'fake' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sessions = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
for (let i = 1; i <= 2; i++) {
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, i, i === 1 ? 'studio-owner' : 'studio-other', encrypt('none'), Date.now(), Date.now())
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sessions[i - 1]), i, Date.now(), Date.now() + 86400_000)
}
await server.start()
const call = async (method: string, path: string, body?: unknown, account: number | null = 0) => fetch(server.origin + path, { method, headers: { ...(account === null ? { 'X-MvL-Account': 'visitor' } : { Cookie: `mvlos_sid=${sessions[account]}`, ...(await asPage(sessions[account])) }), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const ok = async (method: string, path: string, body?: unknown, account = 0) => {
  const res = await call(method, path, body, account)
  assert.equal(res.status, 200, await res.clone().text())
  return res.json() as Promise<any>
}
const events = async (res: Response) => (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const run = async (input: Record<string, unknown>, batch = 1, account = 0) => {
  const res = await call('POST', '/api/agents/images/studio/run', { input, batch }, account)
  return { status: res.status, events: res.status === 200 ? await events(res) : [], text: res.status === 200 ? '' : await res.text() }
}
const lastGraph = () => graphs.at(-1)
const byClass = (g: any, c: string) => Object.entries(g).filter(([, n]: any) => n.class_type === c).map(([id, n]: any) => ({ id, ...n }))

try {
  // Who may use it: signed in, and with ComfyUI connected for this account.
  assert.ok([401, 403].includes((await call('GET', '/api/agents/images/studio', undefined, null)).status))
  assert.ok([401, 403].includes((await call('POST', '/api/agents/images/studio/run', { input: { prompt: 'x' } }, null)).status))
  const other = await ok('GET', '/api/agents/images/studio', undefined, 1)
  assert.equal(other.configured, false)
  const notConnected = await run({ preset: 'sdxl', prompt: 'x' }, 1, 1)
  assert.equal(notConnected.status, 409); assert.match(notConnected.text, /Connect ComfyUI/)
  await ok('PUT', '/api/agents/images/settings', { url: comfyUrl, preset: 'sdxl' })
  const mine = await ok('GET', '/api/agents/images/studio')
  assert.equal(mine.configured, true); assert.match(mine.thread, /^[0-9a-f-]{36}$/)
  assert.notEqual(mine.thread, other.thread)
  assert.equal((await ok('GET', '/api/agents/images/studio')).thread, mine.thread, 'one Studio thread per account')
  const listed = await ok('GET', '/api/agents/threads')
  assert.ok(!(Array.isArray(listed) ? listed : listed.threads ?? []).some((t: any) => t.id === mine.thread), 'the Studio thread is not in the thread list')
  console.log('PASS Studio endpoint: sign-in required, own ComfyUI required, one hidden Studio thread per account')

  // Validation before anything is queued.
  for (const [body, pattern] of [[{ input: { prompt: 'x' }, batch: 9 }, /Batch/], [{ input: { prompt: 'x' }, extra: 1 }, /input, batch/], [{ input: 'x' }, /object/], [{ input: { operation: 'upscale', source_image_id: 'x' }, batch: 2 }, /batch/], [{ input: { preset: 'sdxl', prompt: '' } }, /prompt/], [{ input: { preset: 'sdxl', prompt: 'x', workflow: {} } }, /supported image generation parameters/], [{ input: { preset: 'sdxl', prompt: 'x', steps: 500 } }, /Steps/]] as const) {
    const res = await call('POST', '/api/agents/images/studio/run', body)
    assert.equal(res.status, 400, JSON.stringify(body)); assert.match(await res.text(), pattern)
  }
  const before = graphs.length
  const missing = await run({ preset: 'sdxl', prompt: 'x', checkpoint_vae: 'vae/missing.safetensors' })
  assert.equal(missing.status, 409); assert.match(missing.text, /checkpoint VAE is not installed/)
  assert.equal(graphs.length, before, 'nothing reaches ComfyUI after a refused request')
  console.log('PASS Studio endpoint validation: batch, keys, operation, prompt, graph fields, limits and assets refused before queueing')

  // Krea2 Turbo: separate encoder (krea2) and VAE, zeroed negative, CFG 1, no clip skip, model-only LoRA.
  let r = await run({ preset: 'krea2_turbo', model: 'Krea2/Turbo/fast.safetensors', clip: '', vae: '', prompt: 'a red fox', negative_prompt: 'blurry', cfg: 6, clip_skip: 2, steps: 8, sampler: 'euler_ancestral', scheduler: 'beta', width: 1024, height: 768, seed: 42, loras: [{ name: 'style.safetensors', weight: 0.75 }] })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.events.map((e) => e.type).filter((t) => t !== 'progress'), ['start', 'image', 'done'])
  assert.ok(r.events.some((e) => e.type === 'progress'), 'progress reaches the Studio')
  let g = lastGraph()
  assert.equal(g['1'].class_type, 'UNETLoader'); assert.equal(g['1'].inputs.unet_name, 'Krea2/Turbo/fast.safetensors')
  assert.equal(g['2'].class_type, 'CLIPLoader'); assert.equal(g['2'].inputs.type, 'krea2'); assert.equal(g['2'].inputs.clip_name, 'enc/qwen3-vl-4b.safetensors')
  assert.equal(g['3'].class_type, 'VAELoader'); assert.equal(g['3'].inputs.vae_name, 'vae/qwen_image_vae.safetensors')
  assert.equal(g['5'].class_type, 'ConditioningZeroOut', 'Krea2 Turbo zeroes the negative')
  assert.equal(g['7'].inputs.cfg, 1); assert.equal(g['7'].inputs.seed, 42); assert.equal(g['6'].inputs.width, 1024); assert.equal(g['6'].inputs.height, 768)
  assert.equal(byClass(g, 'CLIPSetLastLayer').length, 0)
  assert.deepEqual(byClass(g, 'LoraLoaderModelOnly').map((n) => [n.inputs.lora_name, n.inputs.strength_model]), [['style.safetensors', 0.75]])
  assert.equal(byClass(g, 'LoraLoader').length, 0, 'Krea2 LoRAs are model-only')
  const krea = r.events.find((e) => e.type === 'image').image
  assert.equal(krea.settings.negative_prompt, ''); assert.equal(krea.settings.cfg, 1)

  // Z-Image Turbo: lumina2 encoder, the negative dropped (an empty text encode), CFG 1.
  r = await run({ preset: 'z_image_turbo', model: 'Z-Image-Turbo/zit.safetensors', prompt: 'a city', negative_prompt: 'ugly', cfg: 4, steps: 8, sampler: 'euler', scheduler: 'simple', width: 1024, height: 1024 })
  assert.equal(r.status, 200, r.text)
  g = lastGraph()
  assert.equal(g['2'].inputs.type, 'lumina2'); assert.equal(g['5'].class_type, 'CLIPTextEncode'); assert.equal(g['5'].inputs.text, ''); assert.equal(g['7'].inputs.cfg, 1)

  // SDXL checkpoint: clip skip, a custom VAE, LoRA on model and encoder, the negative kept; stale workflow encoder/VAE dropped.
  r = await run({ preset: 'sdxl', model: 'SDXL/studio.safetensors', clip: 'enc/qwen_3_4b.safetensors', vae: 'vae/ae.safetensors', checkpoint_vae: 'vae/sdxl_vae.safetensors', prompt: 'portrait', negative_prompt: 'lowres', cfg: 6, clip_skip: 2, steps: 25, sampler: 'dpmpp_2m', scheduler: 'karras', width: 832, height: 1216, loras: [{ name: 'style.safetensors', weight: 1 }] })
  assert.equal(r.status, 200, r.text)
  g = lastGraph()
  assert.equal(g['1'].class_type, 'CheckpointLoaderSimple'); assert.equal(byClass(g, 'CLIPLoader').length, 0)
  assert.equal(g.clipSkip.class_type, 'CLIPSetLastLayer'); assert.equal(g.clipSkip.inputs.stop_at_clip_layer, -2)
  assert.equal(g['3'].class_type, 'VAELoader'); assert.equal(g['3'].inputs.vae_name, 'vae/sdxl_vae.safetensors')
  assert.deepEqual(g['8'].inputs.vae, ['3', 0], 'the custom VAE decodes')
  assert.equal(byClass(g, 'LoraLoader').length, 1); assert.deepEqual(byClass(g, 'LoraLoader')[0].inputs.clip, ['clipSkip', 0])
  assert.equal(g['5'].inputs.text, 'lowres'); assert.equal(g['7'].inputs.cfg, 6)
  const sdxl = r.events.find((e) => e.type === 'image').image
  assert.equal(sdxl.settings.checkpoint_vae, 'vae/sdxl_vae.safetensors'); assert.equal(sdxl.settings.vae, ''); assert.equal(sdxl.settings.clip_skip, 2)
  // Generate another on that picture keeps its custom VAE.
  const { imageAgainInput } = await import('../server/agentImages.ts')
  assert.equal(imageAgainInput({ id: 1 } as never, mine.thread, sdxl.id).checkpoint_vae, 'vae/sdxl_vae.safetensors')
  // A diffusion model refuses a checkpoint VAE when asked directly, past the rules.
  const { imageWorkflow } = await import('../server/agentImages.ts')
  assert.throws(() => imageWorkflow({ url: '', token: '', preset: 'krea2_turbo', model: 'm', clip: 'c', vae: 'v' } as never, { prompt: 'x', checkpoint_vae: 'v2' }), /checkpoint_vae applies/)
  console.log('PASS Studio graphs: Krea2 Turbo zeroed negative, CFG 1, krea2 encoder + VAE, model-only LoRA; Z-Image Turbo negative dropped; SDXL clip skip, custom VAE, LoRA on encoder')

  // A batch: one picture after another, the seed counting up.
  r = await run({ preset: 'sdxl', model: 'SDXL/studio.safetensors', prompt: 'batch', steps: 4, cfg: 6, sampler: 'euler', scheduler: 'normal', width: 512, height: 512, seed: 10 }, 3)
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.events.filter((e) => e.type === 'image').map((e) => e.image.seed), [10, 11, 12])
  assert.deepEqual(r.events.filter((e) => e.type === 'start').map((e) => [e.index, e.total]), [[0, 3], [1, 3], [2, 3]])
  console.log('PASS Studio batch: three runs in order, seeds 10, 11, 12')

  // Uploads become image-to-image sources; history and pictures stay the owner's.
  const bad = await call('POST', '/api/agents/images/studio/upload', { name: 'x.png', data: Buffer.from('not a picture').toString('base64') })
  assert.equal(bad.status, 400)
  const upload = await ok('POST', '/api/agents/images/studio/upload', { name: 'My photo.PNG', data: png.toString('base64') })
  assert.match(upload.name, /^upload-My-photo\.png$/); assert.ok(upload.width > 0)
  r = await run({ preset: 'sdxl', model: 'SDXL/studio.safetensors', prompt: 'edit', steps: 4, cfg: 6, sampler: 'euler', scheduler: 'normal', width: 512, height: 512, source_image_id: upload.id, denoise: 0.6 })
  assert.equal(r.status, 200, r.text)
  g = lastGraph()
  assert.equal(byClass(g, 'LoadImage').length, 1); assert.equal(g['6'].class_type, 'VAEEncode'); assert.equal(g['7'].inputs.denoise, 0.6)
  const history = await ok('GET', '/api/agents/images/studio/images')
  assert.equal(history.images.length, 8); assert.equal(history.images[0].settings.source.id, upload.id)
  assert.ok(history.images.every((i: any) => i.studio && i.url.startsWith('/api/agents/images/')))
  assert.equal(history.images.find((i: any) => i.id === upload.id).settings, null)
  assert.equal((await ok('GET', '/api/agents/images/studio/images?limit=2')).images.length, 2)
  const paged = await ok('GET', `/api/agents/images/studio/images?limit=2&before=${history.images[1].id}`)
  assert.equal(paged.images[0].id, history.images[2].id)
  assert.equal((await ok('GET', '/api/agents/images/studio/images', undefined, 1)).images.length, 0, 'another account sees none')
  assert.equal((await call('GET', `/api/agents/images/${upload.id}`, undefined, 1)).status, 404)
  assert.equal((await call('DELETE', `/api/agents/images/studio/images/${upload.id}`, undefined, 1)).status, 404)
  assert.equal((await call('GET', '/api/agents/images/studio/images?scope=bogus')).status, 400)
  assert.deepEqual((await ok('GET', '/api/agents/images/studio/embeddings')).embeddings, ['EasyNegative', 'good-hands'])
  await ok('DELETE', `/api/agents/images/studio/images/${history.images[0].id}`)
  assert.equal((await ok('GET', '/api/agents/images/studio/images')).images.length, 7)
  console.log('PASS Studio history and uploads: PNG uploads as sources, img2img graph, paging, owner-only pictures, deletes and embeddings')
} finally {
  await server.dispose()
  comfy.close()
}
console.log('all passed')
