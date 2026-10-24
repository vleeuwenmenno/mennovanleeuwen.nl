/**
 * Where one image job is, as the server reports it to its owner's thread (see server/comfyProgress.ts).
 * `queued`: waiting in ComfyUI's queue, `position` 1 when it is next. `running`: started, with no step
 * detail (no live connection to ComfyUI). `sampling`: step `value` of `max`.
 */
export type ImageProgress = { phase: 'queued' | 'running' | 'loading' | 'encoding' | 'sampling' | 'decoding' | 'saving' | 'upscaling' | 'refining'; position?: number; value?: number; max?: number }
/** How much of the picture is done, 0–1, or null when that is not known yet (queued, loading). */
export function imageProgressFraction(p: ImageProgress | null | undefined): number | null {
  if (!p) return null
  if ((p.phase === 'sampling' || p.phase === 'upscaling' || p.phase === 'refining') && p.max) return Math.min(1, Math.max(0, (p.value ?? 0) / p.max))
  return p.phase === 'decoding' || p.phase === 'saving' ? 1 : null
}
/** A short status line: "Queued (position 2)", "Loading model…", "Step 12 of 30 · 40%". */
export function imageProgressLabel(p: ImageProgress | null | undefined): string {
  switch (p?.phase) {
    case 'queued': return p.position ? `Queued (position ${p.position})` : 'Queued…'
    case 'loading': return 'Loading model…'
    case 'encoding': return 'Reading the prompt…'
    case 'sampling': return p.max ? `Step ${p.value ?? 0} of ${p.max} · ${Math.round(imageProgressFraction(p)! * 100)}%` : 'Generating image…'
    case 'refining': return p.max ? `Refining · step ${p.value ?? 0} of ${p.max}` : 'Refining image…'
    case 'upscaling': return p.max ? `Upscaling · ${Math.round(imageProgressFraction(p)! * 100)}%` : 'Upscaling image…'
    case 'decoding': return 'Decoding image…'
    case 'saving': return 'Saving image…'
    default: return 'Generating image…'
  }
}

