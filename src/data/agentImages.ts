import { api } from '../os/account'

export type ImagePreset = 'sd15' | 'sdxl' | 'z_image' | 'z_image_turbo'
export type ImageSettings = { url: string; token: boolean; preset: ImagePreset; model: string; clip: string; vae: string }
export type ImageCatalog = { checkpoints: string[]; diffusionModels: string[]; clips: string[]; vaes: string[] }
export type GeneratedImage = { id: string; name: string; url: string; size: number; width: number; height: number; seed: number; preset: ImagePreset }
export const getImageSettings = () => api<ImageSettings>('/api/agents/images/settings')
export const saveImageSettings = (s: Omit<ImageSettings, 'token'> & { token: string; clearToken?: boolean }) => api<ImageSettings>('/api/agents/images/settings', { method: 'PUT', json: s })
export const resetImageSettings = () => api<ImageSettings>('/api/agents/images/settings', { method: 'DELETE' })
export const getImageCatalog = () => api<ImageCatalog>('/api/agents/images/catalog')

/** Only server artifact paths become previews/links, never model-supplied external URLs. */
export function generatedImage(result?: string): GeneratedImage | null {
  try {
    const image = JSON.parse(result ?? '').image as GeneratedImage | undefined
    return image && typeof image.id === 'string' && /^[0-9a-f-]{36}$/.test(image.id) && image.url === `/api/agents/images/${image.id}` && typeof image.name === 'string' && typeof image.size === 'number' ? image : null
  } catch { return null }
}
