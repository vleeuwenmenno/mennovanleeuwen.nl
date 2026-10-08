import { useEffect, useState } from 'react'
import { isCodeQuery, type SearchResponse } from '../data/code'
import { useAccount } from './account'

// Spotlight's live search over the owner's GitHub and Gitea/Forgejo instances (/api/search),
// debounced while typing. Only runs when signed in.

export type CodeSearch = { loading: boolean; result: SearchResponse | null; error: string | null; for: string }

const DELAY = 220
const cache = new Map<string, SearchResponse>()

export function useCodeSearch(q: string): CodeSearch {
  const account = useAccount()
  const query = q.trim()
  const active = account.status === 'user' && (isCodeQuery(query) || query.length >= 2)
  const [state, setState] = useState<CodeSearch>({ loading: false, result: null, error: null, for: '' })

  useEffect(() => {
    if (!active) return setState({ loading: false, result: null, error: null, for: query })
    const hit = cache.get(query)
    if (hit) return setState({ loading: false, result: hit, error: null, for: query })
    setState((s) => ({ ...s, loading: true }))
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctl.signal, credentials: 'same-origin' })
        .then(async (r) => {
          const body = await r.json()
          if (!r.ok) throw new Error(body?.error ?? `Search failed (${r.status})`)
          return body as SearchResponse
        })
        .then((result) => {
          cache.set(query, result)
          if (cache.size > 100) cache.delete(cache.keys().next().value!)
          setState({ loading: false, result, error: null, for: query })
        })
        .catch((e: Error) => e.name !== 'AbortError' && setState({ loading: false, result: null, error: e.message, for: query }))
    }, DELAY)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [query, active])

  // Results for an older query are kept on screen until the new ones land, to avoid flicker.
  return state
}

/** Drops cached results (e.g. after linking an instance). */
export const clearCodeSearch = () => cache.clear()
