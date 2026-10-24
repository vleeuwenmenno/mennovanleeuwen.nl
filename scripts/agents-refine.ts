// Hires/refinement graphs and execution against a synthetic ComfyUI, never a GPU.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { refinementSize } from '../server/agentImageRefine.ts'
import { imagePresetSpec } from '../src/data/imageModels.ts'

const scratch = mkdtempSync(join(tmpdir(), 'agents-refine-'))
process.env.DATA_DIR = scratch
const { database } = await import('../server/db.ts')
const { imageWorkflow, prepareImageGeneration, generateImage, imageAgainInput, saveImageSettings } = await import('../server/agentImages.ts')
const { addHiresStage } = await import('../server/agentImageRefine.ts')
const user = { id: 1, admin: true, login: 'fixture' } as never
const settings = { url: '', token: '', model: 'checkpoint', preset: 'sdxl' as const, clip: 'clip', vae: 'vae', askBeforeGenerate: false, askBeforeSavingObservations: false, saveImageLearnings: true }
assert.deepEqual(refinementSize({ width: 1024, height: 768 }, {}), { width: 1536, height: 1152 })
assert.deepEqual(refinementSize({ width: 1024, height: 768 }, { scale: 1 }), { width: 1024, height: 768 })
for (const bad of [{ scale: 0.5 }, { scale: 3 }, { scale: NaN }, { scale: 1, width: 512 }, { width: 2049 }, { width: 257 }]) assert.throws(() => refinementSize({ width: 1024, height: 1024 }, bad))
for (const preset of ['sd15', 'sdxl', 'z_image', 'z_image_turbo', 'krea2_raw', 'krea2_turbo'] as const) {
  const spec = imagePresetSpec(preset)
  const base = imageWorkflow({ ...settings, preset }, { prompt: 'fixture', seed: 42, width: 512, height: 512 })
  const stage = addHiresStage(base.graph, { scale: 1.5, denoise: 0.2, steps: 12 }, base, preset)
  assert.equal(stage.settings.width, 768); assert.equal(stage.settings.base_width, 512)
  const sampler = base.graph.hiresSampler.inputs
  assert.equal(sampler.seed, 42); assert.equal(sampler.steps, 12); assert.equal(sampler.denoise, 0.2)
  assert.deepEqual(sampler.model, base.graph['7'].inputs.model)
  assert.deepEqual(sampler.positive, base.graph['7'].inputs.positive)
  assert.deepEqual(sampler.negative, base.graph['7'].inputs.negative)
  assert.deepEqual(base.graph.hiresSize.inputs.image, ['8', 0])
  assert.deepEqual(base.graph['9'].inputs.images, ['hiresDecode', 0])
  assert.equal(Object.values(base.graph).filter(n => n.class_type === 'SaveImage').length, 1)
  const refine = imageWorkflow({ ...settings, preset }, { operation: 'refine', prompt: 'fixture', seed: 42, width: 2048, height: 2048 }, undefined, 'owned.png')
  assert.equal(refine.graph['6'].class_type, 'VAEEncode'); assert.equal(refine.denoise, 0.2)
  assert.equal(Object.values(refine.graph).some(n => n.class_type === 'EmptyLatentImage'), false)
  if (!spec.negative) {
    assert.equal(sampler.cfg, 1)
    assert.throws(() => addHiresStage(base.graph, { cfg: 2 }, base, preset), /CFG 1/)
  }
  if (spec.zeroNegative) assert.equal(base.graph['5'].class_type, 'ConditioningZeroOut')
}
assert.throws(() => imageWorkflow({ ...settings, preset: 'krea2_turbo' }, { prompt: 'fixture', loras: [{ name: 'lora', weight: 1 }] }, { nodes: ['LoraLoader'] }), /model-only LoRA loader/)
console.log('PASS six-family refinement/hires graphs, exact conditioning, Turbo rules, Krea2 model-only LoRAs, independent limits and seed')

