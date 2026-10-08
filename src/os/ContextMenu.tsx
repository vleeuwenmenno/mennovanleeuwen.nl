import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

export type MenuItem =
  | { separator: true }
  | { label: string; onSelect?: () => void; disabled?: boolean; shortcut?: string; danger?: boolean; submenu?: MenuItem[]; swatch?: string; checked?: boolean }

type OpenMenu = { x: number; y: number; items: MenuItem[] } | null

// One menu open at a time, app-wide, so any component can open it from a contextmenu event.
let current: OpenMenu = null
const listeners = new Set<() => void>()
const set = (m: OpenMenu) => {
  current = m
  listeners.forEach((l) => l())
}

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]) {
  e.preventDefault()
  e.stopPropagation()
  set({ x: e.clientX, y: e.clientY, items })
}

export const closeContextMenu = () => set(null)

function MenuList({ items, x, y, altX, onClose }: { items: MenuItem[]; x: number; y: number; altX?: number; onClose: () => void }) {
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
    const ny = y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : y
    setPos({ x: nx, y: ny })
  }, [x, y, altX])

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
              <span className="ctx-label">{item.label}</span>
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
  return <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} onClose={() => set(null)} />
}
