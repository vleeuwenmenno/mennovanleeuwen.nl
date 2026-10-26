import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'

// Which threads are selected in the sidebar, for the bulk actions. The state lives in the app (one
// per Agents window); every style draws it the same way through the shared parts (shared.tsx,
// select.tsx). The order "from here to there" means is the one on screen, read from the list's
// rows, so it follows the search, the Focus chips and folded projects in any style.

type State = { ids: ReadonlySet<string>; anchor: string | null; touch: boolean }
const NONE: State = { ids: new Set(), anchor: null, touch: false }

export type ThreadSelection = {
  ids: ReadonlySet<string>
  size: number
  /** The last row clicked: where Shift+click and Shift+arrows start from. */
  anchor: string | null
  /** Touch selection mode (a long press starts it): a tap toggles a row instead of opening it. */
  touch: boolean
  /** Rows show their checks: something is selected, or touch selection mode is on. */
  active: boolean
  has: (id: string) => boolean
  /** Adds or removes one thread and makes it the anchor. */
  toggle: (id: string) => void
  /** The threads from the anchor to this one, in the order on screen (`add`: on top of what is selected). */
  range: (id: string, add?: boolean, from?: string | null) => void
  /** Replaces the selection (`anchor`: the row Shift+click continues from). */
  set: (ids: Iterable<string>, anchor?: string | null) => void
  selectAll: () => void
  /** Nothing selected, and out of touch selection mode. */
  clear: () => void
  /** Touch selection mode, with this thread the first one selected. */
  startTouch: (id: string) => void
  /** Drops what the list no longer shows (a search, a folded project, a deleted thread). */
  keepOnly: (shown: ReadonlySet<string>) => void
  /** The scrolling list, so the order on screen can be read from it (set by `List`). */
  listRef: RefObject<HTMLDivElement | null>
  /** The thread ids on screen, top to bottom. */
  order: () => string[]
}

/**
 * The thread ids the list shows, top to bottom. A thread shown twice (Focus lists what runs again
 * under Running now: those rows are marked `data-dup`) counts once, in its main place.
 */
export function visibleOrder(list: HTMLElement | null): string[] {
  if (!list || !list.getClientRects().length) return []
  const rows = [...list.querySelectorAll<HTMLElement>('.agt-row[data-thread]')]
  const main = rows.filter((r) => !r.closest('[data-dup]')).map((r) => r.dataset.thread!)
  const mainSet = new Set(main)
  const extra = rows.filter((r) => r.closest('[data-dup]') && !mainSet.has(r.dataset.thread!)).map((r) => r.dataset.thread!)
  return [...new Set([...extra, ...main])]
}

export function useThreadSelection(): ThreadSelection {
  const [state, setState] = useState<State>(NONE)
  const listRef = useRef<HTMLDivElement | null>(null)
  const order = useCallback(() => visibleOrder(listRef.current), [])

  return useMemo<ThreadSelection>(() => {
    const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))
    const set = (ids: Iterable<string>, anchor?: string | null) =>
      setState((s) => {
        const next = new Set(ids)
        const a = anchor === undefined ? s.anchor : anchor
        return same(s.ids, next) && a === s.anchor ? s : { ...s, ids: next, anchor: a }
      })
    return {
      ids: state.ids,
      size: state.ids.size,
      anchor: state.anchor,
      touch: state.touch,
      active: state.ids.size > 0 || state.touch,
      has: (id) => state.ids.has(id),
      toggle: (id) =>
        setState((s) => {
          const next = new Set(s.ids)
          if (!next.delete(id)) next.add(id)
          return { ...s, ids: next, anchor: id }
        }),
      range: (id, add = false, from) => {
        const list = order()
        const start = list.indexOf(from ?? state.anchor ?? id)
        const end = list.indexOf(id)
        if (end < 0) return
        const [a, b] = start < 0 ? [end, end] : start < end ? [start, end] : [end, start]
        const base = add ? state.ids : []
        // The anchor stays where it was, so Shift+click twice moves the far end only.
        const keep = from ?? state.anchor
        setState((s) => ({ ...s, ids: new Set([...base, ...list.slice(a, b + 1)]), anchor: keep && list.includes(keep) ? keep : id }))
      },
      set,
      selectAll: () => set(order()),
      clear: () => setState((s) => (s === NONE || (!s.ids.size && !s.touch && s.anchor === null) ? s : NONE)),
      startTouch: (id) => setState({ ids: new Set([id]), anchor: id, touch: true }),
      keepOnly: (shown) =>
        setState((s) => {
          if (![...s.ids].some((id) => !shown.has(id))) return s
          return { ...s, ids: new Set([...s.ids].filter((id) => shown.has(id))), anchor: s.anchor && shown.has(s.anchor) ? s.anchor : null }
        }),
      listRef,
      order,
    }
  }, [state, order])
}
