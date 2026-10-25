// The Image Studio's form (src/apps/AgentsStudio.tsx), as plain data: its defaults, how a saved copy
// is read back, the recipe a model brings, what keeps Generate disabled, and the request a press
// sends to /api/agents/images/studio/run (server/agentImageStudio.ts). No React and no browser, so
// scripts/agents-image-studio.ts checks the same functions the Studio runs.

import { applyPresetRules, isTurbo, presetFamily, presetRules, SIZE_LIMITS, type Recommended } from './modelFamilies.ts'
import { IMAGE_PRESETS, IMAGE_SAMPLERS, IMAGE_SCHEDULERS, imagePresetSpec, recommendedImageSampling, resolveImageAssets, type DiffusionImageSettings, type ImageAssetCatalog, type ImageGenerationSettings, type ImagePreset } from './imageModels.ts'

/** The live catalog as /api/agents/images/catalog sends it: the asset lists plus the node checks. */
export type StudioCatalog = ImageAssetCatalog & { nodes?: string[]; clipTypes?: string[]; img2img?: boolean }
export type StudioLora = { name: string; weight: number }
/** A textual-inversion embedding written into the prompt (`negative`: into the negative prompt). */
export type StudioEmbedding = { name: string; weight: number; negative: boolean }
export type StudioSource = { id: string; name: string; url: string; width: number; height: number }
export type StudioHires = { on: boolean; scale: number; denoise: number; steps: number; upscaleModel: string }
/** Where the sampling settings came from, shown on the family card. */
export type RecipeSource = { model: string; preset: ImagePreset; source: Recommended['source']; label: string }
export type StudioForm = {
  preset: ImagePreset
  /** Raw/turbo pairs: auto follows the file's name, else the choice. */
  variant: 'auto' | 'raw' | 'turbo'
  model: string
  clip: string
  vae: string
  /** A checkpoint's VAE swapped for an installed one; empty keeps the built-in VAE. */
  checkpointVae: string
  loras: StudioLora[]
  embeddings: StudioEmbedding[]
  prompt: string
  negative: string
  width: number
  height: number
  aspectLock: boolean
  batch: number
  /** -1 is a new random seed for every picture. */
  seed: number
  /** Keep the seed when settings are restored from a result. */
  seedLock: boolean
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  denoise: number
  clipSkip: number
  source: StudioSource | null
  hires: StudioHires
  /** Changed by hand since the last recipe: a new model then asks before replacing the settings. */
  edited: boolean
  recipe: RecipeSource | null
}

export const STUDIO_LIMITS = { steps: [1, 80], cfg: [0, 20], clipSkip: [1, 4], batch: [1, 8], denoise: [0.1, 1], loraWeight: [0, 2], embeddingWeight: [0, 2], hiresScale: [1, 2], seed: [-1, 2 ** 48 - 2], prompt: 6000, loras: 5 } as const
export const STEP_PRESETS = [10, 25, 40, 80] as const

export function defaultStudioForm(preset: ImagePreset = 'sdxl'): StudioForm {
  const spec = imagePresetSpec(preset), edge = presetRules(preset).edge
  return { preset, variant: 'auto', model: '', clip: '', vae: '', checkpointVae: '', loras: [], embeddings: [], prompt: '', negative: '', width: edge, height: edge, aspectLock: false, batch: 1, seed: -1, seedLock: false, steps: spec.steps, cfg: spec.cfg, sampler: spec.sampler, scheduler: spec.scheduler, denoise: 0.6, clipSkip: 1, source: null, hires: { on: false, scale: 1.5, denoise: 0.35, steps: 15, upscaleModel: '' }, edited: false, recipe: null }
}

const clamp = (v: unknown, [min, max]: readonly [number, number], fallback: number, step = 0) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  return step ? Math.round(n / step) * step : n
}
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const PRESETS = IMAGE_PRESETS.map((p) => p.id) as string[]
const sized = (v: unknown, fallback: number) => clamp(v, [SIZE_LIMITS.min, SIZE_LIMITS.max], fallback, SIZE_LIMITS.step)

