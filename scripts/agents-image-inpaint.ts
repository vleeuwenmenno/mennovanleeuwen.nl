// Pure graph/PNG fixtures, no HTTP, GPU or user data.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertInpaintNodes, inpaintGraph, validateInpaintMask, type InpaintNodeInfo, type InpaintGraphInput } from '../server/agentImageInpaint.ts'
import { encodePng } from './perf/png.ts'

const scratch = mkdtempSync(join(tmpdir(), 'agents-inpaint-fixtures-'))
process.env.DATA_DIR = scratch
try {
  const { imageWorkflow, PRESETS } = await import('../server/agentImages.ts')
  // Minimal /object_info fixtures from official nodes.py / comfy_extras/nodes_mask.py.
  const schema: Record<string, Record<string, unknown>> = {
    LoadImage: { image: ['fixture.png'] },
    LoadImageMask: { image: ['mask.png'], channel: ['alpha', 'red', 'green', 'blue'] },
    MaskToImage: { mask: 'MASK' },
    ImageScale: { image: 'IMAGE', width: 'INT', height: 'INT', upscale_method: ['lanczos', 'nearest-exact'], crop: ['disabled', 'center'] },
    ImageToMask: { image: 'IMAGE', channel: ['red', 'green', 'blue', 'alpha'] },
    VAEEncode: { pixels: 'IMAGE', vae: 'VAE' },
    SetLatentNoiseMask: { samples: 'LATENT', mask: 'MASK' },
    KSampler: { model: 'MODEL', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT', denoise: 'FLOAT' },
    VAEDecode: { samples: 'LATENT', vae: 'VAE' },
    ImageCompositeMasked: { destination: 'IMAGE', source: 'IMAGE', mask: 'MASK', x: 'INT', y: 'INT', resize_source: 'BOOLEAN' },
    SaveImage: { images: 'IMAGE', filename_prefix: 'STRING' },
  }
  const info: InpaintNodeInfo = Object.fromEntries(Object.entries(schema).map(([node, fields]) => [node, { input: { required: Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, [type]])) } }]))
  assertInpaintNodes(info)
  for (const node of Object.keys(info)) {
    const missing = structuredClone(info); delete missing[node]
    assert.throws(() => assertInpaintNodes(missing), /ComfyUI inpainting requires/)
  }
  for (const [node, field] of [['LoadImageMask', 'channel'], ['ImageToMask', 'channel'], ['ImageScale', 'crop'], ['ImageScale', 'upscale_method']]) {
    const incompatible = structuredClone(info)
    incompatible[node].input!.required![field] = [['alpha', 'disabled', 'bilinear']]
    assert.throws(() => assertInpaintNodes(incompatible), /ComfyUI inpainting requires/)
  }
  let fixture: InpaintGraphInput | undefined
  for (const preset of PRESETS) {
    const result = imageWorkflow({ preset, url: '', token: '', model: 'fixture.safetensors', clip: 'encoder.safetensors', vae: 'vae.safetensors', askBeforeGenerate: false, askBeforeSavingObservations: false, saveImageLearnings: false }, { prompt: 'replace the marked shape', seed: 42, width: 768, height: 512, loras: [{ name: 'detail.safetensors', weight: 0.5 }] }, undefined, 'source.png')
    result.graph['22'] = { class_type: 'LoadImageMask', inputs: { image: 'mask.png', channel: 'red' } }
    fixture = { graph: result.graph, source: { image: ['20', 0], width: 4096, height: 4096 }, mask: { mask: ['22', 0], width: 4096, height: 4096 }, samplerId: '7', decodeId: '8', saveId: '9' }
    const before = structuredClone(result.graph)
    const painted = inpaintGraph(fixture, info)
    assert.deepEqual(result.graph, before, 'caller graph is immutable')
    assert.deepEqual(painted.graph['6'], before['6'], 'source VAE encoding is preserved')
    assert.deepEqual(painted.graph['8'], before['8'], 'same VAE and sampler output')
    for (const id of ['1', '2', '3', '4', '5', '10', '20', '21', '22']) assert.deepEqual(painted.graph[id], before[id], `${preset}: loader/conditioning/LoRA/source preserved`)
    assert.deepEqual(painted.graph['7'].inputs, { ...before['7'].inputs, latent_image: ['inpaint_latent', 0], denoise: 0.65 })
    assert.deepEqual(painted.graph.inpaint_latent.inputs, { samples: ['6', 0], mask: ['inpaint_mask', 0] })
    assert.deepEqual(painted.graph.inpaint_resize.inputs, { ...before['21'].inputs, image: ['inpaint_pixels', 0] })
    assert.deepEqual(painted.graph.inpaint_pixels.inputs, { mask: ['22', 0] })
    assert.deepEqual(painted.graph.inpaint_mask.inputs, { image: ['inpaint_resize', 0], channel: 'red' })
    assert.deepEqual(painted.graph.inpaint_composite.inputs, { destination: ['21', 0], source: ['8', 0], mask: ['inpaint_mask', 0], x: 0, y: 0, resize_source: false })
    assert.deepEqual(painted.graph['9'].inputs.images, ['inpaint_composite', 0], 'only the final composite is saved')
    assert.equal(inpaintGraph({ ...fixture, denoise: 0.4 }, info).denoise, 0.4)
  }
  assert.ok(fixture)
  for (const denoise of [NaN, Infinity, 0, 1.1]) assert.throws(() => inpaintGraph({ ...fixture, denoise }, info), /Denoise/)
  assert.throws(() => inpaintGraph({ ...fixture, mask: { ...fixture.mask, width: 2048 } }, info), /dimensions must match/)
  for (const [width, height] of [[8193, 1], [4096, 4097], [0, 400], [1.5, 400]]) assert.throws(() => inpaintGraph({ ...fixture, source: { ...fixture.source, width, height } }, info), /8192/)
  for (const change of [
    (x: InpaintGraphInput) => { x.graph['22'].inputs.channel = 'alpha' },
    (x: InpaintGraphInput) => { x.graph['21'].inputs.crop = 'disabled' },
    (x: InpaintGraphInput) => { x.graph['21'].inputs.width = 2048 },
    (x: InpaintGraphInput) => { x.graph['8'].inputs.vae = ['other', 0] },
    (x: InpaintGraphInput) => { x.graph['9'].inputs.images = ['21', 0] },
    (x: InpaintGraphInput) => { x.graph.inpaint_mask = { class_type: 'ImageToMask', inputs: {} } },
  ]) {
    const altered = structuredClone(fixture); change(altered)
    assert.throws(() => inpaintGraph(altered, info))
  }
  const png = encodePng({ width: 2, height: 2, data: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]) })
  assert.deepEqual(validateInpaintMask(png, { width: 2, height: 2 }), { width: 2, height: 2, mime: 'image/png' })
  assert.throws(() => validateInpaintMask(png, { width: 2, height: 3 }), /dimensions must match/)
  const alpha = Buffer.from(png); alpha[25] = 6
  assert.throws(() => validateInpaintMask(alpha, { width: 2, height: 2 }))
  assert.throws(() => validateInpaintMask(Buffer.alloc(8 * 1024 * 1024 + 1), { width: 2, height: 2 }), /8 MiB/)
  assert.deepEqual(readdirSync(scratch), [], 'pure fixtures never opened a database')
  console.log('PASS inpaint: six real preset graphs/LoRAs, shared geometry, masked composite, no alpha inversion, preflight, bounds, immutable input, PNG contract')
} finally { rmSync(scratch, { recursive: true, force: true }) }
