import { deflateSync, inflateSync } from 'node:zlib'
import { HttpError } from './http.ts'

// Server-owned graphs for automatic masks (make_image_mask) and LaMa object removal
// (generate_image operation "remove"). The agent supplies words and numbers only, never nodes.
// Both rely on optional custom nodes from ComfyUI-RMBG (SAM3Segment or SAM2Segment,
// AILab_LamaRemover), so they are discovered from /object_info and switched off cleanly when a
// backend lacks them.

export type SegmentGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
export type SegmentNodeInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>

/**
 * Text-prompted segmenters, best first. SAM3 understands the words itself; SAM2 needs
 * GroundingDINO, whose Python package breaks with newer transformers releases, so it is the
 * fallback (also at run time, when the first one fails).
 */
export const SEGMENTERS = ['SAM3Segment', 'SAM2Segment'] as const
export type Segmenter = (typeof SEGMENTERS)[number]
const MASK_NODES = ['LoadImage', 'GrowMask', 'MaskComposite', 'MaskToImage', 'SaveImage'] as const
export const AUTO_MASK_NODES = [...MASK_NODES, ...SEGMENTERS] as const
export const REMOVE_NODES = ['LoadImage', 'LoadImageMask', 'AILab_LamaRemover', 'SaveImage'] as const
/** Coverage above this is reported as a probable over-selection. */
export const MASK_TOO_LARGE = 0.6
/** LaMa runs at the source's full resolution; keep its memory use within reason. */
export const REMOVE_MAX_SIDE = 4096

/** The choices offered for a combo input, in either of ComfyUI's two schema shapes. */
export function comboOptions(info: SegmentNodeInfo, node: string, field: string): string[] {
  const schema = info[node]?.input?.required?.[field] ?? info[node]?.input?.optional?.[field]
  const first = schema?.[0]
  const values = Array.isArray(first) ? first : first === 'COMBO' ? (schema?.[1] as { options?: unknown } | undefined)?.options : undefined
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : []
}

/** The segmenters this backend has, best first. */
export const segmenters = (info: SegmentNodeInfo): Segmenter[] => SEGMENTERS.filter((n) => info[n])

/** Why this backend cannot run a capability, or '' when it can. */
export function missingNodes(info: SegmentNodeInfo, nodes: readonly string[]) {
  const segmenting = nodes.some((n) => (SEGMENTERS as readonly string[]).includes(n))
  const absent = nodes.filter((n) => !info[n] && !(SEGMENTERS as readonly string[]).includes(n))
  if (segmenting && !segmenters(info).length) absent.push('SAM3Segment or SAM2Segment')
  return absent.length ? `ComfyUI is missing ${absent.join(', ')}${absent.some((n) => /SAM|Lama/.test(n)) ? ' (install the ComfyUI-RMBG custom nodes)' : ''}` : ''
}

/** Every node's inputs must match its live schema: no missing required input, no unknown one. */
function assertGraph(graph: SegmentGraph, info: SegmentNodeInfo) {
  for (const node of Object.values(graph)) {
    const schema = info[node.class_type]?.input
    if (!schema) throw new HttpError(409, `ComfyUI is missing ${node.class_type}`)
    for (const field of Object.keys(schema.required ?? {})) if (!(field in node.inputs)) throw new HttpError(409, `${node.class_type} requires unsupported input ${field}`)
    for (const field of Object.keys(node.inputs)) if (!(field in (schema.required ?? {})) && !(field in (schema.optional ?? {}))) throw new HttpError(409, `${node.class_type} does not support input ${field}`)
  }
}

/** Several things can be named at once, comma separated ("cyclist, bicycle"): each is one segmenter concept. */
export const MAX_PHRASES = 4
const phrases = (value: unknown, name: string, required: boolean): string[] => {
  if (value === undefined && !required) return []
  const bad = () => new HttpError(400, `${name} must be ${required ? '1' : '0'}–${MAX_PHRASES} comma-separated phrases of plain text, each up to 80 characters, like "cyclist, bicycle"`)
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || value.length > 400) throw bad()
  const list = value.split(',').map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean)
  if ((required && !list.length) || list.length > MAX_PHRASES || list.some((p) => p.length > 80)) throw bad()
  return [...new Set(list)]
}
export type AutoMaskInput = { source_image_id?: unknown; target?: unknown; exclude?: unknown; grow?: unknown; threshold?: unknown; hand_off?: unknown }
/** `threshold` null: each segmenter's own sensible default. */
export type AutoMaskOptions = { target: string[]; exclude: string[]; grow: number; threshold: number | null; handOff: boolean }
export function autoMaskOptions(input: AutoMaskInput): AutoMaskOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['source_image_id', 'target', 'exclude', 'grow', 'threshold', 'hand_off'].includes(k))) throw new HttpError(400, 'Supply source_image_id, target and optional exclude, grow, threshold and hand_off; graphs and models are not tool options')
  const target = phrases(input.target, 'target', true), exclude = phrases(input.exclude, 'exclude', false)
  const grow = input.grow ?? 12, threshold = input.threshold ?? null
  if (typeof grow !== 'number' || !Number.isInteger(grow) || grow < 0 || grow > 64) throw new HttpError(400, 'grow must be a whole number of pixels from 0 to 64')
  if (threshold !== null && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.95)) throw new HttpError(400, 'threshold must be from 0.05 to 0.95; lower finds more')
  if (input.hand_off !== undefined && typeof input.hand_off !== 'boolean') throw new HttpError(400, 'hand_off must be true or false')
  return { target, exclude, grow, threshold: threshold as number | null, handOff: input.hand_off === true }
}

