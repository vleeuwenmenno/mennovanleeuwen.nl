import { HttpError } from './http.ts'
import type { ImageProgress } from '../src/data/imageModels.ts'

export type ImageGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
export type ImageGraphProgress = { phases: Record<string, ImageProgress['phase']>; counters: Record<string, 'sampling' | 'upscaling' | 'refining'> }
export type NodeInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>
export const UPSCALE_NODES = ['LoadImage', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'ImageScale', 'SaveImage'] as const
export const UPSCALE_RESOURCE_NOTE = 'The model runs at its native scale before the final resize. Its intermediate image can be larger than the requested output; these limits do not guarantee available GPU or system memory. Sources above 2048 pixels per side are rejected; resize a copy explicitly before using this operation.'

export function nodeOptions(info: NodeInfo, node: string, field: string): string[] {
  const definition = info[node]?.input?.required?.[field] ?? info[node]?.input?.optional?.[field]
  const list = Array.isArray(definition?.[0]) ? definition[0] : (definition?.[1] as { options?: unknown } | undefined)?.options
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 2000) : []
}

/** Validate the actual graph against installed schemas before any upload or GPU submission. */
export function validateUpscaleGraph(graph: ImageGraph, info: NodeInfo) {
  for (const node of Object.values(graph)) {
    const schema = info[node.class_type]?.input
    if (!schema?.required) throw new HttpError(409, `ComfyUI needs ${node.class_type} with its input schema for model upscaling`)
    for (const [key, definition] of Object.entries({ ...schema.optional, ...schema.required })) {
      if (!Array.isArray(definition)) throw new HttpError(409, `Invalid ${node.class_type} input schema`)
      const value = node.inputs[key]
      if (value === undefined) {
        if (Object.hasOwn(schema.required, key)) throw new HttpError(409, `${node.class_type} requires unsupported input ${key}`)
        continue
      }
      if (Array.isArray(value)) continue
      // This random name is uploaded after preflight, so it cannot be in the current file list.
      if (node.class_type === 'LoadImage' && key === 'image') continue
      const options = nodeOptions(info, node.class_type, key)
      const config = definition[1] as { min?: number; max?: number } | undefined
      if ((Array.isArray(definition[0]) || definition[0] === 'COMBO') && !options.includes(String(value))) throw new HttpError(409, `${node.class_type}: ${key} is unavailable`)
      if (typeof value === 'number' && (!Number.isFinite(value) || typeof config?.min === 'number' && value < config.min || typeof config?.max === 'number' && value > config.max)) throw new HttpError(409, `${node.class_type}: ${key} is outside the installed range`)
    }
    for (const key of Object.keys(node.inputs)) if (!(key in schema.required) && !(key in (schema.optional ?? {}))) throw new HttpError(409, `${node.class_type} does not support input ${key}`)
  }
}

export function upscaleDimensions(source: { width: number; height: number }, input: { scale?: unknown; width?: unknown; height?: unknown }) {
  if (input.scale !== undefined && (input.width !== undefined || input.height !== undefined)) throw new HttpError(400, 'Choose scale or output dimensions, not both')
  let width: number, height: number
  if (input.width !== undefined || input.height !== undefined) {
    const dim = (v: unknown) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4096) throw new HttpError(400, 'Upscale dimensions must be integers from 1 to 4096'); return v }
    width = input.width === undefined ? Math.round(dim(input.height) * source.width / source.height) : dim(input.width)
    height = input.height === undefined ? Math.round(width * source.height / source.width) : dim(input.height)
    if (Math.abs(height - width * source.height / source.width) > 1 && Math.abs(width - height * source.width / source.height) > 1) throw new HttpError(400, 'Upscaling preserves the source aspect ratio; supply one dimension or matching dimensions')
  } else {
    const scale = input.scale ?? 2
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 1 || scale > 4) throw new HttpError(400, 'Upscale factor must be greater than 1 and at most 4')
    width = Math.round(source.width * scale); height = Math.round(source.height * scale)
  }
  if (width > 4096 || height > 4096 || width * height > 16_777_216) throw new HttpError(400, 'Upscale output must not exceed 4096 pixels per side or 16 megapixels')
  if (width < source.width || height < source.height || width === source.width && height === source.height || width > source.width * 4 + 1 || height > source.height * 4 + 1) throw new HttpError(400, 'Upscale output must enlarge the source by at most 4×')
  return { width, height }
}

export function upscaleWorkflow(source: { width: number; height: number }, input: { upscale_model?: unknown; scale?: unknown; width?: unknown; height?: unknown }, sourceName: string) {
  if (typeof input.upscale_model !== 'string' || !input.upscale_model || input.upscale_model.length > 2048 || /[\x00-\x1f]/.test(input.upscale_model)) throw new HttpError(400, 'Choose an installed upscale_model from list_image_models')
  const { width, height } = upscaleDimensions(source, input)
  if (source.width > 2048 || source.height > 2048) throw new HttpError(400, 'Model upscaling accepts sources up to 2048 pixels per side. Resize a copy explicitly first; the original is never silently downsampled.')
  const input_width = source.width, input_height = source.height
  const graph: ImageGraph = {
    source: { class_type: 'LoadImage', inputs: { image: sourceName } },
    model: { class_type: 'UpscaleModelLoader', inputs: { model_name: input.upscale_model } },
    upscale: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['model', 0], image: ['source', 0] } },
    size: { class_type: 'ImageScale', inputs: { image: ['upscale', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' } },
    output: { class_type: 'SaveImage', inputs: { images: ['size', 0], filename_prefix: 'agents/upscaled' } },
  }
  const progress: ImageGraphProgress = { phases: { source: 'loading', model: 'loading', upscale: 'upscaling', size: 'upscaling', output: 'saving' }, counters: { upscale: 'upscaling' } }
  return { graph, width, height, input_width, input_height, outputNode: 'output', progress }
}
