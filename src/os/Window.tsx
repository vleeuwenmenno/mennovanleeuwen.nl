import { fitWidget } from './widgetLayout'
import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { addWidgetItems } from '../widgets/registry'
import { APP_META } from './apps'
import { cancelTouchMenu, linkAt, linkMenu, openContextMenu, wantsNativeMenu, type MenuItem } from './ContextMenu'
import { getDockMode, snapReserve } from './dockPrefs'
import { setSnapPreview } from './snapPreview'
import { useSwing } from './swing'
import { WindowMenuContext } from './windowMenu'
import { useDropTarget } from './dnd'
import { dragKeyHeld } from './modDrag'
import { filesFor, SHOWS_FILE } from './appDrops'
import { drawnHeight, fitNote, setDrawnSize, SINGLE_INSTANCE, snapRect, stackOrder, useWM, workspaceOf, WORKSPACES, type Geometry, type SnapZone, type WinState } from './wm'
import { toUi, viewH, viewW } from './uiScale'

const TOP_BAR = 28
const MIN_W = 280
const MIN_H = 180
const EDGE = 14 // how close to a screen edge the pointer must be to snap
const MOD_SLOP = 4 // how far the pointer must move, with the drag key held, before the window takes the drag
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

type Drag = {
  mode: 'move' | 'resize' | 'stack'
  pointerId: number
  edge: string
  startX: number
  startY: number
  x: number
  y: number
  w: number
  h: number
  moved: boolean
  /** How far the phone desktop was scrolled when the finger went down */
  scroll?: number
  /** A finger on a phone note's strip: the note only lifts after it is held still (HOLD_MS) */
  hold?: { timer: ReturnType<typeof setTimeout> | null; armed: boolean; given: boolean; y: number; /** Where the finger was when the note lifted */ at: number }
}
type Target = SnapZone | 'max' | null
/** What a drag reads of a pointer event: React's, or the browser's own (a drag started with a key held). */
type Ptr = { clientX: number; clientY: number; pointerId: number; type: string; currentTarget: EventTarget | null }

// ---------------------------------------------------------------------------------------------
// Phones stack the notes in one column down a desktop that scrolls (styles.css, stackOrder in
// wm.tsx). There, dragging a note by its top strip moves it up or down the column: the note lifts
// and follows the finger, the others slide out of its way, and a dashed slot shows where it will
// land. The desktop scrolls by itself when the finger nears the top bar or the dock.
//
// A finger has to hold the strip still for HOLD_MS first (the note lifts with a buzz): swiping
// across the strip scrolls the desktop instead, since that is what a quick swipe there means.
// Letting go of a lifted note without moving it opens its menu.

const HOLD_MS = 400
/** How far a finger may wander while holding, in px, before it counts as a scroll. */
const HOLD_SLOP = 8

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
  const vw = viewW()
  const vh = viewH()
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

/** The workspace number in the top bar under the pointer, if any: dropping a window there moves
 * it to that workspace. The number being aimed at lights up (data-drop). */
function workspaceAt(x: number, y: number): number | null {
  let hit: number | null = null
  for (const el of document.querySelectorAll<HTMLElement>('.ws[data-ws]')) {
    const r = el.getBoundingClientRect()
    const over = x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 4 && y <= r.bottom + 4
    el.toggleAttribute('data-drop', over)
    if (over) hit = Number(el.dataset.ws)
  }
  return hit
}
const clearWorkspaceDrop = () => document.querySelectorAll('.ws[data-drop]').forEach((el) => el.removeAttribute('data-drop'))

const maxRect = (): Geometry => ({ x: 10, y: TOP_BAR + 10, w: viewW() - 20, h: viewH() - TOP_BAR - 20 - (getDockMode() === 'show' ? snapReserve() : 0) })

