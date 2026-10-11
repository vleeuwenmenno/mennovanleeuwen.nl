import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { addWidgetItems } from '../widgets/registry'
import { APP_META } from './apps'
import { cancelTouchMenu, linkAt, linkMenu, openContextMenu, wantsNativeMenu, type MenuItem } from './ContextMenu'
import { getDockMode, snapReserve } from './dockPrefs'
import { setSnapPreview } from './snapPreview'
import { useSwing } from './swing'
import { WindowMenuContext } from './windowMenu'
import { drawnHeight, fitNote, setDrawnHeight, SINGLE_INSTANCE, snapRect, stackOrder, useWM, type Geometry, type SnapZone, type WinState } from './wm'

const TOP_BAR = 28
const MIN_W = 280
const MIN_H = 180
const EDGE = 14 // how close to a screen edge the pointer must be to snap
const CORNER = 110 // within this distance of the top or bottom, a side edge means a quarter

type Props = {
  win: WinState
  title: string
  chrome?: 'default' | 'note'
  className?: string
  /** Extra inline style, e.g. a sticky's colour and tilt as CSS variables */
  style?: CSSProperties
  /** The app's own items, shown first in the window menu (a widget's settings) */
  menuItems?: MenuItem[]
  /** What "Close" is called in the menu ("Take off the desktop") */
  closeLabel?: string
  /** A width handle on a note-style window (widgets) */
  resizableWidth?: boolean
  children: ReactNode
}

type Drag = { mode: 'move' | 'resize' | 'stack'; edge: string; startX: number; startY: number; x: number; y: number; w: number; h: number; moved: boolean; /** How far the phone desktop was scrolled when the finger went down */ scroll?: number }
type Target = SnapZone | 'max' | null

// ---------------------------------------------------------------------------------------------
// Phones stack the notes in one column down a desktop that scrolls (styles.css, stackOrder in
// wm.tsx). There, dragging a note by its top strip moves it up or down the column: the note lifts
// and follows the finger, the others slide out of its way, and a dashed slot shows where it will
// land. The desktop scrolls by itself when the finger nears the top bar or the dock.

/** A note being moved in the column: where every shown note sat when it started, top to bottom. */
type Lift = {
  slots: { pid: number; el: HTMLElement; top: number; h: number }[]
  from: number
  to: number
  gap: number
  scroller: HTMLElement
  startY: number
  startScroll: number
  /** Where the finger is now, for the auto-scroll to move the note along with the page */
  y: number
  dy: number
  raf: number
}

/** The landing slot, drawn by NoteStackSlot in the windows layer (Shell). */
let slot: { top: number; h: number } | null = null
const slotListeners = new Set<() => void>()
const setSlot = (next: typeof slot) => {
  if (next?.top === slot?.top && next?.h === slot?.h) return
  slot = next
  slotListeners.forEach((l) => l())
}

export function NoteStackSlot() {
  const s = useSyncExternalStore(
    (l) => {
      slotListeners.add(l)
      return () => slotListeners.delete(l)
    },
    () => slot,
  )
  return s ? <div className="note-slot" style={{ top: s.top, height: s.h }} aria-hidden /> : null
}

/** `order` (every note) with its shown notes put in the order of `shown`; hidden ones keep their place. */
function withShown(order: number[], shown: number[]): number[] {
  const set = new Set(shown)
  let k = 0
  return order.map((pid) => (set.has(pid) ? shown[k++] : pid))
}

/** Which snap zone the pointer is in: sides halve, corners quarter, the top edge maximizes. */
function zoneAt(x: number, y: number): Target {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = x <= EDGE
  const right = x >= vw - EDGE
  const nearTop = y <= TOP_BAR + CORNER
  const nearBottom = y >= vh - CORNER
  if (left || right) {
    if (nearTop) return left ? 'tl' : 'tr'
    if (nearBottom) return left ? 'bl' : 'br'
    return left ? 'left' : 'right'
  }
  if (y <= TOP_BAR + 4) return 'max'
  return null
}

const SNAPS: [SnapZone, string][] = [
  ['left', 'Left half'],
  ['right', 'Right half'],
  ['tl', 'Top left quarter'],
  ['tr', 'Top right quarter'],
  ['bl', 'Bottom left quarter'],
  ['br', 'Bottom right quarter'],
]

const noSelect = (e: Event) => e.preventDefault()

const maxRect = (): Geometry => ({ x: 10, y: TOP_BAR + 10, w: window.innerWidth - 20, h: window.innerHeight - TOP_BAR - 20 - (getDockMode() === 'show' ? snapReserve() : 0) })

