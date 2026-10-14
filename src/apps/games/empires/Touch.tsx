import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useMediaQuery } from '../../../os/useMediaQuery'
import './touch.css'

// Touch for Empires At War, shared by the battle, the galaxy map and the menus. Every touch path
// checks `pointerType === 'touch'` (or the coarse-pointer media query in CSS), so mouse and
// keyboard play stays exactly as it was.
//
// The touch model:
// - tap selects or activates; a one-finger drag pans; two fingers pinch to zoom;
// - a long press (LONG_PRESS_MS without moving) opens an action wheel at the finger: slide onto an
//   action and let go, or let go first and tap one; the middle or anywhere outside cancels;
// - the touch bar holds a sticky Shift (queue orders, add to a selection, build five) and a box
//   mode (the next drag draws a selection box instead of panning).

export const LONG_PRESS_MS = 450
/** How far a finger may wander and still count as a tap or a long press, in px. */
export const TAP_SLOP = 10

export const isTouch = (e: { pointerType?: string }) => e.pointerType === 'touch'

/** A short buzz on phones that have it (a long press opening its wheel). */
export function buzz(ms = 12) {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* no vibration motor */
  }
}

/** Whether the main pointer is a finger: for layout choices made in components. */
export const useCoarse = () => useMediaQuery('(pointer: coarse)')

/**
 * A long press: `start` on pointerdown, `move` on pointermove, `cancel` on pointerup or when a
 * second finger lands. `fire` runs once the finger has stayed put long enough; `fired` then tells
 * the pointerup not to treat it as a tap too.
 */
export class LongPress {
  private timer = 0
  private x = 0
  private y = 0
  fired = false
  start(e: { clientX: number; clientY: number }, fire: () => void) {
    this.cancel()
    this.fired = false
    this.x = e.clientX
    this.y = e.clientY
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.fired = true
      buzz()
      fire()
    }, LONG_PRESS_MS)
  }
  /** Cancels when the finger moved too far; answers whether it is still pending. */
  move(e: { clientX: number; clientY: number }) {
    if (this.timer && Math.hypot(e.clientX - this.x, e.clientY - this.y) > TAP_SLOP) this.cancel()
    return !!this.timer
  }
  cancel() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = 0
  }
}

/**
 * A finger's way to cancel something queued (research, an expansion, a platform upgrade): a long
 * press (with `cancel`; without one the handlers only watch). The click that follows it is
 * swallowed, so a cancelled tile isn't ordered again at once, and `touched` tells the context
 * menu, which some phones open on a long press too, to leave it be. The data-longpress mark keeps
 * the long-press tooltip from showing as well.
 */
/** Tooltip line for anything queued that a right-click (long-press on touch) calls off. */
export const CANCEL_TIP = 'Right-click to cancel (full refund). Long-press on touch.'

export function useCancelPress() {
  const lp = useRef(new LongPress())
  const touch = useRef(false)
  return {
    touched: () => touch.current,
    handlers: (cancel: (() => void) | null) => ({
      ...(cancel ? { 'data-longpress': '' } : {}),
      onPointerDown: (e: React.PointerEvent) => {
        touch.current = isTouch(e)
        lp.current.fired = false
        if (cancel && isTouch(e)) lp.current.start(e, cancel)
      },
      onPointerMove: (e: React.PointerEvent) => void (isTouch(e) && lp.current.move(e)),
      onPointerUp: () => lp.current.cancel(),
      onPointerCancel: () => lp.current.cancel(),
      onClickCapture: (e: React.MouseEvent) => {
        if (lp.current.fired) {
          lp.current.fired = false
          e.preventDefault()
          e.stopPropagation()
        }
      },
    }),
  }
}

// --- sticky modifiers (the touch bar) ----------------------------------------------------------

type Mods = { shift: boolean; box: boolean }
let mods: Mods = { shift: false, box: false }
const listeners = new Set<() => void>()
export const getTouchMods = () => mods
export function setTouchMod(k: keyof Mods, on: boolean) {
  if (mods[k] === on) return
  mods = { ...mods, [k]: on }
  listeners.forEach((l) => l())
}
export const useTouchMods = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => mods,
  )
