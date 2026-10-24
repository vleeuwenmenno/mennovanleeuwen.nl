import { HttpError } from './http.ts'
import { imagePresetSpec, IMAGE_SAMPLERS, IMAGE_SCHEDULERS, type ImagePreset, type ImageSampling, type HiresSettings } from '../src/data/imageModels.ts'
import type { ImageGraph, ImageGraphProgress } from './agentImageUpscale.ts'

export type RefineInput = { scale?: unknown; width?: unknown; height?: unknown; denoise?: unknown; upscale_model?: unknown; steps?: unknown; cfg?: unknown; sampler?: unknown; scheduler?: unknown }
export function refinementSize(source: { width: number; height: number }, input: RefineInput) {
  if (input.scale !== undefined && (input.width !== undefined || input.height !== undefined)) throw new HttpError(400, 'Choose refinement scale or dimensions, not both')
  const round = (v: number) => Math.max(256, Math.round(v / 64) * 64)
  const dimension = (v: unknown) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 256 || v > 2048 || v % 64) throw new HttpError(400, 'Refinement dimensions must be multiples of 64 from 256 to 2048'); return v }
  let width: number, height: number
  if (input.width !== undefined || input.height !== undefined) {
    width = input.width === undefined ? round(dimension(input.height) * source.width / source.height) : dimension(input.width)
    height = input.height === undefined ? round(width * source.height / source.width) : dimension(input.height)
  } else {
    const scale = input.scale ?? 1.5
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 1 || scale > 2) throw new HttpError(400, 'Refinement scale must be from 1 to 2')
    width = round(source.width * scale); height = round(source.height * scale)
  }
  dimension(width); dimension(height)
  if (width * height > 4_194_304) throw new HttpError(400, 'Refinement output must not exceed 4 megapixels')
  return { width, height }
}
export function refinementSampling(input: RefineInput, defaults: ImageSampling, preset: ImagePreset) {
  const sampling = { steps: input.steps ?? defaults.steps, cfg: input.cfg ?? defaults.cfg, sampler: input.sampler ?? defaults.sampler, scheduler: input.scheduler ?? defaults.scheduler }
  if (typeof sampling.steps !== 'number' || !Number.isInteger(sampling.steps) || sampling.steps < 1 || sampling.steps > 80) throw new HttpError(400, 'Refinement steps must be from 1 to 80')
  if (typeof sampling.cfg !== 'number' || !Number.isFinite(sampling.cfg) || sampling.cfg < 0 || sampling.cfg > 20) throw new HttpError(400, 'Refinement CFG must be from 0 to 20')
  if (!imagePresetSpec(preset).negative && sampling.cfg !== 1) throw new HttpError(400, 'Turbo refinement requires CFG 1')
  if (!IMAGE_SAMPLERS.includes(sampling.sampler as never) || !IMAGE_SCHEDULERS.includes(sampling.scheduler as never)) throw new HttpError(400, 'Choose a supported refinement sampler and scheduler')
  const denoise = input.denoise ?? 0.2
  if (typeof denoise !== 'number' || !Number.isFinite(denoise) || denoise < 0.1 || denoise > 1) throw new HttpError(400, 'Refinement denoise must be from 0.1 to 1')
  if (input.upscale_model !== undefined && (typeof input.upscale_model !== 'string' || !input.upscale_model || input.upscale_model.length > 2048 || /[\x00-\x1f]/.test(input.upscale_model))) throw new HttpError(400, 'Choose an installed refinement upscale_model or omit it')
  return { ...(sampling as ImageSampling), denoise, ...(input.upscale_model ? { upscale_model: input.upscale_model as string } : {}) }
}
/** A second image-space pass shares the exact first-stage components and conditioning. */
export function addHiresStage(graph: ImageGraph, value: unknown, base: { width: number; height: number; seed: number; sampling: ImageSampling }, preset: ImagePreset): { settings: HiresSettings; progress: ImageGraphProgress } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'hires must be an object')
  const input = value as RefineInput
  if (Object.keys(input).some(k => !['scale', 'width', 'height', 'denoise', 'upscale_model', 'steps', 'cfg', 'sampler', 'scheduler'].includes(k))) throw new HttpError(400, 'Only supported hires size, strength, upscale model and sampling fields are accepted')
  const settings: HiresSettings = { base_width: base.width, base_height: base.height, ...refinementSize(base, input), ...refinementSampling(input, base.sampling, preset), seed: base.seed }
  const add = (id: string, class_type: string, inputs: Record<string, unknown>) => { graph[id] = { class_type, inputs }; return [id, 0] }
  let pixels: (string | number)[] = ['8', 0]
  if (settings.upscale_model) pixels = add('hiresUpscale', 'ImageUpscaleWithModel', { image: pixels, upscale_model: add('hiresModel', 'UpscaleModelLoader', { model_name: settings.upscale_model }) })
  pixels = add('hiresSize', 'ImageScale', { image: pixels, upscale_method: 'lanczos', width: settings.width, height: settings.height, crop: 'center' })
  const vae = graph['8'].inputs.vae
  const latent = add('hiresEncode', 'VAEEncode', { pixels, vae })
  const sampled = add('hiresSampler', 'KSampler', { ...graph['7'].inputs, latent_image: latent, seed: settings.seed, steps: settings.steps, cfg: settings.cfg, sampler_name: settings.sampler, scheduler: settings.scheduler, denoise: settings.denoise })
  const decoded = add('hiresDecode', 'VAEDecode', { samples: sampled, vae })
  graph['9'].inputs.images = decoded
  return { settings, progress: { phases: { '1': 'loading', '2': 'loading', '3': 'loading', '4': 'encoding', '5': 'encoding', '6': 'encoding', '7': 'sampling', '8': 'decoding', '9': 'saving', hiresModel: 'loading', hiresUpscale: 'upscaling', hiresSize: 'refining', hiresEncode: 'encoding', hiresSampler: 'refining', hiresDecode: 'decoding' }, counters: { '7': 'sampling', hiresUpscale: 'upscaling', hiresSampler: 'refining' } } }
}
