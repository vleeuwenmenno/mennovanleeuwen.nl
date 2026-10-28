import type { ImageProgress } from '../src/data/imageModels.ts'
import { H3_SAMPLING, ltxFrameCount, h3FrameCount, VIDEO_FPS, type VideoFamily, type VideoModelChoice } from '../src/data/videoModels.ts'
import type { ImageGraphProgress } from './agentImageUpscale.ts'

// The Video Studio's two fixed ComfyUI graphs, ported from Diffu: MiniMax H3 (fl2va: first and
// last frame, sound made with the picture) and LTX 2.5 Distilled (two stages: eight steps at half
// size, a 2× latent upscale, three refining steps; first frame only). Nothing in a graph comes from
// the browser as a graph: the server builds it from checked settings, and every keyframe is an
// owned picture uploaded under a random name, scaled and centre-cropped to the clip's size by
// ImageScale (the browser usually sends it at that size already, cropped where the person chose).
// `videoGraphProblem` checks a graph against the node schemas ComfyUI reports, like Diffu does.

export type VideoNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }
export type VideoGraph = Record<string, VideoNode>
export type VideoRender = {
  family: VideoFamily
  models: VideoModelChoice
  prompt: string
  width: number
  height: number
  /** Seconds as asked for; the frame count follows the family's rule. */
  duration: number
  seed: number
  steps: number
  turbo: boolean
  turboStrength: number
  turboSteps: number
}
export type BuiltVideo = { graph: VideoGraph; outputNode: string; frames: number; progress: ImageGraphProgress; steps: number }

const builder = (graph: VideoGraph) => (id: string, class_type: string, inputs: Record<string, unknown>, title: string): [string, number] => {
  graph[id] = { class_type, inputs, _meta: { title } }
  return [id, 0]
}

export function buildVideoGraph(r: VideoRender, frames: { first?: string; last?: string }): BuiltVideo {
  return r.family === 'ltx25' ? ltxGraph(r, frames) : h3Graph(r, frames)
}

