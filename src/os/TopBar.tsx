import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useRecents } from '../data/recents'
import { useSpotlightPrefs } from '../data/spotlightPrefs'
import { APP_META } from './apps'
import { appearanceMenu } from './appearanceMenu'
import { tidyMenu, openContextMenu, type MenuItem } from './ContextMenu'
import { NotificationCenter } from './NotificationCenter'
import { toggleOverlay } from './overlays'
import { toggleMode, useTheme } from './theme'
import {
  DEFAULT_ORDER,
  isTopbarHidden,
  resetTopbar,
  resolveTopbar,
  setTopbarLocked,
  setTopbarOrder,
  toggleTopbarWidget,
  topbarPrefs,
  TOPBAR_IDS,
  TOPBAR_LABELS,
  useTopbarPrefs,
  type TopbarId,
  type TopbarSlot,
} from './topbarPrefs'
import { ClockWidget, MinecraftWidget, SystemMenu } from './TopbarWidgets'
import { useWM, workspaceOf, WORKSPACES, type WinState } from './wm'
import { toUi } from './uiScale'

const DRAG_SLOP = 6

const winTitle = (w: WinState) => APP_META[w.app].titleOf?.(w) ?? APP_META[w.app].dock

function stepWorkspace(wm: { workspace: number; elsewhere: number[] }, by: number, last: number) {
  for (let n = wm.workspace + by; n >= 1 && n <= last; n += by) if (!wm.elsewhere.includes(n)) return n
  return wm.workspace
}

function WorkspacesWidget() {
  const wm = useWM()
  const onWs = (n: number) => wm.windows.filter((w) => workspaceOf(w) === n).sort((a, b) => a.pid - b.pid)
  const occupied = new Set(wm.windows.map(workspaceOf).filter((n): n is number => n !== null))
  const count = Math.min(WORKSPACES, Math.max(5, wm.workspace, ...occupied, ...wm.elsewhere))
  const elsewhere = (n: number) => wm.elsewhere.includes(n)
  const focusedWin = wm.windows.find((w) => w.pid === wm.focusedPid && workspaceOf(w) !== null)
  const workspaceMenu = (n: number): MenuItem[] => {
    const wins = onWs(n)
    return [
      { label: elsewhere(n) ? `Workspace ${n} · open in another tab` : `Workspace ${n}`, disabled: true },
      { separator: true },
      ...(n !== wm.workspace && !elsewhere(n) ? [{ label: 'Go to workspace', shortcut: `Alt ${n}`, onSelect: () => wm.setWorkspace(n) }] : []),
      ...(focusedWin && workspaceOf(focusedWin) !== n
        ? [
            {
              label: elsewhere(n) ? `Send ${winTitle(focusedWin)} to that tab` : `Move ${winTitle(focusedWin)} here`,
              shortcut: `Alt Shift ${n}`,
              onSelect: () => wm.moveToWorkspace(focusedWin.pid, n),
            },
          ]
        : []),
      ...(wins.length
        ? [{ separator: true as const }, ...wins.map((w) => ({ label: `${winTitle(w)}${w.minimized ? ' (minimized)' : ''}`, onSelect: () => wm.focus(w.pid) }))]
        : [{ label: 'No windows', disabled: true }]),
      ...(wins.length
        ? [
            { separator: true as const },
            {
              label: wins.length > 1 ? `Close all ${wins.length} windows` : 'Close its window',
              danger: true,
              onSelect: () => wins.forEach((w) => wm.close(w.pid)),
            },
          ]
        : []),
    ]
  }
  const onWheel = (e: React.WheelEvent) => {
    const by = Math.sign(e.deltaY || e.deltaX)
    if (by) wm.setWorkspace(stepWorkspace(wm, by, count))
  }
  return (
    <nav className="workspaces" aria-label="Workspaces" onWheel={onWheel}>
      {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
        const wins = onWs(n)
        return (
          <button
            key={n}
            data-ws={n}
            className={`ws ${n === wm.workspace ? 'is-active' : ''} ${wins.length ? '' : 'is-empty'} ${elsewhere(n) ? 'is-elsewhere' : ''}`}
            onClick={() => wm.setWorkspace(n)}
            onContextMenu={(e) => openContextMenu(e, workspaceMenu(n))}
            title={
              elsewhere(n)
                ? `Workspace ${n} · Open in another tab`
                : `Workspace ${n} (Alt ${n})${wins.length ? ` · ${[...new Set(wins.map((w) => APP_META[w.app].dock))].join(', ')}` : ' · empty'}`
            }
            aria-current={n === wm.workspace ? 'true' : undefined}
          >
            {n}
          </button>
        )
      })}
    </nav>
  )
}

