// A small cache for the public proxy endpoints (GitHub, search suggestions): a hard cap on entries,
// identical in-flight requests shared, failures kept only briefly, and a limit on how many upstream
// requests run at once. Over the limit a request is answered at once with `busy` and not cached,
// so a flood of unique keys can neither grow memory nor pile up outbound work.

interface Entry<T> {
  at: number
  ttl: number
  value: Promise<T>
}

export interface BoundedCache<T> {
  /** Cached or shared result for `key`; otherwise runs `load` if a slot is free, else returns `busy`. */
  get(key: string, load: () => Promise<{ value: T; ok: boolean }>, busy: T): Promise<T>
  size(): number
  inFlight(): number
}

export function boundedCache<T>(opts: { max: number; ttlMs: number; failTtlMs: number; maxInFlight: number; now?: () => number }): BoundedCache<T> {
  const now = opts.now ?? Date.now
  const entries = new Map<string, Entry<T>>()
  let running = 0

  /** Make room for one more: expired entries first, then the least recently used. */
  const evict = () => {
    if (entries.size < opts.max) return
    const t = now()
    for (const [k, e] of entries) if (t - e.at >= e.ttl) entries.delete(k)
    for (const k of entries.keys()) {
      if (entries.size < opts.max) break
      entries.delete(k)
    }
  }

  return {
    get(key, load, busy) {
      const hit = entries.get(key)
      if (hit) {
        if (now() - hit.at < hit.ttl) {
          entries.delete(key)
          entries.set(key, hit) // most recently used goes last
          return hit.value
        }
        entries.delete(key)
      }
      if (running >= opts.maxInFlight) return Promise.resolve(busy)
      running++
      const entry: Entry<T> = { at: now(), ttl: opts.ttlMs, value: undefined as unknown as Promise<T> }
      entry.value = load()
        .then((r) => {
          entry.at = now()
          entry.ttl = r.ok ? opts.ttlMs : opts.failTtlMs
          return r.value
        })
        .catch(() => {
          entry.at = now()
          entry.ttl = opts.failTtlMs
          return busy
        })
        .finally(() => {
          running--
        })
      evict()
      entries.set(key, entry)
      return entry.value
    },
    size: () => entries.size,
    inFlight: () => running,
  }
}
