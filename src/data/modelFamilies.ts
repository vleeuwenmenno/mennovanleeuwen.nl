// Model families: the usual sampling recipe per base model, how A1111/Civitai sampler names map to
// ComfyUI's KSampler names, and the consensus of a model page's example images. Pure data and
// maths, shared by the server (server/agentModelIntel.ts) and the UI (the model browser).
//
// Precedence, highest first: what the user asks for, then the Civitai example consensus, then these
// family defaults. A family default is a starting point, not a verdict on a file.

import type { ImagePreset } from './imageModels.ts'

export type FamilyId = 'illustrious' | 'noobai' | 'noobai_vpred' | 'pony' | 'sdxl' | 'sd15' | 'krea2_turbo' | 'krea2_raw' | 'krea2' | 'z_image_turbo' | 'z_image' | 'flux' | 'anima' | 'minimax_h3'
export type FamilyDefaults = {
  id: FamilyId
  label: string
  /** The app preset that runs it, or null when this app has no workflow for it. */
  preset: ImagePreset | null
  supported: boolean
  sampler: string
  scheduler: string
  /** Another common choice, as "sampler/scheduler". */
  alternative?: string
  steps: number
  stepsRange: [number, number]
  cfg: number
  cfgRange: [number, number]
  clipSkip: number
  width: number
  height: number
  notes: string
}