/** Shift held on the keyboard, or the touch bar's sticky Shift. */
export const shiftOf = (e?: { shiftKey?: boolean } | null) => !!e?.shiftKey || mods.shift

/**
 * The touch bar: a sticky Shift and the box-select mode, shown only to fingers (CSS hides it for
 * mice). `box` is left out where there is nothing to box-select.
 */
export function TouchBar({ className = '', box = true, extra }: { className?: string; box?: boolean; extra?: ReactNode }) {
  const m = useTouchMods()
  // Leaving the screen drops the modifiers, so they never surprise the next one.
  useEffect(() => () => (setTouchMod('shift', false), setTouchMod('box', false)), [])
  return (
    <div className={`ew-touchbar ${className}`} data-nodrag>
      <button className={m.shift ? 'is-on' : ''} aria-pressed={m.shift} onClick={() => setTouchMod('shift', !m.shift)} title="Shift: queue orders, add to the selection, build five">
        ⇧<span>Shift</span>
      </button>
      {box && (
        <button className={m.box ? 'is-on' : ''} aria-pressed={m.box} onClick={() => setTouchMod('box', !m.box)} title="Box: the next drag selects instead of moving the view">
          ▢<span>Box</span>
        </button>
      )}
      {extra}
    </div>
  )
}

// --- the compact selection ----------------------------------------------------------------------
//
// On a touch screen what is selected (in a battle, or on the galaxy map) starts as one small button
// (SelChip in Hud.tsx); tapping it opens the full panel, and a tap anywhere else only closes it.

/** Where the selection's popover lives (with the chip itself and the action wheel a long press in it
 * opens): a press there is the popover's own. */
export const SELPOP_KEEP = '.ew-selpop, .ew-selchip, .ew-wheel-layer'

/**
 * While `open`, a press anywhere in `root` outside `keep` only calls `close`: it is stopped before
 * the map, the battlefield or another button sees it, and so is the click that follows, so that tap
 * gives no order and changes no selection.
 */
