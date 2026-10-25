import { api } from '../os/account'

// OpenAI pictures for the Agents app's gpt_image tool (server/agentOpenAI.ts): which provider,
// the API key, Sign in with ChatGPT, and the icon library. Keys and tokens stay on the server;
// this only ever sees where they come from and who is signed in.

export type OpenAIProvider = 'off' | 'apikey' | 'chatgpt'
export type OpenAIImagesView = {
  provider: OpenAIProvider
  model: string
  models: string[]
  /** Where the API key comes from: saved here, the server's OPENAI_API_KEY (admins), or none */
  apiKey: 'settings' | 'server' | null
  chatgpt: { email: string; plan: string } | null
  /** A sign-in was started and is waiting for the pasted address */
  signingIn: boolean
  usage: { today: number; limit: number }
  ready: boolean
}
export type IconInfo = { slug: string; prompt: string; size: number; url: string; createdAt: number; updatedAt: number }

export const getOpenAIImages = () => api<OpenAIImagesView>('/api/agents/openai')
export const saveOpenAIImages = (patch: { provider?: OpenAIProvider; model?: string }) => api<OpenAIImagesView>('/api/agents/openai', { method: 'PUT', json: patch })
export const setOpenAIKey = (key: string) => api<OpenAIImagesView>('/api/agents/openai/key', { method: 'PUT', json: { key } })
export const removeOpenAIKey = () => api<OpenAIImagesView>('/api/agents/openai/key', { method: 'DELETE' })
/** Only after the risk dialog was accepted: the server refuses without it. */
export const startChatGPTSignIn = () => api<{ url: string; redirect: string }>('/api/agents/openai/chatgpt/start', { method: 'POST', json: { acceptedRisk: true } })
export const finishChatGPTSignIn = (callback: string) => api<OpenAIImagesView>('/api/agents/openai/chatgpt/finish', { method: 'POST', json: { callback } })
export const cancelChatGPTSignIn = () => api<OpenAIImagesView>('/api/agents/openai/chatgpt/cancel', { method: 'POST', json: {} })
export const signOutChatGPT = () => api<OpenAIImagesView>('/api/agents/openai/chatgpt', { method: 'DELETE' })

export const listIcons = () => api<{ icons: IconInfo[] }>('/api/agents/icons').then((r) => r.icons)
export const deleteIcon = (slug: string) => api<{ icons: IconInfo[] }>(`/api/agents/icons/${encodeURIComponent(slug)}`, { method: 'DELETE' }).then((r) => r.icons)
export const regenerateIcon = (slug: string) => api<{ icons: IconInfo[] }>(`/api/agents/icons/${encodeURIComponent(slug)}/regenerate`, { method: 'POST', json: {} }).then((r) => r.icons)
/** An icon's address, changing when it is drawn again so the browser does not show the old one. */
export const iconSrc = (icon: Pick<IconInfo, 'url' | 'updatedAt'>) => `${icon.url}?v=${icon.updatedAt}`