const f = (d: FamilyDefaults) => d
/** Keyed by family id. Sizes are base-generation pixels within this app's limits. */
export const MODEL_FAMILIES: Record<FamilyId, FamilyDefaults> = {
  illustrious: f({ id: 'illustrious', label: 'Illustrious', preset: 'sdxl', supported: true, sampler: 'euler_ancestral', scheduler: 'normal', alternative: 'dpmpp_2m/karras', steps: 26, stepsRange: [20, 28], cfg: 5, cfgRange: [4, 6], clipSkip: 2, width: 832, height: 1216, notes: 'Danbooru tags; quality openers like masterpiece, best quality, newest. No Pony score tags.' }),
  noobai: f({ id: 'noobai', label: 'NoobAI', preset: 'sdxl', supported: true, sampler: 'euler_ancestral', scheduler: 'normal', alternative: 'dpmpp_2m/karras', steps: 26, stepsRange: [20, 28], cfg: 5, cfgRange: [4, 6], clipSkip: 2, width: 832, height: 1216, notes: 'Illustrious-based; Danbooru tags. Check for a v-prediction build.' }),
  noobai_vpred: f({ id: 'noobai_vpred', label: 'NoobAI v-pred', preset: 'sdxl', supported: true, sampler: 'euler', scheduler: 'normal', steps: 28, stepsRange: [24, 40], cfg: 4.5, cfgRange: [3.5, 5.5], clipSkip: 2, width: 832, height: 1216, notes: 'V-prediction model: it needs ModelSamplingDiscrete v_prediction with zsnr, or it renders garbage. Plain Euler, not ancestral, works best.' }),
  pony: f({ id: 'pony', label: 'Pony', preset: 'sdxl', supported: true, sampler: 'euler_ancestral', scheduler: 'normal', alternative: 'dpmpp_2m/karras', steps: 25, stepsRange: [20, 30], cfg: 7, cfgRange: [6, 8.5], clipSkip: 2, width: 832, height: 1216, notes: 'Needs score tags at the start: score_9, score_8_up, score_7_up. Source tags (source_anime, source_cartoon) steer style.' }),
  sdxl: f({ id: 'sdxl', label: 'SDXL', preset: 'sdxl', supported: true, sampler: 'dpmpp_2m', scheduler: 'karras', alternative: 'euler_ancestral/normal', steps: 28, stepsRange: [25, 35], cfg: 6, cfgRange: [5, 8], clipSkip: 1, width: 1024, height: 1024, notes: 'Comma-separated tags or short sentences; about 1 megapixel.' }),
  sd15: f({ id: 'sd15', label: 'SD 1.5', preset: 'sd15', supported: true, sampler: 'dpmpp_2m', scheduler: 'karras', alternative: 'euler_ancestral/normal', steps: 25, stepsRange: [20, 30], cfg: 7, cfgRange: [6, 9], clipSkip: 1, width: 512, height: 768, notes: 'Keep important tags early. Anime mixes usually want clip skip 2. Embeddings can matter.' }),
  krea2_turbo: f({ id: 'krea2_turbo', label: 'Krea 2 Turbo', preset: 'krea2_turbo', supported: true, sampler: 'euler_ancestral', scheduler: 'beta', steps: 8, stepsRange: [6, 10], cfg: 1, cfgRange: [1, 1], clipSkip: 1, width: 1024, height: 1024, notes: 'Natural-language prompt, positive only, CFG 1.' }),
  krea2_raw: f({ id: 'krea2_raw', label: 'Krea 2 Raw', preset: 'krea2_raw', supported: true, sampler: 'euler', scheduler: 'simple', steps: 52, stepsRange: [40, 60], cfg: 3.5, cfgRange: [3, 4.5], clipSkip: 1, width: 1024, height: 1024, notes: 'Natural-language prompt; negatives supported.' }),
  krea2: f({ id: 'krea2', label: 'Krea 2', preset: null, supported: true, sampler: 'euler_ancestral', scheduler: 'beta', steps: 8, stepsRange: [6, 52], cfg: 1, cfgRange: [1, 3.5], clipSkip: 1, width: 1024, height: 1024, notes: 'Raw or turbo is not in the name or metadata: the preset decides (Krea2 Turbo 8 steps CFG 1, Krea2 Raw 52 steps CFG 3.5).' }),
  z_image_turbo: f({ id: 'z_image_turbo', label: 'Z-Image Turbo', preset: 'z_image_turbo', supported: true, sampler: 'euler', scheduler: 'simple', steps: 8, stepsRange: [6, 10], cfg: 1, cfgRange: [1, 1], clipSkip: 1, width: 1024, height: 1024, notes: 'Few steps, CFG 1, positive prompt only.' }),
  z_image: f({ id: 'z_image', label: 'Z-Image', preset: 'z_image', supported: true, sampler: 'euler', scheduler: 'simple', steps: 20, stepsRange: [20, 30], cfg: 4, cfgRange: [3, 5], clipSkip: 1, width: 1024, height: 1024, notes: 'Rich natural-language prompts.' }),
  flux: f({ id: 'flux', label: 'Flux', preset: null, supported: false, sampler: 'euler', scheduler: 'simple', steps: 20, stepsRange: [20, 30], cfg: 1, cfgRange: [1, 1], clipSkip: 1, width: 1024, height: 1024, notes: 'Not a supported preset in this app (Flux uses its own guidance node).' }),
  anima: f({ id: 'anima', label: 'Anima', preset: null, supported: false, sampler: 'euler', scheduler: 'simple', steps: 30, stepsRange: [20, 40], cfg: 4, cfgRange: [3, 5], clipSkip: 1, width: 1024, height: 1024, notes: 'Not a supported preset in this app: Anima needs its own workflow.' }),
  minimax_h3: f({ id: 'minimax_h3', label: 'MiniMax H3', preset: null, supported: false, sampler: 'euler', scheduler: 'simple', steps: 30, stepsRange: [20, 40], cfg: 4, cfgRange: [3, 5], clipSkip: 1, width: 1024, height: 1024, notes: 'Not a supported preset in this app: MiniMax H3 is a video/audio family.' }),
}

const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
/** V-prediction in a name, tag or version name ("vpred", "v-pred", "v_pred", "v-prediction"). */
// A lower-case v must start a word ("noob_vpred", "v-pred"); an upper-case V may start a camel-case
// part ("NoobVpred", "vPred"). "devPred" or "preview" do not count.
export const VPRED = /(?:(?:^|[^a-zA-Z])[vV]|V)[-_ ]?[pP]red(?:iction)?(?![a-z])/
export function isVpred(...texts: (string | undefined | null)[]) {
  return texts.some((t) => !!t && VPRED.test(t))
}

