import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { resource, RESOURCES, type Bag, type Estate, type ResId } from './estate'
import { MATERIALS, type Item, type Look, type Slot, type WeaponKind } from './data'
import { drawFighter, drawShield, drawWeapon, kitOf, weaponKind, type Kit } from './render'
import { Puppet, gripOf, type ClipName } from './rig'

// Small pieces shared by the screens: a live portrait of a gladiator, bars, coins.

/**
 * An animated gladiator on a transparent canvas. `gear` may hold ids (from a save) or items (a
 * shop's try-on). `zoom` frames the whole body at 1, the head and chest above that.
 */
export function Portrait({ look, gear, clip = 'guard', zoom = 1, face = 1, className, still = false, focus, cycle }: { look: Look; gear: Partial<Record<Slot, string | Item | null>>; clip?: ClipName; zoom?: number; face?: 1 | -1; className?: string; still?: boolean; focus?: number; cycle?: ClipName[] }) {
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
    puppet.play(cycle?.[0] ?? clip, 1)
    let step = 0
    let raf = 0
    let last = performance.now()
    const draw = (now: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.round(c.clientWidth * dpr)
      const h = Math.round(c.clientHeight * dpr)
      // Not laid out yet (a grid cell can start at zero width): try again next frame.
      if (!w || !h) {
        raf = requestAnimationFrame(draw)
        return
      }
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      puppet.update(now - last)
      last = now
      if (puppet.done()) {
        // With `cycle`, run through those moves in turn (a drill); otherwise settle into guard.
        if (cycle?.length) {
          step = (step + 1) % cycle.length
          puppet.play(cycle[step], 160)
        } else puppet.play('guard', 200)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // Show 300/zoom units of figure height. Zoomed in, hang the frame from just above the plume
      // so the head stays in view and the feet crop; zoomed out, stand the feet on the bottom edge
      // and leave the headroom for a raised weapon.
      const k = (h * zoom) / 300
      // `focus` centres a height on the body instead (units above the feet), for close-ups of gear.
      const ty = focus !== undefined ? h / 2 + focus * k : zoom > 1 ? 288 * k : h - 8 * k
      ctx.setTransform(k * face, 0, 0, k, w / 2 - face * 6 * k, ty)
      drawFighter(ctx, kitRef.current!, puppet.pose(still ? 0 : now), { time: still ? 0 : now })
      if (!still) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    // A still picture is drawn once, so draw it again whenever its box changes size; otherwise
    // the browser stretches the first drawing to fit.
    const ro = new ResizeObserver(() => {
      if (!still) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(draw)
    })
    ro.observe(c)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [kind, clip, zoom, face, still, sig, focus, cycle?.join()])

  return <canvas ref={ref} className={`gl-portrait ${className ?? ''}`} />
}

// How far each weapon reaches from its butt (+) to its tip (-), in rig units, to fit it in a frame.
const WEAPON_SPAN: Record<WeaponKind, [number, number]> = {
  dagger: [12, -38],
  gladius: [16, -61],
  greatsword: [35, -104],
  axe: [16, -80],
  mace: [14, -67],
  warhammer: [26, -86],
  spear: [56, -132],
  trident: [50, -132],
  staff: [42, -120],
  wand: [12, -44],
  scepter: [14, -60],
}
// Where on the body each piece of armour sits (units above the feet) and how close to zoom.
const SLOT_VIEW: Partial<Record<Slot, [focus: number, zoom: number]>> = {
  head: [240, 3],
  body: [168, 2.2],
  shoulders: [186, 2.6],
  arms: [150, 2.3],
  legs: [52, 2.3],
  feet: [16, 3.4],
  cape: [120, 1.35],
}

/**
 * A picture of one item, drawn by the game itself: weapons and shields on their own, armour
 * worn by `look` and framed on the body part it covers.
 */
export function ItemArt({ it, look, className }: { it: Item; look: Look; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const loose = !!it.weapon || it.slot === 'shield'
  useEffect(() => {
    if (!loose) return
    const c = ref.current!
    const ctx = c.getContext('2d')!
    // Drawn whenever the canvas changes size: in a grid it can still be 0 wide on first paint.
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = (c.width = Math.round(c.clientWidth * dpr))
      const h = (c.height = Math.round(c.clientHeight * dpr))
      if (!w || !h) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.translate(w / 2, h / 2)
      if (it.weapon) {
        // Laid across the frame diagonally, centred on its middle.
        const [butt, tip] = WEAPON_SPAN[it.weapon]
        const k = (Math.min(w, h) * 1.25) / (butt - tip)
        ctx.scale(k, k)
        ctx.rotate(Math.PI / 4)
        ctx.translate(0, -(butt + tip) / 2)
        drawWeapon(ctx, { x: 0, y: 0 }, 0, it)
      } else {
        const k = h / 92
        ctx.scale(k / 0.62, k)
        drawShield(ctx, { x: -2, y: 0 }, 90, it)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => ro.disconnect()
  }, [it, loose])
  if (!loose) {
    const [focus, zoom] = SLOT_VIEW[it.slot] ?? [150, 2]
    return <Portrait look={look} gear={{ [it.slot]: it }} focus={focus} zoom={zoom} still className={className} />
  }
  return <canvas ref={ref} className={`gl-portrait ${className ?? ''}`} />
}

/** The current time, refreshed every `ms`: for countdowns. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
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

/**
 * Pins an overlay to the part of the game that's in view. The game scrolls inside `.gl-root`, so
 * `inset: 0` alone would cover its top, wherever the page is scrolled to; this also holds the
 * page still underneath while the overlay is open.
 */
export function useOverlay<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const root = el?.closest<HTMLElement>('.gl-root')
    if (!el || !root) return
    const was = root.style.overflow
    el.style.top = `${root.scrollTop}px`
    el.style.bottom = 'auto'
    el.style.height = `${root.clientHeight}px`
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = was
    }
  }, [])
  return ref
}

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose?: () => void; wide?: boolean }) {
  const ref = useOverlay<HTMLDivElement>()
  return (
    <div ref={ref} className="gl-modal" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`gl-panel gl-modal-box ${wide ? 'is-wide' : ''}`}>{children}</div>
    </div>
  )
}

