import { useEffect, useState } from 'react'
import { openLink } from './links'
import { synced } from '../os/synced'

// Which web search engine Spotlight uses, and whether it shows that engine's suggestions while
// you type. Kept in this browser; synced when signed in, like notes.

export type EngineId = 'ddg' | 'kagi' | 'google'

export const ENGINES: Record<EngineId, { label: string; search: (q: string) => string }> = {
  ddg: { label: 'DuckDuckGo', search: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  kagi: { label: 'Kagi', search: (q) => `https://kagi.com/search?q=${encodeURIComponent(q)}` },
  google: { label: 'Google', search: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
}

export type SearchSettings = { engine: EngineId; suggestions: boolean }
const DEFAULTS: SearchSettings = { engine: 'ddg', suggestions: true }

const store = synced<SearchSettings>('search', DEFAULTS, {
  normalize: (v) => {
    const s = { ...DEFAULTS, ...(v as Partial<SearchSettings>) }
    return { engine: s.engine in ENGINES ? s.engine : 'ddg', suggestions: s.suggestions !== false }
  },
})

export const useSearchSettings = store.use
export const setSearchSettings = (patch: Partial<SearchSettings>) => store.set((s) => ({ ...s, ...patch }))
export const searchWeb = (q: string) => {
  const engine = ENGINES[store.get().engine]
  openLink(engine.search(q), { title: `“${q}” on ${engine.label}` })
}

const cache = new Map<string, string[]>()

/** The engine's suggestions for `q`, debounced; [] while off, too short or still loading. */
export function useSuggestions(q: string, enabled: boolean): string[] {
  const { engine, suggestions } = store.use()
  const query = q.trim()
  const key = `${engine}|${query.toLowerCase()}`
  const on = enabled && suggestions && query.length >= 2
  const [result, setResult] = useState<{ key: string; list: string[] }>({ key: '', list: [] })

  useEffect(() => {
    if (!on) return
    if (cache.has(key)) return setResult({ key, list: cache.get(key)! })
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(`/api/suggest?engine=${engine}&q=${encodeURIComponent(query)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((body: { suggestions?: string[] }) => {
          const list = body.suggestions ?? []
          cache.set(key, list)
          if (cache.size > 200) cache.delete(cache.keys().next().value!)
          setResult({ key, list })
        })
        .catch(() => {})
    }, 180)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [on, key, engine, query])

  // The previous query's suggestions stay until the new ones land, so the list doesn't flicker.
  return on ? result.list : []
}
