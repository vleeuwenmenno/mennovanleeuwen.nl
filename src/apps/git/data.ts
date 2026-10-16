import { useCallback, useEffect, useState } from 'react'
import { api } from '../../os/account'
import type { GitPage } from '../../data/gitTypes'

// Loading for the Git app. Answers are kept for this page's life, so going back shows the list
// at once; Reload asks the server again past its own one-minute cache (?fresh).

const memo = new Map<string, unknown>()

const withFresh = (path: string) => `${path}${path.includes('?') ? '&' : '?'}fresh=1`

/** Paths forgotten by Reload a moment ago: the next load of any of them skips the server's cache too. */
const reloaded = new Map<string, number>()
const wantsFresh = (path: string) => [...reloaded].some(([prefix, at]) => Date.now() - at < 10_000 && path.startsWith(prefix))

export function useGet<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>(() => ({ path, data: path ? ((memo.get(path) as T) ?? null) : null, error: null }))
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!path) return
    let live = true
    const hit = nonce === 0 ? (memo.get(path) as T | undefined) : undefined
    if (hit) {
      setState({ path, data: hit, error: null })
      return
    }
    setState((s) => ({ path, data: s.path === path ? s.data : null, error: null }))
    api<T>(nonce || wantsFresh(path) ? withFresh(path) : path).then(
      (data) => {
        memo.set(path, data)
        if (live) setState({ path, data, error: null })
      },
      (e: Error) => live && setState((s) => ({ path, data: s.path === path ? s.data : null, error: e.message })),
    )
    return () => {
      live = false
    }
  }, [path, nonce])
  const current = state.path === path
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !!path && (!current || (!state.data && !state.error)),
    reload: useCallback(() => setNonce((n) => n + 1), []),
  }
}

/** A list in pages: `more()` adds the next one. `path` has no page; it is added here. */
export function usePaged<T>(path: string | null) {
  const pageUrl = (page: number) => (path ? `${path}${path.includes('?') ? '&' : '?'}page=${page}` : '')
  type S = { path: string | null; items: T[]; next: number | null; loading: boolean; error: string | null }
  const fromMemo = (): S => {
    const items: T[] = []
    let next: number | null = 1
    while (path && next !== null && memo.has(pageUrl(next))) {
      const p = memo.get(pageUrl(next)) as GitPage<T>
      items.push(...p.items)
      next = p.next
    }
    return { path, items, next, loading: false, error: null }
  }
  const [state, setState] = useState<S>(fromMemo)
  const [nonce, setNonce] = useState(0)

  const load = useCallback(
    (page: number, fresh: boolean) => {
      if (!path) return
      const url = `${path}${path.includes('?') ? '&' : '?'}page=${page}`
      setState((s) => ({ ...s, loading: true, error: null }))
      api<GitPage<T>>(fresh || wantsFresh(url) ? withFresh(url) : url).then(
        (p) => {
          memo.set(url, p)
          setState((s) => (s.path !== path ? s : { path, items: page === 1 ? p.items : [...s.items, ...p.items], next: p.next, loading: false, error: null }))
        },
        (e: Error) => setState((s) => (s.path !== path ? s : { ...s, loading: false, error: e.message })),
      )
    },
    [path],
  )

  useEffect(() => {
    if (!path) return
    if (nonce === 0) {
      const m = fromMemo()
      if (m.items.length || m.next === null) return setState(m)
    }
    setState({ path, items: [], next: 1, loading: true, error: null })
    load(1, nonce > 0)
  }, [path, nonce, load]) // fromMemo only reads `path`

  const current = state.path === path
  return {
    items: current ? state.items : [],
    next: current ? state.next : 1,
    loading: !!path && (!current || state.loading),
    error: current ? state.error : null,
    more: () => state.next !== null && !state.loading && load(state.next, false),
    reload: () => {
      for (const k of memo.keys()) if (path && k.startsWith(path)) memo.delete(k)
      setNonce((n) => n + 1)
    },
  }
}

/** Forget what was loaded under a path (Reload). */
export function forget(prefix: string) {
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k)
  reloaded.set(prefix, Date.now())
}
