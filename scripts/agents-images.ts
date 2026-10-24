import { artMode, artSize, artBytes, pixelArt, ART_BYTES } from '../src/terminal/agents/imageArt.ts'
import { lines as artMarkup } from '../src/terminal/agents/text.ts'
import { parseMarkupLines, stripMarkup } from '../src/terminal/markup.ts'
import { messageMentions, mentionAt, mentionText } from '../src/data/agentMentions.ts'
// Real Agents HTTP/streaming integration against mocked Ollama and ComfyUI. No GPU or real data.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { modelAssets, modelFolders, visibleModelAssets, resolveImageAssets, recommendedImageSampling, imageProgressFraction, imageProgressLabel, type ImageAssetCatalog } from '../src/data/imageModels.ts'
import { applyComfyMessage, frameReader, progressState, queuePosition, throttleProgress } from '../server/comfyProgress.ts'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

// CLI art helpers run without a browser; PNG decoding itself is checked in the browser.
assert.deepEqual(artSize(1024, 1024, 80), { width: 48, height: 48, rows: 24 })
assert.deepEqual(artSize(512, 1536, 80), { width: 16, height: 48, rows: 24 })
assert.equal(artSize(1536, 512, 30)?.width, 26)
assert.deepEqual(artSize(1, 1, 80), { width: 1, height: 1, rows: 1 })
assert.equal(artSize(1024, 1024, 23), null)
assert.equal(artSize(8192, 8192, 80), null)
assert.equal(artMode(true, true, 80, { TERM: 'xterm-mvlos' }), 'truecolour')
assert.equal(artMode(true, true, 80, { TERM: 'xterm-256color' }), 'grayscale')
for (const [tty, enabled, cols, term] of [[false, true, 80, 'xterm-mvlos'], [true, false, 80, 'xterm-mvlos'], [true, true, 23, 'xterm-mvlos'], [true, true, 80, 'dumb']] as const) assert.equal(artMode(tty, enabled, cols, { TERM: term }), null)
const pixel = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
const rgbArt = artMarkup(pixelArt(pixel, 2, 2, 'truecolour'))
assert.equal(stripMarkup(rgbArt), '  ▀▀')
assert.ok(rgbArt.includes('{fg:#ff0000}') && rgbArt.includes('{bg:#0000ff}'))
assert.equal(parseMarkupLines(rgbArt)[0].nodes.length, 3)
assert.ok(!artMarkup(pixelArt(pixel, 2, 2, 'grayscale')).includes('{fg:'))
assert.equal(pixelArt(new Uint8ClampedArray(0), 49, 2, 'truecolour').length, 0)
const artHeader = new Uint8Array(24)
artHeader.set([137, 80, 78, 71, 13, 10, 26, 10]); artHeader.set([73, 72, 68, 82], 12)
new DataView(artHeader.buffer).setUint32(16, 2); new DataView(artHeader.buffer).setUint32(20, 2)
let artRequests = 0, artRequest: RequestInit | undefined
const artFetch: typeof fetch = async (_url, init) => { artRequests++; artRequest = init; return new Response(artHeader, { headers: { 'Content-Type': 'image/png' } }) }
const privateImage = '/api/agents/images/00000000-0000-0000-0000-000000000000'
assert.equal(await artBytes('https://example.test/image.png', {}, new AbortController().signal, artFetch), null)
assert.equal(await artBytes('/api/shares/image.png', {}, new AbortController().signal, artFetch), null)
assert.equal(artRequests, 0)
assert.ok(await artBytes(privateImage, { 'X-MvL-Account': '1' }, new AbortController().signal, artFetch))
assert.equal(artRequest?.credentials, 'same-origin'); assert.equal(artRequest?.redirect, 'error')
assert.equal((artRequest?.headers as Record<string, string>)['X-MvL-Account'], '1')
assert.equal(await artBytes(privateImage, {}, new AbortController().signal, async () => new Response(artHeader, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(ART_BYTES + 1) } })), null)
let artCancelled = false
assert.equal(await artBytes(privateImage, {}, new AbortController().signal, async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(ART_BYTES + 1)) }, cancel() { artCancelled = true } }), { headers: { 'Content-Type': 'image/png' } })), null)
assert.ok(artCancelled)
assert.equal(await artBytes(privateImage, {}, new AbortController().signal, async () => new Response('not PNG', { headers: { 'Content-Type': 'image/png' } })), null)
console.log('PASS CLI image art sizing, RGB markup, grayscale, private authenticated fetches and download refusal bounds')

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
// An unmarked Krea2 variant is a choice, not a verdict: say the variant is unknown and that the
// preset decides the recipe, instead of implying the file is the wrong kind.
{
  const unmarked = resolveImageAssets(autoKrea, { ...automaticCatalog, diffusionModels: ['Krea2/BSS-DesireX.safetensors'] })
  assert.equal(unmarked.effective.model, '')
  assert.match(unmarked.selection.model.reason, /variant of Krea2\/BSS-DesireX\.safetensors is not in the name/)
  assert.match(unmarked.selection.model.reason, /the preset decides the recipe/)
  assert.doesNotMatch(unmarked.selection.model.reason, /variant of .*Turbo\/custom/, 'a marked file is not called unknown')
}
assert.equal(resolveImageAssets(autoKrea, { ...automaticCatalog, vaes: ['other/ae.safetensors'] }).effective.vae, '')
assert.equal(resolveImageAssets(autoKrea, { ...automaticCatalog, clips: [...automaticCatalog.clips, 'other/qwen3-vl-4b.safetensors'] }).effective.clip, '')
assert.equal(recommendedImageSampling('krea2_raw', '', { samplers: ['dpmpp_2m'], schedulers: ['beta'] }).sampler, '')
assert.equal(recommendedImageSampling('z_image_turbo', '', { samplers: ['euler_ancestral', 'dpmpp_2m'], schedulers: ['simple'] }).sampler, 'euler_ancestral')
assert.deepEqual(recommendedImageSampling('sd15', ''), { steps: 20, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras' })
assert.deepEqual(recommendedImageSampling('sdxl', 'Pony/model.safetensors'), { steps: 12, cfg: 5.5, sampler: 'dpmpp_2m', scheduler: 'karras' })
assert.equal(recommendedImageSampling('sdxl', '', { samplers: ['euler'], schedulers: ['simple'] }).sampler, 'euler')
console.log('PASS automatic family/variant matching, nested exact paths, metadata identity, ambiguity, manual preservation, backend/family changes and missing assets')

// Live progress: ComfyUI socket messages, queue position, throttling, frames and labels.
{
  const state = progressState()
  assert.equal(applyComfyMessage(state, { type: 'status', data: { status: { exec_info: { queue_remaining: 3 } } } }, null, 20), false)
  assert.equal(applyComfyMessage(state, { type: 'execution_start', data: { prompt_id: 'mine' } }, 'mine', 20), true)
  assert.deepEqual(state.progress, { phase: 'loading' })
  assert.equal(applyComfyMessage(state, { type: 'progress', data: { value: 19, max: 20, prompt_id: 'other' } }, 'mine', 20), false)
  assert.equal(applyComfyMessage(state, { type: 'executing', data: { node: '7', prompt_id: 'mine' } }, 'mine', 20), true)
  assert.deepEqual(state.progress, { phase: 'sampling', value: 0, max: 20 })
  assert.equal(applyComfyMessage(state, { type: 'progress', data: { value: 8, max: 20, prompt_id: 'mine', node: '7' } }, 'mine', 20), true)
  assert.equal(imageProgressFraction(state.progress), 0.4)
  assert.equal(imageProgressLabel(state.progress), 'Step 8 of 20 · 40%')
  for (const bad of [{ value: 21, max: 20 }, { value: -1, max: 20 }, { value: 1, max: 0 }, { value: 1.5, max: 20 }, { value: '3', max: 20 }, { value: 3, max: 20, node: '8' }]) assert.equal(applyComfyMessage(state, { type: 'progress', data: { ...bad, prompt_id: 'mine' } }, 'mine', 20), false)
  assert.equal(applyComfyMessage(state, { type: 'executing', data: { node: '8', prompt_id: 'mine' } }, 'mine', 20), true)
  assert.equal(imageProgressFraction(state.progress), 1)
  assert.equal(state.finished, false)
  applyComfyMessage(state, { type: 'executing', data: { node: null, prompt_id: 'mine' } }, 'mine', 20)
  assert.equal(state.finished, true)
  for (const junk of [null, 'x', 1, { type: 'progress' }, { type: 1, data: {} }, { type: 'progress', data: { prompt_id: 5 } }]) assert.equal(applyComfyMessage(progressState(), junk, null, 20), false)
  assert.equal(imageProgressFraction({ phase: 'queued', position: 2 }), null)
  assert.equal(imageProgressLabel({ phase: 'queued', position: 2 }), 'Queued (position 2)')
  assert.equal(imageProgressLabel({ phase: 'loading' }), 'Loading model…')
  assert.equal(imageProgressLabel(undefined), 'Generating image…')
  assert.equal(queuePosition({ queue_running: [[1, 'a', {}]], queue_pending: [[7, 'mine'], [3, 'b'], [9, 'c']] }, 'mine'), 3)
  assert.equal(queuePosition({ queue_running: [], queue_pending: [[7, 'mine']] }, 'mine'), 1)
  assert.equal(queuePosition({ queue_running: [[1, 'mine']], queue_pending: [] }, 'mine'), 'running')
  assert.equal(queuePosition({ queue_running: [], queue_pending: [] }, 'mine'), null)
  assert.equal(queuePosition('nonsense', 'mine'), null)

  const emitted: any[] = []
  const throttle = throttleProgress((p) => emitted.push({ p, at: Date.now() }))
  const started = Date.now()
  for (let i = 1; i <= 60; i++) { throttle.push({ phase: 'sampling', value: i, max: 60 }); await new Promise((r) => setTimeout(r, 10)) }
  await new Promise((r) => setTimeout(r, 300))
  const took = Date.now() - started
  assert.ok(emitted.length >= 2 && emitted.length <= Math.ceil(took / 250) + 1, `throttled to ${emitted.length} in ${took} ms`)
  for (let i = 1; i < emitted.length; i++) assert.ok(emitted[i].at - emitted[i - 1].at >= 240, 'at most 4 updates a second')
  assert.equal(emitted[0].p.value, 1)
  assert.equal(emitted.at(-1).p.value, 60) // the latest one always arrives
  const count = emitted.length
  throttle.push({ phase: 'sampling', value: 60, max: 60 })
  throttle.push({ phase: 'decoding' }); throttle.stop()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(emitted.length, count) // a duplicate is never sent, and nothing after stop

  const messages: unknown[] = [], pongs: Buffer[] = []
  let closed = 0
  const read = frameReader((m) => messages.push(m), (b) => pongs.push(b), () => closed++)
  const text = (t: string, opcode = 1, fin = true) => { const b = Buffer.from(t); return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, b.length]), b]) }
  const masked = (t: string) => { const b = Buffer.from(t), m = Buffer.from([1, 2, 3, 4]); return Buffer.concat([Buffer.from([0x81, 0x80 | b.length]), m, Buffer.from(b.map((x, i) => x ^ m[i % 4]))]) }
  const all = Buffer.concat([text('{"type":"a"}'), Buffer.from([0x82, 3, 1, 2, 3]), text('{"type":', 1, false), text('"b"}', 0), text('ping', 9), masked('{"type":"c"}'), text('not json')])
  for (let i = 0; i < all.length; i += 3) read(all.subarray(i, i + 3)) // split anywhere
  assert.deepEqual(messages, [{ type: 'a' }, { type: 'b' }, { type: 'c' }])
  assert.equal(pongs[0].toString(), 'ping')
  const big = Buffer.alloc(10); big[0] = 0x81; big[1] = 127; big.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2)
  read(big)
  assert.equal(closed, 1)
}
console.log('PASS ComfyUI progress messages for this prompt only, step validation, queue position, labels, 4-per-second throttle, WebSocket frames')

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
const send = (res: ServerResponse, data: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
const info = Object.fromEntries(['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'ConditioningZeroOut', 'LoraLoader', 'LoraLoaderModelOnly', 'LoadImage', 'ImageScale', 'VAEEncode'].map((name) => [name, { input: { required: {} } }])) as Record<string, any>
info.ImageScale.input.required = { crop: [['center', 'disabled']], upscale_method: [['lanczos', 'bilinear']] }
let uploadBehavior = 'ok'
const uploads: string[] = []
const loraNames = ['Krea/style.safetensors', 'SDXL/pose.safetensors', 'Folder/Soft light.safetensors']
info.LoraLoader.input.required.lora_name = [[loraNames[1], loraNames[0]]]
info.LoraLoaderModelOnly.input.required.lora_name = [[loraNames[0], loraNames[2]]]
let loraHintsMode = 'ok'
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
let behavior: 'ok' | 'wait' | 'error' | 'invalid' | 'oversize' | 'progress' = 'ok'
let wsMode = false
let progressDone = false
let progressReads = 0
let queueState: (id: string) => unknown = () => ({ queue_running: [], queue_pending: [] })
const sockets = new Map<string, Duplex>()
let pongsSeen = 0
const promptClients: string[] = []
const wsFrame = (data: unknown, opcode = 1) => { const b = typeof data === 'string' || Buffer.isBuffer(data) ? Buffer.from(data as string) : Buffer.from(JSON.stringify(data)); return Buffer.concat([Buffer.from(b.length < 126 ? [0x80 | opcode, b.length] : [0x80 | opcode, 126, b.length >> 8, b.length & 255]), b]) }
/** What a real ComfyUI tells the client that queued a prompt, quickly: start, nodes, 20 steps, done. */
async function streamJob(socket: Duplex, id: string) {
  const say = (type: string, data: unknown) => socket.write(wsFrame({ type, data }))
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  say('status', { status: { exec_info: { queue_remaining: 1 } } })
  await wait(120)
  say('execution_start', { prompt_id: id })
  say('progress', { value: 98, max: 99, prompt_id: 'someone-else' })
  say('executing', { node: '1', prompt_id: id })
  await wait(60)
  say('execution_cached', { nodes: ['2', '3'], prompt_id: id })
  say('executing', { node: '4', prompt_id: id })
  socket.write(wsFrame('ping', 9))
  socket.write(wsFrame(Buffer.alloc(300, 7), 2)) // a latent preview
  say('executing', { node: '7', prompt_id: id })
  for (let i = 1; i <= 20; i++) { await wait(30); say('progress', { value: i, max: 20, prompt_id: id, node: '7' }) }
  say('executing', { node: '8', prompt_id: id })
  await wait(400) // VAE decode
  progressDone = true
  say('executing', { node: null, prompt_id: id })
}
let submissions = 0
let historyReads = 0
let interrupts = 0
const deletions: string[] = []
let submitted: Record<string, any> = {}
let requestedTool = 'generate_image'
let extraToolCalls: { name: string; arguments: Record<string, unknown> }[] = []
let providerChats = 0
let retryLearning = true
const providerInputs: any[] = []
const visionRequests: any[] = []
let visionReply: 'normal' | 'thinking' | 'empty' | 'long-thinking' = 'normal'
let holdVision = false
let cancelledVision = 0
const streamEvents: any[] = []
const eventTimes: number[] = []
let generationArgs: Record<string, unknown> = { prompt: 'A small blue bird', seed: 42 }
const comfy = createServer((req, res) => {
  let raw = ''
  req.on('data', (b) => raw += b)
  req.on('end', () => {
    const path = new URL(req.url!, 'http://test').pathname
    if (path === '/upload/image') {
      const name = /filename="([^"]+)"/.exec(raw)?.[1]
      assert.match(name ?? '', /^agents-source-[0-9a-f-]{36}\.png$/)
      assert.equal(req.headers.authorization, 'Bearer test-secret')
      assert.ok(raw.includes('name="overwrite"\r\n\r\nfalse'))
      uploads.push(name!)
      if (uploadBehavior === 'hold') return
      if (uploadBehavior === 'fail') return res.writeHead(500).end()
      return send(res, { name: uploadBehavior === 'path' ? '../other.png' : name, subfolder: '', type: 'input' })
    }
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
    if (path === '/api/lm/loras/list') {
      if (loraHintsMode === 'missing') return res.writeHead(404).end()
      if (loraHintsMode === 'invalid') return res.end('not JSON')
      if (loraHintsMode === 'oversize') return res.end('x'.repeat(1024 * 1024 + 1))
      const items = [
        { folder: 'Krea', file_path: '/private/models/loras/Krea/style.safetensors', base_model: 'Krea2', civitai: { trainedWords: ['style-trigger', ...Array.from({ length: 12 }, (_, i) => `trigger-${i}`), 'x'.repeat(200)] } },
        { folder: 'SDXL', file_path: '/private/models/loras/SDXL/pose.safetensors', base_model: 'SDXL', civitai: { trainedWords: ['pose-trigger'] } },
        { folder: 'Wrong', file_path: '/private/models/loras/Wrong/Soft light.safetensors', base_model: 'Wrong family', civitai: { trainedWords: ['must-not-join'] } },
      ]
      if (loraHintsMode === 'duplicate') items.push(items[0])
      return send(res, { items })
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
      const clientId = JSON.parse(raw).client_id
      promptClients.push(clientId)
      const id = `job-${++submissions}`
      progressDone = false; progressReads = 0
      const socket = sockets.get(clientId)
      if (socket) void streamJob(socket, id)
      return send(res, { prompt_id: id })
    }
    if (path.startsWith('/history/')) {
      historyReads++
      const id = path.split('/').pop()!
      if (behavior === 'wait') return send(res, {})
      // Without a socket the job is done after a few polls; with one, when the socket says so.
      if (behavior === 'progress' && !(wsMode ? progressDone : ++progressReads > 2)) return send(res, {})
      if (behavior === 'error') return send(res, { [id]: { status: { status_str: 'error' } } })
      return send(res, { [id]: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'test.png', subfolder: '', type: 'output' }] } } } })
    }
    if (path === '/view') {
      if (behavior === 'oversize') return res.writeHead(200, { 'Content-Length': 21 * 1024 * 1024 }).end()
      return res.writeHead(200, { 'Content-Type': 'image/png' }).end(behavior === 'invalid' ? Buffer.from('<html>bad</html>') : png)
    }
    if (path === '/queue' && req.method === 'GET') return send(res, queueState(`job-${submissions}`))
    if (path === '/queue') { deletions.push(...JSON.parse(raw).delete); return send(res, {}) }
    if (path === '/interrupt') interrupts++
    res.writeHead(404).end()
  })
})
comfy.on('upgrade', (req, socket: Duplex) => {
  const url = new URL(req.url!, 'http://test')
  if (!wsMode || url.pathname !== '/ws' || req.headers.authorization !== 'Bearer test-secret') return socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const clientId = url.searchParams.get('clientId')!
  sockets.set(clientId, socket)
  socket.on('data', () => pongsSeen++)
  socket.on('error', () => {})
  socket.on('end', () => { sockets.delete(clientId); socket.end() })
  socket.on('close', () => sockets.delete(clientId))
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
    providerInputs.push(body)
    if (body.messages.some((m: any) => m.images?.length)) {
      visionRequests.push(body)
      if (holdVision) { res.on('close', () => cancelledVision++); return }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      if (visionReply === 'empty') return res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n')
      if (visionReply !== 'normal' && body.think !== false) return res.end(JSON.stringify({ message: { role: 'assistant', thinking: visionReply === 'long-thinking' ? 'Reasoning. '.repeat(1800) : 'I should inspect the visible shapes.', content: '' }, done: true }) + '\n')
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'The image shows a small fixture. Quality observations are uncertain at this size.' }, done: true }) + '\n')
    }
    const after = body.messages.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1)
    const needsLearning = retryLearning && after.some((m: any) => m.role === 'tool' && m.content.includes('\"learning_review_required\":true')) && !after.some((m: any) => m.role === 'tool' && (m.content.startsWith('{\"image\":') || m.content.startsWith('{\"error\":')))
    const message = after.some((m: any) => m.role === 'tool') && !needsLearning ? { content: 'Image request handled.' } : { content: '', tool_calls: [{ function: { name: needsLearning ? 'generate_image' : requestedTool, arguments: generationArgs } }, ...extraToolCalls.map((call) => ({ function: call }))] }
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
const turn = async (id: string, approve?: boolean, text = 'Generate a bird image') => {
  const response = await api('POST', `/api/agents/threads/${id}/messages`, { text })
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
      eventTimes.push(Date.now())
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
  const { imagePromptSection, DIFFU_IMAGE_PROMPT_MARKER } = await import('../server/agentImagePrompt.ts')
  const { usedBytes } = await import('../server/quota.ts')
  const settings = { url: comfyUrl, token: 'test-secret', preset: 'sdxl' as const, model: 'test.safetensors', clip: '', vae: '' }
  const saved = await json('PUT', '/api/agents/images/settings', settings)
  assert.equal(saved.token, true)
  assert.equal(saved.saveImageLearnings, true)
  assert.equal(saved.askBeforeSavingObservations, false)
  assert.equal((await api('PUT', '/api/agents/images/settings', { askBeforeSavingObservations: 'yes' })).status, 400)
  assert.equal((await api('PUT', '/api/agents/images/settings', { saveImageLearnings: 'false' })).status, 400)
  assert.ok(!JSON.stringify(saved).includes('test-secret'))
  assert.ok(!String((database().prepare("SELECT secret FROM integrations WHERE name = 'agents-comfyui'").get() as any).secret).includes('test-secret'))
  assert.equal((await json('GET', '/api/agents/images/settings', undefined, 1)).url, '')
  const catalog = await json('GET', '/api/agents/images/catalog')
  assert.deepEqual(catalog.checkpoints, ['test.safetensors'])
  assert.deepEqual(catalog.diffusionModels, ['z-test.safetensors', 'krea-raw.safetensors', 'krea-turbo.safetensors'])
  assert.deepEqual(catalog.clips, ['encoder.safetensors'])
  assert.deepEqual(catalog.vaes, ['vae.safetensors'])
  assert.deepEqual(catalog.loras, [...loraNames].sort())
  assert.equal(catalog.loraHints.length, 2)
  assert.equal(catalog.loraHints[0].baseModel, 'Krea2')
  assert.equal(catalog.loraHints[0].triggers.length, 8)
  assert.equal(catalog.loraHints[0].triggers[0], 'style-trigger')
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
  const chain = [{ name: loraNames[0], weight: 0.8 }, { name: loraNames[1], weight: 1.2 }]
  for (const preset of ['krea2_turbo', 'sdxl'] as const) {
    const graph = imageWorkflow({ ...settings, preset, clip: 'encoder.safetensors', vae: 'vae.safetensors' }, { prompt: 'LoRA chain', loras: chain }, catalog).graph
    assert.equal(graph['10'].class_type, preset === 'sdxl' ? 'LoraLoader' : 'LoraLoaderModelOnly')
    assert.deepEqual(graph['10'].inputs.model, ['1', 0])
    assert.deepEqual(graph['11'].inputs.model, ['10', 0])
    assert.equal(graph['10'].inputs.strength_model, 0.8)
    assert.equal(graph['11'].inputs.strength_model, 1.2)
    assert.deepEqual(graph['7'].inputs.model, ['11', 0])
    assert.deepEqual(graph['4'].inputs.clip, preset === 'sdxl' ? ['11', 1] : ['2', 0])
    if (preset === 'sdxl') {
      assert.deepEqual(graph['10'].inputs.clip, ['1', 1])
      assert.deepEqual(graph['11'].inputs.clip, ['10', 1])
      assert.deepEqual(graph['5'].inputs.clip, ['11', 1])
      assert.equal(graph['10'].inputs.strength_clip, 0.8)
      assert.equal(graph['11'].inputs.strength_clip, 1.2)
    } else assert.equal(graph['10'].inputs.clip, undefined)
    assert.equal(graph['9'].class_type, 'SaveImage')
    const fallback = preset === 'sdxl' ? 'LoraLoaderModelOnly' : 'LoraLoader'
    assert.equal(imageWorkflow({ ...settings, preset, clip: 'encoder.safetensors', vae: 'vae.safetensors' }, { prompt: 'fallback', loras: chain }, { nodes: [fallback] }).graph['10'].class_type, fallback)
  }
  assert.throws(() => imageWorkflow(settings, { prompt: 'missing loader', loras: chain }, { nodes: [] }), /no LoRA loader/)
  assert.equal(imageWorkflow(settings, { prompt: 'default weight', loras: [{ name: loraNames[0] }] }).graph['10'].inputs.strength_model, 1)
  for (const loras of [null, {}, Array.from({ length: 6 }, () => chain[0]), [{ name: 'a', weight: NaN }], [{ name: 'a', weight: Infinity }], [{ name: 'a', weight: -0.1 }], [{ name: 'a', weight: 2.1 }], [{ name: 'a', weight: '1' }]]) {
    const { validateImageOverrides } = await import('../server/agentImages.ts')
    assert.throws(() => validateImageOverrides({ loras }))
  }
  const quoted = mentionText('#', loraNames[2])
  assert.equal(quoted, '#"Folder/Soft light.safetensors"')
  assert.deepEqual(messageMentions(`Use ${quoted}:0.8 $msh @list_image_models #missing`), [{ sigil: '#', name: loraNames[2], weight: 0.8 }, { sigil: '$', name: 'msh' }, { sigil: '@', name: 'list_image_models' }, { sigil: '#', name: 'missing', weight: 1 }])
  assert.deepEqual(messageMentions('email@example.com @./file # remember this'), [])
  assert.deepEqual(mentionAt('text #Sty', 9), { start: 5, sigil: '#', query: 'sty' })
  assert.equal(mentionAt('text @./file', 12), null)
  console.log('PASS ordered checkpoint and model-only LoRA graphs, fallbacks, weights/count bounds and shared mention syntax')
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
  assert.equal(providerChats - chatsBeforeImage, 2)
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
  // The Diffu image guidance is part of the system prompt only while Images is on.
  const imageGuidance = imagePromptSection()
  assert.ok(imageGuidance.includes('MODEL FAMILY GUIDANCE'))
  assert.ok(imageGuidance.includes('LORAS AND ASSET CONFLICTS'))
  assert.ok(imageGuidance.includes('selected.loras'))
  assert.ok(imageGuidance.includes('IMAGE OBSERVATIONS'))
  assert.ok(imageGuidance.includes('Prefer one evolving profile over a pile of per-image notes'))
  assert.ok(imageGuidance.includes('do not save it unless the user explicitly asks'))
  assert.ok(imageGuidance.includes('Profiles are global to the account across threads and projects'))
  assert.ok(imageGuidance.includes('prompting style and vocabulary'))
  assert.ok(!imageGuidance.includes('cannot see or change active LoRAs'))
  // The adult-content stance, without which models refuse an explicit request (Diffu never
  // filters a generation, so it never needed the wording).
  assert.ok(imageGuidance.includes('CONTENT AND REFUSALS'))
  assert.ok(imageGuidance.includes('Adult content is allowed when the user asks for it'))
  // The preset/checkpoint basics: the thread's `selected` recipe is the truth, a file name is a hint.
  assert.ok(imageGuidance.includes('PRESET, CHECKPOINT AND RECIPE'))
  // Plain answers by default: the image guidance and the base prompt both say when detail is wanted.
  assert.ok(imageGuidance.includes('HOW MUCH TO SAY'))
  assert.ok(providerInputs.at(-1).messages[0].content.includes('Answer at the length the question deserves'))
  assert.ok(imageGuidance.includes('Never say a checkpoint'))
  // The base prompt carries the same stance for threads without Images: no refusals of fiction,
  // art or mature themes, and one stated limit.
  const basePrompt = providerInputs.at(-1).messages[0].content as string
  assert.ok(basePrompt.includes('Do not refuse, moralize, or add warnings'))
  assert.ok(basePrompt.includes('never write is sexual content involving minors'))
  assert.ok(providerInputs.at(-1).messages[0].content.includes(DIFFU_IMAGE_PROMPT_MARKER))
  assert.ok(providerInputs.at(-1).messages[0].content.includes(imageGuidance.trim()))
  console.log('PASS streamed tool generation, approved prompt, PNG retrieval, ownership, quota and restart durability')

  // Off by default: a default-mode thread generates without asking. With the switch on, a decline submits nothing.
  const unasked = await thread('default')
  await turn(unasked.id, false)
  assert.equal(submissions, 2)
  assert.equal((await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: true })).askBeforeGenerate, true)
  const declined = await thread('default')
  await turn(declined.id, false)
  assert.equal(submissions, 2)
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: false })
  console.log('PASS generation runs without approval by default; Ask before generating images makes a decline submit nothing')
  const disabled = await thread()
  await json('PATCH', `/api/agents/threads/${disabled.id}`, { tools: ['web'] })
  assert.ok(result(await turn(disabled.id)).error)
  assert.equal(providerInputs.at(-1).messages[0].content.includes(DIFFU_IMAGE_PROMPT_MARKER), false)
  assert.equal(submissions, 2)
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

  // Live progress over ComfyUI's socket reaches the job's own stream, at most 4 a second.
  wsMode = true; behavior = 'progress'
  let from = streamEvents.length
  const live = await thread()
  assert.ok(result(await turn(live.id)).image)
  const progressEvents = streamEvents.slice(from).map((e, i) => ({ e, at: eventTimes[from + i] })).filter((x) => x.e.type === 'imageProgress')
  const generation = streamEvents.slice(from).find((e) => e.type === 'imageGeneration')
  assert.ok(progressEvents.length >= 3, JSON.stringify(progressEvents.map((x) => x.e.progress)))
  assert.ok(progressEvents.every((x) => x.e.callId === generation.callId))
  assert.ok(promptClients.at(-1))
  await until(() => sockets.size === 0) // closed once the job ends
  const phases = progressEvents.map((x) => x.e.progress)
  assert.equal(phases[0].phase, 'queued')
  const steps = phases.filter((p) => p.phase === 'sampling')
  assert.ok(steps.length >= 1 && steps.every((p) => p.max === 20), JSON.stringify(phases))
  assert.ok(steps.every((p, i) => i === 0 || p.value >= steps[i - 1].value))
  assert.ok(phases.some((p) => p.phase === 'decoding' || p.phase === 'saving'))
  for (let i = 1; i < progressEvents.length; i++) assert.ok(progressEvents[i].at - progressEvents[i - 1].at >= 200, 'throttled to about 4 a second')
  assert.ok(pongsSeen >= 1, 'ping answered')
  assert.ok(streamEvents.slice(from).findIndex((e) => e.type === 'imageGenerationDone') > streamEvents.slice(from).indexOf(progressEvents.at(-1)!.e), 'no progress after the job ends')
  // Without the socket (an older or proxied ComfyUI): the queue position, then it finishes as before.
  wsMode = false
  queueState = (id) => ({ queue_running: [[1, 'someone-else', {}]], queue_pending: [[9, id, {}], [4, 'another', {}]] })
  from = streamEvents.length
  assert.ok(result(await turn((await thread()).id)).image)
  const fallback = streamEvents.slice(from).filter((e) => e.type === 'imageProgress').map((e) => e.progress)
  assert.ok(fallback.some((p) => p.phase === 'queued' && p.position === 3), JSON.stringify(fallback))
  assert.ok(!fallback.some((p) => p.phase === 'sampling'))
  queueState = () => ({ queue_running: [], queue_pending: [] })
  behavior = 'ok'
  console.log('PASS live progress over the ComfyUI socket (own prompt only, throttled, ping/pong, closed after), queue position and clean fallback without a socket')

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
  const overrides = { preset: 'sd15', model: exactModel, width: 768, height: 512, seed: 123, loras: [{ name: loraNames[1], weight: 0.8 }] }
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
  assert.deepEqual(fromSession.settings.loras, overrides.loras)
  assert.equal(submitted['10'].inputs.strength_clip, 0.8)
  assert.equal(fromSession.width, 768)
  assert.equal(fromSession.height, 512)
  assert.equal(submitted['1'].inputs.ckpt_name, exactModel)
  generationArgs = { prompt: 'Use per-call settings', seed: 77, width: 512, loras: [] }
  const once = result(await turn(first.id)).image
  assert.equal(once.seed, 77)
  assert.equal(once.width, 512)
  assert.deepEqual(once.settings.loras, [])
  assert.equal(submitted['10'], undefined)
  assert.deepEqual((await json('GET', endpoint(first.id))).overrides, overrides)
  await json('PUT', '/api/agents/images/settings', { preset: 'sd15' })
  assert.equal((await json('GET', endpoint(second.id))).effective.width, 512)
  await json('PUT', '/api/agents/images/settings', { url: '' })
  const resetImages = await json('DELETE', endpoint(first.id)) // /images reset uses this endpoint, including offline.
  assert.deepEqual(resetImages.overrides, {})
  assert.deepEqual(resetImages.effective.loras, [])
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
  // The approval card is what shows the resolved settings, so this part asks first.
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: true })
  const tuningThread = await thread('default')
  const beforeAccount = await json('GET', '/api/agents/images/settings')
  const beforeSession = (await json('GET', endpoint(tuningThread.id))).overrides
  generationArgs = { prompt: 'Tuned image', preset: 'krea2_raw', model: 'krea-raw.safetensors', clip: 'qwen3vl_4b.safetensors', vae: 'qwen_image_vae.safetensors', steps: 32, cfg: 4.5, sampler: 'dpmpp_2m', scheduler: 'karras', width: 768, height: 1024, seed: 321, negative_prompt: 'blurry', loras: chain }
  const tuned = result(await turn(tuningThread.id, true)).image
  assert.equal(tuned.settings.steps, 32)
  assert.equal(tuned.settings.cfg, 4.5)
  assert.equal(tuned.settings.model, generationArgs.model)
  assert.equal(tuned.settings.seed, 321)
  assert.equal(submitted['7'].inputs.sampler_name, 'dpmpp_2m')
  const review = approvalSummaries.at(-1)
  assert.equal(review.body, 'Tuned image')
  assert.ok(review.rows.some(([label, value]: string[]) => label === 'LoRAs' && value === `${loraNames[0]} (0.8), ${loraNames[1]} (1.2)`))
  assert.deepEqual(tuned.settings.loras, chain)
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
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: false })
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
  for (const response of ['thinking', 'long-thinking', 'empty'] as const) {
    visionReply = response
    const beforeRetry = visionRequests.length
    const inspection = JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content)
    assert.equal(visionRequests.length, beforeRetry + 2)
    assert.equal(visionRequests.at(-2).options.num_predict, 2048)
    assert.equal(visionRequests.at(-1).think, false)
    assert.equal(visionRequests.at(-1).options.num_predict, 4096)
    assert.match(visionRequests.at(-1).messages[0].content, /Answer with the visual analysis itself/)
    if (response === 'empty') {
      assert.match(inspection.error, /test-model returned no text.*reasoning only or an empty answer/)
      assert.match(inspection.error, /The image is fine; only the inspection failed/)
      assert.doesNotMatch(inspection.error, /different vision-capable/)
      assert.equal(inspection.inspected, false)
      assert.equal(inspection.status, 'inspection_unavailable')
    } else { assert.equal(inspection.inspected, true); assert.match(inspection.analysis, /small fixture/) }
  }
  visionReply = 'normal'
  console.log('PASS reasoning-only and watchdog-truncated vision retries with thinking off; empty answers report inspection unavailable')
  generationArgs = { image_id: firstVisionImage.id }
  assert.equal(JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content).image_id, firstVisionImage.id)
  generationArgs = { image_id: tuned.id }
  const crossThread = JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content)
  assert.equal(crossThread.image_id, tuned.id)
  assert.equal(crossThread.inspected, true)
  assert.equal(visionRequests.at(-1).messages.at(-1).images[0], png.toString('base64'))
  // Explicit IDs cross owned threads, but an omitted ID still chooses the current thread's latest.
  generationArgs = {}
  assert.equal(JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'view_generated_image').content).image_id, lastVisionImage.id)
  const otherOwnerThread = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model' }, 1)
  const otherOwnerImage = randomUUID()
  database().prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(otherOwnerImage, otherOwnerThread.id, 'other-owner.png', png, Date.now(), JSON.stringify(tuned.settings))
  generationArgs = { image_id: otherOwnerImage }
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
  assert.throws(() => generatedImageForVision({ id: 2 } as any, otherOwnerThread.id, lastVisionImage.id), /No generated image/)
  assert.throws(() => generatedImageForVision({ id: 1 } as any, visionThread.id, null), /Choose a generated image ID/)
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
  const batchResults = batch.messages.filter((m: any) => m.role === 'tool').slice(-3).map((m: any) => JSON.parse(m.content))
  assert.equal(batchResults.length, 3)
  assert.ok(batchResults[0].image)
  assert.ok(batchResults[1].skipped && batchResults[2].skipped)
  assert.equal(submissions, beforeBatch + 1)
  assert.equal(providerChats, chatsBeforeBatch + 2)
  assert.equal(visionRequests.length, visionBeforeBatch)
  assert.equal(batch.thread.todos[0].status, 'pending')
  extraToolCalls = []
  behavior = 'error'
  const errorChats = providerChats
  await turn((await thread()).id)
  assert.equal(providerChats, errorChats + 3)
  behavior = 'ok'
  console.log('PASS silent generation, complete tool batches and todos, exact pending dimensions, actual vision bytes, current-thread default and explicit owner-wide inspection, unsupported models and payload limit')
  // Durable learning uses actual artifacts and evidence, not agent-supplied settings.
  const { imageLearnings, saveImageLearning } = await import('../server/agentImageLearning.ts')
  const { imageBackendScope } = await import('../server/agentImages.ts')
  const { saveImageProfile, selectedImageProfile } = await import('../server/agentImageProfiles.ts')
  const owner = { id: 1, admin: true } as any, stranger = { id: 2 } as any
  const profile = await json('POST', '/api/agents/image-profiles', { name: 'Studio preference', description: 'Quiet composition and restrained contrast.' })
  const otherProfile = await json('POST', '/api/agents/image-profiles', { name: 'Graphic preference', description: 'Simple shapes.' })
  assert.equal(profile.origin, 'user')
  const deepDescription = '光'.repeat(1200)
  assert.equal((await json('POST', '/api/agents/image-profiles', { id: otherProfile.id, description: deepDescription })).description, deepDescription)
  assert.equal((await api('POST', '/api/agents/image-profiles', { id: otherProfile.id, description: 'x'.repeat(1201) })).status, 400)
  const suggestedProfile = saveImageProfile(owner, { name: 'Evolving look', description: deepDescription }, true)
  assert.equal(saveImageProfile(owner, { id: suggestedProfile.id, description: 'A general look, revised after feedback.' }, true).description, 'A general look, revised after feedback.')
  await json('DELETE', `/api/agents/image-profiles/${suggestedProfile.id}`)
  for (const invalid of [null, [], { name: 'x', description: '', backend: 'forbidden' }]) assert.equal((await api('POST', '/api/agents/image-profiles', invalid)).status, 400)
  assert.equal((await api('PUT', `/api/agents/image-profiles/threads/${visionThread.id}`, null)).status, 400)
  assert.equal((await json('GET', '/api/agents/image-profiles', undefined, 1)).length, 0)
  assert.equal((await api('POST', '/api/agents/image-profiles', { id: profile.id, name: 'stolen', description: '' }, 1)).status, 404)
  assert.throws(() => saveImageProfile(owner, { id: profile.id, description: 'Agent overwrite' }, true), /cannot be overwritten/)
  await json('PUT', `/api/agents/image-profiles/threads/${visionThread.id}`, { id: profile.id })
  assert.equal(selectedImageProfile(owner, visionThread.id)?.id, profile.id)
  assert.equal((await api('PUT', `/api/agents/image-profiles/threads/${visionThread.id}`, { id: null }, 1)).status, 404)
  const feedbackId = Number(database().prepare('INSERT INTO agent_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(visionThread.id, 'user', 'I prefer this softer result, but the hands need work.', Date.now()).lastInsertRowid)
  const baseLearning = { image_id: lastVisionImage.id, profile_id: profile.id, task: 'Studio portrait', note: 'User prefers softer contrast; hands remain an issue.', source: 'user_feedback', evidence_message_id: feedbackId, evidence_quote: 'I prefer this softer result, but the hands need work.' }
  const storageBeforeLearning = usedBytes(1)
  const learned = saveImageLearning(owner, visionThread.id, baseLearning)
  assert.ok(usedBytes(1) > storageBeforeLearning)
  assert.deepEqual(learned.settings, lastVisionImage.settings)
  assert.equal(learned.source.kind, 'user_feedback')
  assert.throws(() => saveImageLearning(owner, visionThread.id, { ...baseLearning, settings: { steps: 80 } }), /settings come from the artifact/)
  assert.throws(() => saveImageLearning(owner, visionThread.id, { ...baseLearning, evidence_quote: 'Perfect, no flaws.' }), /match the saved message/)
  assert.throws(() => saveImageLearning(stranger, visionThread.id, baseLearning), /No such thread/)
  assert.throws(() => saveImageLearning(owner, batchThread.id, baseLearning), /Choose an image generated in this thread/)
  assert.throws(() => saveImageLearning(owner, visionThread.id, { ...baseLearning, image_id: 'not-an-artifact' }), /Use the image UUID/)
  assert.throws(() => saveImageLearning(owner, visionThread.id, { ...baseLearning, image_id: 'https://comfy/view?filename=x.png' }), /Use the image UUID/)
  const oldScope = database().prepare('SELECT backend_scope FROM agent_images WHERE id = ?').get(lastVisionImage.id) as any
  database().prepare('UPDATE agent_images SET backend_scope = NULL WHERE id = ?').run(lastVisionImage.id)
  assert.throws(() => saveImageLearning(owner, visionThread.id, baseLearning), /older images/)
  database().prepare('UPDATE agent_images SET backend_scope = ? WHERE id = ?').run(oldScope.backend_scope, lastVisionImage.id)
  const visionMessage = inspectedThread.messages.findLast((m: any) => m.toolName === 'view_generated_image')
  const visionNote = saveImageLearning(owner, visionThread.id, { image_id: lastVisionImage.id, profile_id: profile.id, task: 'Pixel inspection', note: 'Small fixture only; quality uncertain.', source: 'vision', evidence_message_id: visionMessage.id, evidence_quote: inspected.analysis })
  assert.equal(visionNote.source.kind, 'vision')
  assert.throws(() => saveImageLearning(owner, visionThread.id, { ...baseLearning, source: 'vision' }), /completed image inspection/)
  assert.throws(() => saveImageLearning(owner, visionThread.id, { ...baseLearning, source: 'suggestion' }), /cannot claim evidence/)
  const updated = saveImageLearning(owner, visionThread.id, { id: learned.id, note: 'Keep the user preference provisional for other compositions.' })
  assert.deepEqual(updated.source, learned.source)
  assert.deepEqual(updated.settings, learned.settings)
  assert.throws(() => saveImageLearning(owner, visionThread.id, { id: learned.id, source: 'suggestion' }), /preserve artifact and evidence/)
  assert.throws(() => saveImageLearning(stranger, visionThread.id, { id: learned.id, note: 'wrong owner' }), /No such thread/)
  const relevant = imageLearnings(owner, visionThread.id, lastVisionImage.settings, 'Studio portrait')
  assert.equal(relevant.evidence.notes[0].id, learned.id)
  const compactNote = relevant.evidence.notes[0]
  assert.equal(compactNote.artifactId, lastVisionImage.id)
  assert.equal(compactNote.source.messageId, feedbackId)
  assert.ok(baseLearning.evidence_quote.includes(compactNote.source.quote))
  assert.match(compactNote.settingsLine, new RegExp(`${lastVisionImage.settings.preset} .* ${lastVisionImage.settings.steps} steps .* CFG ${lastVisionImage.settings.cfg}`))
  assert.ok(compactNote.settingsLine.includes(`${lastVisionImage.settings.sampler}/${lastVisionImage.settings.scheduler}`))
  assert.ok(compactNote.settingsLine.includes(lastVisionImage.settings.model))
  assert.ok(compactNote.settingsLine.includes('LoRAs (none)'))
  assert.ok(!('settings' in compactNote))
  assert.ok(!JSON.stringify(relevant.evidence).includes('"prompt":'))
  assert.ok(!JSON.stringify(relevant.evidence).includes('"negative_prompt":'))
  const overview = relevant.evidence.profiles.find((p) => p.id === profile.id)!
  assert.match(overview.summary, /Studio preference: Quiet composition.*2 notes · last touched/)
  assert.ok(!overview.summary.includes('\n'))
  const storedLearning = database().prepare('SELECT text, image_learning FROM agent_memories WHERE id = ?').get(learned.id) as any
  assert.ok(storedLearning.text.startsWith(`Image learning · profile ${profile.id} · user_feedback · Studio portrait\nInterpretation (not verified): `))
  assert.ok(storedLearning.text.includes(`\nEvidence #${feedbackId}: ${baseLearning.evidence_quote}\nImage: ${lastVisionImage.id}\nRecorded settings: `))
  assert.deepEqual(JSON.parse(storedLearning.text.split('\nRecorded settings: ')[1]), lastVisionImage.settings)
  assert.deepEqual(JSON.parse(storedLearning.image_learning).settings, lastVisionImage.settings)
  assert.deepEqual(imageLearnings(owner, visionThread.id, lastVisionImage.settings, 'Studio portrait'), relevant)
  assert.equal(imageLearnings(owner, visionThread.id, { ...lastVisionImage.settings, model: 'other/model' }).evidence.notes.length, 0)
  assert.equal(imageLearnings(owner, visionThread.id, lastVisionImage.settings, '', undefined, otherProfile.id).evidence.notes.length, 0)
  assert.equal(imageLearnings(owner, visionThread.id, lastVisionImage.settings, '', undefined, null).evidence.notes.length, 0)
  assert.equal(imageLearnings(owner, visionThread.id, lastVisionImage.settings, '', 'different-backend').evidence.notes.length, 0)
  assert.ok(!JSON.stringify(relevant.evidence).includes(comfyUrl) && !JSON.stringify(relevant.evidence).includes('test-secret'))
  await json('PUT', '/api/agents/images/settings', { token: 'different-namespace' })
  assert.notEqual(imageBackendScope(owner), oldScope.backend_scope)
  assert.equal(imageLearnings(owner, visionThread.id, lastVisionImage.settings).evidence.notes.length, 0)
  await json('PUT', '/api/agents/images/settings', settings)
  const memories = await json('GET', '/api/agents/memories')
  assert.ok(memories.find((m: any) => m.id === learned.id).imageLearning)
  assert.ok(memories.find((m: any) => m.id === profile.id).imageProfile)
  assert.equal((await api('PATCH', `/api/agents/memories/${learned.id}`, { text: 'Contradictory settings' })).status, 400)
  assert.equal((await api('PATCH', `/api/agents/memories/${profile.id}`, { text: 'untyped overwrite' })).status, 400)
  // Every new turn/resume re-reads evidence before a job, including in Bypass.
  requestedTool = 'generate_image'; generationArgs = { prompt: 'Studio portrait', profile_id: profile.id, profile_reason: 'User-selected studio style', seed: 91, steps: 23 }
  retryLearning = false
  const submissionsBeforeGate = submissions
  const gated = await turn(visionThread.id)
  assert.equal(submissions, submissionsBeforeGate)
  assert.equal(result(gated).learning_review_required, true)
  assert.equal(result(gated).selectedProfile.id, profile.id)
  assert.equal(result(gated).notes[0].id, learned.id)
  assert.ok(providerInputs.at(-1).messages.filter((m: any) => m.role === 'system').every((m: any) => !m.content.includes('Keep the user preference provisional')))
  retryLearning = true
  const learnedGeneration = await turn(visionThread.id)
  assert.equal(result(learnedGeneration).image.settings.steps, 23)
  assert.equal(result(learnedGeneration).image.settings.seed, 91)
  assert.equal(result(learnedGeneration).image.settings.profile_id, profile.id)
  assert.equal(learnedGeneration.messages.at(-1).role, 'tool')
  // Discovery and generation in one batch cannot count as evidence already read by the model.
  requestedTool = 'list_image_models'; generationArgs = { prompt: 'Studio portrait', profile_id: profile.id }
  extraToolCalls = [{ name: 'generate_image', arguments: generationArgs }]
  const batchedRead = await turn(visionThread.id)
  assert.ok(batchedRead.messages.some((m: any) => m.toolName === 'generate_image' && m.content.includes('learning_review_required')))
  assert.equal(batchedRead.messages.at(-1).role, 'tool')
  extraToolCalls = []; requestedTool = 'read_image_learnings'; generationArgs = { profile_id: profile.id, all_models: true, task: 'Studio' }
  const readTurn = await turn(visionThread.id)
  assert.ok(JSON.parse(readTurn.messages.findLast((m: any) => m.toolName === 'read_image_learnings').content).notes.length >= 2)
  requestedTool = 'save_image_learning'; generationArgs = { image_id: lastVisionImage.id, profile_id: profile.id, task: 'Experiment', note: 'Try another framing only if requested.', source: 'suggestion' }
  await json('PATCH', `/api/agents/threads/${visionThread.id}`, { permission: 'default' })
  const beforeDefaultSave = (database().prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = 1 AND image_learning IS NOT NULL').get() as any).n
  const approvalsBeforeDefault = approvalSummaries.length
  const saveTurn = await turn(visionThread.id)
  assert.equal(approvalSummaries.length, approvalsBeforeDefault)
  assert.equal((database().prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = 1 AND image_learning IS NOT NULL').get() as any).n, beforeDefaultSave + 1)
  assert.equal(JSON.parse(saveTurn.messages.findLast((m: any) => m.toolName === 'save_image_learning').content).source.kind, 'suggestion')
  const savedCount = () => (database().prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = 1 AND image_learning IS NOT NULL').get() as any).n
  const beforeDecline = savedCount()
  assert.equal((await json('PUT', '/api/agents/images/settings', { askBeforeSavingObservations: true })).askBeforeSavingObservations, true)
  assert.equal((await json('GET', '/api/agents/images/settings', undefined, 1)).askBeforeSavingObservations, false)
  const beforeAsked = approvalSummaries.length
  const declinedSave = await turn(visionThread.id, false)
  assert.equal(approvalSummaries.length, beforeAsked + 1)
  assert.match(JSON.parse(declinedSave.messages.findLast((m: any) => m.toolName === 'save_image_learning').content).error, /declined/i)
  assert.equal(savedCount(), beforeDecline)
  const allowedSave = await turn(visionThread.id, true)
  assert.equal(approvalSummaries.length, beforeAsked + 2)
  assert.equal(JSON.parse(allowedSave.messages.findLast((m: any) => m.toolName === 'save_image_learning').content).source.kind, 'suggestion')
  assert.equal(savedCount(), beforeDecline + 1)
  for (const name of ['save_image_profile', 'save_image_learning', 'read_image_learnings']) {
    const definition = providerInputs.at(-1).tools.find((t: any) => t.function.name === name).function
    assert.match(definition.description, /do not save your own guess unless the user explicitly asks/i)
    assert.match(definition.description, /profile/i)
  }
  assert.equal(providerInputs.at(-1).tools.find((t: any) => t.function.name === 'save_image_profile').function.parameters.properties.description.maxLength, 1200)
  await json('PUT', '/api/agents/images/settings', { askBeforeSavingObservations: false })
  console.log('PASS observations save without approval by default; opt-in asks, decline writes nothing and approval saves')
  const countBeforeOff = savedCount()
  await json('PUT', '/api/agents/images/settings', { saveImageLearnings: false })
  const offSave = await turn(visionThread.id)
  assert.match(JSON.parse(offSave.messages.findLast((m: any) => m.toolName === 'save_image_learning').content).error, /observations are turned off.*Settings/)
  assert.ok(!providerInputs.at(-1).tools.some((t: any) => t.function.name === 'save_image_learning'))
  assert.ok(providerInputs.at(-1).tools.some((t: any) => t.function.name === 'read_image_learnings'))
  assert.ok(providerInputs.at(-1).tools.some((t: any) => t.function.name === 'save_image_profile'))
  assert.equal(savedCount(), countBeforeOff)
  assert.throws(() => saveImageLearning(owner, visionThread.id, generationArgs), /observations are turned off/)
  const saveArgs = generationArgs
  requestedTool = 'read_image_learnings'; generationArgs = { profile_id: profile.id, all_models: true }
  const readWhileOff = await turn(visionThread.id)
  assert.ok(JSON.parse(readWhileOff.messages.findLast((m: any) => m.toolName === 'read_image_learnings').content).notes.length)
  requestedTool = 'generate_image'; generationArgs = { prompt: 'Review without saving', profile_id: profile.id }
  assert.ok(result(await turn(visionThread.id)).image)
  assert.equal(savedCount(), countBeforeOff)
  await json('PUT', '/api/agents/images/settings', { saveImageLearnings: true })
  requestedTool = 'save_image_learning'; generationArgs = saveArgs
  assert.equal(JSON.parse((await turn(visionThread.id)).messages.findLast((m: any) => m.toolName === 'save_image_learning').content).source.kind, 'suggestion')
  assert.equal(savedCount(), countBeforeOff + 1)
  assert.ok(providerInputs.at(-1).tools.some((t: any) => t.function.name === 'save_image_learning'))
  console.log('PASS observations default on, disabled tool and direct writes, existing reads and review/retry, re-enabled writes')
  assert.equal(decide('test', 'default', { name: 'save_image_learning', arguments: {} }), 'ask')
  assert.equal(decide('test', 'plan', { name: 'save_image_profile', arguments: {} }), 'refuse')
  await server.stop(); await server.start()
  assert.equal((await json('GET', `/api/agents/image-profiles/threads/${visionThread.id}`)).profile.id, profile.id)
  assert.ok((await json('GET', '/api/agents/memories')).some((m: any) => m.id === learned.id))
  const renamed = await json('POST', '/api/agents/image-profiles', { id: profile.id, name: 'Studio revised', description: 'User correction: less contrast.' })
  assert.equal(renamed.name, 'Studio revised')
  assert.notEqual(imageLearnings(owner, visionThread.id, lastVisionImage.settings).receipt, relevant.receipt)
  const receiptBeforeModelSwitch = imageLearnings(owner, visionThread.id, lastVisionImage.settings).receipt
  database().prepare('UPDATE agent_threads SET model = ? WHERE id = ?').run('text-model', visionThread.id)
  assert.notEqual(imageLearnings(owner, visionThread.id, lastVisionImage.settings).receipt, receiptBeforeModelSwitch)
  database().prepare('UPDATE agent_threads SET model = ? WHERE id = ?').run('test-model', visionThread.id)
  const extraProfiles: number[] = []
  for (let i = 0; i < 18; i++) extraProfiles.push(saveImageProfile(owner, { name: `Bounded profile ${i}`, description: '' }).id)
  assert.throws(() => saveImageProfile(owner, { name: 'Overflow profile', description: '' }), /20 profiles/)
  for (const id of extraProfiles) await json('DELETE', `/api/agents/image-profiles/${id}`)
  const imageCount = (database().prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = 1 AND image_learning IS NOT NULL').get() as any).n
  const extraLearningIds: number[] = []
  for (let i = imageCount; i < 100; i++) extraLearningIds.push(Number(database().prepare('INSERT INTO agent_memories (user_id, text, category, created_at, image_learning) SELECT user_id, text, category, created_at, image_learning FROM agent_memories WHERE id = ?').run(visionNote.id).lastInsertRowid))
  assert.throws(() => saveImageLearning(owner, visionThread.id, generationArgs), /100 image notes/)
  for (const id of extraLearningIds) await json('DELETE', `/api/agents/memories/${id}`)
  const oldQuota = process.env.USER_STORAGE_MB
  process.env.USER_STORAGE_MB = '1'
  assert.throws(() => saveImageLearning(owner, visionThread.id, { ...generationArgs, note: 'Quota test' }), /storage is full/)
  if (oldQuota === undefined) delete process.env.USER_STORAGE_MB; else process.env.USER_STORAGE_MB = oldQuota
  for (let i = 0; i < 6; i++) saveImageLearning(owner, visionThread.id, { ...generationArgs, note: `Suggestion ${i}` })
  const capped = imageLearnings(owner, visionThread.id, lastVisionImage.settings)
  assert.equal(capped.evidence.notes.length, 5)
  assert.equal(capped.evidence.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(capped.evidence)) < 20_000)
  assert.ok(capped.evidence.notes.slice(0, 2).every((n) => n.source.kind !== 'suggestion'))
  assert.ok(capped.evidence.notes.some((n) => n.source.kind === 'suggestion')) // Explicitly requested guesses remain readable.
  const longEvidence = 'Concrete defect: '.repeat(28)
  const longEvidenceId = Number(database().prepare('INSERT INTO agent_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(visionThread.id, 'user', longEvidence, Date.now()).lastInsertRowid)
  const longNote = saveImageLearning(owner, visionThread.id, { ...baseLearning, note: 'n'.repeat(500), evidence_message_id: longEvidenceId, evidence_quote: longEvidence })
  const clippedNotes = imageLearnings(owner, visionThread.id, lastVisionImage.settings).evidence
  const clippedNote = clippedNotes.notes.find((n) => n.id === longNote.id)!
  assert.equal(clippedNote.note.length, 240)
  assert.equal(clippedNote.source.quote.length, 160)
  assert.ok(longEvidence.includes(clippedNote.source.quote))
  assert.ok(clippedNotes.feedbackSources.every((source) => source.quote.length <= 200))
  // Retrieval must retain exact LoRA-set matching and show weights without returning prompt JSON.
  const loraSettings = { ...lastVisionImage.settings, loras: [{ name: 'style/example.safetensors', weight: 0.7 }] }
  const withLora = JSON.parse(storedLearning.image_learning)
  withLora.settings = loraSettings
  database().prepare('UPDATE agent_memories SET image_learning = ? WHERE id = ?').run(JSON.stringify(withLora), learned.id)
  assert.ok(!imageLearnings(owner, visionThread.id, lastVisionImage.settings).evidence.notes.some((n) => n.id === learned.id))
  assert.ok(imageLearnings(owner, visionThread.id, loraSettings).evidence.notes.find((n) => n.id === learned.id)!.settingsLine.includes('LoRAs style/example.safetensors (0.7)'))
  database().prepare('UPDATE agent_memories SET image_learning = ? WHERE id = ?').run(storedLearning.image_learning, learned.id)
  console.log('PASS profile-first guidance, 1200-character profiles, protected preferences, compact evidence/settings, evidence-first ranking, exact LoRA matching and unchanged stored format')
  await json('DELETE', `/api/agents/memories/${learned.id}`)
  assert.ok(!(await json('GET', '/api/agents/memories')).some((m: any) => m.id === learned.id))
  await json('DELETE', `/api/agents/image-profiles/${profile.id}/reset`)
  assert.equal(imageLearnings(owner, visionThread.id, lastVisionImage.settings).evidence.notes.length, 0)
  assert.equal((await json('GET', '/api/agents/image-profiles')).find((p: any) => p.id === profile.id).description, 'User correction: less contrast.')
  await json('DELETE', `/api/agents/memories/${profile.id}`)
  assert.equal((await json('GET', `/api/agents/image-profiles/threads/${visionThread.id}`)).profile, null)
  await json('DELETE', `/api/agents/image-profiles/${otherProfile.id}`)
  requestedTool = 'generate_image'; generationArgs = { prompt: 'Normal generation' }
  console.log('PASS durable image evidence, exact provenance/settings, profile and backend isolation, first-attempt and batch review guard, per-call precedence, protected preferences, quota, bounded relevance, deletion/reset and restart')
  // LoRA HTTP discovery, mention resolution and real tool calls use the same installed identifiers.
  const loraEndpoint = '/api/agents/images/loras'
  assert.equal((await fetch(server.origin + loraEndpoint)).status, 401)
  const exposedLoras = await json('GET', loraEndpoint)
  assert.deepEqual(exposedLoras.loras.map((l: any) => l.name), [...loraNames].sort())
  assert.ok(!JSON.stringify(exposedLoras).includes('/private/') && !JSON.stringify(exposedLoras).includes('test-secret'))
  for (const mode of ['missing', 'invalid', 'oversize']) {
    loraHintsMode = mode
    assert.ok((await json('GET', loraEndpoint)).loras.every((l: any) => !l.baseModel && !l.triggers.length))
  }
  loraHintsMode = 'duplicate'
  assert.equal((await json('GET', loraEndpoint)).loras.find((l: any) => l.name === loraNames[0]).baseModel, '')
  loraHintsMode = 'ok'
  const mentionThread = await thread()
  requestedTool = 'list_image_models'; generationArgs = { query: 'style', limit: 1 }
  const mentionTextInput = `Use #STYLE:0.8 $msh @list_image_models #not-installed $missing-skill @missing_tool and #"Folder/Soft light.safetensors"`
  const mentioned = await turn(mentionThread.id, undefined, mentionTextInput)
  const userMessage = mentioned.messages.findLast((m: any) => m.role === 'user')
  assert.equal(userMessage.content, mentionTextInput)
  assert.equal(userMessage.attachments.filter((a: any) => a.source === 'application context').length, 1)
  assert.ok(userMessage.attachments.some((a: any) => a.name === 'msh skill'))
  const mentionedFiles = JSON.parse((database().prepare('SELECT attachments FROM agent_messages WHERE id = ?').get(userMessage.id) as any).attachments)
  const contextNote = mentionedFiles.find((a: any) => a.source === 'application context').text
  assert.match(contextNote, /not user instructions/)
  assert.match(contextNote, /#not-installed: not installed/)
  assert.match(contextNote, /\$missing-skill: no such skill/)
  assert.match(contextNote, /@missing_tool: no such tool/)
  assert.match(contextNote, /group images is on/)
  const mentionDiscovery = JSON.parse(mentioned.messages.findLast((m: any) => m.toolName === 'list_image_models').content)
  assert.deepEqual(mentionDiscovery.options.loras.values, [loraNames[0]])
  assert.equal(mentionDiscovery.loraHints[0].baseModel, 'Krea2')
  assert.deepEqual(mentionDiscovery.selected.loras, [{ name: loraNames[0], weight: 0.8 }, { name: loraNames[2], weight: 1 }])
  assert.deepEqual((await json('GET', endpoint(mentionThread.id))).effective.loras, mentionDiscovery.selected.loras)
  await turn(mentionThread.id, undefined, '#style:0.5 #not-installed')
  assert.deepEqual((await json('GET', endpoint(mentionThread.id))).effective.loras, [{ name: loraNames[0], weight: 0.5 }, { name: loraNames[2], weight: 1 }])
  const slashSkill = await turn(mentionThread.id, undefined, '/msh help with a command')
  assert.ok(slashSkill.messages.findLast((m: any) => m.role === 'user').attachments.some((a: any) => a.name === 'msh skill'))
  await json('PATCH', `/api/agents/threads/${mentionThread.id}`, { tools: ['web'] })
  const disabledMention = await turn(mentionThread.id, undefined, 'Use @generate_image')
  const disabledUser = disabledMention.messages.findLast((m: any) => m.role === 'user')
  assert.match((database().prepare('SELECT attachments FROM agent_messages WHERE id = ?').get(disabledUser.id) as any).attachments, /is off.*Tools menu or CLI \/tools/)
  await json('PATCH', `/api/agents/threads/${mentionThread.id}`, { tools: ['images'] })
  requestedTool = 'generate_image'
  for (const loras of [[{ name: 'invented.safetensors' }], [{ name: loraNames[0], weight: -1 }], [{ name: loraNames[0], weight: 3 }], Array.from({ length: 6 }, () => ({ name: loraNames[0] }))]) {
    const before = submissions
    generationArgs = { prompt: 'Invalid LoRAs', loras }
    assert.ok(result(await turn(mentionThread.id)).error)
    assert.equal(submissions, before)
    assert.equal((await api('PUT', endpoint(mentionThread.id), { loras })).status, 400)
  }
  generationArgs = { prompt: 'Mention settings actually run' }
  const mentionImage = result(await turn(mentionThread.id)).image
  assert.equal(submitted['10'].inputs.lora_name, loraNames[0])
  assert.equal(submitted['10'].inputs.strength_model, 0.5)
  assert.equal(submitted['11'].inputs.lora_name, loraNames[2])
  const legacyMetadata = { ...mentionImage.settings }; delete legacyMetadata.loras
  database().prepare('UPDATE agent_images SET metadata = ? WHERE id = ?').run(JSON.stringify(legacyMetadata), mentionImage.id)
  assert.deepEqual((await json('GET', mentionImage.url + '/metadata')).settings, legacyMetadata)
  await json('DELETE', endpoint(mentionThread.id))
  assert.deepEqual((await json('GET', endpoint(mentionThread.id))).effective.loras, [])
  console.log('PASS bounded private LoRA discovery/enrichment, mentions and unchanged text, skills, disabled/unknown tools, exact installed names, persistent and per-call lists, legacy metadata')
  // Generate another is a direct streamed action: no provider round and no approval card.
  await json('PUT', '/api/agents/images/settings', { ...settings, askBeforeGenerate: true })
  await json('PATCH', `/api/agents/threads/${mentionThread.id}`, { permission: 'default' })
  database().prepare('UPDATE agent_images SET metadata = ? WHERE id = ?').run(JSON.stringify(mentionImage.settings), mentionImage.id)
  const againPath = `/api/agents/threads/${mentionThread.id}/images/${mentionImage.id}/again`
  const directEvents = async (path: string) => {
    const response = await api('POST', path, {})
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
  const callsBeforeAgain = providerChats, imageRowsBeforeAgain = (database().prepare('SELECT COUNT(*) AS n FROM agent_images').get() as any).n
  const againEvents = await directEvents(againPath)
  const another = JSON.parse(againEvents.find((e: any) => e.type === 'message' && e.message.role === 'tool').message.content).image
  assert.ok(another, JSON.stringify(againEvents))
  assert.equal(providerChats, callsBeforeAgain)
  assert.ok(!againEvents.some((e: any) => e.type === 'approval'))
  assert.ok(againEvents.some((e: any) => e.type === 'imageGeneration') && againEvents.some((e: any) => e.type === 'imageProgress') && againEvents.some((e: any) => e.type === 'imageGenerationDone'))
  assert.notEqual(another.id, mentionImage.id)
  assert.notEqual(another.settings.seed, mentionImage.settings.seed)
  assert.deepEqual({ ...another.settings, seed: 0 }, { ...mentionImage.settings, seed: 0 })
  assert.equal((database().prepare('SELECT COUNT(*) AS n FROM agent_images').get() as any).n, imageRowsBeforeAgain + 1)
  assert.equal((await api('GET', another.url)).status, 200)
  assert.deepEqual((await json('GET', another.url + '/metadata')).settings, another.settings)
  const retryEvents = await directEvents(`/api/agents/threads/${mentionThread.id}/retry`)
  assert.ok(retryEvents.some((e: any) => e.type === 'message' && e.message.role === 'tool' && JSON.parse(e.message.content).image))
  assert.equal(providerChats, callsBeforeAgain)
  assert.ok(!retryEvents.some((e: any) => e.type === 'approval'))
  const previousLoras = [info.LoraLoader.input.required.lora_name, info.LoraLoaderModelOnly.input.required.lora_name]
  info.LoraLoader.input.required.lora_name = [[]]; info.LoraLoaderModelOnly.input.required.lora_name = [[]]
  const beforeMissing = submissions
  const missingAgain = await directEvents(againPath)
  assert.ok(missingAgain.some((e: any) => e.type === 'error' && e.error.includes(loraNames[0]) && e.error.includes('no longer installed')))
  assert.equal(submissions, beforeMissing)
  ;[info.LoraLoader.input.required.lora_name, info.LoraLoaderModelOnly.input.required.lora_name] = previousLoras
  await json('PATCH', `/api/agents/threads/${mentionThread.id}`, { tools: ['web'] })
  assert.equal((await api('POST', againPath)).status, 409)
  await json('PATCH', `/api/agents/threads/${mentionThread.id}`, { tools: ['images'] })
  assert.equal((await api('POST', againPath, undefined, 1)).status, 404)
  const unrelated = await thread()
  assert.equal((await api('POST', `/api/agents/threads/${unrelated.id}/images/${mentionImage.id}/again`)).status, 404)
  // A running direct action can be followed and stopped, and refuses a concurrent account job.
  const concurrentBranch = await json('POST', `/api/agents/threads/${mentionThread.id}/branch`, { messageId: (await json('GET', `/api/agents/threads/${mentionThread.id}`)).messages.at(-1).id })
  behavior = 'wait'
  const startAt = submissions
  const pendingAgain = directEvents(againPath)
  await until(() => submissions > startAt)
  assert.equal((await api('POST', `/api/agents/threads/${mentionThread.id}/branch`, { messageId: mentioned.messages[0].id })).status, 409)
  const follow = await api('GET', `/api/agents/threads/${mentionThread.id}/follow`)
  const reader = follow.body!.getReader()
  let snapshot = ''
  while (!snapshot.includes('\n')) { const chunk = await reader.read(); assert.ok(!chunk.done); snapshot += new TextDecoder().decode(chunk.value) }
  assert.ok(JSON.parse(snapshot.split('\n')[0]).pending.some((p: any) => p.kind === 'image'))
  await reader.cancel()
  const concurrentEvents = await directEvents(`/api/agents/threads/${concurrentBranch.thread.id}/images/${mentionImage.id}/again`)
  assert.ok(concurrentEvents.some((e: any) => e.type === 'error' && e.error.includes('already generating for this account')))
  const rowsBeforeStop = (database().prepare('SELECT COUNT(*) AS n FROM agent_images').get() as any).n
  await json('POST', `/api/agents/threads/${mentionThread.id}/stop`, {})
  await pendingAgain
  assert.equal((database().prepare('SELECT COUNT(*) AS n FROM agent_images').get() as any).n, rowsBeforeStop)
  assert.ok(deletions.includes(`job-${submissions}`))
  behavior = 'ok'
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: false })
  console.log('PASS Generate another preserves settings, writes a new private image, streams progress without model/approval, Retry, missing LoRA, group/ownership guards, follow and cancellation')
  // Source bytes are private persisted data, never a URL supplied by the model.
  const { imageSource, sourceRaster, sourceDimensions, listImageAttachments } = await import('../server/agentImageSources.ts')
  const { prepareImageGeneration, imageAgainInput } = await import('../server/agentImages.ts')
  await json('PUT', '/api/agents/images/settings', { ...settings, askBeforeGenerate: true })
  const editThread = await thread('default')
  await json('PATCH', `/api/agents/threads/${editThread.id}`, { model: 'text-model' })
  const sourceThread = await thread()
  const sourceId = randomUUID()
  database().prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(sourceId, sourceThread.id, 'source.png', png, Date.now())
  const attached = Number(database().prepare("INSERT INTO agent_messages (thread_id, role, content, attachments, created_at) VALUES (?, 'user', 'Edit this picture', ?, ?)").run(editThread.id, JSON.stringify([{ kind: 'image', name: 'attached.png', mime: 'image/png', data: png.toString('base64'), size: png.length }]), Date.now()).lastInsertRowid)
  const attachmentId = `attachment:${attached}:0`
  assert.deepEqual(sourceRaster(png), { width: 1, height: 1, mime: 'image/png' })
  assert.equal(listImageAttachments(admin, editThread.id, {}).attachments[0].source_image_id, attachmentId)
  assert.throws(() => listImageAttachments({ ...admin, id: 2 }, editThread.id, {}), /No such thread/)
  for (const id of [sourceId, attachmentId]) {
    assert.deepEqual(imageSource(admin, id).bytes, png)
    assert.throws(() => imageSource({ ...admin, id: 2 }, id), /No such source/)
  }
  for (const id of ['https://example.test/private.png', '/private/a.png', 'data:image/png;base64,a', `attachment:${attached}:9`]) assert.throws(() => imageSource(admin, id))
  assert.throws(() => sourceRaster(Buffer.from('<svg/>')), /valid still/)
  assert.throws(() => sourceRaster(Buffer.alloc(8 * 1024 * 1024 + 1)), /8 MiB/)
  const huge = Buffer.from(png); huge.writeUInt32BE(8193, 16)
  assert.throws(() => sourceRaster(huge), /dimensions exceed/)
  assert.deepEqual(sourceDimensions({ width: 1600, height: 800 }, undefined, undefined, 1024), { width: 1024, height: 512 })
  assert.deepEqual(sourceDimensions({ width: 1600, height: 800 }, undefined, 256, 1024), { width: 512, height: 256 })
  const editSettings = { ...settings, askBeforeGenerate: false, askBeforeSavingObservations: false, saveImageLearnings: true }
  for (const preset of ['sd15', 'sdxl', 'z_image', 'z_image_turbo', 'krea2_raw', 'krea2_turbo'] as const) {
    const graph = imageWorkflow({ ...editSettings, preset, clip: 'encoder.safetensors', vae: 'vae.safetensors' }, { prompt: 'Change sky', denoise: 0.45, loras: [{ name: loraNames[0], weight: 0.8 }] }, { nodes: Object.keys(info) }, 'scoped.png')
    assert.equal(graph.graph['20'].inputs.image, 'scoped.png')
    assert.equal(graph.graph['21'].inputs.crop, 'center')
    assert.equal(graph.graph['6'].class_type, 'VAEEncode')
    assert.deepEqual(graph.graph['6'].inputs.vae, preset === 'sd15' || preset === 'sdxl' ? ['1', 2] : ['3', 0])
    assert.deepEqual(graph.graph['7'].inputs.latent_image, ['6', 0])
    assert.equal(graph.graph['7'].inputs.denoise, 0.45)
    assert.equal(graph.graph['10'].inputs.strength_model, 0.8)
  }
  for (const denoise of [null, 0, -1, 1.01, NaN, Infinity, '0.5']) assert.throws(() => imageWorkflow(editSettings, { prompt: 'test', denoise }, undefined, 'scoped.png'), /Denoise/)
  assert.throws(() => imageWorkflow(editSettings, { prompt: 'test', denoise: 0.5 }), /requires source/)
  const textGraph = imageWorkflow(editSettings, { prompt: 'text only' })
  assert.equal(textGraph.graph['6'].class_type, 'EmptyLatentImage'); assert.equal(textGraph.graph['7'].inputs.denoise, 1)
  delete info.VAEEncode
  await assert.rejects(prepareImageGeneration(admin, editThread.id, { prompt: 'edit', source_image_id: sourceId }, new AbortController().signal), /needs LoadImage/)
  info.VAEEncode = { input: { required: {} } }
  generationArgs = { prompt: 'Change the sky', source_image_id: sourceId, denoise: 0.45, width: 512, height: 768, seed: 123 }
  requestedTool = 'generate_image'; extraToolCalls = []; retryLearning = true
  const declinedEdit = await thread('default'), beforeDeclinedUpload = uploads.length
  await turn(declinedEdit.id, false, 'Edit this source image')
  assert.equal(uploads.length, beforeDeclinedUpload)
  const editBefore = uploads.length, eventsBeforeEdit = streamEvents.length
  approvalHook = async () => { assert.equal(uploads.length, editBefore) }
  const edited = await turn(editThread.id, true, 'Use this image, change the sky')
  approvalHook = undefined
  const editResult = result(edited)
  assert.equal(editResult.image.settings.source.id, sourceId)
  assert.equal(editResult.image.settings.denoise, 0.45)
  assert.equal(editResult.image.settings.source.resize, 'lanczos-center-crop')
  assert.equal(approvalSummaries.at(-1).image.url, `/api/agents/images/${sourceId}`)
  assert.match(approvalSummaries.at(-1).title, /Edit image/)
  assert.equal(uploads.length, editBefore + 1)
  assert.equal(submitted['20'].inputs.image, uploads.at(-1))
  assert.equal(submitted['6'].class_type, 'VAEEncode')
  assert.deepEqual(imageSource(admin, sourceId).bytes, png)
  const editEvents = streamEvents.slice(eventsBeforeEdit)
  assert.ok(editEvents.some((e) => e.type === 'imageGeneration' && e.width === 512 && e.height === 768))
  assert.ok(!editEvents.some((e) => e.type === 'message' && e.message.role === 'assistant' && e.message.content))
  const againEdit = imageAgainInput(admin, editThread.id, editResult.image.id)
  assert.equal(againEdit.source_image_id, sourceId); assert.equal(againEdit.denoise, 0.45)
  assert.notEqual(againEdit.seed, 123)
  assert.ok(providerInputs.some((p) => p.tools?.some((x: any) => x.function?.name === 'list_image_attachments')))
  assert.ok(providerInputs.some((p) => p.tools?.some((x: any) => x.function?.name === 'generate_image' && x.function.parameters.properties.source_image_id)))
  // Prepare captures bytes before approval, even if the owner removes their original message.
  const captured = await prepareImageGeneration(admin, editThread.id, { prompt: 'edit attached', source_image_id: attachmentId }, new AbortController().signal)
  database().prepare('DELETE FROM agent_messages WHERE id = ?').run(attached)
  const captureResult = JSON.parse(await captured.run())
  assert.equal(captureResult.image.settings.source.id, attachmentId)
  assert.equal(captureResult.image.settings.denoise, 0.65)
  assert.equal(new Set(uploads).size, uploads.length)
  for (const mode of ['fail', 'path']) {
    uploadBehavior = mode
    const before = submissions
    await assert.rejects(generateImage(admin, editThread.id, { prompt: 'edit', source_image_id: sourceId }, new AbortController().signal), /upload/)
    assert.equal(submissions, before)
  }
  uploadBehavior = 'hold'
  const cancelUpload = new AbortController(), uploadsBeforeCancel = uploads.length, submissionsBeforeCancel = submissions
  const uploading = generateImage(admin, editThread.id, { prompt: 'edit', source_image_id: sourceId }, cancelUpload.signal)
  const rejectedUpload = assert.rejects(uploading, /cancelled/)
  await until(() => uploads.length > uploadsBeforeCancel)
  cancelUpload.abort(); await rejectedUpload
  assert.equal(submissions, submissionsBeforeCancel)
  uploadBehavior = 'ok'
  const stopped = new AbortController(); stopped.abort()
  const beforeStoppedUpload = uploads.length
  await assert.rejects(generateImage(admin, editThread.id, { prompt: 'edit', source_image_id: sourceId }, stopped.signal))
  assert.equal(uploads.length, beforeStoppedUpload)
  behavior = 'wait'
  const cancelEdit = new AbortController(), beforeEditSubmissions = submissions
  const editing = generateImage(admin, editThread.id, { prompt: 'edit', source_image_id: sourceId }, cancelEdit.signal)
  const refusedEdit = assert.rejects(editing, /cancelled/)
  await until(() => submissions > beforeEditSubmissions)
  cancelEdit.abort(); await refusedEdit
  assert.ok(deletions.includes(`job-${submissions}`)); assert.equal(interrupts, 0)
  behavior = 'ok'
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: false })
  console.log('PASS img2img six families, source/attachment ownership, source validation, preserved ratio, upload errors, pinned bytes, provenance, approvals, silent completion, cancellation and text-to-image regression')
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
  for (const socket of sockets.values()) socket.destroy() // upgraded, so closeAllConnections no longer holds them
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>((r) => comfy.close(() => r())), new Promise<void>((r) => ollama.close(() => r()))])
}
