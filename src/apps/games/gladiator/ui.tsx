import { useEffect, useRef, type ReactNode } from 'react'
import { MATERIALS, type Item, type Look, type Slot } from './data'
import { drawFighter, kitOf, weaponKind, type Kit } from './render'
import { Puppet, gripOf, type ClipName } from './rig'

// Small pieces shared by the screens: a live portrait of a gladiator, bars, coins.

/**
 * An animated gladiator on a transparent canvas. `gear` may hold ids (from a save) or items (a
 * shop's try-on). `zoom` frames the whole body at 1, the head and chest above that.
 */
export function Portrait({ look, gear, clip = 'guard', zoom = 1, face = 1, className, still = false }: { look: Look; gear: Partial<Record<Slot, string | Item | null>>; clip?: ClipName; zoom?: number; face?: 1 | -1; className?: string; still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const kitRef = useRef<Kit | null>(null)
  const ids: Partial<Record<Slot, string>> = {}
  const items: Kit['gear'] = {}
  for (const [k, v] of Object.entries(gear) as [Slot, string | Item | null][]) {
    if (typeof v === 'string') ids[k] = v
    else if (v) items[k] = v
  }
  const kit = kitOf(look, ids)
  Object.assign(kit.gear, items)
  kitRef.current = kit
  const kind = weaponKind(kit)
  // Still portraits draw once, so they redraw whenever what they show changes.
  const sig = still ? JSON.stringify([look, Object.values(kit.gear).map((i) => i?.id)]) : ''

  useEffect(() => {
    const c = ref.current!
    const ctx = c.getContext('2d')!
    const puppet = new Puppet(gripOf(kind))
    puppet.play(clip, 1)
    let raf = 0
    let last = performance.now()
    const draw = (now: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.round(c.clientWidth * dpr)
      const h = Math.round(c.clientHeight * dpr)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      puppet.update(now - last)
      last = now
      if (puppet.done()) puppet.play('guard', 200)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // Show 300/zoom units of figure height. Zoomed in, hang the frame from just above the plume
      // so the head stays in view and the feet crop; zoomed out, stand the feet on the bottom edge
      // and leave the headroom for a raised weapon.
      const k = (h * zoom) / 300
      ctx.setTransform(k * face, 0, 0, k, w / 2 - face * 6 * k, zoom > 1 ? 288 * k : h - 8 * k)
      drawFighter(ctx, kitRef.current!, puppet.pose(still ? 0 : now), { time: still ? 0 : now })
      if (!still) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [kind, clip, zoom, face, still, sig])

  return <canvas ref={ref} className={`gl-portrait ${className ?? ''}`} />
}

export function Bar({ value, max, kind, label }: { value: number; max: number; kind: 'hp' | 'sta' | 'mana' | 'xp' | 'favour'; label?: ReactNode }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100))
  return (
    <div className={`gl-bar is-${kind}`}>
      <span style={{ width: `${pct}%` }} />
      {label !== undefined && <em>{label}</em>}
    </div>
  )
}

export const Gold = ({ n }: { n: number }) => (
  <span className="gl-gold">
    <i />
    {n.toLocaleString()}
  </span>
)

export const tierColour = (it: Item) => MATERIALS[it.tier].base

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose?: () => void; wide?: boolean }) {
  return (
    <div className="gl-modal" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`gl-panel gl-modal-box ${wide ? 'is-wide' : ''}`}>{children}</div>
    </div>
  )
}
