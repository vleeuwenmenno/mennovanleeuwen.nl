import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { openLink } from '../data/links'
import { notify } from './notify'

export type MenuItem =
  | { separator: true }
  | { label: string; onSelect?: () => void; disabled?: boolean; shortcut?: string; danger?: boolean; submenu?: MenuItem[]; swatch?: string; checked?: boolean; /** A second, smaller line under the label */ hint?: string }

/** `up`: the menu's bottom sits at y (a dropdown above its button); `altY`: where to flip up to when it doesn't fit below. */
type OpenMenu = { x: number; y: number; items: MenuItem[]; up?: boolean; altY?: number } | null

// One menu open at a time, app-wide, so any component can open it from a contextmenu event.
let current: OpenMenu = null
const listeners = new Set<() => void>()
const set = (m: OpenMenu) => {
  current = m
  listeners.forEach((l) => l())
}

type MenuEvent = { clientX: number; clientY: number; shiftKey?: boolean; target?: EventTarget | null; preventDefault: () => void; stopPropagation: () => void }

/** Shift+right-click always gets the browser's own menu, as an escape hatch. */
export function openContextMenu(e: MenuEvent, items: MenuItem[]) {
  if (e.shiftKey) return e.stopPropagation()
  e.preventDefault()
  e.stopPropagation()
  set({ x: e.clientX, y: e.clientY, items })
}

/** Where the browser's menu is the useful one: text fields (paste, spelling), selected text
 * (copy), and anything holding Shift. */
export function wantsNativeMenu(e: { shiftKey?: boolean; target?: EventTarget | null }): boolean {
  if (e.shiftKey) return true
  const el = e.target instanceof Element ? e.target : null
  if (el?.closest('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, [contenteditable="true"]')) return true
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && !!sel.toString().trim() && !!el && sel.containsNode(el, true)
}

/** The link under the pointer, if any (only real web links). */
export function linkAt(target: EventTarget | null): string | null {
  const a = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
  return a && /^https?:|^mailto:/.test(a.href) ? a.href : null
}

export const linkMenu = (href: string): MenuItem[] => [
  { label: href.startsWith('mailto:') ? 'Write an email' : 'Open link ↗', onSelect: () => (href.startsWith('mailto:') ? window.open(href, '_blank', 'noopener') : openLink(href)) },
  { label: href.startsWith('mailto:') ? 'Copy address' : 'Copy link', onSelect: () => navigator.clipboard?.writeText(href.replace(/^mailto:/, '')).catch(() => {}) },
]

/**
 * Undo, cut, copy, paste and select all for a text field, as the desktop's own menu. Edits go
 * through the browser's editing commands, so a controlled field (React) sees them and Ctrl+Z still
 * undoes them.
 */
export function fieldMenu(el: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  const ro = el.readOnly || el.disabled
  const secret = el instanceof HTMLInputElement && el.type === 'password'
  const sel = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
  const run = (cmd: string, value?: string) => {
    el.focus()
    document.execCommand(cmd, false, value)
  }
  return [
    { label: 'Undo', shortcut: 'Ctrl Z', disabled: ro, onSelect: () => run('undo') },
    { label: 'Redo', shortcut: 'Ctrl Shift Z', disabled: ro, onSelect: () => run('redo') },
    { separator: true },
    { label: 'Cut', shortcut: 'Ctrl X', disabled: ro || secret || !sel, onSelect: () => void navigator.clipboard?.writeText(sel).then(() => run('delete'), () => {}) },
    { label: 'Copy', shortcut: 'Ctrl C', disabled: secret || !sel, onSelect: () => void navigator.clipboard?.writeText(sel).catch(() => {}) },
    {
      label: 'Paste',
      shortcut: 'Ctrl V',
      disabled: ro,
      onSelect: () =>
        void navigator.clipboard?.readText().then(
          (text) => text && run('insertText', text),
          () => notify({ title: 'Could not paste', body: 'The browser did not allow reading the clipboard. Ctrl+V still works.' }),
        ),
    },
    { label: 'Select all', shortcut: 'Ctrl A', onSelect: () => (el.focus(), el.select()) },
  ]
}

