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
export type ImageConfig = { preset: ImagePreset; model: string; clip: string; vae: string; width: number; height: number; seed: number | null }
export type ImageOverrides = Partial<ImageConfig>
export const IMAGE_PRESETS: { id: ImagePreset; title: string; detail: string; requirements: string; size: number }[] = [
  { id: 'sd15', title: 'SD 1.5', detail: '512 px · 25 steps · CFG 7 · Euler / simple', requirements: 'A complete SD 1.5 checkpoint with its text encoder and VAE.', size: 512 },
  { id: 'sdxl', title: 'SDXL', detail: '1024 px · 25 steps · CFG 7 · Euler / simple', requirements: 'A complete SDXL checkpoint with its text encoder and VAE.', size: 1024 },
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
    default: return { clipType: '', steps: 25, cfg: 7, sampler: 'euler', scheduler: 'simple', negative: true, zeroNegative: false }
  }
}
