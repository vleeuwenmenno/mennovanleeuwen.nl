import { readEvents, type TurnEvent } from './agents'
import { api } from '../os/account'
import type { ObservationsView } from './imageObservations'

import type { ImagePreset, ImageConfig, ImageOverrides, ImageAssetCatalog, ImageAssetField, ImageSelection, ImageSampling, ImageGenerationSettings, ImageLoraHint } from './imageModels'
export type { ImagePreset, ImageConfig, ImageOverrides } from './imageModels'
export type ImageSettings = { url: string; token: boolean; preset: ImagePreset; model: string; clip: string; vae: string; askBeforeGenerate: boolean; askBeforeSavingObservations: boolean; saveImageLearnings: boolean }
export type ImageCatalog = ImageAssetCatalog
export type GeneratedImage = { id: string; name: string; url: string; size: number; width: number; height: number; seed?: number; preset?: ImagePreset; settings?: ImageGenerationSettings }
export const getImageSettings = () => api<ImageSettings>('/api/agents/images/settings')
/** Saves only the approval choice; the rest of the saved settings stay as they are. */
export const saveImageApproval = (askBeforeGenerate: boolean) => api<ImageSettings>('/api/agents/images/settings', { method: 'PUT', json: { askBeforeGenerate } })
export const saveImageSettings = (s: Omit<ImageSettings, 'token'> & { token: string; clearToken?: boolean }) => api<ImageSettings>('/api/agents/images/settings', { method: 'PUT', json: s })
export const resetImageSettings = () => api<ImageSettings>('/api/agents/images/settings', { method: 'DELETE' })
export const getImageCatalog = () => api<ImageCatalog>('/api/agents/images/catalog')

export type ImageProfile = { id: number; name: string; description: string; origin: 'user' | 'suggestion' }
/** The account's profiles, each with the number of image observations filed under it. */
export const getImageProfiles = () => api<(ImageProfile & { observations: number })[]>('/api/agents/image-profiles')
export const saveImageProfile = (profile: { id?: number; name: string; description: string }) => api<ImageProfile>('/api/agents/image-profiles', { method: 'POST', json: profile })
export const deleteImageProfile = (id: number, reset = false) => api(`/api/agents/image-profiles/${id}${reset ? '/reset' : ''}`, { method: 'DELETE' })
export const getImageProfilePin = (thread: string) => api<{ profile: ImageProfile | null }>(`/api/agents/image-profiles/threads/${thread}`)
export const pinImageProfile = (thread: string, id: number | null) => api<{ profile: ImageProfile | null }>(`/api/agents/image-profiles/threads/${thread}`, { method: 'PUT', json: { id } })

/** Only server artifact paths become previews/links, never model-supplied external URLs. */
export function generatedImage(result?: string): GeneratedImage | null {
  try {
    const image = JSON.parse(result ?? '').image as GeneratedImage | undefined
    return image && typeof image.id === 'string' && /^[0-9a-f-]{36}$/.test(image.id) && image.url === `/api/agents/images/${image.id}` && typeof image.name === 'string' && typeof image.size === 'number' ? image : null
  } catch { return null }
}

export type ThreadImageSettings = { overrides: ImageOverrides; defaults: ImageConfig; effective: ImageConfig; selection?: Record<ImageAssetField, ImageSelection>; discoveryError?: string; sampling?: ImageSampling }
export const getThreadImageSettings = (id: string) => api<ThreadImageSettings>(`/api/agents/images/threads/${id}`)
export const saveThreadImageSettings = (id: string, overrides: ImageOverrides) => api<ThreadImageSettings>(`/api/agents/images/threads/${id}`, { method: 'PUT', json: overrides })
export const resetThreadImageSettings = (id: string) => api<ThreadImageSettings>(`/api/agents/images/threads/${id}`, { method: 'DELETE' })