/**
 * The family of a base model (LoRA Manager's base_model or Civitai's baseModel), refined by the
 * file name, tags and LoRA Manager auto tags: Krea 2 turbo/raw, Z-Image turbo, NoobAI v-pred.
 */
export function familyOf(baseModel: string, hints: { name?: string; tags?: string[]; vpred?: boolean } = {}): FamilyId | null {
  const b = key(baseModel)
  const words = [hints.name ?? '', ...(hints.tags ?? [])].join(' ')
  const w = key(words)
  if (!b) return null
  if (b.startsWith('illustrious')) return hints.vpred ? 'noobai_vpred' : 'illustrious'
  if (b.startsWith('noobai')) return hints.vpred || b.includes('vpred') ? 'noobai_vpred' : 'noobai'
  if (b.startsWith('pony')) return 'pony'
  if (b.startsWith('sdxl') || b === 'sdxl10' || b.includes('sdxllightning') || b.includes('sdxlturbo')) return 'sdxl'
  if (b.startsWith('sd15') || b.startsWith('sd1') || b === 'sd14') return 'sd15'
  if (b.startsWith('krea2') || b === 'krea') return w.includes('turbo') ? 'krea2_turbo' : key(hints.name ?? '').includes('raw') ? 'krea2_raw' : 'krea2'
  if (b.startsWith('zimageturbo')) return 'z_image_turbo'
  if (b.startsWith('zimage')) return w.includes('turbo') || /(?:^|[\W_])zit/i.test(hints.name ?? '') ? 'z_image_turbo' : 'z_image'
  if (b.startsWith('flux')) return 'flux'
  if (b.startsWith('anima')) return 'anima'
  if (b.startsWith('minimax')) return 'minimax_h3'
  return null
}

// --- A1111 / Civitai sampler names to ComfyUI ---------------------------------------------------

