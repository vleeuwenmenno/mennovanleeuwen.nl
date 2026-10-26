import './Select.css'
import { useEffect, useRef } from 'react'
import type { Thread } from '../../data/agents'
import { openMenuAt } from '../../os/ContextMenu'
import { Icon } from './bits'
import type { SideCtx } from './ctx'

// Selecting threads for the bulk actions, the part every sidebar style shares: how a row reacts to
// the mouse, the keyboard and a long press, the rubber band over the list, the tick box in front of
// a selected row and the bar with the actions. The selection itself is in selection.ts; the actions
// are the app's (Agents.tsx, `ctx.bulk`). Classic and the rest look as they always did until a
// selection starts.

/** A finger held this long on a row starts touch selection. */
const LONG_PRESS_MS = 450

/** Where a thread is not an ordinary click away: Ctrl/Cmd toggles it, Shift selects up to it. */
const extending = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => e.ctrlKey || e.metaKey || e.shiftKey

/**
 * What a thread row's button does for the selection: click (plain, Ctrl/Cmd, Shift), Space, a long
 * press on a touch screen (and the menu and drag that press would start by themselves).
 */
export function useRowSelect(ctx: SideCtx, t: Thread) {
  const sel = ctx.selection
  const timer = useRef<number | undefined>(undefined)
  const origin = useRef({ x: 0, y: 0 })
  /** The press that started selection is still going on (its click, menu and drag are not wanted). */
  const longPressed = useRef(false)
  const stop = () => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(() => stop, [])
  return {
    onPointerDown: (e: React.PointerEvent) => {
      longPressed.current = false
      if (e.pointerType === 'mouse' || !e.isPrimary || sel.touch) return
      origin.current = { x: e.clientX, y: e.clientY }
      stop()
      timer.current = window.setTimeout(() => {
        timer.current = undefined
        longPressed.current = true
        try {
          navigator.vibrate?.(12)
        } catch {
          /* no haptics */
        }
        sel.startTouch(t.id)
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (timer.current !== undefined && Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 10) stop()
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (longPressed.current) {
        longPressed.current = false
        return e.preventDefault()
      }
      if (e.shiftKey) {
        const from = sel.anchor ?? (ctx.mainKind === 'thread' ? ctx.selected : null)
        sel.range(t.id, e.ctrlKey || e.metaKey, from)
        return e.currentTarget.focus()
      }
      if (e.ctrlKey || e.metaKey) {
        sel.toggle(t.id)
        return e.currentTarget.focus()
      }
      if (sel.touch) return sel.toggle(t.id)
      if (sel.size) sel.clear()
      ctx.open(t.id)
    },
    // Space ticks the focused row (and does not also press its button).
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      if (e.shiftKey) sel.range(t.id, false, sel.anchor ?? t.id)
      else sel.toggle(t.id)
    },
    onKeyUp: (e: React.KeyboardEvent) => e.key === ' ' && e.preventDefault(),
    // A long press must not also open the row's menu (Android sends a contextmenu) or lift it for dragging.
    onContextMenu: (e: React.MouseEvent) => {
      if (!longPressed.current) return false
      e.preventDefault()
      return true
    },
    onDragStart: (e: React.DragEvent, drag: (e: React.DragEvent) => void) => (longPressed.current || sel.touch ? e.preventDefault() : drag(e)),
  }
}

/** The tick in front of a row while a selection is going on: click it to tick, Shift+click for a range. */
export function SelectCheck({ ctx, t }: { ctx: SideCtx; t: Thread }) {
  const sel = ctx.selection
  const on = sel.has(t.id)
  return (
    <button
      type="button"
      className={`agt-check ${on ? 'is-on' : ''}`}
      role="checkbox"
      aria-checked={on}
      aria-label={`Select “${t.title}”`}
      tabIndex={-1}
      onClick={(e) => (e.stopPropagation(), e.shiftKey ? sel.range(t.id, e.ctrlKey || e.metaKey, sel.anchor ?? t.id) : sel.toggle(t.id))}
    >
      {on && <Icon name="check" size={12} />}
    </button>
  )
}

/**
 * Dragging a rubber band over the list ticks the rows it touches. It starts on empty space (a
 * header, the gutter, below the last row) or on a row with Ctrl/Cmd or Shift held; a plain drag on a
 * row keeps its meaning (moving the thread into a project). Holding Ctrl/Cmd or Shift adds to the
 * selection instead of replacing it. The list scrolls while the pointer is near its top or bottom
 * edge. Mouse only: a finger scrolls, and long-presses for touch selection.
 */
export function useBandSelect(ctx: SideCtx) {
  const band = useRef<HTMLDivElement>(null)
  const sel = ctx.selection
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const list = e.currentTarget
    const el = e.target as HTMLElement
    if (el.closest('input, textarea, select, a, [contenteditable], .agt-rename, .agt-project-head')) return
    const mod = extending(e)
    const button = el.closest('button')
    const rowButton = button?.classList.contains('agt-item') && button.closest('.agt-row') ? button : null
    if (button && !(rowButton && mod)) return
    // No text selection, and no drag of the row: this is a band now (or a click on nothing).
    e.preventDefault()

    const box = list.getBoundingClientRect()
    const from = { x: e.clientX - box.left, y: e.clientY - box.top + list.scrollTop }
    const base = mod ? new Set(sel.ids) : new Set<string>()
    let last = { x: e.clientX, y: e.clientY }
    let active = false
    let lastHit: string | null = null
    let timer: number | undefined

    const update = () => {
      const r = list.getBoundingClientRect()
      const x = Math.min(Math.max(last.x - r.left, 0), r.width)
      const y = last.y - r.top + list.scrollTop
      const left = Math.min(from.x, x)
      const top = Math.min(from.y, y)
      const width = Math.abs(x - from.x)
      const height = Math.abs(y - from.y)
      const b = band.current
      if (b) Object.assign(b.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
      const ids = new Set(base)
      for (const row of list.querySelectorAll<HTMLElement>('.agt-row[data-thread]')) {
        const rr = row.getBoundingClientRect()
        const rt = rr.top - r.top + list.scrollTop
        if (rr.left - r.left < left + width && rr.right - r.left > left && rt < top + height && rt + rr.height > top) {
          ids.add(row.dataset.thread!)
          lastHit = row.dataset.thread!
        }
      }
      sel.set(ids, lastHit)
    }
    const tick = () => {
      const r = list.getBoundingClientRect()
      const edge = 34
      const over = last.y < r.top + edge ? last.y - (r.top + edge) : last.y > r.bottom - edge ? last.y - (r.bottom - edge) : 0
      if (!over) return
      const step = Math.max(2, Math.min(22, Math.abs(over) / 3)) * Math.sign(over)
      const before = list.scrollTop
      list.scrollTop += step
      if (list.scrollTop !== before) update()
    }
    const move = (ev: MouseEvent) => {
      last = { x: ev.clientX, y: ev.clientY }
      if (!active) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
        active = true
        list.classList.add('is-banding')
        window.getSelection()?.removeAllRanges()
        if (band.current) band.current.style.display = 'block'
        timer = window.setInterval(tick, 30)
      }
      update()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.clearInterval(timer)
      list.classList.remove('is-banding')
      if (band.current) band.current.style.display = 'none'
      if (active) {
        // The click that ends a drag (on the row it began on) is not a click on that row.
        const swallow = (ev: Event) => (ev.stopPropagation(), ev.preventDefault())
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 60)
      } else if (!mod && !rowButton) sel.clear()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return { onMouseDown, band }
}

/** What to do with the selected threads, at the bottom of the list (above the foot) while one is going on. */
export function BulkBar({ ctx }: { ctx: SideCtx }) {
  const { selection: sel, bulk, archived } = ctx
  if (!sel.active) return null
  const none = sel.size === 0 || bulk.busy
  return (
    <div className="agt-bulk" role="toolbar" aria-label="Selected threads">
      <div className="agt-bulk-head">
        <button className="agt-icon agt-mini" onClick={sel.clear} title="Clear the selection (Esc)" aria-label="Clear the selection">
          <Icon name="close" size={14} />
        </button>
        <strong className="agt-bulk-count" aria-live="polite">
          {sel.size ? `${sel.size} selected` : 'Select threads'}
        </strong>
        <button className="agt-bulk-all" onClick={sel.selectAll} title="Select every thread in the list (Ctrl+A)">
          Select all
        </button>
      </div>
      <div className="agt-bulk-actions">
        <button disabled={none} onClick={bulk.archive} title={archived ? 'Move the selected threads back to the list' : 'Archive the selected threads'}>
          <Icon name="archive" size={14} />
          <span>{archived ? 'Unarchive' : 'Archive'}</span>
        </button>
        <button disabled={none} onClick={(e) => openMenuAt(e.currentTarget, bulk.moveMenu(), 'above')} title="Move the selected threads to a project">
          <Icon name="folder" size={14} />
          <span>Move</span>
        </button>
        <button className="is-danger" disabled={none} onClick={bulk.remove} title="Delete the selected threads">
          <Icon name="trash" size={14} />
          <span>Delete</span>
        </button>
      </div>
    </div>
  )
}