/** A saved form (this browser's copy or the account's) as a usable one: anything odd takes its default. */
export function normalizeStudioForm(v: unknown): StudioForm {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const preset = (PRESETS.includes(o.preset as string) ? o.preset : 'sdxl') as ImagePreset
  const d = defaultStudioForm(preset)
  const list = <T,>(x: unknown, map: (i: Record<string, unknown>) => T | null, max: number) => (Array.isArray(x) ? x.flatMap((i) => (i && typeof i === 'object' ? [map(i as Record<string, unknown>)].filter((m): m is T => m !== null) : [])).slice(0, max) : [])
  const s = o.source as Record<string, unknown> | null
  const h = (o.hires && typeof o.hires === 'object' ? o.hires : {}) as Record<string, unknown>
  const r = o.recipe as Record<string, unknown> | null
  return {
    preset,
    variant: o.variant === 'raw' || o.variant === 'turbo' ? o.variant : 'auto',
    model: text(o.model, 2048), clip: text(o.clip, 2048), vae: text(o.vae, 2048), checkpointVae: text(o.checkpointVae, 2048),
    loras: list(o.loras, (i) => (typeof i.name === 'string' && i.name ? { name: i.name.slice(0, 2048), weight: clamp(i.weight, STUDIO_LIMITS.loraWeight, 1) } : null), STUDIO_LIMITS.loras),
    embeddings: list(o.embeddings, (i) => (typeof i.name === 'string' && i.name ? { name: i.name.slice(0, 1024), weight: clamp(i.weight, STUDIO_LIMITS.embeddingWeight, 1), negative: i.negative === true } : null), 20),
    prompt: text(o.prompt, STUDIO_LIMITS.prompt), negative: text(o.negative, STUDIO_LIMITS.prompt),
    width: sized(o.width, d.width), height: sized(o.height, d.height), aspectLock: o.aspectLock === true,
    batch: clamp(o.batch, STUDIO_LIMITS.batch, 1, 1), seed: clamp(o.seed, STUDIO_LIMITS.seed, -1, 1), seedLock: o.seedLock === true,
    steps: clamp(o.steps, STUDIO_LIMITS.steps, d.steps, 1), cfg: clamp(o.cfg, STUDIO_LIMITS.cfg, d.cfg), sampler: text(o.sampler, 60) || d.sampler, scheduler: text(o.scheduler, 60) || d.scheduler,
    denoise: clamp(o.denoise, STUDIO_LIMITS.denoise, d.denoise), clipSkip: clamp(o.clipSkip, STUDIO_LIMITS.clipSkip, 1, 1),
    source: s && typeof s === 'object' && typeof s.id === 'string' && typeof s.url === 'string' && s.url.startsWith('/api/agents/') ? { id: s.id, name: text(s.name, 200), url: s.url, width: clamp(s.width, [1, 8192], 1024, 1), height: clamp(s.height, [1, 8192], 1024, 1) } : null,
    hires: { on: h.on === true, scale: clamp(h.scale, STUDIO_LIMITS.hiresScale, 1.5), denoise: clamp(h.denoise, STUDIO_LIMITS.denoise, 0.35), steps: clamp(h.steps, STUDIO_LIMITS.steps, 15, 1), upscaleModel: text(h.upscaleModel, 2048) },
    edited: o.edited === true,
    recipe: r && typeof r === 'object' && typeof r.model === 'string' && PRESETS.includes(r.preset as string) ? { model: r.model, preset: r.preset as ImagePreset, source: (['civitai_examples', 'family_default', 'user_saved', 'none'].includes(r.source as string) ? r.source : 'none') as Recommended['source'], label: text(r.label, 200) } : null,
  }
}

/** The preset a raw/turbo variant choice runs: auto reads the model's name, else keeps the pair's current half. */
export function variantPreset(preset: ImagePreset, variant: StudioForm['variant'], model: string): ImagePreset {
  const pair = presetRules(preset).variants
  if (!pair) return preset
  if (variant === 'raw') return pair[0]
  if (variant === 'turbo') return pair[1]
  const name = model.toLowerCase()
  return name.includes('turbo') || /(?:^|[\W_])zit/i.test(model) ? pair[1] : name.includes('raw') ? pair[0] : preset
}