export function Window({ win, title, chrome = 'default', className = '', style, menuItems = [], closeLabel = 'Close', resizableWidth = false, children }: Props) {
  const wm = useWM()
  const drag = useRef<Drag | null>(null)
  const target = useRef<Target>(null)
  const wsTarget = useRef<number | null>(null)
  const focused = wm.focusedPid === win.pid
  const canSnap = chrome === 'default' && window.innerWidth >= 720
  const sectionRef = useRef<HTMLElement>(null)
  const swing = useSwing(sectionRef, 'notes')
  // Apps that show a file (Preview, Player, Zed…) show the one dropped on their window, unless
  // a target of the app's own inside takes it first.
  const bodyRef = useRef<HTMLDivElement>(null)
  useDropTarget(
    bodyRef,
    {
      accept: (d) => (filesFor(win.app, d.items).length ? 'open' : null),
      drop: (d) => {
        const file = filesFor(win.app, d.items)[0]
        if (!file) return
        wm.setProps(win.pid, { path: file.path, t: String(Date.now()) })
        wm.focus(win.pid)
      },
    },
    SHOWS_FILE.has(win.app),
  )

  // A note's text can run on below its box: how tall it really shows, so it is never fitted
  // half off the bottom of the screen (fitNote in wm.tsx).
  useEffect(() => {
    const el = sectionRef.current
    if (chrome !== 'note' || win.app === 'widget' || !el) return
    let last = { w: 0, h: 0 }
    const measure = () => {
      const h = Math.max(el.offsetHeight, ...[...el.children].map((c) => (c as HTMLElement).offsetTop + (c as HTMLElement).offsetHeight))
      const w = el.offsetWidth
      if (Math.abs(h - last.h) < 2 && Math.abs(w - last.w) < 2) return
      last = { w, h }
      setDrawnSize(win.pid, last)
      wm.refit()
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    return () => {
      ro.disconnect()
      setDrawnSize(win.pid, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chrome, win.pid])

  // On a phone a note's strip moves it within the column instead of around the screen.
  const phoneStack = chrome === 'note' && window.innerWidth < 720
  const lift = useRef<Lift | null>(null)

  const begin = (mode: Drag['mode'], edge = '') => (e: ReactPointerEvent) => {
    if (e.button !== 0 || drag.current) return
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    if (win.maximized && mode === 'resize') return
    if (mode === 'move' && phoneStack) mode = 'stack'
    e.preventDefault()
    wm.focus(win.pid)
    const el = e.currentTarget as HTMLElement
    const d: Drag = { mode, edge, pointerId: e.pointerId, startX: toUi(e.clientX), startY: toUi(e.clientY), x: win.x, y: win.y, w: win.w, h: win.h, moved: false, scroll: el.closest('.desk-scroll')?.scrollTop }
    drag.current = d
    if (mode === 'stack' && e.pointerType === 'touch') {
      const hold: NonNullable<Drag['hold']> = { timer: null, armed: false, given: false, y: toUi(e.clientY), at: toUi(e.clientY) }
      d.hold = hold
      hold.timer = setTimeout(() => {
        hold.timer = null
        if (drag.current !== d || hold.given) return
        // Held still long enough: the note is the finger's now, not the page's.
        hold.armed = true
        hold.at = hold.y
        d.moved = true
        cancelTouchMenu()
        try {
          navigator.vibrate?.(10)
        } catch {
          /* no vibration motor */
        }
        liftStart(d.startY, d.scroll, hold.y)
      }, HOLD_MS)
      // Once the note has lifted, the desktop must not scroll under it (a passive listener can't stop that).
      const block = (t: TouchEvent) => {
        if (drag.current !== d) return document.removeEventListener('touchmove', block)
        if (hold.armed) t.preventDefault()
      }
      document.addEventListener('touchmove', block, { passive: false })
    }
    el.setPointerCapture(e.pointerId)
    document.body.classList.add(mode === 'resize' ? 'is-resizing' : 'is-dragging')
    if (mode === 'resize') document.body.dataset.rz = edge
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
      const bottom = viewH() - 130
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

  const onMove = (e: Ptr) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    // Page pixels (the UI scale, uiScale.ts), as the window's geometry is.
    const px = toUi(e.clientX)
    const py = toUi(e.clientY)
    const dx = px - d.startX
    const dy = py - d.startY
    if (d.mode === 'stack' && d.hold) {
      d.hold.y = py
      if (d.hold.armed) return liftMove(py)
      // Moving before the hold is up: a scroll. Let the page have the finger.
      if (!d.hold.given && Math.hypot(dx, dy) > HOLD_SLOP) {
        d.hold.given = true
        if (d.hold.timer) clearTimeout(d.hold.timer)
        ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      }
      return
    }
    if (d.mode === 'stack') {
      if (!d.moved && Math.abs(dy) < 6) return
      if (!d.moved) {
        d.moved = true
        cancelTouchMenu()
        liftStart(d.startY, d.scroll, py)
      } else liftMove(py)
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
        win.app === 'widget'
          ? fitWidget({ x: d.x + dx, y: d.y + dy, w: d.w, h: d.h }, viewW(), viewH())
          : chrome === 'note'
          ? fitNote({ x: d.x + dx, y: d.y + dy, w: d.w, h: d.h }, viewW(), viewH(), phoneStack, sectionRef.current?.offsetHeight ?? drawnHeight(win.pid))
          : { x: Math.min(Math.max(d.x + dx, -d.w + 120), viewW() - 120), y: Math.min(Math.max(d.y + dy, TOP_BAR), viewH() - 60) }
      wm.setGeometry(win.pid, { x, y })
      // Over a workspace number in the top bar: dropping there moves the window to it.
      wsTarget.current = chrome === 'default' && wm.workspaces ? workspaceAt(e.clientX, e.clientY) : null
      if (wsTarget.current !== null) {
        target.current = null
        setSnapPreview(null)
      } else if (canSnap) {
        target.current = zoneAt(px, py)
        setSnapPreview(target.current === 'max' ? maxRect() : target.current ? snapRect(target.current) : null)
      }
    } else {
      const g: Partial<Geometry> = {}
      const minW = win.app === 'widget' ? 160 : MIN_W
      if (d.edge.includes('e')) g.w = Math.max(minW, d.w + dx)
      if (d.edge.includes('s')) g.h = Math.max(MIN_H, d.h + dy)
      if (d.edge.includes('w')) {
        const w = Math.max(minW, d.w - dx)
        g.w = w
        g.x = d.x + (d.w - w)
      }
      if (d.edge.includes('n')) {
        // The bottom edge stays put, and the top one stays under the top bar.
        const top = Math.min(Math.max(d.y + dy, TOP_BAR), d.y + d.h - MIN_H)
        g.y = top
        g.h = d.y + d.h - top
      }
      // Keep the origin unless a wider rotated grip needs more clearance below the bar.
      if (win.app === 'widget' && g.w !== undefined) {
        const fitted = fitWidget({ x: g.x ?? d.x, y: d.y, w: g.w, h: d.h }, viewW(), viewH())
        g.w = d.edge.includes('w') ? fitted.w : Math.max(1, Math.min(g.w, viewW() - d.x - 24))
        if (d.edge.includes('w')) g.x = fitted.x
        g.y = fitWidget({ x: g.x ?? d.x, y: g.y ?? d.y, w: g.w, h: d.h }, viewW(), viewH()).y
      }
      // Resizing a snapped window makes it a normal one again.
      wm.setGeometry(win.pid, { ...g, snap: undefined, restore: undefined })
    }
  }

  const end = (e: Ptr) => {
    const d = drag.current
    if (d && d.pointerId !== e.pointerId) return
    drag.current = null
    if (d?.hold?.timer) clearTimeout(d.hold.timer)
    // Let go of a lifted note that never moved: it was a long press, so it gets its menu.
    const pressed = !!d?.hold?.armed && e.type === 'pointerup' && Math.abs(toUi(e.clientY) - d.hold.at) <= HOLD_SLOP
    // A cancelled gesture (the browser took the finger) puts the note back where it was.
    if (d?.mode === 'stack') liftEnd(e.type === 'pointerup')
    if (pressed) {
      // The click that follows this lift would land on the menu opening under the finger.
      const swallow = (c: MouseEvent) => {
        c.preventDefault()
        c.stopPropagation()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 600)
      onMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} } as React.MouseEvent)
    }
    swing.end()
    document.body.classList.remove('is-dragging', 'is-resizing')
    delete document.body.dataset.rz
    document.removeEventListener('selectstart', noSelect)
    setSnapPreview(null)
    clearWorkspaceDrop()
    const zone = target.current
    const toWs = wsTarget.current
    target.current = null
    wsTarget.current = null
    if (d?.mode === 'move' && d.moved && toWs !== null) return wm.moveToWorkspace(win.pid, toWs)
    if (!d || d.mode !== 'move' || !d.moved || !zone) return
    const restore = { x: d.x, y: d.y, w: d.w, h: d.h }
    if (zone === 'max') wm.setGeometry(win.pid, { maximized: true, restore })
    else wm.setGeometry(win.pid, { ...snapRect(zone), snap: zone, restore, maximized: false })
  }

  useEffect(() => () => {
    if (!drag.current) return
    if (drag.current.hold?.timer) clearTimeout(drag.current.hold.timer)
    drag.current = null
    document.body.classList.remove('is-dragging', 'is-resizing')
    delete document.body.dataset.rz
    document.removeEventListener('selectstart', noSelect)
  }, [])

  const handlers = { onPointerMove: onMove, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: (e: ReactPointerEvent) => { if (win.app === 'widget' && drag.current) end(e) } }

  // --- moving and resizing with a key held (modDrag.ts) ---
  //
  // The key and the left button drag the window from anywhere on it; the key and the right button
  // resize it from the corner nearest the pointer. But the key and a click mean other things in
  // apps (Ctrl+click selects more, on a link it opens a new tab), and the app sees the press
  // before any move. So the press only starts watching: while the pointer stays within MOD_SLOP of
  // where it went down, nothing has happened and the click reaches the app whole. Once it goes
  // further, the window takes the drag: the app is told the gesture is off (a pointercancel on
  // window, which ends its rubber band), no more moves reach it, the browser's own drags (links,
  // images, files) and text selection are held back, and the click that would follow is eaten.

  // The handlers are rebuilt on every render (they close over the window); the ones on `window`
  // call whichever is newest.
  const latest = useRef({ onMove, end })
  latest.current = { onMove, end }
  const modPress = useRef<(() => void) | null>(null)
  useEffect(() => () => modPress.current?.(), [])

  /** What the held key does with this button here: the left one moves, the right one resizes. */
  const modModeOf = (e: { button: number; ctrlKey: boolean; altKey: boolean; metaKey: boolean; target: EventTarget | null }): Drag['mode'] | null => {
    if (window.innerWidth < 720 || !dragKeyHeld(e) || APP_META[win.app].ownsModifierDrag || (e.target as HTMLElement).closest('[data-no-mod-drag]')) return null
    if (e.button === 0) return 'move'
    return e.button === 2 && chrome === 'default' && !win.maximized ? 'resize' : null
  }

  const modPressDown = (e: ReactPointerEvent) => {
    const el = sectionRef.current
    const mode = e.pointerType === 'mouse' && el ? modModeOf(e) : null
    // The title bar, the note's strip and the handles already take a plain left drag themselves.
    if (!el || !mode || (mode === 'move' && (e.target as HTMLElement).closest('.titlebar, .note-grip, .rz'))) return
    modPress.current?.()
    const box = el.getBoundingClientRect()
    // Resizing moves the corner the pointer is nearest to; the opposite one stays where it is.
    const edge = mode === 'resize' ? `${e.clientY > box.top + box.height / 2 ? 's' : 'n'}${e.clientX > box.left + box.width / 2 ? 'e' : 'w'}` : ''
    const press = { id: e.pointerId, x: e.clientX, y: e.clientY, taken: false }
    const on = { capture: true }
    const ours = (ev: PointerEvent) => ev.isTrusted && ev.pointerId === press.id
    const take = () => {
      press.taken = true
      drag.current = { mode, edge, pointerId: press.id, startX: toUi(press.x), startY: toUi(press.y), x: win.x, y: win.y, w: win.w, h: win.h, moved: false }
      try {
        el.setPointerCapture(press.id)
      } catch {
        /* the pointer is already gone: the release below ends it */
      }
      document.body.classList.add(mode === 'resize' ? 'is-resizing' : 'is-dragging')
      if (mode === 'resize') document.body.dataset.rz = edge
      document.addEventListener('selectstart', noSelect)
      window.getSelection()?.removeAllRanges()
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: press.id, pointerType: 'mouse', bubbles: true }))
    }
    const noDrag = (ev: Event) => {
      ev.preventDefault()
      ev.stopPropagation()
    }
    const move = (ev: PointerEvent) => {
      if (!ours(ev)) return
      ev.stopPropagation()
      if (!press.taken) {
        if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < MOD_SLOP) return
        take()
      }
      latest.current.onMove(ev)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move, on)
      window.removeEventListener('pointerup', finish, on)
      window.removeEventListener('pointercancel', finish, on)
      window.removeEventListener('dragstart', noDrag, on)
      modPress.current = null
    }
    const finish = (ev: PointerEvent) => {
      if (!ours(ev)) return
      stop()
      if (!press.taken) return
      latest.current.end(ev)
      // The click (or, on Windows, the menu) that follows the release is not meant for the app.
      const swallow = (c: Event) => {
        c.preventDefault()
        c.stopPropagation()
      }
      const kinds = ['click', 'auxclick', 'contextmenu']
      kinds.forEach((k) => window.addEventListener(k, swallow, on))
      setTimeout(() => kinds.forEach((k) => window.removeEventListener(k, swallow, on)), 250)
    }
    modPress.current = () => {
      stop()
      if (press.taken) latest.current.end({ clientX: press.x, clientY: press.y, pointerId: press.id, type: 'pointercancel', currentTarget: null })
    }
    window.addEventListener('pointermove', move, on)
    window.addEventListener('pointerup', finish, on)
    window.addEventListener('pointercancel', finish, on)
    window.addEventListener('dragstart', noDrag, on)
  }

  // No menu for a right-drag that resizes (the browser's would come up at the press).
  const modContextMenu = (e: React.MouseEvent) => {
    if (e.button !== 2 || modModeOf(e) !== 'resize') return
    e.preventDefault()
    e.stopPropagation()
  }

  // Right-clicking the title bar (or a note's top strip): quick window actions instead of the
  // browser's own menu.
  const geometry = () => ({ x: win.x, y: win.y, w: win.w, h: win.h })
  const snapTo = (zone: SnapZone) => wm.setGeometry(win.pid, { ...snapRect(zone), snap: zone, restore: win.restore ?? geometry(), maximized: false })
  const unsnap = () => win.restore && wm.setGeometry(win.pid, { ...win.restore, snap: undefined, restore: undefined })
  const center = () => {
    const base = win.snap && win.restore ? win.restore : geometry()
    wm.setGeometry(win.pid, {
      ...base,
      x: Math.round(Math.max(8, (viewW() - base.w) / 2)),
      y: Math.round(Math.max(TOP_BAR + 8, TOP_BAR + (viewH() - TOP_BAR - base.h) / 2 - 30)),
      snap: undefined,
      restore: undefined,
      maximized: false,
    })
  }
  const windowMenu = (): MenuItem[] => {
    // Windows on other workspaces are out of sight, so "other windows" means the ones on this one.
    const others = wm.windows.filter((w) => w.pid !== win.pid && wm.shown(w))
    const ws = workspaceOf(win)
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
      ...(ws !== null && wm.workspaces
        ? [{ label: 'Move to workspace', submenu: Array.from({ length: WORKSPACES }, (_, i) => ({ label: `Workspace ${i + 1}${wm.elsewhere.includes(i + 1) ? ' (other tab)' : ''}`, shortcut: `Alt Shift ${i + 1}`, checked: ws === i + 1, onSelect: () => wm.moveToWorkspace(win.pid, i + 1) })) }]
        : []),
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
      className={`window chrome-${chrome} ${focused ? 'is-focused' : ''} ${win.maximized ? 'is-max' : ''} ${win.minimized ? 'is-min' : ''} ${wm.shown(win) ? '' : 'is-away'} ${win.snap ? 'is-snapped' : ''} ${className}`}
      // --stack: the note's place in the phone layout's column (only that layout reads it).
      style={{ ...style, ...(win.app === 'widget' ? { ['--widget-body-max' as string]: `${Math.max(60, viewH() - win.y - 70)}px` } : {}), left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z, ...(chrome === 'note' ? { ['--stack' as string]: stackOrder(wm.windows).indexOf(win.pid) } : {}) }}
      onPointerDown={() => wm.focus(win.pid)}
      onPointerDownCapture={modPressDown}
      onContextMenuCapture={modContextMenu}
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
            <button className="ctl ctl-max" aria-label={win.maximized ? 'Restore size' : 'Maximize'} onClick={() => wm.toggleMax(win.pid)} />
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
      {chrome === 'default' && win.maximized && (
        <button className="mobile-window-restore" aria-label="Restore size" title="Restore size" onClick={() => wm.toggleMax(win.pid)}>↙</button>
      )}
      <div className="window-body" ref={bodyRef}>
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