/** One segmenter's inputs for `prompt`. Optional inputs get explicit neutral values: these nodes read them all. */
function segmentInputs(node: Segmenter, info: SegmentNodeInfo, prompt: string, threshold: number | null) {
  const pick = (field: string, preferred: string[]) => {
    const options = comboOptions(info, node, field)
    const chosen = preferred.find((p) => options.includes(p)) ?? options[0]
    if (!chosen) throw new HttpError(409, `${node} offers no ${field}`)
    return chosen
  }
  const schema = { ...info[node].input?.required, ...info[node].input?.optional }
  // unload_model: each node in a graph is its own instance with its own copy of the model, so with
  // several phrases they would pile up in VRAM (seen: out of memory at three SAM3 nodes on 16 GB).
  // Unloading after each node keeps one at a time, and leaves the GPU free for the edit after it.
  const neutral: Record<string, unknown> = { mask_blur: 0, mask_offset: 0, invert_output: false, background: 'Alpha', background_color: '#222222', max_segments: 0, segment_pick: 0, unload_model: true }
  const inputs: Record<string, unknown> = { image: ['1', 0], prompt, ...Object.fromEntries(Object.entries(neutral).filter(([k]) => k in schema)) }
  if ('device' in schema) inputs.device = pick('device', ['Auto'])
  if (node === 'SAM3Segment') {
    inputs.output_mode = pick('output_mode', ['Merged'])
    inputs.confidence_threshold = threshold ?? 0.4
  } else {
    // Small balances speed and edges; then whatever this backend offers.
    inputs.sam2_model = pick('sam2_model', ['sam2.1_hiera_small', 'sam2.1_hiera_base_plus', 'sam2.1_hiera_tiny'])
    inputs.dino_model = pick('dino_model', ['GroundingDINO_SwinT_OGC (694MB)'])
    if ('threshold' in schema) inputs.threshold = threshold ?? 0.3
  }
  return inputs
}

/**
 * LoadImage; the segmenter once per target phrase, unioned (MaskComposite add), grown; the same
 * for the exclude phrases, grown further than the target so no ring is left around what stays,
 * and subtracted; then MaskToImage → SaveImage. Each phrase's raw selection is saved too, so the
 * result can say what every phrase caught. Node IDs and shape depend only on the phrase counts.
 */
export function autoMaskGraph(options: AutoMaskOptions, uploadName: string, info: SegmentNodeInfo, segmenter = segmenters(info)[0]) {
  const missing = missingNodes(info, AUTO_MASK_NODES)
  if (missing) throw new HttpError(409, missing)
  if (!segmenter || !info[segmenter]) throw new HttpError(409, `ComfyUI is missing ${segmenter ?? 'a segmenter'}`)
  const operations = comboOptions(info, 'MaskComposite', 'operation')
  if (!operations.includes('subtract') || !operations.includes('add')) throw new HttpError(409, 'MaskComposite does not offer add and subtract')
  if (!options.target.length || options.target.length > MAX_PHRASES || options.exclude.length > MAX_PHRASES) throw new HttpError(400, `Use 1–${MAX_PHRASES} target phrases and at most ${MAX_PHRASES} exclude phrases`)
  const growSchema = { ...info.GrowMask.input?.required, ...info.GrowMask.input?.optional }
  const grow = (mask: [string, number], expand: number) => ({ mask, expand, ...('tapered_corners' in growSchema ? { tapered_corners: true } : {}) })
  const graph: SegmentGraph = { 1: { class_type: 'LoadImage', inputs: { image: uploadName } } }
  const parts: { phrase: string; role: 'target' | 'exclude'; output: string }[] = []
  /** Segment every phrase of one role and union them; `key` prefixes the node IDs (t or x). */
  const union = (list: string[], key: 't' | 'x'): [string, number] => {
    let mask: [string, number] | null = null
    list.forEach((phrase, i) => {
      const id = `${key}${i + 1}`
      graph[id] = { class_type: segmenter, inputs: segmentInputs(segmenter, info, phrase, options.threshold) }
      graph[`${id}_image`] = { class_type: 'MaskToImage', inputs: { mask: [id, 1] } }
      graph[`${id}_save`] = { class_type: 'SaveImage', inputs: { images: [`${id}_image`, 0], filename_prefix: 'agents/mask-part' } }
      parts.push({ phrase, role: key === 't' ? 'target' : 'exclude', output: `${id}_save` })
      if (mask) { graph[`${key}u${i + 1}`] = { class_type: 'MaskComposite', inputs: { destination: mask, source: [id, 1], x: 0, y: 0, operation: 'add' } }; mask = [`${key}u${i + 1}`, 0] }
      else mask = [id, 1]
    })
    return mask!
  }
  graph.grow = { class_type: 'GrowMask', inputs: grow(union(options.target, 't'), options.grow) }
  let mask: [string, number] = ['grow', 0]
  if (options.exclude.length) {
    graph.xgrow = { class_type: 'GrowMask', inputs: grow(union(options.exclude, 'x'), options.grow + 4) }
    graph.subtract = { class_type: 'MaskComposite', inputs: { destination: mask, source: ['xgrow', 0], x: 0, y: 0, operation: 'subtract' } }
    mask = ['subtract', 0]
  }
  graph.image = { class_type: 'MaskToImage', inputs: { mask } }
  graph.save = { class_type: 'SaveImage', inputs: { images: ['image', 0], filename_prefix: 'agents/mask' } }
  assertGraph(graph, info)
  return { graph, outputNode: 'save', parts, segmenter }
}

