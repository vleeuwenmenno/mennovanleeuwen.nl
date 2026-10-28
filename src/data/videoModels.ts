// The two video models the Video Studio drives on the account's own ComfyUI, and their hard rules:
// how many frames a duration becomes, which sizes they take, and the size tiers and aspect ratios
// the editor offers. Ported from Diffu's video parameters and resolution rules. Shared by the
// browser (the editor) and the server (server/agentVideo.ts checks everything again), so no DOM or
// Node APIs here.
//
// MiniMax H3 (the fl2va weights): 5–15 s at 24 fps, the frame count rounded up to 17k + 5 (5 s is
// 124 frames, 5.17 s), sizes in steps of 32. It takes a first and a last frame. LTX 2.5 Distilled:
// whole seconds 1–15, seconds × 24 + 1 frames, sizes in steps of 64 from 128 to 2048 (its first
// stage runs at half size), a first frame only.

export type VideoFamily = 'minimax_h3' | 'ltx25'
export const VIDEO_FAMILIES: readonly VideoFamily[] = ['minimax_h3', 'ltx25']
export const FAMILY_LABEL: Record<VideoFamily, string> = { minimax_h3: 'MiniMax H3', ltx25: 'LTX 2.5 Distilled' }
export const VIDEO_FPS = 24

/** What each family takes: duration range (and whether it must be whole seconds), the size grid, keyframes. */
export const FAMILY_RULES: Record<VideoFamily, { minSeconds: number; maxSeconds: number; wholeSeconds: boolean; step: number; minSide: number; maxSide: number; lastFrame: boolean }> = {
  minimax_h3: { minSeconds: 5, maxSeconds: 15, wholeSeconds: false, step: 32, minSide: 32, maxSide: 16384, lastFrame: true },
  ltx25: { minSeconds: 1, maxSeconds: 15, wholeSeconds: true, step: 64, minSide: 128, maxSide: 2048, lastFrame: false },
}

/** H3's frame count for a duration: rounded up to 17k + 5. Throws outside 5–15 s. */
export function h3FrameCount(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 15) throw new Error('MiniMax H3 videos are 5 to 15 seconds long.')
  const requested = Math.round(seconds * VIDEO_FPS)
  return requested + ((5 - (requested % 17) + 17) % 17)
}

/** LTX's frame count: seconds × 24 + 1, whole seconds 1–15. */
export function ltxFrameCount(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 15) throw new Error('LTX 2.5 videos are a whole number of seconds, 1 to 15.')
  return seconds * VIDEO_FPS + 1
}

export const videoFrameCount = (family: VideoFamily, seconds: number) => (family === 'ltx25' ? ltxFrameCount(seconds) : h3FrameCount(seconds))

/** How long the clip really is: H3 rounds its frames up, so 10 s plays 10.58 s. */
export const effectiveSeconds = (family: VideoFamily, seconds: number) => videoFrameCount(family, seconds) / VIDEO_FPS

/** A duration the family accepts, nearest to `seconds` (whole seconds for LTX, 0.25 s steps for H3). */
export function snapDuration(family: VideoFamily, seconds: number): number {
  const r = FAMILY_RULES[family]
  const v = Number.isFinite(seconds) ? seconds : r.minSeconds
  const stepped = r.wholeSeconds ? Math.round(v) : Math.round(v * 4) / 4
  return Math.min(r.maxSeconds, Math.max(r.minSeconds, stepped))
}

/** Why a duration or size is refused for a family, or null. */
export function videoParameterProblem(family: VideoFamily, seconds: number, width: number, height: number): string | null {
  const r = FAMILY_RULES[family]
  try {
    videoFrameCount(family, seconds)
  } catch (e) {
    return (e as Error).message
  }
  if (![width, height].every((n) => Number.isInteger(n) && n >= r.minSide && n <= r.maxSide && n % r.step === 0)) return `${FAMILY_LABEL[family]} sizes are multiples of ${r.step}, from ${r.minSide} to ${r.maxSide} pixels.`
  return null
}

export const VIDEO_ASPECT_RATIOS = [
  { label: '21:9', value: 21 / 9 },
  { label: '16:9', value: 16 / 9 },
  { label: '3:2', value: 3 / 2 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '3:4', value: 3 / 4 },
  { label: '2:3', value: 2 / 3 },
  { label: '9:16', value: 9 / 16 },
] as const

/** Named by the short side. 768p is H3's native size (1344 × 768 at 16:9). */
export const VIDEO_SIZE_TIERS = [
  { label: '360p', shortSide: 360 },
  { label: '480p', shortSide: 480 },
  { label: '576p', shortSide: 576 },
  { label: '720p', shortSide: 720 },
  { label: '768p', shortSide: 768 },
  { label: '1080p', shortSide: 1080 },
] as const

const snap = (value: number, step: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value / step) * step))

/** Width and height for an aspect ratio at a short side, on the family's grid (MiniMax's own sizes come out: 1344 × 768, 832 × 480). */
export function videoSizeFor(ratio: number, shortSide: number, family: VideoFamily) {
  const { step, minSide: min, maxSide: max } = FAMILY_RULES[family]
  const longSide = shortSide * Math.max(ratio, 1 / ratio)
  const scale = Math.min(1, max / longSide)
  const short = snap(shortSide * scale, step, min, max)
  const long = Math.min(max, Math.max(min, Math.floor((short * Math.max(ratio, 1 / ratio)) / step) * step))
  return ratio >= 1 ? { width: long, height: short } : { width: short, height: long }
}

/** A size snapped onto the family's grid and limits (switching family keeps the shape). */
export function snapVideoSize(width: number, height: number, family: VideoFamily) {
  const { step, minSide: min, maxSide: max } = FAMILY_RULES[family]
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: snap(width * scale, step, min, max), height: snap(height * scale, step, min, max) }
}