export function Window({ win, title, chrome = 'default', className = '', style, menuItems = [], closeLabel = 'Close', resizableWidth = false, children }: Props) {
  const wm = useWM()
  const drag = useRef<Drag | null>(null)
  const target = useRef<Target>(null)
  const focused = wm.focusedPid === win.pid
  const canSnap = chrome === 'default' && window.innerWidth >= 720
  const sectionRef = useRef<HTMLElement>(null)
  const swing = useSwing(sectionRef, 'notes')

  // A note's text can run on below its box: how tall it really shows, so it is never fitted
  // half off the bottom of the screen (fitNote in wm.tsx).
  useEffect(() => {
    const el = sectionRef.current
    if (chrome !== 'note' || !el) return
    let last = 0
    const measure = () => {
      const h = Math.max(el.offsetHeight, ...[...el.children].map((c) => (c as HTMLElement).offsetTop + (c as HTMLElement).offsetHeight))
      if (Math.abs(h - last) < 2) return
      last = h
      setDrawnHeight(win.pid, h)
      wm.refit()
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    return () => {
      ro.disconnect()
      setDrawnHeight(win.pid, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chrome, win.pid])

  // On a phone a note's strip moves it within the column instead of around the screen.
  const phoneStack = chrome === 'note' && window.innerWidth < 720
  const lift = useRef<Lift | null>(null)

  const begin = (mode: Drag['mode'], edge = '') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    if (win.maximized && mode === 'resize') return
    if (mode === 'move' && phoneStack) mode = 'stack'
    e.preventDefault()
    wm.focus(win.pid)
    const el = e.currentTarget as HTMLElement
    drag.current = { mode, edge, startX: e.clientX, startY: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h, moved: false, scroll: el.closest('.desk-scroll')?.scrollTop }
    el.setPointerCapture(e.pointerId)
    document.body.classList.add(mode === 'resize' ? 'is-resizing' : 'is-dragging')
    // No text gets selected on the way, whatever the browser does with the pointer.
    document.addEventListener('selectstart', noSelect)
  }

  // --- moving a note within the phone column ---

  /** `startY` and `startScroll`: where the finger went down and how far the desktop was scrolled then. */
  const liftStart = (startY: number, startScroll: number | undefined, y: number) => {
    const el = sectionRef.current
    const scroller = el?.closest<HTMLElement>('.desk-scroll')
    if (!el || !scroller) return
    const slots = stackOrder(wm.windows)
      .map((pid) => ({ pid, el: document.querySelector<HTMLElement>(`.window.chrome-note[data-pid="${pid}"]`) }))
      .filter((s): s is { pid: number; el: HTMLElement } => !!s.el && s.el.offsetParent !== null)
      .map((s) => ({ ...s, top: s.el.offsetTop, h: s.el.offsetHeight }))
    const from = slots.findIndex((s) => s.pid === win.pid)
    if (from < 0) return
    const gap = parseFloat(getComputedStyle(el.parentElement!).rowGap) || 18
    lift.current = { slots, from, to: from, gap, scroller, startY, startScroll: startScroll ?? scroller.scrollTop, y, dy: 0, raf: 0 }
    for (const s of slots) s.el.toggleAttribute(s.pid === win.pid ? 'data-lifting' : 'data-shifting', true)
    // Near the top bar or the dock, the desktop scrolls, faster the closer the finger gets.
    const tick = () => {
      const L = lift.current
      if (!L) return
      const top = TOP_BAR + 70
      const bottom = window.innerHeight - 130
      const v = L.y < top ? -Math.min(18, (top - L.y) / 4) : L.y > bottom ? Math.min(18, (L.y - bottom) / 4) : 0
      if (v) {
        const before = L.scroller.scrollTop
        L.scroller.scrollTop += v
        if (L.scroller.scrollTop !== before) liftMove(L.y)
      }
      L.raf = requestAnimationFrame(tick)
    }
    lift.current.raf = requestAnimationFrame(tick)
    liftMove(y)
  }

  const liftMove = (y: number) => {
    const L = lift.current
    if (!L) return
    L.y = y
    const me = L.slots[L.from]
    const first = L.slots[0]
    const last = L.slots[L.slots.length - 1]
    // The note follows the finger (and the page, when it scrolls), but stays within the column,
    // so the page can't keep growing under an auto-scroll.
    L.dy = Math.min(Math.max(y - L.startY + L.scroller.scrollTop - L.startScroll, first.top - me.top), last.top + last.h - me.h - me.top)
    me.el.style.translate = `0 ${L.dy}px`
    // Its place: above every note whose middle its top edge has passed going up, or below every
    // note whose middle its bottom edge has passed going down.
    const top = me.top + L.dy
    const bottom = top + me.h
    const above = L.slots.findIndex((s, i) => i < L.from && top < s.top + s.h / 2)
    let below = -1
    L.slots.forEach((s, i) => i > L.from && bottom > s.top + s.h / 2 && (below = i))
    const to = above >= 0 ? above : below >= 0 ? below : L.from
    L.to = to
    // The notes between where it was and where it would go make room by one note's height.
    const shift = me.h + L.gap
    L.slots.forEach((s, i) => {
      if (i === L.from) return
      const off = L.from < to && i > L.from && i <= to ? -shift : to < L.from && i >= to && i < L.from ? shift : 0
      s.el.style.translate = off ? `0 ${off}px` : ''
    })
    const at = to === L.from ? me.top : to > L.from ? L.slots[to].top + L.slots[to].h - me.h : L.slots[to].top
    setSlot({ top: at, h: me.h })
  }

  const liftEnd = (commit: boolean) => {
    const L = lift.current
    lift.current = null
    if (!L) return
    cancelAnimationFrame(L.raf)
    setSlot(null)
    const me = L.slots[L.from]
    const letGo = me.top + L.dy
    // The others are already drawn where the new order puts them, so dropping their offsets in
    // the same frame as the reorder (and without their transition) shows no jump.
    for (const s of L.slots) {
      s.el.removeAttribute('data-lifting')
      s.el.removeAttribute('data-shifting')
      s.el.style.translate = ''
    }
    if (commit && L.to !== L.from) {
      const shown = L.slots.map((s) => s.pid)
      shown.splice(L.from, 1)
      shown.splice(L.to, 0, me.pid)
      wm.restack(withShown(stackOrder(wm.windows), shown))
    }
    // The note glides from where it was let go into its place.
    requestAnimationFrame(() => {
      const d = letGo - me.el.offsetTop
      if (!d) return
      me.el.style.transition = 'none'
      me.el.style.translate = `0 ${d}px`
      requestAnimationFrame(() => {
        me.el.style.transition = 'translate 0.2s ease'
        me.el.style.translate = ''
        setTimeout(() => (me.el.style.transition = ''), 220)
      })
    })
  }

  /** Move up, Move down and Move to top in a note's menu on a phone. */
  const moveInStack = (where: 'up' | 'down' | 'top') => {
    const order = stackOrder(wm.windows)
    const shown = order.filter((pid) => !wm.windows.find((w) => w.pid === pid)?.minimized)
    const i = shown.indexOf(win.pid)
    const j = where === 'top' ? 0 : where === 'up' ? i - 1 : i + 1
    if (i < 0 || j < 0 || j >= shown.length || i === j) return
    shown.splice(i, 1)
    shown.splice(j, 0, win.pid)
    wm.restack(withShown(order, shown))
    requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'stack') {
      if (!d.moved && Math.abs(dy) < 6) return
      if (!d.moved) {
        d.moved = true
        cancelTouchMenu()
        liftStart(d.startY, d.scroll, e.clientY)
      } else liftMove(e.clientY)
    } else if (d.mode === 'move') {
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      if (chrome === 'note') d.moved ? swing.move(e.clientX) : swing.start(e.clientX)
      if (!d.moved) {
        d.moved = true
        cancelTouchMenu()
        // Dragging a snapped or maximized window away gives it back its old size, under the pointer.
        const restore = win.maximized ? { x: win.x, y: win.y, w: win.w, h: win.h } : win.restore
        if (win.maximized || win.snap) {
          const from = win.maximized ? maxRect() : { x: win.x, y: win.y, w: win.w, h: win.h }
          const size = restore ?? from
          const ratio = (d.startX - from.x) / from.w
          d.w = size.w
          d.h = size.h
          d.x = d.startX - ratio * size.w
          d.y = from.y
          wm.setGeometry(win.pid, { x: d.x, y: d.y, w: d.w, h: d.h, snap: undefined, restore: undefined, maximized: false })
        }
      }
      // A note stays whole on the screen (fitNote); other windows may hang off it a little.
      const { x, y } =
        chrome === 'note'
          ? fitNote({ x: d.x + dx, y: d.y + dy, w: d.w, h: d.h }, window.innerWidth, window.innerHeight, sectionRef.current?.offsetHeight ?? drawnHeight(win.pid))
          : { x: Math.min(Math.max(d.x + dx, -d.w + 120), window.innerWidth - 120), y: Math.min(Math.max(d.y + dy, TOP_BAR), window.innerHeight - 60) }
      wm.setGeometry(win.pid, { x, y })
      if (canSnap) {
        target.current = zoneAt(e.clientX, e.clientY)
        setSnapPreview(target.current === 'max' ? maxRect() : target.current ? snapRect(target.current) : null)
      }
    } else {
      const g: Partial<Geometry> = {}
      if (d.edge.includes('e')) g.w = Math.max(MIN_W, d.w + dx)
      if (d.edge.includes('s')) g.h = Math.max(MIN_H, d.h + dy)
      if (d.edge.includes('w')) {
        const w = Math.max(MIN_W, d.w - dx)
        g.w = w
        g.x = d.x + (d.w - w)
      }
      // Resizing a snapped window makes it a normal one again.
      wm.setGeometry(win.pid, { ...g, snap: undefined, restore: undefined })
    }
  }

  const end = (e: ReactPointerEvent) => {
    const d = drag.current
    drag.current = null
    // A cancelled gesture (the browser took the finger) puts the note back where it was.
    if (d?.mode === 'stack') liftEnd(e.type === 'pointerup')
    swing.end()
    document.body.classList.remove('is-dragging', 'is-resizing')
    document.removeEventListener('selectstart', noSelect)
    setSnapPreview(null)
    const zone = target.current
    target.current = null
    if (!d || d.mode !== 'move' || !d.moved || !zone) return
    const restore = { x: d.x, y: d.y, w: d.w, h: d.h }
    if (zone === 'max') wm.setGeometry(win.pid, { maximized: true, restore })
    else wm.setGeometry(win.pid, { ...snapRect(zone), snap: zone, restore, maximized: false })
  }

  const handlers = { onPointerMove: onMove, onPointerUp: end, onPointerCancel: end }

  // Right-clicking the title bar (or a note's top strip): quick window actions instead of the
  // browser's own menu.
  const geometry = () => ({ x: win.x, y: win.y, w: win.w, h: win.h })
  const snapTo = (zone: SnapZone) => wm.setGeometry(win.pid, { ...snapRect(zone), snap: zone, restore: win.restore ?? geometry(), maximized: false })
  const unsnap = () => win.restore && wm.setGeometry(win.pid, { ...win.restore, snap: undefined, restore: undefined })
  const center = () => {
    const base = win.snap && win.restore ? win.restore : geometry()
    wm.setGeometry(win.pid, {
      ...base,
      x: Math.round(Math.max(8, (window.innerWidth - base.w) / 2)),
      y: Math.round(Math.max(TOP_BAR + 8, TOP_BAR + (window.innerHeight - TOP_BAR - base.h) / 2 - 30)),
      snap: undefined,
      restore: undefined,
      maximized: false,
    })
  }
  const windowMenu = (): MenuItem[] => {
    const others = wm.windows.filter((w) => w.pid !== win.pid)
    // For widgets, only the same kind (all weather widgets, not every widget).
    const siblings = others.filter((w) => w.app === win.app && w.props.kind === win.props.kind)
    // Phones: the note's place in the column, for when dragging it is fiddly (or a long way).
    const shown = phoneStack ? stackOrder(wm.windows).filter((pid) => !wm.windows.find((w) => w.pid === pid)?.minimized) : []
    const place = shown.indexOf(win.pid)
    return [
      ...(phoneStack && shown.length > 1
        ? [
            { label: 'Move up', disabled: place <= 0, onSelect: () => moveInStack('up') },
            { label: 'Move down', disabled: place < 0 || place >= shown.length - 1, onSelect: () => moveInStack('down') },
            { label: 'Move to top', disabled: place <= 0, onSelect: () => moveInStack('top') },
            { separator: true as const },
          ]
        : []),
      { label: 'Minimize', onSelect: () => wm.minimize(win.pid) },
      ...(chrome === 'default'
        ? [
            { label: win.maximized ? 'Restore size' : 'Maximize', shortcut: 'dbl-click', onSelect: () => wm.toggleMax(win.pid) },
            ...(canSnap ? [{ label: 'Snap', submenu: [...SNAPS.map(([zone, label]) => ({ label, checked: win.snap === zone, onSelect: () => snapTo(zone) })), ...(win.snap ? [{ separator: true as const }, { label: 'Unsnap', onSelect: unsnap }] : [])] }] : []),
          ]
        : []),
      { label: 'Center on screen', onSelect: center },
      ...(chrome === 'note' ? [{ label: 'Add widget', submenu: addWidgetItems(wm) }] : []),
      ...(!SINGLE_INSTANCE.has(win.app) && win.app !== 'widget' ? [{ separator: true as const }, { label: 'New window', onSelect: () => wm.openNew(win.app) }] : []),
      { separator: true },
      ...(siblings.length ? [{ label: `Close all ${siblings.length + 1} ${win.app === 'widget' ? `${title} widgets` : `${APP_META[win.app].dock} windows`}`, onSelect: () => [win, ...siblings].forEach((w) => wm.close(w.pid)) }] : []),
      ...(others.length ? [{ label: 'Close other windows', onSelect: () => others.forEach((w) => wm.close(w.pid)) }] : []),
      { label: closeLabel, danger: true, onSelect: () => wm.close(win.pid) },
    ]
  }
  const onMenu = (e: React.MouseEvent, before: MenuItem[] = []) => {
    wm.focus(win.pid)
    const own = menuItems.length ? [...menuItems, { separator: true as const }] : []
    openContextMenu(e, [...before, ...own, ...windowMenu()])
  }
  // Inside the window, wherever the app has no menu of its own: links get theirs, text fields and
  // selections keep the browser's, the rest gets the window menu.
  const onBodyMenu = (e: React.MouseEvent) => {
    // The app used the right-click itself (a game's orders, its own menu).
    if (e.defaultPrevented || wantsNativeMenu(e)) return
    const href = linkAt(e.target)
    onMenu(e, href ? [...linkMenu(href), { separator: true }] : [])
  }

  return (
    <section
      ref={sectionRef}
      className={`window chrome-${chrome} ${focused ? 'is-focused' : ''} ${win.maximized ? 'is-max' : ''} ${win.minimized ? 'is-min' : ''} ${win.snap ? 'is-snapped' : ''} ${className}`}
      // --stack: the note's place in the phone layout's column (only that layout reads it).
      style={{ ...style, left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z, ...(chrome === 'note' ? { ['--stack' as string]: stackOrder(wm.windows).indexOf(win.pid) } : {}) }}
      onPointerDown={() => wm.focus(win.pid)}
      onContextMenu={onBodyMenu}
      role="dialog"
      aria-label={title}
      data-app={win.app}
      data-pid={win.pid}
    >
      {chrome === 'default' ? (
        <header className="titlebar" onPointerDown={begin('move')} onDoubleClick={() => wm.toggleMax(win.pid)} onContextMenu={onMenu} {...handlers}>
          <span className="titlebar-title">{title}</span>
          <span className="titlebar-pid">pid {win.pid}</span>
          <div className="win-controls">
            <button className="ctl ctl-min" aria-label="Minimize" onClick={() => wm.minimize(win.pid)} />
            <button className="ctl ctl-max" aria-label="Maximize" onClick={() => wm.toggleMax(win.pid)} />
            <button className="ctl ctl-close" aria-label="Close" onClick={() => wm.close(win.pid)} />
          </div>
        </header>
      ) : (
        <div className="note-grip" onPointerDown={begin('move')} onContextMenu={onMenu} {...handlers}>
          <span className="note-tape" />
          <button className="note-close" aria-label="Close note" onClick={() => wm.close(win.pid)}>
            ×
          </button>
        </div>
      )}
      <div className="window-body">
        <WindowMenuContext.Provider value={(e) => onMenu(e)}>{children}</WindowMenuContext.Provider>
      </div>
      {chrome === 'default' && !win.maximized && (
        <>
          <div className="rz rz-e" onPointerDown={begin('resize', 'e')} {...handlers} />
          <div className="rz rz-s" onPointerDown={begin('resize', 's')} {...handlers} />
          <div className="rz rz-w" onPointerDown={begin('resize', 'w')} {...handlers} />
          <div className="rz rz-se" onPointerDown={begin('resize', 'se')} {...handlers} />
          <div className="rz rz-sw" onPointerDown={begin('resize', 'sw')} {...handlers} />
        </>
      )}
      {/* Stickies grow with their text; only their width is up to you. */}
      {resizableWidth && <div className="rz rz-e" onPointerDown={begin('resize', 'e')} {...handlers} />}
    </section>
  )
}