/** LaMa fills the white mask area from its surroundings at the source's full size; no prompt, no sampler. */
export function removeGraph(sourceName: string, maskName: string, info: SegmentNodeInfo) {
  const missing = missingNodes(info, REMOVE_NODES)
  if (missing) throw new HttpError(409, missing)
  if (!comboOptions(info, 'LoadImageMask', 'channel').includes('red')) throw new HttpError(409, 'LoadImageMask must offer the red channel')
  const graph: SegmentGraph = {
    20: { class_type: 'LoadImage', inputs: { image: sourceName } },
    22: { class_type: 'LoadImageMask', inputs: { image: maskName, channel: 'red' } },
    30: { class_type: 'AILab_LamaRemover', inputs: { images: ['20', 0], masks: ['22', 0], removal_strength: 230, edge_smoothness: 8 } },
    9: { class_type: 'SaveImage', inputs: { images: ['30', 0], filename_prefix: 'agents/removed' } },
  }
  assertGraph(graph, info)
  return { graph, outputNode: '9' }
}

/** Decode a non-interlaced 8-bit PNG (gray, RGB, gray+alpha or RGBA) to its first channel. */
export function pngFirstChannel(bytes: Buffer) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new HttpError(502, 'ComfyUI did not return a PNG mask')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], type = bytes[25], interlace = bytes[28]
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[type]
  if (depth !== 8 || !channels || interlace !== 0 || !width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) throw new HttpError(502, 'ComfyUI returned an unsupported mask PNG')
  const parts: Buffer[] = []
  for (let at = 8; at + 12 <= bytes.length; at += bytes.readUInt32BE(at) + 12) if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + bytes.readUInt32BE(at)))
  const stride = width * channels, length = (stride + 1) * height
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(parts), { maxOutputLength: length }) } catch { throw new HttpError(502, 'ComfyUI returned unreadable mask pixels') }
  if (raw.length !== length) throw new HttpError(502, 'ComfyUI returned a truncated mask')
  const out = Buffer.alloc(width * height)
  let previous = Buffer.alloc(stride), current = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1), filter = raw[offset]
    if (filter > 4) throw new HttpError(502, 'ComfyUI returned an invalid mask filter')
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      current[x] = (raw[offset + 1 + x] + prediction) & 255
    }
    for (let x = 0; x < width; x++) out[y * width + x] = current[x * channels]
    ;[previous, current] = [current, previous]
  }
  return { width, height, values: out }
}

function crc(data: Buffer) {
  let c = 0xffffffff
  for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0) }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(kind: string, body: Buffer) {
  const payload = Buffer.concat([Buffer.from(kind, 'ascii'), body]), head = Buffer.alloc(4), tail = Buffer.alloc(4)
  head.writeUInt32BE(body.length); tail.writeUInt32BE(crc(payload))
  return Buffer.concat([head, payload, tail])
}
/** The stored mask format: opaque 8-bit RGB, white edits and black preserves, no metadata. Half grey and up is white. */
export function binaryMaskPng(width: number, height: number, values: Uint8Array) {
  const stride = width * 3 + 1, raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (values[y * width + x] >= 128) raw.fill(255, y * stride + 1 + x * 3, y * stride + 4 + x * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