/** Catalog identifiers are opaque to ComfyUI. Split paths for browsing, never rewrite the value sent back. */
export type ModelAsset = { value: string; name: string; folders: string[]; folder: string; extension: string }
export function modelAssets(values: readonly string[]): ModelAsset[] {
  return [...new Set(values)].map((value) => {
    const parts = value.split(/[\\/]+/).filter(Boolean)
    const name = parts.pop() ?? value
    return { value, name, folders: parts, folder: parts.join('/'), extension: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : 'Unknown' }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
}
export type ModelFolder = { name: string; path: string; count: number; children: ModelFolder[] }
export function modelFolders(assets: readonly ModelAsset[]): ModelFolder {
  const root: ModelFolder = { name: 'All folders', path: '', count: assets.length, children: [] }
  for (const asset of assets) {
    let parent = root
    for (const name of asset.folders) {
      const path = parent.path ? `${parent.path}/${name}` : name
      let child = parent.children.find((x) => x.path === path)
      if (!child) { child = { name, path, count: 0, children: [] }; parent.children.push(child) }
      child.count++
      parent = child
    }
  }
  const sort = (node: ModelFolder) => { node.children.sort((a, b) => a.name.localeCompare(b.name)); node.children.forEach(sort) }
  sort(root)
  return root
}
export function visibleModelAssets(assets: readonly ModelAsset[], folder: string, query: string): ModelAsset[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return assets.filter((a) => words.length ? words.every((word) => `${a.folder}/${a.name}`.toLocaleLowerCase().includes(word)) : a.folder === folder)
}
export type ImagePreset = 'sd15' | 'sdxl' | 'z_image' | 'z_image_turbo' | 'krea2_raw' | 'krea2_turbo'
export type ImageLora = { name: string; weight: number }
export type ImageLoraHint = { name: string; baseModel: string; triggers: string[] }
export type ImageConfig = { loras: ImageLora[]; preset: ImagePreset; model: string; clip: string; vae: string; width: number; height: number; seed: number | null }
export type ImageOverrides = Partial<ImageConfig>
export const IMAGE_PRESETS: { id: ImagePreset; title: string; detail: string; requirements: string; size: number }[] = [
  { id: 'sd15', title: 'SD 1.5', detail: '512 px · 20 steps · CFG 7 · DPM++ 2M / Karras', requirements: 'A complete SD 1.5 checkpoint with its text encoder and VAE.', size: 512 },
  { id: 'sdxl', title: 'SDXL', detail: '1024 px · 25 steps · CFG 7 · DPM++ 2M / Karras', requirements: 'A complete SDXL checkpoint with its text encoder and VAE.', size: 1024 },
  { id: 'z_image', title: 'Z-Image', detail: '1024 px · 20 steps · CFG 4 · Euler / simple', requirements: 'A Z-Image diffusion model, matching lumina2 text encoder and VAE. Positive and negative prompts.', size: 1024 },
  { id: 'z_image_turbo', title: 'Z-Image Turbo', detail: '1024 px · 8 steps · CFG 1 · Euler / simple', requirements: 'A Z-Image Turbo diffusion model, matching lumina2 text encoder and VAE. Positive prompt only.', size: 1024 },
  { id: 'krea2_raw', title: 'Krea2 Raw', detail: '1024 px · 52 steps · CFG 3.5 · Euler / simple', requirements: 'A Krea2 Raw diffusion model, matching krea2 text encoder and separate VAE. Positive and negative prompts.', size: 1024 },
  { id: 'krea2_turbo', title: 'Krea2 Turbo', detail: '1024 px · 8 steps · CFG 1 · Euler ancestral / beta', requirements: 'A Krea2 Turbo diffusion model, matching krea2 text encoder and separate VAE. Positive prompt only; zeroed negative conditioning.', size: 1024 },
]

/** Explicit workflow properties; filenames never establish model compatibility. */
export function imagePresetSpec(preset: ImagePreset) {
  switch (preset) {
    case 'krea2_raw': return { clipType: 'krea2', steps: 52, cfg: 3.5, sampler: 'euler', scheduler: 'simple', negative: true, zeroNegative: false }
    case 'krea2_turbo': return { clipType: 'krea2', steps: 8, cfg: 1, sampler: 'euler_ancestral', scheduler: 'beta', negative: false, zeroNegative: true }
    case 'z_image': return { clipType: 'lumina2', steps: 20, cfg: 4, sampler: 'euler', scheduler: 'simple', negative: true, zeroNegative: false }
    case 'z_image_turbo': return { clipType: 'lumina2', steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', negative: false, zeroNegative: false }
    case 'sd15': return { clipType: '', steps: 20, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', negative: true, zeroNegative: false }
    default: return { clipType: '', steps: 25, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', negative: true, zeroNegative: false }
  }
}

export type ImageAssets = Pick<ImageConfig, 'preset' | 'model' | 'clip' | 'vae'> & { loras?: ImageLora[] }
export type ImageAssetField = 'model' | 'clip' | 'vae'
export type ImageModelHint = { name: string; category: 'checkpoints' | 'diffusionModels'; baseModel: string }
export type ImageAssetCatalog = { inpaint?: boolean; inpaintError?: string; upscalers?: string[]; upscale?: boolean; upscaleError?: string; checkpoints: string[]; diffusionModels: string[]; clips: string[]; vaes: string[]; loras?: string[]; loraHints?: ImageLoraHint[]; modelHints?: ImageModelHint[]; samplers?: string[]; schedulers?: string[] }
export type ImageSelection = { value: string; automatic: boolean; reason: string; candidates: string[]; error?: string }
const assetKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
const assetLeaf = (name: string) => name.split(/[\\/]/).at(-1)!.replace(/\.[^.]+$/, '')
/** Diffu's family/style hints, deliberately excluding video and unsupported architectures first.
 * These are catalog/name hints, not an inspection of tensor shapes or a quality ranking. */
export function detectedImageFamily(name: string): ImagePreset | 'krea2' | 'unsupported' | undefined {
  const key = assetKey(name)
  if (/ltx|hunyuanvideo|cogvideo|minimax|wanvideo|wan[12]|flux|anima|qwenimage|stablecascade|sd3/.test(key)) return 'unsupported'
  if (key.includes('krea2')) return key.includes('turbo') ? 'krea2_turbo' : key.includes('raw') ? 'krea2_raw' : 'krea2'
  if (key.includes('zimage') || /(?:^|[\W_])zit(?:[\W_\d]|$)/i.test(name)) return key.includes('turbo') || /(?:^|[\W_])zit/i.test(name) ? 'z_image_turbo' : 'z_image'
  if (/sdxl|stablediffusionxl|illustrious|pony/.test(key)) return 'sdxl'
  if (/sd15|stablediffusion15|stablediffusionv1/.test(key)) return 'sd15'
  return undefined
}
export function resolveImageAssets(config: ImageAssets, catalog: ImageAssetCatalog) {
  const spec = imagePresetSpec(config.preset), krea = spec.clipType === 'krea2'
  const category = spec.clipType ? 'diffusionModels' : 'checkpoints'
  const models = catalog[category]
  const family = (name: string) => {
    const hint = catalog.modelHints?.find((h) => h.category === category && h.name.replaceAll('\\', '/') === name.replaceAll('\\', '/'))
    const fromName = detectedImageFamily(name), fromMetadata = detectedImageFamily(hint?.baseModel ?? '')
    if (fromMetadata && fromName && fromMetadata !== fromName && !(fromMetadata === 'krea2' && fromName.startsWith('krea2')) && !(fromName === 'krea2' && fromMetadata.startsWith('krea2'))) return 'unsupported'
    return fromMetadata === 'krea2' && fromName?.startsWith('krea2') ? fromName : fromMetadata ?? fromName
  }
  const modelScore = (name: string) => family(name) === config.preset ? 1 : 0
  const clipScore = (name: string) => {
    const key = assetKey(assetLeaf(name))
    if (/minimax|ltx|wan[12]/.test(assetKey(name))) return 0
    const match = krea ? key.includes('qwen3vl4b') : key.includes('qwen34b') && !key.includes('vl')
    return match ? key === (krea ? 'qwen3vl4b' : 'qwen34b') ? 2 : 1 : 0
  }
  const vaeScore = (name: string) => {
    const key = assetKey(name), leaf = assetKey(assetLeaf(name))
    if (/minimax|ltx|wan[12]|flux2/.test(key)) return 0
    return krea ? leaf === 'qwenimagevae' ? 2 : key.includes('qwenimagevae') || key.includes('krea2') && key.includes('vae') ? 1 : 0 : leaf === 'ae' ? 1 : key.includes('zimage') && key.includes('vae') ? 2 : 0
  }
  const resolve = (field: ImageAssetField, values: string[], score: (name: string) => number, guidance: string): ImageSelection => {
    const manual = config[field]
    const ranked = [...new Set(values)].filter((name) => score(name) > 0).sort((a, b) => score(b) - score(a) || a.localeCompare(b))
    if (manual) {
      const knownFamily = field === 'model' ? family(manual) : undefined
      const incompatible = field === 'model' ? knownFamily && knownFamily !== config.preset && !(knownFamily === 'krea2' && krea)
        : field === 'clip' ? /minimax|ltx|wan[12]|gemma|mistral|t5|qwen306b|qwen25vl/.test(assetKey(manual)) || /^(clipl|clipg)$/.test(assetKey(assetLeaf(manual))) || (krea ? assetKey(manual).includes('qwen34b') : assetKey(manual).includes('qwen3vl4b'))
        : krea ? assetKey(assetLeaf(manual)) === 'ae' || /flux|zimage|sdxl|sd15|ltx|wan[12]|minimax/.test(assetKey(manual)) : /qwenimage|krea2|flux2|ltx|wan[12]|minimax/.test(assetKey(manual))
      const error = !values.includes(manual) ? `Selected ${field} is not installed on this backend.` : incompatible ? `Selected ${field} is known to belong to a different workflow. ${guidance}` : undefined
      return { value: manual, automatic: false, candidates: ranked, reason: score(manual) ? 'Manual choice · matches catalog/name hints.' : 'Manual choice · compatibility is unverified; check the model documentation.', error }
    }
    const best = ranked.filter((name) => score(name) === score(ranked[0] ?? ''))
    if (best.length !== 1) return { value: '', automatic: true, candidates: ranked, reason: best.length ? 'Several equally plausible matches. Choose one below; no model was picked arbitrarily.' : `No recognized match. ${guidance}`, error: best.length ? `Choose one of the recommended ${field} candidates.` : `No recommended ${field} is installed. ${guidance}` }
    return { value: best[0], automatic: true, candidates: ranked, reason: `Automatic · ${guidance}` }
  }
  // A Krea2 file whose name or metadata says neither raw nor turbo matches neither Krea2 preset,
  // which reads like a verdict on the file. It is not one: Diffu keeps the variant as a choice the
  // user makes (inferKrea2Variant in app/src/lib/comfy/capabilities.ts returns undefined and its
  // guidance says to choose), and a name hint never inspects weights. Say what is unknown, so the
  // model reports a choice instead of inventing "that file is raw".
  const unmarkedKrea = krea ? [...new Set(models)].filter((name) => family(name) === 'krea2') : []
  const modelGuidance = `Use a ${IMAGE_PRESETS.find((p) => p.id === config.preset)!.title} model.${unmarkedKrea.length ? ` The raw/turbo variant of ${unmarkedKrea.join(', ')} is not in the name or the metadata, so it matches neither Krea2 preset on its own: the preset decides the recipe (Krea2 Raw 52 steps CFG 3.5, Krea2 Turbo 8 steps CFG 1), and the file is not "raw" or "turbo" by itself.` : ''}`
  const selection = {
    model: resolve('model', models, modelScore, modelGuidance),
    clip: spec.clipType ? resolve('clip', catalog.clips, clipScore, krea ? 'Diffu recommends Qwen3-VL 4B.' : 'Diffu recommends Qwen 3 4B (not VL).') : { value: '', automatic: true, reason: 'Built into the checkpoint.', candidates: [] },
    vae: spec.clipType ? resolve('vae', catalog.vaes, vaeScore, krea ? 'Diffu requires a Qwen Image/Krea2 VAE; ae.safetensors is not suitable.' : 'Use a Z-Image VAE or the documented Flux 1 ae.safetensors fallback.') : { value: '', automatic: true, reason: 'Built into the checkpoint.', candidates: [] },
  } satisfies Record<ImageAssetField, ImageSelection>
  return { effective: { ...config, model: selection.model.value, clip: spec.clipType ? selection.clip.value : config.clip, vae: spec.clipType ? selection.vae.value : config.vae }, selection, errors: Object.values(selection).flatMap((s) => 'error' in s && s.error ? [s.error] : []) }
}

export const IMAGE_SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_3m_sde', 'dpmpp_sde'] as const
export const IMAGE_SCHEDULERS = ['simple', 'karras', 'normal', 'sgm_uniform', 'beta'] as const
export type ImageSampling = { steps: number; cfg: number; sampler: string; scheduler: string }
export type HiresSettings = ImageSampling & { base_width: number; base_height: number; width: number; height: number; denoise: number; seed: number; upscale_model?: string }
export type DiffusionImageSettings = ImageAssets & ImageSampling & { operation?: 'generate' | 'refine' | 'inpaint'; mask?: { id: string; url: string; width: number; height: number; semantics: 'white-edits-black-preserves' }; upscale_model?: string; hires?: HiresSettings; loras: ImageLora[]; width: number; height: number; seed: number; prompt: string; negative_prompt: string; denoise: number; source?: { id: string; name: string; url: string; width: number; height: number; resize: 'lanczos-center-crop' }; profile_id?: number | null; profile_reason?: string }
export type UpscaleImageSettings = { operation: 'upscale'; upscale_model: string; width: number; height: number; input_width: number; input_height: number; source: { id: string; name: string; url: string; width: number; height: number; resize: 'lanczos' } }
export type ImageGenerationSettings = DiffusionImageSettings | UpscaleImageSettings
/** Diffu defaults.ts preferences, restricted to the KSampler workflows we actually build. */
export function recommendedImageSampling(preset: ImagePreset, model: string, catalog?: { samplers?: string[]; schedulers?: string[]; modelHints?: ImageModelHint[] }): ImageSampling {
  const spec = imagePresetSpec(preset)
  const label = assetKey(`${model} ${catalog?.modelHints?.find((h) => h.name.replaceAll('\\', '/') === model.replaceAll('\\', '/'))?.baseModel ?? ''}`)
  const pony = preset === 'sdxl' && label.includes('pony')
  const samplers = preset === 'sd15' ? ['dpmpp_2m', 'euler_ancestral', 'euler'] : preset === 'sdxl' ? ['dpmpp_2m', 'dpmpp_3m_sde', 'euler'] : preset === 'krea2_turbo' ? ['euler_ancestral', 'euler'] : preset === 'krea2_raw' ? ['euler'] : preset === 'z_image_turbo' ? ['euler', 'euler_ancestral', 'dpmpp_sde'] : ['euler', 'dpmpp_2m', 'dpmpp_sde']
  const schedulers = preset === 'sd15' ? ['karras', 'normal', 'simple'] : preset === 'sdxl' ? ['karras', 'sgm_uniform', 'normal', 'simple'] : preset === 'krea2_turbo' ? ['beta', 'simple'] : preset === 'krea2_raw' ? ['simple'] : ['simple', 'sgm_uniform', 'normal']
  return { steps: pony ? 12 : preset === 'sd15' ? 20 : spec.steps, cfg: pony ? 5.5 : spec.cfg, sampler: samplers.find((s) => !catalog?.samplers || catalog.samplers.includes(s)) ?? '', scheduler: schedulers.find((s) => !catalog?.schedulers || catalog.schedulers.includes(s)) ?? '' }
}
