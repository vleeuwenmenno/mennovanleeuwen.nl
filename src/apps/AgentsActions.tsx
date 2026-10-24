import type { ReactNode } from 'react'
import { openMenuAt, type MenuItem } from '../os/ContextMenu'

// One action row for every message and card in a thread (your messages, answers, tool cards,
// image cards): the same small buttons in the same order, at the same edge, with More last.
// The row always takes its space, so showing it never moves anything; it fades in on hover or
// keyboard focus, and stays shown on touch screens (home.css, .agt-actions).

/** The row. Renders nothing when there is nothing in it, so a card without actions has no gap. */
export function ActionRow({ label, children }: { label: string; children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean)
  if (!items.length) return null
  return <div className="agt-actions" role="toolbar" aria-label={label}>{items}</div>
}

/** More: the overflow as a real menu. From the keyboard, its first item takes focus. */
export function MoreButton({ label, items }: { label: string; items: MenuItem[] }) {
  if (!items.some((i) => 'label' in i)) return null
  return <button type="button" className="btn btn-small" aria-haspopup="menu" aria-label={`${label}: more actions`} onClick={(e) => {
    openMenuAt(e.currentTarget, items)
    if (e.detail === 0) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.ctx-menu [role="menuitem"]:not(:disabled)')?.focus())
  }}>More</button>
}

/** Drops separators at the ends and doubled ones, so joined lists read cleanly. */
export function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const it of items) if (!('separator' in it) || (out.length && !('separator' in out[out.length - 1]))) out.push(it)
  while (out.length && 'separator' in out[out.length - 1]) out.pop()
  return out
}