/** The text selected inside `root`, if the selection is there at all. */
export function selectionIn(root: Element): string {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return ''
  const range = sel.getRangeAt(0)
  return root.contains(range.commonAncestorContainer) ? sel.toString().trim() : ''
}

/** Drops separators at the ends and doubled ones, for menus built from optional parts. */
export function tidyMenu(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const item of items) {
    if ('separator' in item && (!out.length || 'separator' in out[out.length - 1])) continue
    out.push(item)
  }
  while (out.length && 'separator' in out[out.length - 1]) out.pop()
  return out
}

/**
 * The last word on right-clicks nobody handled: links get a small menu, text fields and selections
 * keep the browser's, everything else gets nothing (instead of "View Page Source" on a desktop).
 */
export function installContextMenuFallback() {
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || wantsNativeMenu(e)) return
    const href = linkAt(e.target)
    if (href) openContextMenu(e, linkMenu(href))
    else e.preventDefault()
  })
}

export const closeContextMenu = () => set(null)

/**
 * A dropdown from a button: below it, flipping above when there is no room, or above it to
 * begin with (for buttons at the bottom of a window).
 */
export function openMenuAt(anchor: Element, items: MenuItem[], place: 'below' | 'above' = 'below') {
  const r = anchor.getBoundingClientRect()
  set(place === 'above' ? { x: r.left, y: r.top - 4, items, up: true } : { x: r.left, y: r.bottom + 4, items, altY: r.top - 4 })
}

function MenuList({ items, x, y, altX, up, altY, onClose }: { items: MenuItem[]; x: number; y: number; altX?: number; up?: boolean; altY?: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [subPos, setSubPos] = useState({ x: 0, y: 0, altX: 0 })

  // Keep the menu on screen: flip left/up when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = x + r.width > window.innerWidth - 8 ? Math.max(8, (altX ?? x) - r.width) : x
    let ny = up ? y - r.height : y
    if (ny < 8) ny = 8
    else if (ny + r.height > window.innerHeight - 8) ny = altY !== undefined && altY - r.height >= 8 ? altY - r.height : Math.max(8, window.innerHeight - r.height - 8)
    setPos({ x: nx, y: ny })
  }, [x, y, altX, up, altY])

  // The submenu is a sibling, not a child: the menu's entry animation uses a transform, which
  // would make a nested position:fixed element position relative to the menu instead of the viewport.
  return (
    <>
      <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((item, i) =>
          'separator' in item ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`ctx-item ${item.danger ? 'is-danger' : ''} ${openSub === i ? 'is-open' : ''}`}
              disabled={item.disabled}
              onPointerEnter={(e) => {
                if (item.submenu) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSubPos({ x: r.right + 2, y: r.top - 5, altX: r.left - 2 })
                  setOpenSub(i)
                } else setOpenSub(null)
              }}
              onClick={(e) => {
                if (item.submenu) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSubPos({ x: r.right + 2, y: r.top - 5, altX: r.left - 2 })
                  setOpenSub(i)
                  return
                }
                onClose()
                item.onSelect?.()
              }}
            >
              {item.checked !== undefined && <span className="ctx-check">{item.checked ? '✓' : ''}</span>}
              {item.swatch && <span className="ctx-swatch" style={{ background: item.swatch }} />}
              {item.hint ? (
                <span className="ctx-label ctx-two">
                  {item.label}
                  <small>{item.hint}</small>
                </span>
              ) : (
                <span className="ctx-label">{item.label}</span>
              )}
              {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
              {item.submenu && <span className="ctx-arrow">›</span>}
            </button>
          ),
        )}
      </div>
      {openSub !== null && 'submenu' in items[openSub] && (
        <MenuList items={(items[openSub] as { submenu: MenuItem[] }).submenu} x={subPos.x} y={subPos.y} altX={subPos.altX} onClose={onClose} />
      )}
    </>
  )
}

export function ContextMenuHost() {
  const menu = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )

  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
      if (e.type === 'pointerdown' && (e.target as HTMLElement).closest('.ctx-menu')) return
      set(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null
  return <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} up={menu.up} altY={menu.altY} onClose={() => set(null)} />
}