/** Sampler and scheduler options: what ComfyUI has and this app sends. */
export const studioSamplers = (catalog: StudioCatalog | null) => (catalog?.samplers ?? []).filter((s) => (IMAGE_SAMPLERS as readonly string[]).includes(s))
export const studioSchedulers = (catalog: StudioCatalog | null) => (catalog?.schedulers ?? []).filter((s) => (IMAGE_SCHEDULERS as readonly string[]).includes(s))

export type StudioRecipe = { steps: number; cfg: number; sampler: string; scheduler: string; clipSkip: number; width: number; height: number; source: Recommended['source']; label: string; notes?: string }
/**
 * The settings a model starts with: its own recipe (model_details: the Civitai example consensus, or
 * its family's defaults) when that recipe is for this preset, else the preset's family defaults
 * (Diffu's defaults.ts). Samplers only when installed; Turbo keeps CFG 1; clip skip for checkpoints.
 */
export function studioRecipe(preset: ImagePreset, model: string, catalog: StudioCatalog | null, recommended?: Partial<Recommended> | null): StudioRecipe {
  const rules = presetRules(preset)
  const samplers = studioSamplers(catalog), schedulers = studioSchedulers(catalog)
  const installed = (v: string | undefined, list: string[]) => !!v && (!catalog || list.includes(v))
  const fallback = recommendedImageSampling(preset, model, catalog ?? undefined)
  const own = recommended && recommended.sampler && recommended.preset === preset && (recommended.source === 'civitai_examples' || recommended.source === 'family_default' || recommended.source === 'user_saved')
  const family = presetFamily(preset)
  const base = own
    ? { steps: recommended!.steps ?? family.steps, cfg: recommended!.cfg ?? family.cfg, sampler: recommended!.sampler!, scheduler: recommended!.scheduler ?? family.scheduler, clipSkip: recommended!.clip_skip ?? family.clipSkip, width: recommended!.width ?? family.width, height: recommended!.height ?? family.height, source: recommended!.source!, label: recommended!.source === 'civitai_examples' ? `Civitai recipe${recommended!.agree ? ` (${recommended!.agree} agree)` : ''}` : recommended!.source === 'user_saved' ? 'Your saved settings' : 'Family default', notes: recommended!.notes }
    : { steps: family.steps, cfg: family.cfg, sampler: family.sampler, scheduler: family.scheduler, clipSkip: family.clipSkip, width: family.width, height: family.height, source: 'family_default' as const, label: `${family.label} family default`, notes: family.notes }
  return {
    ...base,
    sampler: installed(base.sampler, samplers) ? base.sampler : fallback.sampler,
    scheduler: installed(base.scheduler, schedulers) ? base.scheduler : fallback.scheduler,
    steps: clamp(base.steps, STUDIO_LIMITS.steps, fallback.steps, 1),
    cfg: rules.fixedCfg ?? clamp(base.cfg, STUDIO_LIMITS.cfg, fallback.cfg),
    clipSkip: rules.clipSkip ? clamp(base.clipSkip, STUDIO_LIMITS.clipSkip, 1, 1) : 1,
    width: sized(base.width, rules.edge), height: sized(base.height, rules.edge),
  }
}
/** The form with a recipe applied for `model` (the one Auto picked, when the form names none); it counts as untouched again. */
export function applyRecipe(form: StudioForm, recipe: StudioRecipe, model = form.model, keepSize = false): StudioForm {
  const size = keepSize || form.source ? {} : { width: recipe.width, height: recipe.height }
  return { ...form, ...size, steps: recipe.steps, cfg: recipe.cfg, sampler: recipe.sampler, scheduler: recipe.scheduler, clipSkip: recipe.clipSkip, edited: false, recipe: { model, preset: form.preset, source: recipe.source, label: recipe.label } }
}

/** The prompt as sent: the embeddings written in as ComfyUI reads them, `(embedding:name:weight)`. */
export function promptWithEmbeddings(prompt: string, embeddings: StudioEmbedding[], negative: boolean) {
  const tags = embeddings.filter((e) => e.negative === negative).map((e) => (e.weight === 1 ? `embedding:${e.name}` : `(embedding:${e.name}:${Number(e.weight.toFixed(2))})`))
  return [prompt.trim(), ...tags].filter(Boolean).join(', ')
}

