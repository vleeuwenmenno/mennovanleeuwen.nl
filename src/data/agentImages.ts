import { api } from '../os/account'

import type { ImagePreset, ImageConfig, ImageOverrides, ImageAssetCatalog, ImageAssetField, ImageSelection, ImageSampling, ImageGenerationSettings } from './imageModels'
export type { ImagePreset, ImageConfig, ImageOverrides } from './imageModels'
export type ImageSettings = { url: string; token: boolean; preset: ImagePreset; model: string; clip: string; vae: string; askBeforeGenerate: boolean }
export type ImageCatalog = ImageAssetCatalog
export type GeneratedImage = { id: string; name: string; url: string; size: number; width: number; height: number; seed: number; preset: ImagePreset; settings?: ImageGenerationSettings }
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

export type ModelCategory = 'checkpoints' | 'diffusion_models' | 'text_encoders' | 'vae'
export type ModelMetadata = { available: boolean; reason?: string; source?: string; title?: string; baseModel?: string; size?: number; tags?: string[]; preview?: string }
export const getModelMetadata = (category: ModelCategory, name: string, signal: AbortSignal) => api<ModelMetadata>(`/api/agents/images/model-metadata?${new URLSearchParams({ category, name })}`, { signal })
