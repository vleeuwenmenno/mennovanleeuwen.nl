import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from 'react'
import { toUi } from './uiScale'
import { splitDragValue, splitKeyValue, type SplitEdge } from './splitMath'
import './useSplitter.css'

export { SPLIT_STEP, SPLIT_STEP_BIG, clampSplit, splitDragValue, splitKeyValue, type SplitEdge } from './splitMath'

// A vertical splitter between two panes, shared by the apps that have one. The hook owns the
// pointer and keyboard behaviour and the separator's accessibility; the caller owns the width.
//
// While the pointer is down, `onPreview` gets the width at most once per frame: set a CSS variable
// with it, don't render. `onCommit` follows once, when the pointer is let go on a different width;
// a cancel (pointercancel, Escape, losing the capture) puts `onPreview` back at the start width and
// never commits. The keyboard commits straight away.

export type SplitterOptions = {
  edge: SplitEdge
  value: number
  min: number
  max: number
  label: string
  onPreview: (v: number) => void
  onCommit: (v: number) => void
  /** Double click and Enter: back to the default width. */
  onReset: () => void
}

type Drag = { id: number; el: HTMLElement; startX: number; start: number; value: number; frame: number }

/** Spread the result on the handle element: `<div {...useSplitter(...).props} />`. */
export function useSplitter(o: SplitterOptions): { props: HTMLAttributes<HTMLDivElement> & { 'data-no-touch-menu': string }; dragging: boolean } {
  const latest = useRef(o)
  latest.current = o
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)

  const finish = (commit: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    cancelAnimationFrame(d.frame)
    try {
      d.el.releasePointerCapture(d.id)
    } catch {
      // Already released.
    }
    setDragging(false)
    const { onPreview, onCommit } = latest.current
    if (commit && d.value !== d.start) {
      onPreview(d.value)
      onCommit(d.value)
    } else {
      onPreview(d.start)
      d.el.setAttribute('aria-valuenow', String(d.start))
    }
  }
  // Unmounted in the middle of a drag: nothing to commit.
  useEffect(() => () => finish(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  // Escape during a drag puts the width back, caught before anything else acts on it.
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dragging]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current || (e.button !== 0 && e.pointerType === 'mouse')) return
    e.preventDefault()
    const el = e.currentTarget
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // Not capturable (the pointer already went): the drag then ends on cancel.
    }
    el.focus({ preventScroll: true })
    drag.current = { id: e.pointerId, el, startX: toUi(e.clientX), start: latest.current.value, value: latest.current.value, frame: 0 }
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const { edge, min, max } = latest.current
    const v = splitDragValue(d.start, toUi(e.clientX) - d.startX, edge, min, max)
    if (v === d.value) return
    d.value = v
    if (d.frame) return
    d.frame = requestAnimationFrame(() => {
      d.frame = 0
      d.el.setAttribute('aria-valuenow', String(d.value))
      latest.current.onPreview(d.value)
    })
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current && e.pointerId === drag.current.id) finish(true)
  }
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current && e.pointerId === drag.current.id) finish(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const { edge, value, min, max, onCommit, onReset } = latest.current
    const next = splitKeyValue(e.key, e.shiftKey, value, edge, min, max)
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    if (next === 'reset') onReset()
    else if (next !== value) onCommit(next)
  }

  return {
    dragging,
    props: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': o.label,
      'aria-valuemin': o.min,
      'aria-valuemax': o.max,
      'aria-valuenow': o.value,
      tabIndex: 0,
      className: `usplit is-${o.edge}${dragging ? ' is-dragging' : ''}`,
      'data-no-touch-menu': '',
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture: () => finish(false),
      onKeyDown,
      onDoubleClick: () => latest.current.onReset(),
    },
  }
}