type RunInput = Record<string, unknown>
/** The request one Generate press sends, after the family rules (the server applies them again). */
export function studioRunInput(form: StudioForm): RunInput {
  const rules = presetRules(form.preset)
  const embeddings = rules.embeddings ? form.embeddings : []
  const input: RunInput = {
    preset: form.preset, model: form.model, clip: form.clip, vae: form.vae,
    ...(form.checkpointVae ? { checkpoint_vae: form.checkpointVae } : {}),
    prompt: promptWithEmbeddings(form.prompt, embeddings, false),
    negative_prompt: promptWithEmbeddings(form.negative, embeddings, true),
    width: form.width, height: form.height,
    ...(form.seed >= 0 ? { seed: form.seed } : {}),
    steps: form.steps, cfg: form.cfg, sampler: form.sampler, scheduler: form.scheduler,
    ...(form.clipSkip > 1 ? { clip_skip: form.clipSkip } : {}),
    loras: form.loras.map((l) => ({ name: l.name, weight: Number(l.weight.toFixed(2)) })),
    ...(form.source ? { source_image_id: form.source.id, denoise: form.denoise } : {}),
    ...(form.hires.on ? { hires: { scale: form.hires.scale, denoise: form.hires.denoise, steps: form.hires.steps, ...(form.hires.upscaleModel ? { upscale_model: form.hires.upscaleModel } : {}) } } : {}),
  }
  return applyPresetRules(input)
}

/**
 * Why Generate cannot run yet, most basic first (Diffu's prepareGenerationRun): no backend, no
 * catalog, no prompt, the model and its encoder and VAE, sampler and scheduler, the nodes a choice
 * needs, the size. Empty means it can run.
 */
export function studioProblems(form: StudioForm, ctx: { configured: boolean; catalog: StudioCatalog | null; catalogError?: string; loading?: boolean }): string[] {
  if (!ctx.configured) return ['Connect ComfyUI in Settings → Agents → Images first.']
  if (ctx.catalogError) return [`The ComfyUI catalog could not be read: ${ctx.catalogError}`]
  if (!ctx.catalog) return [ctx.loading === false ? 'Discover the installed models first.' : 'Reading the installed models…']
  const catalog = ctx.catalog, nodes = catalog.nodes
  const out: string[] = []
  const spec = imagePresetSpec(form.preset), rules = presetRules(form.preset)
  if (!form.prompt.trim()) out.push('Write a prompt.')
  const resolved = resolveImageAssets({ preset: form.preset, model: form.model, clip: form.clip, vae: form.vae }, catalog)
  const models = spec.clipType ? catalog.diffusionModels : catalog.checkpoints
  if (!models.length) out.push(spec.clipType ? 'This ComfyUI has no diffusion models for this workflow.' : 'This ComfyUI has no checkpoints installed.')
  else if (!resolved.effective.model) out.push(resolved.selection.model.error ?? 'Choose a model.')
  else if (resolved.selection.model.error) out.push(resolved.selection.model.error)
  if (rules.encoder) {
    if (!resolved.effective.clip) out.push(`Choose a text encoder: ${IMAGE_PRESETS.find((p) => p.id === form.preset)!.title} diffusion models need a separate one.`)
    else if (resolved.selection.clip.error) out.push(resolved.selection.clip.error)
    if (!resolved.effective.vae) out.push('Choose a VAE: diffusion models need a separate one.')
    else if (resolved.selection.vae.error) out.push(resolved.selection.vae.error)
    if (catalog.clipTypes && !catalog.clipTypes.includes(spec.clipType)) out.push(`This ComfyUI’s text encoder loader has no ${spec.clipType} type.`)
  } else if (form.checkpointVae && !catalog.vaes.includes(form.checkpointVae)) out.push('The custom VAE is not installed any more; choose another or use the built-in one.')
  if (!form.sampler || !studioSamplers(catalog).includes(form.sampler)) out.push('Choose a sampler this ComfyUI has.')
  if (!form.scheduler || !studioSchedulers(catalog).includes(form.scheduler)) out.push('Choose a scheduler this ComfyUI has.')
  if (form.loras.length) {
    if (nodes && !nodes.includes('LoraLoaderModelOnly') && (spec.clipType === 'krea2' || !nodes.includes('LoraLoader'))) out.push(spec.clipType === 'krea2' ? 'Krea2 needs a model-only LoRA loader (LoraLoaderModelOnly).' : 'This ComfyUI has no LoRA loader.')
    const missing = form.loras.filter((l) => catalog.loras && !catalog.loras.includes(l.name))
    if (missing.length) out.push(`Not installed: ${missing.map((l) => l.name).join(', ')}.`)
  }
  if (form.clipSkip > 1 && rules.clipSkip && nodes && !nodes.includes('CLIPSetLastLayer')) out.push('This ComfyUI lacks CLIPSetLastLayer, so clip skip must be 1.')
  if (form.width * form.height > SIZE_LIMITS.area) out.push(`The size is over the ${SIZE_LIMITS.area.toLocaleString('en')}-pixel limit (1536 × 1024).`)
  if (form.source && catalog.img2img === false) out.push('This ComfyUI lacks LoadImage, ImageScale or VAEEncode for image-to-image.')
  if (form.hires.on) {
    if (form.hires.upscaleModel && !(catalog.upscalers ?? []).includes(form.hires.upscaleModel)) out.push('The upscale model is not installed any more.')
    const w = Math.round((form.width * form.hires.scale) / 64) * 64, h = Math.round((form.height * form.hires.scale) / 64) * 64
    if (w > 2048 || h > 2048 || w * h > 4_194_304) out.push('The upscaled size is over 2048 pixels a side or 4 megapixels; lower the scale.')
  }
  return out
}

