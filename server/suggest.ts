// Search suggestions for Spotlight's web search, from the engine the visitor picked in Settings.
// Browsers can't call these endpoints directly (no CORS), so the server asks on their behalf:
// fixed hosts only, short queries, cached for a few minutes.

const ENGINES: Record<string, (q: string) => string> = {
  ddg: (q) => `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
  kagi: (q) => `https://kagi.com/api/autosuggest?q=${encodeURIComponent(q)}`,
  google: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
}

const CACHE_MS = 5 * 60_000
const cache = new Map<string, { at: number; value: Promise<string[]> }>()

/** Up to eight suggestions; an empty list when the engine is unknown or doesn't answer. */
export function suggest(engine: string, raw: string): Promise<string[]> {
  const q = raw.trim().slice(0, 100)
  const url = ENGINES[engine]
  if (!url || q.length < 2) return Promise.resolve([])
  const key = `${engine}|${q.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  // Every engine answers in the OpenSearch suggestions format: ["query", ["suggestion", ...], ...].
  const value = fetch(url(q), { headers: { 'User-Agent': 'Mozilla/5.0 (mvlos)', Accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => (Array.isArray(body) && Array.isArray(body[1]) ? (body[1] as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 8) : []))
    .catch(() => [] as string[])
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 1000) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k)
  return value
}