/** ComfyUI KSampler sampler names this mapping can produce. */
const COMFY_SAMPLERS = new Set(['euler', 'euler_ancestral', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ipndm', 'deis', 'ddim', 'uni_pc', 'uni_pc_bh2', 'euler_cfg_pp', 'euler_ancestral_cfg_pp', 'res_multistep'])
const COMFY_SCHEDULERS = new Set(['simple', 'sgm_uniform', 'karras', 'exponential', 'ddim_uniform', 'beta', 'normal', 'linear_quadratic', 'kl_optimal'])
const A1111_SAMPLERS: Record<string, string> = {
  'euler a': 'euler_ancestral', 'euler ancestral': 'euler_ancestral', euler: 'euler', heun: 'heun', lms: 'lms',
  dpm2: 'dpm_2', 'dpm2 a': 'dpm_2_ancestral', 'dpm++ 2s a': 'dpmpp_2s_ancestral', 'dpm++ 2m': 'dpmpp_2m', 'dpm++ sde': 'dpmpp_sde',
  'dpm++ 2m sde': 'dpmpp_2m_sde', 'dpm++ 2m sde gpu': 'dpmpp_2m_sde_gpu', 'dpm++ 3m sde': 'dpmpp_3m_sde', 'dpm fast': 'dpm_fast', 'dpm adaptive': 'dpm_adaptive',
  ddim: 'ddim', ddpm: 'ddpm', unipc: 'uni_pc', 'uni pc': 'uni_pc', lcm: 'lcm', deis: 'deis', ipndm: 'ipndm',
}
const A1111_SCHEDULES: Record<string, string> = { karras: 'karras', exponential: 'exponential', 'sgm uniform': 'sgm_uniform', simple: 'simple', normal: 'normal', beta: 'beta', 'ddim uniform': 'ddim_uniform', 'kl optimal': 'kl_optimal', 'linear quadratic': 'linear_quadratic' }
/** Schedule suffixes a combined A1111 name can carry ("DPM++ 2M Karras"), longest first. */
const SUFFIXES = Object.keys(A1111_SCHEDULES).sort((a, b) => b.length - a.length)

export type SamplerMapping = { rawSampler: string; rawSchedule: string; sampler: string | null; scheduler: string | null }
/**
 * Maps an A1111 sampler (and optional separate "Schedule type") to ComfyUI names, without checking
 * what is installed. Combined names split off their schedule; ComfyUI names pass through. A missing
 * or "Automatic" schedule maps to null: unspecified, not wrong. An unknown name maps to null.
 */
export function mapA1111Sampler(sampler: unknown, schedule?: unknown): SamplerMapping {
  const rawSampler = typeof sampler === 'string' ? sampler.trim().slice(0, 60) : ''
  const rawSchedule = typeof schedule === 'string' ? schedule.trim().slice(0, 40) : ''
  let name = rawSampler.toLowerCase().replace(/\s+/g, ' ')
  let scheduler: string | null = null
  if (COMFY_SAMPLERS.has(name)) return { rawSampler, rawSchedule, sampler: name, scheduler: mapSchedule(rawSchedule) }
  // ComfyUI-style combined names, like dpmpp_2m_karras.
  const underscored = /^(.*)_(karras|exponential|sgm_uniform|simple|normal|beta)$/.exec(name)
  if (underscored && COMFY_SAMPLERS.has(underscored[1])) return { rawSampler, rawSchedule, sampler: underscored[1], scheduler: underscored[2] }
  for (const suffix of SUFFIXES) {
    if (name.endsWith(` ${suffix}`) && A1111_SAMPLERS[name.slice(0, -suffix.length - 1)]) { scheduler = A1111_SCHEDULES[suffix]; name = name.slice(0, -suffix.length - 1); break }
  }
  const mapped = A1111_SAMPLERS[name] ?? null
  return { rawSampler, rawSchedule, sampler: mapped, scheduler: mapSchedule(rawSchedule) ?? scheduler }
}
function mapSchedule(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[_\s]+/g, ' ').trim()
  if (!s || s === 'automatic') return null
  if (COMFY_SCHEDULERS.has(s.replace(/ /g, '_'))) return s.replace(/ /g, '_')
  return A1111_SCHEDULES[s] ?? null
}
/** Whether a schedule was named but could not be mapped (as opposed to left unspecified). */
export const scheduleUnmapped = (m: SamplerMapping) => !!m.rawSchedule && m.rawSchedule.toLowerCase() !== 'automatic' && !m.scheduler

// --- the example images' consensus ------------------------------------------------------------

export type ExampleMeta = { sampler?: unknown; 'Schedule type'?: unknown; steps?: unknown; cfgScale?: unknown; clipSkip?: unknown; Size?: unknown; [k: string]: unknown }
export type Consensus = {
  /** Example images that carried generation settings, of all images. */
  images: number
  total: number
  /** The most common sampler + schedule pair. `comfy` only when both are installed and supported here. */
  sampler: { raw: string; schedule: string; agree: number; comfy: { sampler: string; scheduler: string | null } | null; unmapped?: string } | null
  steps: number | null
  cfg: number | null
  clipSkip: number | null
  sizes: { size: string; count: number }[]
}
export const median = (values: number[]) => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const num = (v: unknown, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}
/**
 * The example images' settings in agreement: the most common sampler/schedule pair (counted after
 * mapping, so "DPM++ 2M Karras" and "DPM++ 2M" + "Karras" agree), and the median steps, CFG and clip
 * skip. `installed` limits mapped names to what the backend and this app both run.
 */
export function exampleConsensus(metas: (ExampleMeta | null | undefined)[], installed?: { samplers?: readonly string[]; schedulers?: readonly string[] }): Consensus {
  const withMeta = metas.filter((m): m is ExampleMeta => !!m && typeof m === 'object' && (m.sampler !== undefined || m.steps !== undefined || m.cfgScale !== undefined))
  const pairs = new Map<string, { raw: string; schedule: string; mapping: SamplerMapping; count: number }>()
  for (const m of withMeta) {
    if (typeof m.sampler !== 'string' || !m.sampler.trim()) continue
    const mapping = mapA1111Sampler(m.sampler, m['Schedule type'])
    const id = mapping.sampler ? `${mapping.sampler}|${mapping.scheduler ?? ''}` : `raw:${mapping.rawSampler.toLowerCase()}|${mapping.rawSchedule.toLowerCase()}`
    const hit = pairs.get(id) ?? { raw: mapping.rawSampler, schedule: mapping.rawSchedule, mapping, count: 0 }
    hit.count++
    pairs.set(id, hit)
  }
  const top = [...pairs.values()].sort((a, b) => b.count - a.count)[0]
  let sampler: Consensus['sampler'] = null
  if (top) {
    const okSampler = top.mapping.sampler && (!installed?.samplers || installed.samplers.includes(top.mapping.sampler))
    const okScheduler = !top.mapping.scheduler || !installed?.schedulers || installed.schedulers.includes(top.mapping.scheduler)
    const unmapped = !top.mapping.sampler ? `sampler “${top.raw}” has no ComfyUI equivalent here` : !okSampler ? `${top.mapping.sampler} is not installed or not supported here` : scheduleUnmapped(top.mapping) ? `schedule “${top.schedule}” has no ComfyUI equivalent here` : !okScheduler ? `${top.mapping.scheduler} is not installed or not supported here` : undefined
    sampler = { raw: top.raw, schedule: top.schedule, agree: top.count, comfy: okSampler && top.mapping.sampler ? { sampler: top.mapping.sampler, scheduler: okScheduler && !scheduleUnmapped(top.mapping) ? top.mapping.scheduler : null } : null, ...(unmapped ? { unmapped } : {}) }
  }
  const sizes = new Map<string, number>()
  for (const m of withMeta) {
    const s = typeof m.Size === 'string' ? /^(\d{2,4})\s*x\s*(\d{2,4})$/i.exec(m.Size.trim()) : null
    if (s) sizes.set(`${s[1]}x${s[2]}`, (sizes.get(`${s[1]}x${s[2]}`) ?? 0) + 1)
  }
  const values = (k: keyof ExampleMeta, min: number, max: number) => withMeta.map((m) => num(m[k], min, max)).filter((v): v is number => v !== null)
  return {
    images: withMeta.length, total: metas.length, sampler,
    steps: median(values('steps', 1, 150)), cfg: median(values('cfgScale', 0, 30)), clipSkip: median(values('clipSkip', 1, 12)),
    sizes: [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([size, count]) => ({ size, count })),
  }
}

/** The recommended block a model_details result carries, and the UI shows. */
export type Recommended = {
  preset: ImagePreset | null
  sampler: string
  scheduler: string
  steps: number
  cfg: number
  clip_skip: number
  width: number
  height: number
  source: 'civitai_examples' | 'family_default' | 'user_saved' | 'none'
  agree?: string
  v_prediction?: boolean
  notes?: string
}
/** One line: "dpmpp_2m/karras · 20 steps · CFG 5 · clip skip 2 · 832 × 1216". */
export const recommendedLine = (r: Pick<Recommended, 'sampler' | 'scheduler' | 'steps' | 'cfg' | 'clip_skip' | 'width' | 'height'>) => `${r.sampler}/${r.scheduler} · ${r.steps} steps · CFG ${r.cfg} · clip skip ${r.clip_skip} · ${r.width} × ${r.height}`
export const recommendedSourceLabel = (r: Pick<Recommended, 'source' | 'agree'>) => r.source === 'civitai_examples' ? `Civitai examples${r.agree ? ` (${r.agree} agree)` : ''}` : r.source === 'family_default' ? 'Family default' : r.source === 'user_saved' ? 'Your saved settings' : 'No recommendation'
