import { api } from '../os/account'

// Client helpers for custom OpenAI-compatible API endpoints (server/agentCustomOpenAI.ts).
// API keys stay encrypted on the server; the browser only sees whether an endpoint has one.

export type CustomOpenAIEndpoint = {
  id: string
  name: string
  url: string
  hasKey: boolean
  manualModels: string[]
}

export type CustomOpenAIInput = {
  name: string
  url: string
  apiKey?: string
  clearKey?: boolean
  manualModels?: string[]
}

export const listCustomOpenAI = () => api<{ endpoints: CustomOpenAIEndpoint[] }>('/api/agents/custom-openai').then((r) => r.endpoints)
export const addCustomOpenAI = (input: CustomOpenAIInput) =>
  api<{ endpoints: CustomOpenAIEndpoint[]; endpoint: CustomOpenAIEndpoint; discovered: string[] }>('/api/agents/custom-openai', { method: 'POST', json: input })
export const updateCustomOpenAI = (id: string, input: CustomOpenAIInput) =>
  api<{ endpoints: CustomOpenAIEndpoint[]; endpoint: CustomOpenAIEndpoint; discovered: string[] }>(`/api/agents/custom-openai/${encodeURIComponent(id)}`, { method: 'PUT', json: input })
export const deleteCustomOpenAI = (id: string) =>
  api<{ endpoints: CustomOpenAIEndpoint[] }>(`/api/agents/custom-openai/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => r.endpoints)
export const testCustomOpenAI = (id: string) =>
  api<{ ok: boolean; models: string[]; error?: string }>(`/api/agents/custom-openai/${encodeURIComponent(id)}/test`, { method: 'POST', json: {} })