/** A painted icon for a place in town, or its emoji until the picture has loaded (or if it can't). */
export function PlaceIcon({ id, glyph }: { id: string; glyph: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading')
  return (
    <span className="gl-place-icon">
      {state !== 'ok' && <i>{glyph}</i>}
      {state !== 'missing' && <img src={`/games/gladiator/icons/${id}.webp`} alt="" draggable={false} onLoad={() => setState('ok')} onError={() => setState('missing')} style={state === 'ok' ? undefined : { display: 'none' }} />}
    </span>
  )
}

export function PageHead({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="gl-page-head">
      <button className="gl-btn is-quiet" onClick={onBack}>
        ← Town
      </button>
      <h2>{title}</h2>
      {children}
    </div>
  )
}

/** A big painted icon for a card, glowing in `colour`, with an emoji until the picture loads. */
export function CardIcon({ id, glyph, colour }: { id: string; glyph: string; colour: string }) {
  return (
    <div className="gl-card-art gl-icon-art" style={{ ['--glow' as string]: colour }}>
      <PlaceIcon id={id} glyph={glyph} />
    </div>
  )
}

/** One material: its painted icon and a number, red when there isn't enough. */
export function Res({ id, n, need }: { id: ResId; n?: number; need?: number }) {
  const r = resource(id)
  const short = need !== undefined && (n ?? 0) < need
  return (
    <span className={`gl-res ${short ? 'is-short' : ''}`} title={r.name}>
      <PlaceIcon id={`res-${id}`} glyph={r.glyph} />
      {need !== undefined ? (
        <b>
          {n ?? 0}/{need}
        </b>
      ) : (
        <b>{n ?? 0}</b>
      )}
    </span>
  )
}

/** A list of materials, with what you hold against what's needed. */
export function BagView({ bag, have }: { bag: Bag; have?: Bag }) {
  return (
    <span className="gl-bag">
      {(Object.keys(bag) as ResId[]).map((k) => (have ? <Res key={k} id={k} n={have[k]} need={bag[k]} /> : <Res key={k} id={k} n={bag[k]} />))}
    </span>
  )
}

/** Everything in the storehouse, in one strip. */
export function Storehouse({ estate }: { estate: Estate }) {
  return (
    <div className="gl-storehouse" aria-label="Storehouse">
      {RESOURCES.map((r) => (
        <Res key={r.id} id={r.id} n={estate.res[r.id]} />
      ))}
    </div>
  )
}