function h3Graph(r: VideoRender, frames: { first?: string; last?: string }): BuiltVideo {
  const graph: VideoGraph = {}
  const add = builder(graph)
  let model = add('model', 'UNETLoader', { unet_name: r.models.model, weight_dtype: 'default' }, 'Loading video model')
  if (r.turbo) model = add('turbo', 'LoraLoaderModelOnly', { model, lora_name: r.models.turboLora, strength_model: r.turboStrength }, 'Applying Turbo LoRA')
  const clip = add('clip', 'CLIPLoader', { clip_name: r.models.clip, type: 'minimax', device: 'default' }, 'Loading text encoder')
  const vae = add('video_vae', 'VAELoader', { vae_name: r.models.videoVae }, 'Loading video VAE')
  const audioVae = add('audio_vae', 'VAELoader', { vae_name: r.models.audioVae }, 'Loading audio VAE')
  const length = h3FrameCount(r.duration)
  const conditioning = add('conditioning', 'MiniMaxH3ImageToVideo', { clip, vae, prompt: r.prompt, width: r.width, height: r.height, length }, 'Encoding video prompt')
  for (const [slot, name] of [['first_frame', frames.first], ['last_frame', frames.last]] as const) {
    if (!name) continue
    const loaded = add(`${slot}_load`, 'LoadImage', { image: name }, `Loading ${slot.replace('_', ' ')}`)
    graph.conditioning.inputs[slot] = add(`${slot}_fit`, 'ImageScale', { image: loaded, upscale_method: 'lanczos', width: r.width, height: r.height, crop: 'center' }, `Fitting ${slot.replace('_', ' ')}`)
  }
  const steps = r.turbo ? r.turboSteps : r.steps
  const noise = add('noise', 'RandomNoise', { noise_seed: r.seed }, 'Preparing noise')
  const guider = add('guider', 'BasicGuider', { model, conditioning }, 'Preparing guidance')
  const sampler = add('sampler', 'KSamplerSelect', { sampler_name: H3_SAMPLING.sampler }, 'Preparing sampler')
  const sigmas = add('schedule', 'BasicScheduler', { model, scheduler: H3_SAMPLING.scheduler, steps, denoise: 1 }, 'Preparing schedule')
  const samples = add('sample', 'SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image: ['conditioning', 1] }, 'Generating video and audio')
  const images = add('decode_video', 'VAEDecode', { samples, vae }, 'Decoding video')
  const audio = add('decode_audio', 'VAEDecodeAudio', { samples, vae: audioVae }, 'Decoding audio')
  const video = add('video', 'CreateVideo', { images, audio, fps: VIDEO_FPS }, 'Combining video and audio')
  add('save', 'SaveVideo', { video, filename_prefix: 'video/MvL_H3', format: 'mp4', codec: 'h264' }, 'Saving video')
  const phases: Record<string, ImageProgress['phase']> = { model: 'loading', turbo: 'loading', clip: 'loading', video_vae: 'loading', audio_vae: 'loading', conditioning: 'encoding', sample: 'sampling', decode_video: 'decoding', decode_audio: 'decoding', video: 'saving', save: 'saving' }
  return { graph, outputNode: 'save', frames: length, steps, progress: { phases, counters: { sample: 'sampling' } } }
}

function ltxGraph(r: VideoRender, frames: { first?: string; last?: string }): BuiltVideo {
  if (frames.last) throw new Error('LTX 2.5 does not take a last frame here. Remove it, or switch to MiniMax H3.')
  const graph: VideoGraph = {}
  const add = builder(graph)
  const length = ltxFrameCount(r.duration)
  const model = add('model', 'UNETLoader', { unet_name: r.models.model, weight_dtype: 'default' }, 'Loading LTX 2.5 Distilled')
  const clip = add('clip', 'CLIPLoader', { clip_name: r.models.clip, type: 'ltxv', device: 'default' }, 'Loading LTX text encoder')
  const vae = add('video_vae', 'VAELoader', { vae_name: r.models.videoVae }, 'Loading video VAE')
  const audioVae = add('audio_vae', 'VAELoader', { vae_name: r.models.audioVae }, 'Loading audio VAE')
  const positive = add('positive', 'CLIPTextEncode', { text: r.prompt, clip }, 'Encoding prompt')
  // The reference recipe's fixed negative (CFG 1: it only shapes the conditioning template).
  const negative = add('negative', 'CLIPTextEncode', { text: 'pc game, console game, video game, cartoon, childish, ugly', clip }, 'Encoding template conditioning')
  const conditioning = add('conditioning', 'LTXVConditioning', { frame_rate: VIDEO_FPS, positive, negative }, 'Conditioning video and audio')
  const guider = add('guider', 'LTXVDualCFGGuider', { video_cfg: 1, audio_cfg: 1, model, positive: conditioning, negative: ['conditioning', 1] }, 'Preparing distilled guidance')
  let latent = add('latent', 'EmptyLTXVLatentVideo', { width: r.width / 2, height: r.height / 2, length, batch_size: 1 }, 'Preparing half-resolution video')
  let image: [string, number] | undefined
  if (frames.first) {
    const loaded = add('first_frame_load', 'LoadImage', { image: frames.first }, 'Loading first frame')
    const fitted = add('first_frame_fit', 'ImageScale', { image: loaded, upscale_method: 'lanczos', width: r.width, height: r.height, crop: 'center' }, 'Fitting first frame')
    image = add('preprocess', 'LTXVPreprocess', { img_compression: 18, image: fitted }, 'Preparing image conditioning')
    latent = add('image_stage1', 'LTXVImgToVideoInplace', { strength: 0.7, bypass: false, vae, image, latent }, 'Conditioning first frame')
  }
  const audioLatent = add('audio_latent', 'LTXVEmptyLatentAudio', { frames_number: length, frame_rate: VIDEO_FPS, batch_size: 1, audio_vae: audioVae }, 'Preparing audio')
  const av = add('av_stage1', 'LTXVConcatAVLatent', { video_latent: latent, audio_latent: audioLatent }, 'Combining video and audio latents')
  const noise = add('noise', 'RandomNoise', { noise_seed: r.seed }, 'Preparing noise')
  const sampler = add('sampler', 'KSamplerSelect', { sampler_name: 'euler_ancestral' }, 'Preparing sampler')
  const sigmas = add('sigmas_stage1', 'ManualSigmas', { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' }, 'Preparing 8-step schedule')
  const sampled = add('sample_stage1', 'SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image: av }, 'Generating video and audio · 8 steps')
  const split = add('split_stage1', 'LTXVSeparateAVLatent', { av_latent: sampled }, 'Separating first-stage latents')
  const upscaler = add('upscaler', 'LatentUpscaleModelLoader', { model_name: r.models.latentUpscaler }, 'Loading latent upscaler')
  let upscaled = add('upscale', 'LTXVLatentUpsampler', { samples: split, upscale_model: upscaler, vae }, 'Upscaling video latents 2×')
  if (image) upscaled = add('image_stage2', 'LTXVImgToVideoInplace', { strength: 1, bypass: false, vae, image, latent: upscaled }, 'Restoring first-frame conditioning')
  const refinedAv = add('av_stage2', 'LTXVConcatAVLatent', { video_latent: upscaled, audio_latent: ['split_stage1', 1] }, 'Preparing refinement')
  // The reference recipe refines with a fixed seed, apart from the first stage's.
  const refineNoise = add('refine_noise', 'RandomNoise', { noise_seed: 42 }, 'Preparing refinement noise')
  const refineSigmas = add('sigmas_stage2', 'ManualSigmas', { sigmas: '0.85, 0.7250, 0.4219, 0.0' }, 'Preparing 3-step refinement')
  const refined = add('sample_stage2', 'SamplerCustomAdvanced', { noise: refineNoise, guider, sampler, sigmas: refineSigmas, latent_image: refinedAv }, 'Refining video and audio · 3 steps')
  const final = add('split_final', 'LTXVSeparateAVLatent', { av_latent: refined }, 'Separating final video and audio')
  const images = add('decode_video', 'VAEDecodeTiled', { tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16, samples: final, vae }, 'Decoding video')
  const audio = add('decode_audio', 'LTXVAudioVAEDecode', { samples: ['split_final', 1], audio_vae: audioVae }, 'Decoding audio')
  const video = add('video', 'CreateVideo', { images, audio, fps: VIDEO_FPS }, 'Combining video and audio')
  add('save', 'SaveVideo', { video, filename_prefix: 'video/MvL_LTX25', format: 'mp4', codec: 'h264' }, 'Saving video')
  const phases: Record<string, ImageProgress['phase']> = { model: 'loading', clip: 'loading', video_vae: 'loading', audio_vae: 'loading', upscaler: 'loading', positive: 'encoding', negative: 'encoding', conditioning: 'encoding', preprocess: 'encoding', image_stage1: 'encoding', sample_stage1: 'sampling', upscale: 'upscaling', image_stage2: 'upscaling', sample_stage2: 'refining', decode_video: 'decoding', decode_audio: 'decoding', video: 'saving', save: 'saving' }
  return { graph, outputNode: 'save', frames: length, steps: 8, progress: { phases, counters: { sample_stage1: 'sampling', sample_stage2: 'refining' } } }
}

// --- checking a graph against what ComfyUI says its nodes take ----------------------------------

/**
 * Inputs that moved between ComfyUI versions, set the way this ComfyUI reports its nodes:
 * SaveVideo's codec is a plain `codec` dropdown, or sits inside the V3 dynamic `format` dropdown
 * as `format.codec`; newer CreateVideo nodes also take a bit depth and colour space.
 */
export function fitVideoNodes(graph: VideoGraph, schemas: Record<string, VideoNodeSchema> | undefined) {
  const inputs = (name: string) => ({ ...(schemas?.[name]?.input?.required ?? {}), ...(schemas?.[name]?.input?.optional ?? {}) })
  for (const node of Object.values(graph)) {
    if (node.class_type === 'SaveVideo') {
      const format = inputs('SaveVideo').format
      if (Array.isArray(format) && format[0] === 'COMFY_DYNAMICCOMBO_V3' && 'codec' in node.inputs) {
        const { codec, ...rest } = node.inputs
        node.inputs = { ...rest, 'format.codec': codec }
      }
    }
    if (node.class_type === 'CreateVideo') {
      const spec = inputs('CreateVideo')
      if (spec.bit_depth && node.inputs.bit_depth === undefined) node.inputs.bit_depth = 8
      if (Array.isArray(spec.color_space) && node.inputs.color_space === undefined) {
        const choices = nodeChoices(schemas?.CreateVideo, 'color_space')
        node.inputs.color_space = choices.find((c) => /srgb/i.test(c)) ?? choices[0] ?? 'sRGB'
      }
    }
  }
}

type Spec = unknown[]
export type VideoNodeSchema = { input?: { required?: Record<string, Spec>; optional?: Record<string, Spec> }; output?: string[]; api_node?: boolean }
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** A dropdown's choices, from the old (`[[...]]`) and the V3 (`['COMBO', { options }]`) schema shapes. */
export function nodeChoices(schema: VideoNodeSchema | undefined, input: string): string[] {
  const spec = schema?.input?.required?.[input] ?? schema?.input?.optional?.[input]
  if (!Array.isArray(spec)) return []
  const choices = Array.isArray(spec[0]) ? spec[0] : record(spec[1]).options
  return Array.isArray(choices) ? choices.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Why ComfyUI cannot run this graph, or null: a node missing (or only the paid API version of
 * it), a required input the graph does not set, a dropdown value that is not installed, a number
 * out of range, or a link to an output of the wrong type.
 */
export function videoGraphProblem(graph: VideoGraph, schemas: Record<string, VideoNodeSchema> | undefined): string | null {
  if (!schemas) return 'Refresh the ComfyUI models to check video support.'
  if (Object.values(graph).some((n) => n.class_type === 'MiniMaxH3ImageToVideo')) {
    const native = schemas.MiniMaxH3ImageToVideo
    if (!native || native.api_node || native.output?.[0] !== 'CONDITIONING' || native.output?.[1] !== 'LATENT') return 'ComfyUI needs the native MiniMax H3 node (MiniMaxH3ImageToVideo with CONDITIONING and LATENT outputs), not the API node.'
  }
  for (const node of Object.values(graph)) {
    const schema = schemas[node.class_type]
    if (schema?.api_node) return `ComfyUI needs the native ${node.class_type} node, not the API node.`
    if (!schema?.input) return `ComfyUI is missing the ${node.class_type} node, which this video model needs.`
    // V3 dynamic dropdowns (SaveVideo's format) carry their own inputs, named "<field>.<input>".
    const check = (groups: VideoNodeSchema['input'], prefix = ''): string | null => {
      for (const group of ['required', 'optional'] as const) {
        for (const [key, spec] of Object.entries(groups?.[group] ?? {})) {
          if (!Array.isArray(spec)) continue
          const field = prefix + key
          const value = node.inputs[field]
          if (value === undefined) {
            if (group === 'required') return `${node.class_type} needs an input this graph does not set (${field}): its ComfyUI version may be newer than this recipe.`
            continue
          }
          if (Array.isArray(value)) {
            const source = graph[String(value[0])]
            const outputs = source && schemas[source.class_type]?.output
            if (!source || !outputs || !Number.isInteger(value[1]) || !outputs[value[1] as number]) return `${node.class_type}: ${field} is linked to an output that does not exist.`
            if (typeof spec[0] === 'string' && spec[0] !== '*' && !spec[0].split(',').includes(outputs[value[1] as number])) return `${node.class_type}: ${field} needs ${spec[0]}, but gets ${outputs[value[1] as number]}.`
            continue
          }
          if (node.class_type === 'LoadImage' && key === 'image') continue
          const config = record(spec[1])
          const choices = Array.isArray(spec[0]) ? spec[0] : config.options
          if (Array.isArray(choices)) {
            if (spec[0] === 'COMFY_DYNAMICCOMBO_V3') {
              const picked = choices.map(record).find((o) => o.key === value)
              if (!picked) return `${node.class_type}: ${field} "${String(value).slice(0, 80)}" is not offered.`
              const inner = check(record(picked.inputs) as VideoNodeSchema['input'], `${field}.`)
              if (inner) return inner
            } else if (!choices.includes(value)) return `${node.class_type}: ${field} "${String(value).slice(0, 80)}" is not installed or not offered.`
          }
          if (typeof value === 'number' && (!Number.isFinite(value) || (typeof config.min === 'number' && value < config.min) || (typeof config.max === 'number' && value > config.max))) return `${node.class_type}: ${field} is outside the range it takes.`
        }
      }
      return null
    }
    const problem = check(schema.input)
    if (problem) return problem
    if (node.class_type === 'MiniMaxH3ImageToVideo') for (const slot of ['first_frame', 'last_frame']) {
      if (node.inputs[slot] && !schema.input.optional?.[slot] && !schema.input.required?.[slot]) return `This ComfyUI's MiniMax H3 node does not take a ${slot.replace('_', ' ')}.`
    }
  }
  return null
}
