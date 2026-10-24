import { inflateSync } from 'node:zlib'
import { HttpError } from './http.ts'
import { sourceRaster } from './agentImageSources.ts'

export type InpaintGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
export type InpaintRef = readonly [string, number]
type Dimensions = { width: number; height: number }
export type InpaintNodeInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>

/** Discover these optional classes before uploading either input; absence must not break text-to-image. */
export const INPAINT_EXTRA_NODES = ['LoadImageMask', 'MaskToImage', 'ImageToMask', 'SetLatentNoiseMask', 'ImageCompositeMasked'] as const
const required: Record<string, Record<string, string>> = {
  LoadImage: { image: 'COMBO' },
  LoadImageMask: { image: 'COMBO', channel: 'red' },
  MaskToImage: { mask: 'MASK' },
  ImageScale: { image: 'IMAGE', upscale_method: 'lanczos', width: 'INT', height: 'INT', crop: 'center' },
  ImageToMask: { image: 'IMAGE', channel: 'red' },
  VAEEncode: { pixels: 'IMAGE', vae: 'VAE' },
  SetLatentNoiseMask: { samples: 'LATENT', mask: 'MASK' },
  KSampler: { model: 'MODEL', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT', denoise: 'FLOAT' },
  VAEDecode: { samples: 'LATENT', vae: 'VAE' },
  ImageCompositeMasked: { destination: 'IMAGE', source: 'IMAGE', x: 'INT', y: 'INT', resize_source: 'BOOLEAN', mask: 'MASK' },
  SaveImage: { images: 'IMAGE', filename_prefix: 'STRING' },
}

/** Validate actual input schemas, not just class names. No network or uploads are performed here. */
export function assertInpaintNodes(info: InpaintNodeInfo) {
  for (const [node, fields] of Object.entries(required)) {
    for (const [field, expected] of Object.entries(fields)) {
      const definition = info[node]?.input
      const fieldSchema = definition?.required?.[field] ?? definition?.optional?.[field]
      const actual = fieldSchema?.[0]
      const choices = Array.isArray(actual) ? actual : (fieldSchema?.[1] as { options?: unknown } | undefined)?.options
      const okay = expected === 'COMBO' ? Array.isArray(actual) || actual === 'COMBO'
        : ['red', 'lanczos', 'center'].includes(expected) ? Array.isArray(choices) && choices.includes(expected) : actual === expected
      if (!okay) throw new HttpError(409, `ComfyUI inpainting requires ${node}.${field} supporting ${expected}; refresh the model catalog after updating ComfyUI`)
    }
  }
}

function dimensions(value: Dimensions) {
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192 || value.width * value.height > 16_777_216) throw new HttpError(400, 'Inpainting inputs must be at most 8192 pixels per side and 16 megapixels')
}
function matching(source: Dimensions, mask: Dimensions) {
  dimensions(source); dimensions(mask)
  if (source.width !== mask.width || source.height !== mask.height) throw new HttpError(400, 'Mask dimensions must match the EXIF-oriented source image')
}

/** Raster structure/orientation validation stays in sourceRaster; these are mask-specific rules. */
export function validateInpaintMask(bytes: Buffer, source: Dimensions) {
  const mask = sourceRaster(bytes, 8 * 1024 * 1024)
  if (mask.mime !== 'image/png' || bytes[24] !== 8 || bytes[25] !== 2 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw new HttpError(400, 'Use an opaque 8-bit RGB PNG mask: white edits, black preserves')
  for (let at = 8; at + 12 <= bytes.length; at += bytes.readUInt32BE(at) + 12) {
    const kind = bytes.toString('ascii', at + 4, at + 8)
    if (kind === 'tRNS' || kind === 'eXIf') throw new HttpError(400, 'Mask PNG must not contain transparency or EXIF orientation')
  }
  matching(source, mask)
  // Masks have a narrow format: verify every pixel, and reject empty selections server-side too.
  const parts: Buffer[] = []
  for (let at = 8; at + 12 <= bytes.length; at += bytes.readUInt32BE(at) + 12) {
    if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + bytes.readUInt32BE(at)))
  }
  const stride = mask.width * 3, length = (stride + 1) * mask.height
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(parts), { maxOutputLength: length }) } catch { throw new HttpError(400, 'Invalid PNG mask pixel data') }
  if (raw.length !== length) throw new HttpError(400, 'Invalid PNG mask pixel length')
  let previous = Buffer.alloc(stride), current = Buffer.alloc(stride), nonempty = false
  for (let y = 0; y < mask.height; y++) {
    const offset = y * (stride + 1), filter = raw[offset]
    if (filter > 4) throw new HttpError(400, 'Invalid PNG mask filter')
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? current[x - 3] : 0, b = previous[x], c = x >= 3 ? previous[x - 3] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      current[x] = (raw[offset + 1 + x] + prediction) & 255
      if (current[x] !== 0 && current[x] !== 255 || x % 3 && current[x] !== current[x - 1]) throw new HttpError(400, 'Mask pixels must be black or white RGB')
      nonempty ||= current[x] === 255
    }
    ;[previous, current] = [current, previous]
  }
  if (!nonempty) throw new HttpError(400, 'The mask is empty; select an area to edit')
  return mask
}

