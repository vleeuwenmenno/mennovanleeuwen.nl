import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBucket, getBuckets, type Bucket, type Filter, type Item, type SourceId } from '../../data/photos'

// A source's timeline in the browser: the months (with how many photos each has) first, then
// each month's photos, the ones on screen first and the rest in the background, two at a time,
// so going through the whole timeline in the lightbox works without scrolling it all.

export type Timeline = {
  buckets: Bucket[] | null
  /** Each month's photos, once loaded */
  loaded: Map<string, Item[]>
  error: string | null
  /** Every loaded photo, newest first: the lightbox's order */
  flat: Item[]
  /** Asks for these months first */
  want: (keys: string[]) => void
  /** Changes one photo in place (a favourite) */
  patch: (id: string, change: Partial<Item>) => void
}

export function useTimeline(source: SourceId | null, filter: Filter, refresh: number): Timeline {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [loaded, setLoaded] = useState<Map<string, Item[]>>(() => new Map())
  const [error, setError] = useState<string | null>(null)
  const filterKey = `${source}|${filter.album ?? ''}|${filter.favourites ? 1 : 0}`
  const wanted = useRef<string[]>([])
  const pump = useRef<() => void>(() => {})

  // A new source or filter starts empty; a refresh (the walk found more) keeps what is shown until the new answers come.
  const lastKey = useRef('')
  useEffect(() => {
    if (!source) return
    let live = true
    const fresh = lastKey.current !== filterKey
    lastKey.current = filterKey
    if (fresh) {
      setBuckets(null)
      setLoaded(new Map())
    }
    setError(null)
    getBuckets(source, filter).then(
      (list) => {
        if (!live) return
        setBuckets(list)
        // Months whose count changed are loaded again; the rest stay.
        setLoaded((old) => {
          const next = new Map<string, Item[]>()
          for (const b of list) {
            const items = old.get(b.key)
            if (items && items.length === b.count && !fresh) next.set(b.key, items)
          }
          return next
        })
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refresh])

  // Loads months, two at a time: the wanted ones first (newest wish first), then the rest in order.
  const inFlight = useRef(new Set<string>())
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  useEffect(() => {
    if (!source || !buckets) return
    let live = true
    const key = filterKey
    const next = () => {
      const missing = (k: string) => !loadedRef.current.has(k) && !inFlight.current.has(k)
      const wish = [...wanted.current].reverse().find((k) => missing(k) && buckets.some((b) => b.key === k))
      return wish ?? buckets.find((b) => missing(b.key))?.key ?? null
    }
    const run = () => {
      while (live && inFlight.current.size < 2) {
        const k = next()
        if (!k) return
        inFlight.current.add(k)
        getBucket(source, k, filter)
          .then(
            (items) => live && key === lastKey.current && setLoaded((old) => new Map(old).set(k, items)),
            () => {},
          )
          .finally(() => {
            inFlight.current.delete(k)
            if (live) setTimeout(run, 0)
          })
      }
    }
    pump.current = run
    run()
    return () => {
      live = false
      inFlight.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, filterKey])

  const want = useCallback((keys: string[]) => {
    wanted.current = keys
    pump.current()
  }, [])

  const patch = useCallback((id: string, change: Partial<Item>) => {
    setLoaded((old) => {
      const next = new Map(old)
      for (const [k, items] of old) {
        const i = items.findIndex((x) => x.id === id)
        if (i >= 0) next.set(k, items.map((x, j) => (j === i ? { ...x, ...change } : x)))
      }
      return next
    })
  }, [])

  const flat = useMemo(() => (buckets ?? []).flatMap((b) => loaded.get(b.key) ?? []), [buckets, loaded])
  return { buckets: source ? buckets : null, loaded, error, flat, want, patch }
}