/** The named ratio within 3% of width/height, if any. */
export function videoAspectLabel(width: number, height: number): string | null {
  const ratio = width / height
  return VIDEO_ASPECT_RATIOS.find((a) => Math.abs(a.value / ratio - 1) < 0.03)?.label ?? null
}

/** The size tier whose short side matches (within half a grid step), if any. */
export function videoSizeTier(width: number, height: number, family: VideoFamily): string | null {
  const short = Math.min(width, height)
  return VIDEO_SIZE_TIERS.find((t) => Math.abs(t.shortSide - short) <= FAMILY_RULES[family].step / 2)?.label ?? null
}

// --- the ComfyUI side -----------------------------------------------------------------------------

/** The nodes each family's graph uses (server/agentVideoGraphs.ts), for the capability check. */
export const H3_NODES = ['MiniMaxH3ImageToVideo', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoaderModelOnly', 'RandomNoise', 'BasicGuider', 'KSamplerSelect', 'BasicScheduler', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo', 'LoadImage', 'ImageScale'] as const
export const LTX_NODES = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'LTXVConditioning', 'LTXVDualCFGGuider', 'EmptyLTXVLatentVideo', 'LoadImage', 'ImageScale', 'LTXVPreprocess', 'LTXVImgToVideoInplace', 'LTXVEmptyLatentAudio', 'LTXVConcatAVLatent', 'RandomNoise', 'KSamplerSelect', 'ManualSigmas', 'SamplerCustomAdvanced', 'LTXVSeparateAVLatent', 'LatentUpscaleModelLoader', 'LTXVLatentUpsampler', 'VAEDecodeTiled', 'LTXVAudioVAEDecode', 'CreateVideo', 'SaveVideo'] as const
export const VIDEO_NODES = [...new Set<string>([...H3_NODES, ...LTX_NODES])]

/** The model files a family needs, picked in Settings → Image & Video Studio (empty: picked by name from what is installed). */
export type VideoModelChoice = { model: string; clip: string; videoVae: string; audioVae: string; turboLora: string; latentUpscaler: string }
export type VideoModelSettings = Record<VideoFamily, VideoModelChoice>
export const emptyVideoModels = (): VideoModelSettings => ({
  minimax_h3: { model: '', clip: '', videoVae: '', audioVae: '', turboLora: '', latentUpscaler: '' },
  ltx25: { model: '', clip: '', videoVae: '', audioVae: '', turboLora: '', latentUpscaler: '' },
})

/** What ComfyUI has for video (GET /api/video/catalog). */
export type VideoCatalog = {
  families: Record<VideoFamily, { ok: boolean; error: string }>
  models: string[]
  clips: string[]
  vaes: string[]
  loras: string[]
  latentUpscalers: string[]
  samplers: string[]
  schedulers: string[]
}

const looks = (family: VideoFamily, name: string) => (family === 'ltx25' ? /ltx/i.test(name) : /(minimax|\bh3\b|[_-]h3[_.-]|fl2va|hailuo)/i.test(name))
/**
 * The files a family runs with: the account's own picks where they are installed, else the
 * first installed file whose name says the family (and "audio" for the audio VAE).
 */
export function resolveVideoModels(family: VideoFamily, chosen: VideoModelChoice, catalog: Pick<VideoCatalog, 'models' | 'clips' | 'vaes' | 'loras' | 'latentUpscalers'>): VideoModelChoice {
  const pick = (picked: string, list: string[], test: (n: string) => boolean) => (picked && list.includes(picked) ? picked : list.find(test) ?? '')
  const audio = (n: string) => /audio/i.test(n)
  return {
    model: pick(chosen.model, catalog.models, (n) => looks(family, n) && (family !== 'ltx25' || /distill/i.test(n))),
    clip: pick(chosen.clip, catalog.clips, (n) => looks(family, n) || (family === 'ltx25' ? /gemma/i.test(n) : false)),
    videoVae: pick(chosen.videoVae, catalog.vaes, (n) => looks(family, n) && !audio(n)),
    audioVae: pick(chosen.audioVae, catalog.vaes, (n) => looks(family, n) && audio(n)),
    turboLora: family === 'ltx25' ? '' : pick(chosen.turboLora, catalog.loras, (n) => looks(family, n) && /turbo/i.test(n)),
    latentUpscaler: family === 'ltx25' ? pick(chosen.latentUpscaler, catalog.latentUpscalers, (n) => looks(family, n)) : '',
  }
}

/** What is still missing to render with a family, by name, or null. */
export function missingVideoModels(family: VideoFamily, m: VideoModelChoice): string | null {
  const need: [keyof VideoModelChoice, string][] = [['model', 'video model'], ['clip', 'text encoder'], ['videoVae', 'video VAE'], ['audioVae', 'audio VAE'], ...(family === 'ltx25' ? [['latentUpscaler', 'latent upscaler'] as [keyof VideoModelChoice, string]] : [])]
  const gone = need.filter(([k]) => !m[k]).map(([, label]) => label)
  return gone.length ? `Pick the ${FAMILY_LABEL[family]} ${gone.join(', ')} in Settings → Image & Video Studio → Video.` : null
}

/** H3's sampling: its own sampler and schedule, 20 steps (8 with the Turbo LoRA). */
export const H3_SAMPLING = { sampler: 'res_multistep', scheduler: 'simple', steps: 20, turboSteps: 8, turboStrength: 1 }

/** A render job's progress, as the Studio shows it. */
export type VideoJobStatus = 'queued' | 'uploading' | 'running' | 'saving' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export const JOB_ACTIVE: readonly VideoJobStatus[] = ['queued', 'uploading', 'running', 'saving']
