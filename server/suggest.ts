// Search suggestions for Spotlight's web search, from the engine the visitor picked in Settings.
// Browsers can't call these endpoints directly (no CORS), so the server asks on their behalf:
// fixed hosts only, short queries, cached for a few minutes. At most 1000 answers are kept (failures
// for 30 seconds) and 8 requests to the engines run at once; past that the list is empty.

import { boundedCache } from './boundedcache.ts'

const ENGINES: Record<string, (q: string) => string> = {
  ddg: (q) => `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
  kagi: (q) => `https://kagi.com/api/autosuggest?q=${encodeURIComponent(q)}`,
  google: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
}

const CACHE_MS = 5 * 60_000
const cache = boundedCache<string[]>({ max: 1000, ttlMs: CACHE_MS, failTtlMs: 30_000, maxInFlight: 8 })

/** Entries held and requests running, for the check script. */
export const suggestCacheStats = () => ({ size: cache.size(), inFlight: cache.inFlight() })

/** Up to eight suggestions; an empty list when the engine is unknown or doesn't answer. */
export function suggest(engine: string, raw: string): Promise<string[]> {
  const q = raw.trim().slice(0, 100)
  const url = ENGINES[engine]
  if (!url || q.length < 2) return Promise.resolve([])
  const key = `${engine}|${q.toLowerCase()}`
  // Every engine answers in the OpenSearch suggestions format: ["query", ["suggestion", ...], ...].
  return cache.get(
    key,
    () =>
      fetch(url(q), { headers: { 'User-Agent': 'Mozilla/5.0 (mvlos)', Accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
        .then(async (r) => {
          const body = r.ok ? await r.json() : null
          const list = Array.isArray(body) && Array.isArray(body[1]) ? (body[1] as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 8) : []
          return { value: list, ok: r.ok }
        })
        .catch(() => ({ value: [] as string[], ok: false })),
    [],
  )
}