export type ModelCategory = 'checkpoints' | 'diffusion_models' | 'text_encoders' | 'vae' | 'upscale_models'
export type ModelMetadata = { available: boolean; reason?: string; source?: string; title?: string; baseModel?: string; size?: number; tags?: string[]; preview?: string }
export const getModelMetadata = (category: ModelCategory, name: string, signal: AbortSignal) => api<ModelMetadata>(`/api/agents/images/model-metadata?${new URLSearchParams({ category, name })}`, { signal })

export const getImageLoras = () => api<{ loras: ImageLoraHint[]; total: number; truncated: boolean }>('/api/agents/images/loras')
export const saveImageLearningPreference = (saveImageLearnings: boolean) => api<ImageSettings>('/api/agents/images/settings', { method: 'PUT', json: { saveImageLearnings } })

export const saveImageObservationApproval = (askBeforeSavingObservations: boolean) => api<ImageSettings>('/api/agents/images/settings', { method: 'PUT', json: { askBeforeSavingObservations } })
/** Read-only: the newest image observations, parsed, with every style profile. Delete with deleteMemory. */
export const getImageObservations = () => api<ObservationsView>('/api/agents/images/observations')

/** An installed LoRA as the # picker shows it: LoRA Manager's facts when it has them, else what the name says. */
export type LoraDetail = { name: string; title: string; baseModel: string; triggers: string[]; tags: string[]; folder: string; size: number | null; hasPreview: boolean }
/** Every installed LoRA (up to 2000), with facts for the ones LoRA Manager matches (first 50). `manager`: LoRA Manager answered. */
export const getLoraDetails = () => api<{ loras: LoraDetail[]; total: number; truncated: boolean; manager: boolean }>('/api/agents/images/lora-details')
/** The LoRA's own preview, through this server (only when `hasPreview`). */
export const loraPreviewUrl = (name: string) => `/api/agents/images/lora-preview?${new URLSearchParams({ name })}`

/** An explicit model upscale; diffusion settings are deliberately absent. */
export type UpscaleImageInput = { operation: 'upscale'; source_image_id: string; upscale_model: string } & ({ scale: number } | { width: number; height: number })
export async function upscaleImage(id: string, input: UpscaleImageInput, onEvent: (e: TurnEvent) => void, signal: AbortSignal) {
  const res = await fetch(`/api/agents/threads/${id}/upscale`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  })
  await readEvents(res, onEvent)
}

/** A diffusion refinement with optional overrides of the source's recorded settings. */
export type RefineImageInput = { operation: 'refine'; source_image_id: string; denoise: number; upscale_model?: string; prompt?: string; negative_prompt?: string } & Partial<Pick<ImageConfig, 'preset' | 'model' | 'clip' | 'vae'>> & Partial<ImageSampling> & ({ scale: number } | { width: number; height: number })
export async function refineImage(id: string, input: RefineImageInput, onEvent: (e: TurnEvent) => void, signal: AbortSignal) {
  const res = await fetch(`/api/agents/threads/${id}/refine`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  })
  await readEvents(res, onEvent)
}

export type InpaintImageInput = { operation: 'inpaint'; source_image_id: string; mask_id: string; prompt: string; denoise: number } & Partial<Pick<import('./imageModels').DiffusionImageSettings, 'preset' | 'model' | 'clip' | 'vae' | 'loras' | 'steps' | 'cfg' | 'sampler' | 'scheduler'>>
export async function saveImageMask(thread: string, source: string, mask: Blob) {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('Could not read the mask'))
    reader.readAsDataURL(mask)
  })
  return api<{ id: string; url: string; width: number; height: number }>(`/api/agents/threads/${thread}/image-masks`, { method: 'POST', json: { source_image_id: source, data } })
}
export async function inpaintImage(id: string, input: InpaintImageInput, onEvent: (e: TurnEvent) => void, signal: AbortSignal) {
  const res = await fetch(`/api/agents/threads/${id}/inpaint`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal })
  await readEvents(res, onEvent)
}

export const discardImageMask = (id: string) => api(`/api/agents/image-masks/${id}`, { method: 'DELETE' })