export type InpaintGraphInput = {
  /** Server-built img2img graph only. Never expose graph/ref fields as tool arguments. */
  graph: InpaintGraph
  source: Dimensions & { image: InpaintRef }
  mask: Dimensions & { mask: InpaintRef }
  samplerId: string
  decodeId: string
  saveId: string
  denoise?: number
}

/**
 * Decorates the existing six-preset img2img chain without changing loaders, LoRAs or sampling.
 * ComfyUI nodes.py: LoadImageMask(red) is not inverted; SetLatentNoiseMask sets noise_mask.
 * comfy_extras/nodes_mask.py: composite = generated * mask + destination * (1 - mask).
 * The final composite is essential: latent masking alone does not preserve decoded pixels.
 * https://github.com/comfyanonymous/ComfyUI/blob/master/nodes.py
 * https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_mask.py
 */
export function inpaintGraph(input: InpaintGraphInput, info: InpaintNodeInfo) {
  assertInpaintNodes(info)
  matching(input.source, input.mask)
  const denoise = input.denoise ?? 0.65
  if (typeof denoise !== 'number' || !Number.isFinite(denoise) || denoise < 0.1 || denoise > 1) throw new HttpError(400, 'Denoise must be a finite number from 0.1 to 1')
  const graph = structuredClone(input.graph)
  const ref = (value: unknown, kind: string) => {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || value[1] !== 0 || graph[value[0]]?.class_type !== kind) throw new HttpError(400, `Inpainting needs a server-built ${kind} output reference`)
    return value as [string, number]
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const samplerRef = ref([input.samplerId, 0], 'KSampler')
  const decodeRef = ref([input.decodeId, 0], 'VAEDecode')
  ref([input.saveId, 0], 'SaveImage')
  ref(input.source.image, 'LoadImage')
  const maskRef = ref(input.mask.mask, 'LoadImageMask')
  if (graph[maskRef[0]].inputs.channel !== 'red') throw new HttpError(400, 'Inpainting must load the mask red channel, never alpha')
  const sampler = graph[input.samplerId], decode = graph[input.decodeId], save = graph[input.saveId]
  const latent = ref(sampler.inputs.latent_image, 'VAEEncode')
  const encode = graph[latent[0]]
  const pixels = ref(encode.inputs.pixels, 'ImageScale')
  const scale = graph[pixels[0]].inputs
  if (!same(scale.image, input.source.image) || scale.upscale_method !== 'lanczos' || scale.crop !== 'center') throw new HttpError(400, 'Inpainting source must use the server-owned Lanczos/center resize')
  const { width, height } = scale
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256 || width > 1536 || height > 1536 || width % 64 || height % 64 || width * height > 1536 * 1024) throw new HttpError(400, 'Inpainting working dimensions must use the generation size bounds')
  if (!same(decode.inputs.samples, samplerRef) || !same(decode.inputs.vae, encode.inputs.vae) || !same(save.inputs.images, decodeRef)) throw new HttpError(400, 'Inpainting requires the matching sampler, VAE decoder and save chain')
  const add = (suffix: string, class_type: string, inputs: Record<string, unknown>): [string, number] => {
    const id = `inpaint_${suffix}`
    if (Object.hasOwn(graph, id)) throw new HttpError(400, 'Inpainting graph already contains reserved nodes')
    graph[id] = { class_type, inputs }
    return [id, 0]
  }
  const maskPixels = add('pixels', 'MaskToImage', { mask: maskRef })
  // Identical geometry AND filter. No implicit mask stretch inside the sampler/composite.
  const resized = add('resize', 'ImageScale', { ...scale, image: maskPixels })
  const workingMask = add('mask', 'ImageToMask', { image: resized, channel: 'red' })
  sampler.inputs.latent_image = add('latent', 'SetLatentNoiseMask', { samples: latent, mask: workingMask })
  sampler.inputs.denoise = denoise
  const images = add('composite', 'ImageCompositeMasked', { destination: pixels, source: decodeRef, mask: workingMask, x: 0, y: 0, resize_source: false })
  save.inputs.images = images
  // Optional/custom versions may add mandatory inputs. Refuse these before any upload.
  for (const id of [...Object.keys(graph).filter(id => id.startsWith('inpaint_')), maskRef[0]]) {
    const node = graph[id], schema = info[node.class_type]?.input
    for (const field of Object.keys(schema?.required ?? {})) if (!(field in node.inputs)) throw new HttpError(409, `${node.class_type} requires unsupported input ${field}`)
    for (const field of Object.keys(node.inputs)) if (!(field in (schema?.required ?? {})) && !(field in (schema?.optional ?? {}))) throw new HttpError(409, `${node.class_type} does not support input ${field}`)
  }
  return { graph, width, height, denoise, workingMask, images }
}