export function useTapAway(root: { current: HTMLElement | null }, open: boolean, close: () => void, keep = SELPOP_KEEP, deps: unknown[] = []) {
  const state = useRef({ open, close })
  state.current = { open, close }
  useEffect(() => {
    const el = root.current
    if (!el) return
    let swallow = 0
    const down = (e: PointerEvent) => {
      if (!state.current.open || (e.target as Element).closest(keep)) return
      swallow = performance.now()
      e.stopPropagation()
      state.current.close()
    }
    const click = (e: Event) => {
      if (!swallow || performance.now() - swallow > 800) return
      swallow = 0
      e.stopPropagation()
      e.preventDefault()
    }
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('click', click, true)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      el.removeEventListener('click', click, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keep, ...deps])
}

// --- the action wheel --------------------------------------------------------------------------

export type WheelItem = {
  id: string
  label: string
  icon?: ReactNode
  /** Greyed out: true, or why (shown as its title) */
  disabled?: boolean | string
  danger?: boolean
  run: () => void
}
export type WheelRequest = { x: number; y: number; items: WheelItem[]; title?: string }

const WheelCtx = createContext<(r: WheelRequest | null) => void>(() => {})
/** Opens an action wheel at a client position (inside a WheelHost); null closes it. */
export const useWheel = () => useContext(WheelCtx)

const RADIUS = 84
const ITEM = 58

/**
 * Holds the action wheel for a screen: put it round the screen's content, inside its `.ew-root`
 * (which is `position: relative`). The wheel opens under a finger that is still down: sliding onto
 * an action and letting go picks it; letting go in the middle leaves it open to tap.
 */
export function WheelHost({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<WheelRequest | null>(null)
  const open = useCallback((r: WheelRequest | null) => setReq(r && r.items.length ? r : null), [])
  return (
    <WheelCtx.Provider value={open}>
      {children}
      {req && <Wheel req={req} onClose={() => setReq(null)} />}
    </WheelCtx.Provider>
  )
}

function Wheel({ req, onClose }: { req: WheelRequest; onClose: () => void }) {
  const layer = useRef<HTMLDivElement>(null)
  const [centre, setCentre] = useState<{ x: number; y: number } | null>(null)
  const [hot, setHot] = useState<number | null>(null)
  const items = req.items.slice(0, 8)
  const angleOf = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / items.length
  // Where the wheel's middle sits inside the layer: under the finger, but never off its edges.
  useLayoutEffect(() => {
    const el = layer.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = RADIUS + ITEM / 2 + 6
    setCentre({ x: Math.max(pad, Math.min(r.width - pad, req.x - r.left)), y: Math.max(pad, Math.min(r.height - pad, req.y - r.top)) })
  }, [req])
  const pick = (i: number | null) => {
    if (i === null) return
    const it = items[i]
    if (!it || it.disabled) return
    onClose()
    it.run()
  }
  // The finger that opened it: slide to choose, let go to pick (or to leave it open for a tap).
  useEffect(() => {
    const el = layer.current
    if (!el || !centre) return
    let fresh = true
    const nearest = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect()
      const dx = cx - r.left - centre.x
      const dy = cy - r.top - centre.y
      // Still where it opened (near an edge the wheel sits off the finger): nothing picked yet.
      if (Math.hypot(dx, dy) < 30 || Math.hypot(cx - req.x, cy - req.y) < 30) return null
      const a = Math.atan2(dy, dx)
      let best = 0
      let bestD = Infinity
      items.forEach((_, i) => {
        const d = Math.abs(Math.atan2(Math.sin(a - angleOf(i)), Math.cos(a - angleOf(i))))
        if (d < bestD) (best = i), (bestD = d)
      })
      return best
    }
    const move = (e: PointerEvent) => {
      if (fresh) setHot(nearest(e.clientX, e.clientY))
    }
    const up = (e: PointerEvent) => {
      if (!fresh) return
      fresh = false
      const i = nearest(e.clientX, e.clientY)
      setHot(null)
      if (i !== null) pick(i)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centre])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div
      ref={layer}
      className="ew-wheel-layer"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {centre && (
        <div className="ew-wheel" style={{ left: centre.x, top: centre.y }}>
          <div className="ew-wheel-ring" style={{ width: RADIUS * 2 + ITEM, height: RADIUS * 2 + ITEM }} />
          {req.title && <div className="ew-wheel-title" style={{ top: -RADIUS - ITEM / 2 - 26 }}>{req.title}</div>}
          <button className="ew-wheel-mid" onClick={onClose} aria-label="Close the action wheel">
            ×
          </button>
          {items.map((it, i) => (
            <button
              key={it.id}
              className={`ew-wheel-item ${hot === i ? 'is-hot' : ''} ${it.danger ? 'is-danger' : ''}`}
              style={{ left: Math.cos(angleOf(i)) * RADIUS, top: Math.sin(angleOf(i)) * RADIUS, width: ITEM, height: ITEM }}
              disabled={!!it.disabled}
              title={typeof it.disabled === 'string' ? it.disabled : it.label}
              onClick={() => pick(i)}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A long press on a HUD button (a ship card, a tile) that opens a wheel, while a tap still clicks
 * it: spread the returned handlers on the element. The click after a long press is swallowed.
 */
export function useLongPressWheel(items: () => WheelItem[], title?: string) {
  const open = useWheel()
  const lp = useRef(new LongPress())
  return {
    'data-longpress': '',
    onPointerDown: (e: React.PointerEvent) => {
      if (!isTouch(e)) return
      lp.current.start(e, () => open({ x: e.clientX, y: e.clientY, items: items(), title }))
    },
    onPointerMove: (e: React.PointerEvent) => void (isTouch(e) && lp.current.move(e)),
    onPointerUp: () => lp.current.cancel(),
    onPointerCancel: () => lp.current.cancel(),
    onClickCapture: (e: React.MouseEvent) => {
      if (lp.current.fired) {
        lp.current.fired = false
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }
}
