import { deflateSync } from 'node:zlib'
// Pure graph/PNG fixtures, no HTTP, GPU or user data.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertInpaintNodes, inpaintGraph, normalizeInpaintMask, validateInpaintMask, type InpaintNodeInfo, type InpaintGraphInput } from '../server/agentImageInpaint.ts'
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
  // Evaluate the actual graph's final output with deliberately changed decoded pixels.
  // Crop coordinates follow official comfy/utils.py common_upscale. Nearest sampling here
  // isolates coordinate alignment; this is not a numerical test of Pillow Lanczos edges.
  // The production graph must select Lanczos for both paths. Composite follows nodes_mask.py.
  for (const [sourceWidth, sourceHeight] of [[256,256], [512,512], [1024,512], [512,1024]]) {
  const pixelInput = structuredClone(fixture)
  pixelInput.source.width = pixelInput.mask.width = sourceWidth
  pixelInput.source.height = pixelInput.mask.height = sourceHeight
  pixelInput.graph['21'].inputs.width = pixelInput.graph['21'].inputs.height = 256
  const pixelGraph = inpaintGraph(pixelInput, info).graph
  const sourcePixels = Uint8Array.from({ length: sourceWidth * sourceHeight * 3 }, (_, i) => (i * 17 + 23) % 256)
  const generatedPixels = new Uint8Array(256 * 256 * 3).fill(197)
  const maskPixels = Uint8Array.from({ length: sourceWidth * sourceHeight }, (_, i) => i % sourceWidth >= sourceWidth / 2 ? 255 : 0)
  const evaluate = (reference: unknown): Uint8Array => {
    const [id] = reference as [string, number], node = pixelGraph[id], input = node.inputs
    switch (node.class_type) {
      case 'LoadImage': return sourcePixels
      case 'LoadImageMask': assert.equal(input.channel, 'red'); return maskPixels
      case 'MaskToImage': { const mask = evaluate(input.mask); return Uint8Array.from({ length: mask.length * 3 }, (_, i) => mask[Math.floor(i / 3)]) }
      case 'ImageScale': {
        assert.equal(input.width, 256); assert.equal(input.height, 256)
        assert.equal(input.upscale_method, 'lanczos'); assert.equal(input.crop, 'center')
        const pixels = evaluate(input.image), side = Math.min(sourceWidth, sourceHeight)
        const left = (sourceWidth - side) / 2, top = (sourceHeight - side) / 2
        return Uint8Array.from({ length: 256 * 256 * 3 }, (_, i) => {
          const pixel = Math.floor(i / 3), x = left + Math.floor((pixel % 256 + .5) * side / 256)
          const y = top + Math.floor((Math.floor(pixel / 256) + .5) * side / 256)
          return pixels[(y * sourceWidth + x) * 3 + i % 3]
        })
      }
      case 'ImageToMask': { const pixels = evaluate(input.image); return Uint8Array.from({ length: pixels.length / 3 }, (_, i) => pixels[i * 3]) }
      case 'VAEDecode': return generatedPixels
      case 'ImageCompositeMasked': {
        const destination = evaluate(input.destination), source = evaluate(input.source), mask = evaluate(input.mask)
        assert.equal(input.resize_source, false); assert.equal(input.x, 0); assert.equal(input.y, 0)
        return Uint8Array.from(destination, (v, i) => source[i] * mask[Math.floor(i / 3)] / 255 + v * (1 - mask[Math.floor(i / 3)] / 255))
      }
      case 'SaveImage': return evaluate(input.images)
      default: throw new Error(`Unexpected fixture node ${node.class_type}`)
    }
  }
  const composited = evaluate(['9', 0])
  const workingSource = evaluate(['21',0]), workingMask = evaluate(['inpaint_mask',0])
  let unchanged = 0, edited = 0
  for (let i = 0; i < composited.length; i++) {
    if (workingMask[Math.floor(i / 3)] === 0) { assert.equal(composited[i], workingSource[i]); unchanged++ }
    else { assert.equal(composited[i], generatedPixels[i]); edited++ }
  }
  assert.equal(unchanged, 98_304); assert.equal(edited, 98_304)
  assert.notDeepEqual(composited, generatedPixels, 'saving decoded pixels alone must fail preservation')
  }
  const { sourceRaster } = await import('../server/agentImageSources.ts')
  const oriented = sourceRaster(readFileSync(new URL('./fixtures/agent-image-sources/rotated.jpg',import.meta.url)))
  assert.deepEqual([oriented.width,oriented.height],[32,48])
  const orientedMask = encodePng({width:32,height:48,data:new Uint8Array(32*48*4).fill(255)})
  validateInpaintMask(orientedMask,oriented)
  assert.throws(()=>validateInpaintMask(orientedMask,{width:48,height:32}),/dimensions must match/)
  console.log('PASS pixel evaluator: native, landscape/portrait crop and resize preserve every black RGB byte; EXIF-oriented mask dimensions enforced')
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
  assert.deepEqual(validateInpaintMask(png, { width: 2, height: 2 }), { width: 2, height: 2, mime: 'image/png', coverage: 0.5, bbox: { x: 1, y: 0, width: 1, height: 2 } })
  assert.throws(() => validateInpaintMask(png, { width: 2, height: 3 }), /dimensions must match/)
  // Independent RGBA encoder exercises browser-portable opaque alpha, not a forged IHDR.
  const rgbaPng = (alpha: number, white = true) => {
    const chunk = (type: string, body: Buffer) => {
      const data = Buffer.concat([Buffer.from(type), body])
      let crc = 0xffffffff
      for (const byte of data) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
      }
      const head = Buffer.alloc(4), tail = Buffer.alloc(4)
      head.writeUInt32BE(body.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
      return Buffer.concat([head, data, tail])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header.set([8, 6], 8)
    return Buffer.concat([png.subarray(0, 8), chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255, ...Array(3).fill(white ? 255 : 0), alpha]))),
      chunk('IEND', Buffer.alloc(0))])
  }
  assert.deepEqual(validateInpaintMask(rgbaPng(255), { width: 2, height: 1 }), { width: 2, height: 1, mime: 'image/png', coverage: 0.5, bbox: { x: 1, y: 0, width: 1, height: 1 } })
  for (const alpha of [0, 254]) assert.throws(() => validateInpaintMask(rgbaPng(alpha), { width: 2, height: 1 }), /fully opaque/)
  assert.throws(() => validateInpaintMask(rgbaPng(255, false), { width: 2, height: 1 }), /empty/)
  assert.throws(() => validateInpaintMask(Buffer.alloc(8 * 1024 * 1024 + 1), { width: 2, height: 2 }), /8 MiB/)
  // A fingerprint-guarding browser nudges canvas pixels: near-black and near-white values round to a strict mask.
  const nudged = encodePng({ width: 2, height: 2, data: Uint8Array.from([3, 1, 2, 250, 252, 254, 255, 255, 1, 0, 4, 255, 250, 251, 253, 254]) })
  assert.throws(() => validateInpaintMask(nudged, { width: 2, height: 2 }))
  const rounded = normalizeInpaintMask(nudged, { width: 2, height: 2 })
  assert.deepEqual(validateInpaintMask(rounded, { width: 2, height: 2 }), { width: 2, height: 2, mime: 'image/png', coverage: 0.5, bbox: { x: 1, y: 0, width: 1, height: 2 } })
  assert.throws(() => normalizeInpaintMask(nudged, { width: 3, height: 2 }), /dimensions must match/)
  assert.deepEqual(readdirSync(scratch), [], 'pure fixtures never opened a database')
  console.log('PASS inpaint: six real preset graphs/LoRAs, shared geometry, masked composite, no alpha inversion, preflight, bounds, immutable input, PNG contract')
} finally { rmSync(scratch, { recursive: true, force: true }) }
