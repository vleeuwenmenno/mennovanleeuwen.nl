import { api } from '../os/account'

// The Agents app's web search provider (server/websearch.ts). The server never sends a key or
// header value back: it says which ones are set, and saving with one left empty keeps it.

export type Provider = 'ollama' | 'searxng' | 'brave' | 'kagi' | 'tavily' | 'custom'
export type ResultMap = { results: string; title: string; url: string; snippet: string }
export type SearchResult = { title: string; url: string; snippet: string }

export type WebSearchView = {
  provider: Provider
  searxng: { url: string; auth: boolean }
  brave: { key: boolean }
  kagi: { key: boolean }
  tavily: { key: boolean }
  custom: { url: string; method: 'GET' | 'POST'; body: string; headers: { name: string; set: boolean }[]; map: ResultMap }
}

export type WebSearchInput = {
  provider?: Provider
  searxng?: { url?: string; auth?: string }
  brave?: { key?: string }
  kagi?: { key?: string }
  tavily?: { key?: string }
  custom?: { url?: string; method?: 'GET' | 'POST'; body?: string; headers?: { name: string; value: string }[]; map?: ResultMap }
}

export const PROVIDERS: { value: Provider; label: string; hint: string }[] = [
  { value: 'ollama', label: 'Ollama', hint: 'Uses your Ollama key; nothing to set up' },
  { value: 'searxng', label: 'SearXNG', hint: 'Your own instance, with JSON output on' },
  { value: 'brave', label: 'Brave Search', hint: 'Brave Search API key' },
  { value: 'kagi', label: 'Kagi', hint: 'Kagi Search API key' },
  { value: 'tavily', label: 'Tavily', hint: 'Tavily API key' },
  { value: 'custom', label: 'Custom', hint: 'Any JSON search API' },
]

export const getWebSearch = () => api<WebSearchView>('/api/agents/websearch')
export const saveWebSearch = (input: WebSearchInput) => api<WebSearchView>('/api/agents/websearch', { method: 'PUT', json: input })
export const resetWebSearch = () => api<WebSearchView>('/api/agents/websearch', { method: 'DELETE' })
/** Searches with the settings given (saved or not), falling back to the stored ones for anything left out. */
export const testWebSearch = (query: string, settings?: WebSearchInput) =>
  api<{ provider: Provider; results: SearchResult[]; ms: number }>('/api/agents/websearch/test', { method: 'POST', json: { query, settings } })
