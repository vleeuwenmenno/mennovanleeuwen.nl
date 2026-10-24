import type { ReactNode } from 'react'
import { openMenuAt, type MenuItem } from '../os/ContextMenu'

// One action row for every message and card in a thread (your messages, answers, tool cards,
// image cards): the same quiet text buttons in the same order, with Options last. It sits on the
// message's own side: right under your messages, left under everything else. The row always
// takes its space, so showing it never moves anything; on a desktop it appears only while the
// pointer is over that message or something in it has keyboard focus, and on touch screens it is
// always shown (home.css, .agt-actions).

/** The class every button in a row uses: muted text, no border, highlighted on hover. */
export const ACTION = 'agt-act'

/** The row. Renders nothing when there is nothing in it, so a card without actions has no gap. */
export function ActionRow({ label, children }: { label: string; children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean)
  if (!items.length) return null
  return <div className="agt-actions" role="toolbar" aria-label={label}>{items}</div>
}

/** Options: the rest of the message's actions as a real menu. From the keyboard, its first item takes focus. */
export function MoreButton({ label, items }: { label: string; items: MenuItem[] }) {
  if (!items.some((i) => 'label' in i)) return null
  return <button type="button" className={ACTION} aria-haspopup="menu" aria-label={`${label} options`} onClick={(e) => {
    openMenuAt(e.currentTarget, items)
    if (e.detail === 0) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.ctx-menu [role="menuitem"]:not(:disabled)')?.focus())
  }}>Options</button>
}

/** Drops separators at the ends and doubled ones, so joined lists read cleanly. */
export function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const it of items) if (!('separator' in it) || (out.length && !('separator' in out[out.length - 1]))) out.push(it)
  while (out.length && 'separator' in out[out.length - 1]) out.pop()
  return out
}