function SearchWidget() {
  const ctrlSpace = useSpotlightPrefs().ctrlSpace
  return (
    <button className="tb-icon" onClick={() => toggleOverlay('spotlight')} title={ctrlSpace === 'spotlight' ? 'Search (Ctrl+Space)' : 'Search (Ctrl+K)'} aria-label="Search">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
    </button>
  )
}

function ActivityWidget() {
  const wm = useWM()
  const recents = useRecents()
  return (
    <button
      className="tb-icon tb-activity"
      onClick={() => wm.open('recents')}
      title={recents.live ? 'Activity · GitHub live' : recents.status === 'loading' ? 'Activity · syncing' : 'Activity · offline'}
      aria-label="Recent activity"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
      </svg>
      <span className={`tb-dot ${recents.live ? 'is-live' : ''}`} />
    </button>
  )
}

function ThemeWidget() {
  const theme = useTheme()
  return (
    <button
      className="tb-icon"
      title={`${theme.label} · click for ${theme.palette.mode === 'light' ? 'night' : 'day'}, right-click for themes`}
      aria-label="Toggle light and dark theme"
      onClick={toggleMode}
      onContextMenu={(e) => openContextMenu(e, appearanceMenu())}
    >
      {theme.palette.mode === 'light' ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  )
}

const WIDGETS: Record<TopbarId, () => ReactNode> = {
  menu: () => <SystemMenu />,
  workspaces: () => <WorkspacesWidget />,
  clock: () => <ClockWidget />,
  search: () => <SearchWidget />,
  activity: () => <ActivityWidget />,
  minecraft: () => <MinecraftWidget />,
  theme: () => <ThemeWidget />,
  notifications: () => <NotificationCenter />,
}

export function TopBar() {
  const wm = useWM()
  const prefs = useTopbarPrefs()
  const unlocked = !prefs.locked
  const resolved = resolveTopbar(prefs)
  const resolvedKey = resolved.join('|')
  const [order, setOrder] = useState<TopbarSlot[]>(resolved)
  const orderRef = useRef(order)
  orderRef.current = order
  const [dragging, setDragging] = useState<{ index: number; clientX: number; grabOffset: number } | null>(null)
  const drag = useRef<{ index: number; startX: number; moved: boolean } | null>(null)
  const items = useRef(new Map<number, HTMLElement>())
  const suppressClick = useRef(false)
  const cancelDrag = useRef<(() => void) | null>(null)

  useEffect(() => () => cancelDrag.current?.(), [])
  useEffect(() => {
    cancelDrag.current?.()
  }, [resolvedKey, prefs.locked, prefs.hidden.join('|')])

  useEffect(() => {
    if (drag.current) return
    setOrder(resolved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedKey, prefs.locked, prefs.hidden.join('|')])

  const mine = wm.windows.filter((w) => wm.shown(w))
  const customized = prefs.order.join() !== DEFAULT_ORDER.join() || prefs.hidden.length > 0
  const ctrlSpace = useSpotlightPrefs().ctrlSpace

  const barMenu = (): MenuItem[] => {
    const widgets: MenuItem[] = TOPBAR_IDS.map((id) => ({
      label: TOPBAR_LABELS[id],
      checked: !isTopbarHidden(id, prefs),
      onSelect: () => toggleTopbarWidget(id),
    }))
    return tidyMenu([
      unlocked
        ? { label: 'Lock the top bar', onSelect: () => setTopbarLocked(true) }
        : { label: 'Unlock the top bar', onSelect: () => setTopbarLocked(false) },
      ...(unlocked
        ? [{ label: 'Show or hide', submenu: widgets }, ...(customized ? [{ label: 'Reset top bar', onSelect: resetTopbar }] : [])]
        : []),
      { separator: true },
      { label: 'Search…', shortcut: ctrlSpace === 'spotlight' ? 'Ctrl Space' : 'Ctrl K', onSelect: () => toggleOverlay('spotlight') },
      { label: 'All apps', shortcut: ctrlSpace === 'spotlight' ? 'Ctrl K' : 'Ctrl Space', onSelect: () => toggleOverlay('launchpad') },
      { label: 'Show desktop', disabled: !mine.some((w) => !w.minimized), onSelect: () => mine.forEach((w) => wm.minimize(w.pid)) },
      { separator: true },
      { label: 'Settings', onSelect: () => wm.open('settings', { t: String(Date.now()) }) },
      { label: 'About this system', onSelect: () => wm.open('about', { t: String(Date.now()) }) },
    ])
  }

  useLayoutEffect(() => {
    // Read the slot's new natural position after each reorder, so the handle stays under the finger.
    for (const node of items.current.values()) node.style.transform = ''
    if (!dragging) return
    const node = items.current.get(dragging.index)
    if (node) node.style.transform = `translateX(${toUi(dragging.clientX - dragging.grabOffset - node.getBoundingClientRect().left)}px)`
  }, [dragging, order])

  const saveOrder = (next: TopbarSlot[]) => {
    const current = topbarPrefs()
    if (current.locked) return
    const hiddenSlots = current.order.filter((s) => s !== 'spacer' && isTopbarHidden(s, current))
    setTopbarOrder([...next, ...hiddenSlots])
  }

  const moveSlot = (index: number, by: number) => {
    const next = [...orderRef.current]
    // CSS-hidden mobile widgets have no position to move to.
    let to = index + by
    while (to >= 0 && to < next.length && !items.current.get(to)?.getBoundingClientRect().width) to += by
    if (to < 0 || to >= next.length) return
    const [slot] = next.splice(index, 1)
    next.splice(to, 0, slot)
    saveOrder(next)
  }

  const onSlotPointerDown = (e: React.PointerEvent, index: number, handle = false) => {
    if (!unlocked || e.button !== 0 || !e.isPrimary || (e.pointerType !== 'mouse' && !handle)) return
    if (cancelDrag.current) return
    e.stopPropagation()
    // Keyed slots move in the DOM during reordering, so capture on the stable root.
    const capture = document.documentElement
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    const original = [...orderRef.current]
    const el = items.current.get(index)
    if (!el) return
    const grabOffset = startX - el.getBoundingClientRect().left

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      let d = drag.current
      if (!d) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= DRAG_SLOP) return
        d = { index, startX, moved: true }
        drag.current = d
        // Wait for a drag so a stationary handle press still clicks its own menu.
        capture.setPointerCapture(pointerId)
      }
      ev.preventDefault()
      document.body.classList.add('is-dragging')
      const node = items.current.get(d.index)
      if (!node) return
      const from = d.index
      const slot = orderRef.current[from]
      const others = orderRef.current.filter((_, i) => i !== from)
      // Keep CSS-hidden slots in the saved layout without treating their zero rect as a target.
      let at = from
      for (let i = 0; i < orderRef.current.length; i++) {
        if (i === from) continue
        const r = items.current.get(i)?.getBoundingClientRect()
        if (!r?.width) continue
        if (i < from && ev.clientX < r.left + r.width / 2) { at = i; break }
        if (i > from && ev.clientX > r.left + r.width / 2) at = i
      }
      const arranged = [...others.slice(0, at), slot, ...others.slice(at)]
      if (at !== from) {
        d.index = at
        orderRef.current = arranged
        setOrder(arranged)
      }
      setDragging({ index: d.index, clientX: ev.clientX, grabOffset })
    }

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('keydown', onKey)
      capture.removeEventListener('lostpointercapture', onLostCapture)
      cancelDrag.current = null
      const moved = !!drag.current?.moved
      drag.current = null
      document.body.classList.remove('is-dragging')
      if (capture.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId)
      if (moved) {
        suppressClick.current = true
        setTimeout(() => (suppressClick.current = false), 400)
      }
      if (commit && moved) saveOrder(orderRef.current)
      else {
        orderRef.current = original
        setOrder(resolveTopbar(topbarPrefs()))
      }
      setDragging(null)
    }
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(true) }
    const onCancel = (ev?: Event) => {
      if (ev instanceof PointerEvent && ev.pointerId !== pointerId) return
      finish(false)
    }
    // The handle loses its implicit touch capture when capture transfers to the root.
    // Ignore that bubbled loss; only losing the root's own capture cancels the drag.
    const onLostCapture = (ev: PointerEvent) => { if (ev.target === capture) onCancel(ev) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); finish(false) } }
    cancelDrag.current = onCancel
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKey)
    capture.addEventListener('lostpointercapture', onLostCapture)
  }

  const reorderHandle = (slot: TopbarSlot, index: number) => unlocked && (
    <button
      type="button"
      className="topbar-reorder-handle"
      aria-label={`Reorder ${slot === 'spacer' ? 'spacer' : TOPBAR_LABELS[slot]}`}
      title="Drag to reorder; Left/Right arrows to move; tap for menu"
      aria-description="Use Left and Right arrow keys to move, or activate for move and lock actions."
      onPointerDown={(e) => onSlotPointerDown(e, index, true)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        e.stopPropagation()
        moveSlot(index, e.key === 'ArrowLeft' ? -1 : 1)
      }}
      onClick={(e) => openContextMenu(e, [
        { label: 'Move left', onSelect: () => moveSlot(index, -1) },
        { label: 'Move right', onSelect: () => moveSlot(index, 1) },
        { separator: true },
        ...barMenu(),
      ])}
    >↔</button>
  )

  const editMenu = (e: React.MouseEvent) => {
    if (!unlocked) return
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e, barMenu())
  }

  return (
    <header
      className={`topbar ${unlocked ? 'is-unlocked' : ''} ${dragging ? 'is-reordering' : ''}`}
      data-no-touch-menu={unlocked ? '' : undefined}
      onPointerDownCapture={() => { suppressClick.current = false }}
      onContextMenu={(e) => openContextMenu(e, barMenu())}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {order.map((slot, index) => {
        const isDragged = dragging?.index === index
        const style = isDragged ? { zIndex: 2 } : undefined
        if (slot === 'spacer') {
          return (
            <div
              key={`spacer-${order.slice(0, index).filter((s) => s === 'spacer').length}`}
              ref={(el) => {
                if (el) items.current.set(index, el)
                else items.current.delete(index)
              }}
              className={`topbar-spacer ${isDragged ? 'is-dragged' : ''}`}
              data-id="spacer"
              style={style}
              onPointerDown={(e) => onSlotPointerDown(e, index)}
              onContextMenu={editMenu}
            >
              {reorderHandle(slot, index)}
            </div>
          )
        }
        const Widget = WIDGETS[slot]
        return (
          <div
            key={slot}
            ref={(el) => {
              if (el) items.current.set(index, el)
              else items.current.delete(index)
            }}
            className={`topbar-slot ${isDragged ? 'is-dragged' : ''}`}
            data-id={slot}
            style={style}
            onPointerDown={(e) => onSlotPointerDown(e, index)}
            onContextMenu={editMenu}
          >
            {Widget()}
            {reorderHandle(slot, index)}
          </div>
        )
      })}
    </header>
  )
}