const info: Record<string, any> = Object.fromEntries(['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'ConditioningZeroOut', 'LoraLoader', 'LoraLoaderModelOnly', 'LoadImage', 'ImageScale', 'VAEEncode', 'UpscaleModelLoader', 'ImageUpscaleWithModel'].map(n => [n, { input: { required: {} } }]))
info.CheckpointLoaderSimple.input.required.ckpt_name = [['checkpoint']]
info.UNETLoader.input.required.unet_name = [['diffusion']]
info.CLIPLoader.input.required = { clip_name: [['clip']], type: [['lumina2', 'krea2']] }
info.VAELoader.input.required.vae_name = [['vae']]
info.LoraLoaderModelOnly.input.required.lora_name = [['lora']]
info.KSampler.input.required = { sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m']], scheduler: [['simple', 'beta', 'karras']] }
info.LoadImage.input.required.image = [['source.png']]
info.ImageScale.input.required = { image: ['IMAGE'], upscale_method: [['lanczos']], width: ['INT', { min: 0, max: 4096 }], height: ['INT', { min: 0, max: 4096 }], crop: [['center', 'disabled']] }
info.VAEEncode.input.required = { pixels: ['IMAGE'], vae: ['VAE'] }
info.VAEDecode.input.required = { samples: ['LATENT'], vae: ['VAE'] }
info.SaveImage.input.required = { images: ['IMAGE'], filename_prefix: ['STRING'] }
info.UpscaleModelLoader.input.required.model_name = [['upscaler']]
info.ImageUpscaleWithModel.input.required = { image: ['IMAGE'], upscale_model: ['UPSCALE_MODEL'] }
const png = readFileSync(new URL('./fixtures/agent-image-sources/source.png', import.meta.url))
let graph: any, submits = 0, uploads = 0, missing = '', outputWrong = false
const comfy = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString(), path = new URL(req.url!, 'http://fixture').pathname
  const send = (value: unknown) => res.end(JSON.stringify(value))
  if (path.startsWith('/object_info/')) { const node = path.slice(13); return send(node === missing ? {} : { [node]: info[node] }) }
  if (path.startsWith('/api/lm/')) return res.writeHead(404).end()
  if (path === '/upload/image') { uploads++; return send({ name: /filename="([^"]+)"/.exec(body)![1], subfolder: '', type: 'input' }) }
  if (path === '/prompt') { graph = JSON.parse(body).prompt; submits++; return send({ prompt_id: 'ours' }) }
  if (path === '/history/ours') return send({ ours: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] } } } })
  if (path === '/view') {
    // Synthetic backend response: dimensions are deliberately tested before persistence.
    const bytes = Buffer.from(png), size = graph.hiresSize?.inputs ?? graph['21']?.inputs ?? graph['6'].inputs
    bytes.writeUInt32BE(outputWrong ? 1 : size.width, 16); bytes.writeUInt32BE(size.height, 20)
    return res.end(bytes)
  }
  if (path === '/queue') return send({})
  res.writeHead(404).end()
})
await new Promise<void>(r => comfy.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(comfy.address() as { port: number }).port}`
const db = database(), thread = randomUUID(), source = randomUUID()
try {
  db.prepare("INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (1,1,'fixture','',0,0)").run()
  db.prepare("INSERT INTO agent_threads (id,user_id,title,mode,model,created_at,updated_at) VALUES (?,1,'Fixture','quick','fixture',0,0)").run(thread)
  const original = { preset: 'sdxl', model: 'checkpoint', clip: '', vae: '', prompt: 'Inherited fixture prompt', negative_prompt: 'blur', steps: 25, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', width: 512, height: 512, seed: 123, denoise: 1, loras: [] }
  const insert = (id: string, metadata: object | null, ownerThread = thread) => db.prepare('INSERT INTO agent_images (id,thread_id,name,body,created_at,metadata) VALUES (?,?,?,?,0,?)').run(id, ownerThread, 'fixture.png', png, metadata ? JSON.stringify(metadata) : null)
  insert(source, original)
  saveImageSettings(user, { url, preset: 'sdxl', model: 'checkpoint' })
  const signal = AbortSignal.timeout(30000)
  let plan = await prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: source, width: 768, height: 768 }, signal)
  assert.equal(plan.parameters.operation, 'refine')
  assert.equal((plan.parameters as any).prompt, original.prompt); assert.equal((plan.parameters as any).seed, 123)
  assert.equal((plan.parameters as any).denoise, 0.2)
  assert.ok(plan.summary.rows.some(r => r[0] === 'Operation' && /Refine/.test(r[1])))
  const refined = JSON.parse(await plan.run()).image
  assert.equal(refined.width, 768); assert.equal(graph['7'].inputs.seed, 123)
  assert.deepEqual(db.prepare('SELECT body FROM agent_images WHERE id=?').get(source)!.body, new Uint8Array(png))
  const upscaled = randomUUID(); insert(upscaled, { operation: 'upscale', source: { id: source } })
  plan = await prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: upscaled, width: 1024, height: 1024, prompt: 'Explicit wins', steps: 12, upscale_model: 'upscaler' }, signal)
  assert.equal((plan.parameters as any).prompt, 'Explicit wins'); assert.equal((plan.parameters as any).steps, 12)
  await plan.run(); assert.deepEqual(graph.refineUpscale.inputs.image, ['20', 0]); assert.equal(graph['7'].inputs.steps, 12)
  const bare = randomUUID(); insert(bare, null)
  await assert.rejects(prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: bare }, signal), /no recorded diffusion settings/)
  assert.equal((await prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: bare, prompt: 'Explicit photo prompt', scale: 1 }, signal)).parameters.operation, 'refine')
  const cycle = randomUUID(); insert(cycle, { operation: 'upscale', source: { id: cycle } })
  await assert.rejects(prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: cycle }, signal), /cycle/)
  let deep = source
  for (let i = 0; i < 8; i++) { const id = randomUUID(); insert(id, { operation: 'upscale', source: { id: deep } }); deep = id }
  await assert.rejects(prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: deep }, signal), /exceeds 8/)
  const foreignThread = randomUUID(), foreignSource = randomUUID()
  db.prepare("INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (2,2,'other','',0,0)").run()
  db.prepare("INSERT INTO agent_threads (id,user_id,title,mode,model,created_at,updated_at) VALUES (?,2,'Other','quick','fixture',0,0)").run(foreignThread)
  insert(foreignSource, original, foreignThread)
  const crossing = randomUUID(); insert(crossing, { operation: 'upscale', source: { id: foreignSource } })
  await assert.rejects(prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: crossing }, signal), /owned source ancestor/)
  const generated = await generateImage(user, thread, { prompt: 'New image', width: 512, height: 512, seed: 55, hires: { scale: 1.5, steps: 17, denoise: 0.3, upscale_model: 'upscaler' } }, signal)
  const p = generated.image.settings as any
  assert.equal(p.width, 768); assert.equal(p.hires.base_width, 512); assert.equal(p.hires.seed, 55); assert.equal(graph['7'].inputs.seed, graph.hiresSampler.inputs.seed)
  const again = imageAgainInput(user, thread, generated.image.id)
  assert.equal(again.width, 512); assert.equal((again.hires as any).width, 768); assert.equal((again.hires as any).scale, undefined)
  const repeated = JSON.parse(await (await prepareImageGeneration(user, thread, again, signal, true)).run()).image
  assert.equal(repeated.width, 768); assert.equal(repeated.settings.hires.steps, 17); assert.equal(repeated.settings.hires.seed, repeated.seed); assert.notEqual(repeated.seed, 55)
  const refinedAgain = imageAgainInput(user, thread, refined.id)
  assert.equal(refinedAgain.width, 768); assert.equal(refinedAgain.operation, 'refine')
  const { saveImageLearning, imageLearnings } = await import('../server/agentImageLearning.ts')
  const refinedNote = saveImageLearning(user, thread, { image_id: refined.id, source: 'suggestion', task: 'Refinement fixture', note: 'Explicitly requested synthetic note.' })
  const hiresNote = saveImageLearning(user, thread, { image_id: generated.image.id, source: 'suggestion', task: 'Hires fixture', note: 'Explicitly requested synthetic note.' })
  assert.equal(imageLearnings(user, thread, original as never).evidence.notes.length, 0)
  assert.deepEqual(imageLearnings(user, thread, original as never, '', undefined, undefined, false, 'refine').evidence.notes.map(n => n.id), [refinedNote.id])
  assert.deepEqual(imageLearnings(user, thread, original as never, '', undefined, undefined, false, 'hires').evidence.notes.map(n => n.id), [hiresNote.id])
  assert.deepEqual(new Set(imageLearnings(user, thread, original as never, '', undefined, undefined, true).evidence.notes.map(n => n.operation)), new Set(['hires', 'refine']))
  const frozen = await prepareImageGeneration(user, thread, { operation: 'refine', source_image_id: source, width: 512, height: 512 }, signal)
  const frozenCounts = [uploads, submits]
  saveImageSettings(user, { token: 'different-after-approval' })
  await assert.rejects(frozen.run(), /backend changed/)
  assert.deepEqual([uploads, submits], frozenCounts)
  saveImageSettings(user, { clearToken: true })
  const counts = [uploads, submits]
  for (const bad of [{ hires: { cfg: 21 } }, { hires: { model: 'arbitrary' } }, { hires: { upscale_model: 'missing' } }, { hires: { sampler: 'not-installed' } }]) await assert.rejects(prepareImageGeneration(user, thread, { prompt: 'Fixture', width: 512, height: 512, ...bad }, signal))
  missing = 'VAEEncode'
  await assert.rejects(prepareImageGeneration(user, thread, { prompt: 'Fixture', hires: {} }, signal))
  missing = ''; assert.deepEqual([uploads, submits], counts)
  outputWrong = true
  await assert.rejects(generateImage(user, thread, { prompt: 'Fixture', hires: {} }, signal), /dimensions/)
  console.log('PASS owned bounded/cycle-safe ancestry, explicit overrides, source preservation, two-stage execution, exact Again dimensions/seed/settings and preflight refusal before uploads')
} finally {
  comfy.closeAllConnections(); await new Promise<void>(r => comfy.close(() => r())); db.close(); rmSync(scratch, { recursive: true, force: true })
}