/** The form a result's recorded settings make ("Use these settings"); assets that are gone are left as they are. */
export function formFromSettings(form: StudioForm, recorded: ImageGenerationSettings): StudioForm {
  if (!recorded || recorded.operation === 'upscale' || recorded.operation === 'remove' || !recorded.preset || !PRESETS.includes(recorded.preset)) return form
  const settings: DiffusionImageSettings = recorded
  const preset = settings.preset
  const hires = settings.hires
  const next: StudioForm = {
    ...form,
    preset,
    variant: presetRules(preset).variants ? (isTurbo(preset) ? 'turbo' : 'raw') : 'auto',
    model: settings.model ?? form.model,
    clip: imagePresetSpec(preset).clipType ? settings.clip ?? '' : '',
    vae: imagePresetSpec(preset).clipType ? settings.vae ?? '' : '',
    checkpointVae: settings.checkpoint_vae ?? '',
    loras: (settings.loras ?? []).slice(0, STUDIO_LIMITS.loras),
    embeddings: [],
    prompt: settings.prompt ?? form.prompt,
    negative: settings.negative_prompt ?? '',
    width: hires ? hires.base_width : settings.width ?? form.width,
    height: hires ? hires.base_height : settings.height ?? form.height,
    seed: form.seedLock ? form.seed : settings.seed ?? form.seed,
    steps: settings.steps ?? form.steps, cfg: settings.cfg ?? form.cfg, sampler: settings.sampler ?? form.sampler, scheduler: settings.scheduler ?? form.scheduler,
    clipSkip: settings.clip_skip ?? 1,
    denoise: settings.source ? settings.denoise ?? form.denoise : form.denoise,
    source: settings.source && settings.operation !== 'inpaint' && settings.operation !== 'refine' ? { id: settings.source.id, name: settings.source.name, url: settings.source.url, width: settings.source.width, height: settings.source.height } : null,
    hires: hires ? { on: true, scale: Math.round((hires.width / hires.base_width) * 100) / 100, denoise: hires.denoise, steps: hires.steps, upscaleModel: hires.upscale_model ?? '' } : { ...form.hires, on: false },
    edited: true,
  }
  return normalizeStudioForm(next)
}

/** A source's size on the grid (Use its size): its own when it fits, else about edge² pixels at its shape. */
export function sourceSize(source: { width: number; height: number }, edge: number) {
  let w = source.width, h = source.height
  if (w > SIZE_LIMITS.max || h > SIZE_LIMITS.max || w * h > SIZE_LIMITS.area) {
    const k = Math.sqrt((edge * edge) / (w * h))
    w *= k
    h *= k
  }
  let width = sized(w, edge), height = sized(h, edge)
  while (width * height > SIZE_LIMITS.area) {
    if (width >= height) width -= SIZE_LIMITS.step
    else height -= SIZE_LIMITS.step
  }
  return { width, height }
}
