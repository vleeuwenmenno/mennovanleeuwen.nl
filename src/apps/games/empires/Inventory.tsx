import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { UNIT } from './data'
import { CAPTURE_TIME, MAX_FLEETS, eta, factionName, fleetsAt, fleetsHere, heldOf, holdBack, mergeFleets, shiftShips, type Bay, type Fleet, type Galaxy } from './galaxy'
import { Floating, Icon, ShipArt, unitTip, type IconName } from './Hud'
import { galaxyLayout } from './layout'
import type { EmpiresSound } from './sound'
import { LongPress, TAP_SLOP, getTouchMods, isTouch, useCoarse, useWheel, type WheelItem } from './Touch'
import './inventory.css'

// The fleet inventory of Galactic conquest: our fleets at a planet side by side, each a grid of
// slots like a crafting game's inventory, with a stack per kind of ship. Ships move between the
// fleets there (and into a new one, up to MAX_FLEETS), and between the part of a fleet that jumps
// in when a battle starts and the part held back in the battle's reserve. The rules live in
// galaxy.ts (shiftShips, holdBack, mergeFleets); this is only the hands.
//
// Mouse: drag a stack onto a fleet to move it all (Shift or the right button: half, Ctrl: one), or
// click it to pick it up and click a fleet to put it there; double-click sends it to the next
// fleet. After a move a bar under the title sets the exact count. Fingers: tap a stack to pick it
// up and tap a fleet to put it there (with the touch bar's Shift: half); a long press opens a wheel.

const ME = 0
/** Slots across a fleet's grid, and the rows each part has at least. */
const COLS = 4
const DEPLOY_ROWS = 2
const HELD_ROWS = 1

type Target = { fleet: number | 'new'; held: boolean }
/** What's under the pointer in the panel: a fleet's column (or the new fleet one), which part of
 * it, and the stack, header or hold toggle hit. */
type Hit = Target & { unit?: string; head: boolean; toggle: boolean }

/** Ships of one fleet's part (jumping in, or held back) as stacks, the biggest kind first. */
function stacks(f: Fleet, held: boolean): [string, number][] {
  const m = new Map<string, number>()
  for (const id of f.ships) m.set(id, (m.get(id) ?? 0) + 1)
  return [...m.entries()]
    .map(([id, n]): [string, number] => [id, held ? heldOf(f, id) : n - heldOf(f, id)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => UNIT[b[0]].cost - UNIT[a[0]].cost)
}
/** How many of a type a part of a fleet has. */
const inBay = (g: Galaxy, bay: Bay, unit: string) => {
  const f = g.fleets.find((x) => x.id === bay.fleet)
  if (!f) return 0
  const held = heldOf(f, unit)
  return bay.held ? held : f.ships.filter((x) => x === unit).length - held
}
const half = (n: number) => Math.max(1, Math.ceil(n / 2))
const shipsN = (n: number) => `${n} ship${n === 1 ? '' : 's'}`

function hitAt(el: Element | null): Hit | null {
  const col = el?.closest<HTMLElement>('[data-inv-fleet]')
  if (!el || !col) return null
  const fleet = col.dataset.invFleet === 'new' ? 'new' : Number(col.dataset.invFleet)
  return {
    fleet,
    held: el.closest<HTMLElement>('[data-inv-bay]')?.dataset.invBay === 'held',
    unit: el.closest<HTMLElement>('[data-inv-unit]')?.dataset.invUnit,
    head: !!el.closest('[data-inv-head]'),
    toggle: !!el.closest('[data-inv-toggle]'),
  }
}

export function FleetInventory({ g, planet, flight, selected, sound, toast, onSelect, onMoved, onClose }: {
  g: Galaxy
  /** The planet whose fleets of ours it shows, or -1 for `flight`, one of ours in flight. */
  planet: number
  flight?: Fleet
  selected: Set<number>
  sound: EmpiresSound
  toast: (text: string, tone?: 'good' | 'bad' | 'info') => void
  /** A fleet's header was clicked: it becomes the selection, for orders. */
  onSelect: (f: Fleet) => void
  /** Ships went from one fleet to another (which may have emptied and gone). */
  onMoved: (from: number, to: Fleet) => void
  onClose: () => void
}) {
  const coarse = useCoarse()
  const [, setTick] = useState(0)
  const bump = () => setTick((n) => n + 1)
  /** A stack picked up (a click, or a tap), with how many of it go where it's put. */
  const [carry, setCarry] = useState<{ from: Bay; unit: string; n: number } | null>(null)
  /** The last move, for setting its exact count afterwards. */
  const [adjust, setAdjust] = useState<{ from: Bay; to: Bay; unit: string; moved: number } | null>(null)
  /** A stack (or a whole fleet, by its header) being dragged with the mouse. */
  const [ghost, setGhost] = useState<{ unit?: string; fleet?: number; n: number; x: number; y: number } | null>(null)
  const wheel = useWheel()
  const press = useRef(new LongPress())
  const fleets = planet >= 0 ? fleetsHere(g, ME, planet) : flight ? [flight] : []
  const moving = planet < 0
  const p = planet >= 0 ? g.planets[planet] : null
  const label = (f: Fleet) => `Fleet ${fleets.indexOf(f) + 1}`

  // A carried stack or a move being adjusted that no longer exists is let go.
  useEffect(() => {
    if (carry && inBay(g, carry.from, carry.unit) <= 0) setCarry(null)
    if (adjust && !g.fleets.some((f) => f.id === adjust.to.fleet)) setAdjust(null)
  })
  // Esc puts down what's carried (or closes the count bar) before the map gets the key.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (!carry && !adjust)) return
      e.stopPropagation()
      setCarry(null)
      setAdjust(null)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [carry, adjust])

  /** Moves ships, telling the player why not when they can't go; returns where they went and how many. */
  const move = (from: Bay, to: Target, unit: string, n: number): { fleet: Fleet; moved: number } | null => {
    const had = inBay(g, from, unit)
    const r = shiftShips(g, ME, from, to, unit, n)
    if (typeof r === 'string') {
      sound.error()
      toast(r, 'bad')
      return null
    }
    sound.click()
    if (r.id !== from.fleet) onMoved(from.fleet, r)
    bump()
    return { fleet: r, moved: Math.min(Math.floor(n), had) }
  }
  /** A move from a drop or a click: then the count bar, to make it exact. */
  const drop = (from: Bay, to: Target, unit: string, n: number) => {
    if (to.fleet === from.fleet && to.held === from.held) return setCarry(null)
    const r = move(from, to, unit, n)
    setCarry(null)
    if (r) setAdjust({ from, to: { fleet: r.fleet.id, held: to.held }, unit, moved: r.moved })
  }
  /** One more (or one fewer) of the last move, or all that's left of them. */
  const nudge = (by: 1 | -1 | 'all') => {
    if (!adjust) return
    const { from, to, unit } = adjust
    if (by === -1) {
      // The fleet they came from may be gone (it gave all it had): one back makes it anew.
      const back = g.fleets.some((f) => f.id === from.fleet) ? from : { fleet: 'new' as const, held: from.held }
      const r = move(to, back, unit, 1)
      if (r) setAdjust(g.fleets.some((f) => f.id === to.fleet) ? { from: { fleet: r.fleet.id, held: from.held }, to, unit, moved: adjust.moved - 1 } : null)
      return
    }
    const left = inBay(g, from, unit)
    const n = by === 'all' ? left : 1
    if (!n) return sound.error()
    const r = move(from, to, unit, n)
    if (r) setAdjust({ ...adjust, moved: adjust.moved + r.moved })
  }
  /** A whole stack to the other part of its fleet: held back, or back into the battle line. */
  const toggle = (bay: Bay, unit: string) => {
    const n = inBay(g, bay, unit)
    const r = move(bay, { fleet: bay.fleet, held: !bay.held }, unit, n)
    if (r) setAdjust({ from: bay, to: { fleet: bay.fleet, held: !bay.held }, unit, moved: r.moved })
  }
  /** Every ship of a fleet held back, or (when it holds them all back already) none. */
  const holdAll = (f: Fleet) => {
    const all = stacks(f, false).length === 0
    for (const id of new Set(f.ships)) holdBack(g, ME, f.id, id, all ? 0 : f.ships.length)
    sound.click()
    setAdjust(null)
    bump()
  }
  const merge = (from: number, into: number) => {
    const why = mergeFleets(g, ME, from, into)
    if (why) {
      sound.error()
      return toast(why, 'bad')
    }
    sound.click()
    const to = g.fleets.find((f) => f.id === into)
    if (to) onMoved(from, to)
    setCarry(null)
    setAdjust(null)
    bump()
  }
  /** The stack to the next fleet along (the first after the last; a new one when there's only one). */
  const next = (bay: Bay, unit: string) => {
    const i = fleets.findIndex((f) => f.id === bay.fleet)
    const to: Target = fleets.length > 1 ? { fleet: fleets[(i + 1) % fleets.length].id, held: bay.held } : { fleet: 'new', held: bay.held }
    setCarry(null)
    drop(bay, to, unit, inBay(g, bay, unit))
  }

  /** A click (or a tap) on the panel: pick up, put down, or select. */
  const activate = (hit: Hit, mods: { half: boolean; one: boolean }) => {
    const bay = typeof hit.fleet === 'number' ? { fleet: hit.fleet, held: hit.held } : null
    if (hit.toggle && bay && hit.unit) return toggle(bay, hit.unit)
    if (carry) {
      if (hit.fleet === carry.from.fleet && hit.held === carry.from.held && !hit.head) {
        // Its own place: another stack there is picked up instead; the same one is put back.
        if (hit.unit && hit.unit !== carry.unit) setCarry({ from: carry.from, unit: hit.unit, n: inBay(g, carry.from, hit.unit) })
        else setCarry(null)
        return
      }
      return drop(carry.from, { fleet: hit.fleet, held: hit.head ? false : hit.held }, carry.unit, carry.n)
    }
    setAdjust(null)
    if (hit.unit && bay) {
      const n = inBay(g, bay, hit.unit)
      sound.click()
      return setCarry({ from: bay, unit: hit.unit, n: mods.one ? 1 : mods.half ? half(n) : n })
    }
    if (hit.head && bay) {
      const f = g.fleets.find((x) => x.id === bay.fleet)
      if (f) onSelect(f)
    }
  }

  /** A finger's long press: what can be done with the stack (or fleet) under it. */
  const wheelFor = (hit: Hit, x: number, y: number) => {
    if (typeof hit.fleet !== 'number') return
    const f = g.fleets.find((v) => v.id === hit.fleet)
    if (!f) return
    const ic = (name: IconName) => <Icon name={name} size={18} />
    const bay = { fleet: f.id, held: hit.held }
    const full = !moving && fleets.length >= MAX_FLEETS ? `At most ${MAX_FLEETS} fleets at one planet` : false
    const inFlight = moving ? 'In flight: ships move between fleets only in orbit' : false
    let items: WheelItem[]
    let title: string
    if (hit.unit) {
      const unit = hit.unit
      const n = inBay(g, bay, unit)
      title = `${UNIT[unit].name} ×${n} · ${label(f)}${hit.held ? ' · held back' : ''}`
      items = [
        { id: 'all', label: 'Move all', icon: ic('move'), disabled: inFlight, run: () => (setAdjust(null), setCarry({ from: bay, unit, n })) },
        { id: 'half', label: 'Move half', icon: <b>½</b>, disabled: inFlight || (n < 2 ? 'Only one' : false), run: () => (setAdjust(null), setCarry({ from: bay, unit, n: half(n) })) },
        { id: 'some', label: 'Move…', icon: <b>±</b>, disabled: inFlight, run: () => (setAdjust(null), setCarry({ from: bay, unit, n: 1 })) },
        { id: 'new', label: 'New fleet', icon: ic('fleet'), disabled: inFlight || (n === f.ships.length ? 'That is the whole fleet' : full), run: () => drop(bay, { fleet: 'new', held: false }, unit, n) },
        hit.held
          ? { id: 'deploy', label: 'Deploy', icon: ic('attack'), run: () => toggle(bay, unit) }
          : { id: 'hold', label: 'Hold back', icon: ic('hold'), run: () => toggle(bay, unit) },
        { id: 'select', label: 'Select fleet', icon: ic('target'), run: () => onSelect(f) },
      ]
    } else {
      title = `${label(f)} · ${shipsN(f.ships.length)}`
      const allHeld = stacks(f, false).length === 0
      items = [
        { id: 'select', label: 'Select', icon: ic('target'), run: () => onSelect(f) },
        { id: 'hold', label: allHeld ? 'Deploy all' : 'Hold back all', icon: ic(allHeld ? 'attack' : 'hold'), run: () => holdAll(f) },
        ...fleets.filter((x) => x !== f).map((x): WheelItem => ({ id: `join${x.id}`, label: `Join ${label(x)}`, icon: ic('rally'), run: () => merge(f.id, x.id) })),
      ]
    }
    wheel({ x, y, title, items })
  }

  /** Every press in the panel comes here: drags and clicks with a mouse, taps and long presses with a finger. */
  const down = (e: React.PointerEvent) => {
    const target = e.target as Element
    if (target.closest('button')) return
    const hit = hitAt(target)
    if (!hit) return
    if (isTouch(e)) {
      const x0 = e.clientX
      const y0 = e.clientY
      if (hit.unit || hit.head) press.current.start(e, () => wheelFor(hit, x0, y0))
      const move = (m: PointerEvent) => void (m.pointerId === e.pointerId && press.current.move(m))
      const up = (u: PointerEvent) => {
        if (u.pointerId !== e.pointerId) return
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        press.current.cancel()
        if (press.current.fired || u.type !== 'pointerup' || Math.hypot(u.clientX - x0, u.clientY - y0) > TAP_SLOP) return
        activate(hit, { half: getTouchMods().shift, one: false })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      return
    }
    if (e.button !== 0 && e.button !== 2) return
    e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    const bay = typeof hit.fleet === 'number' ? { fleet: hit.fleet, held: hit.held } : null
    // What a drag carries: the stack (all, half or one of it), or with the header the whole fleet.
    const avail = bay && hit.unit ? inBay(g, bay, hit.unit) : 0
    const n = e.ctrlKey || e.metaKey ? 1 : e.button === 2 || e.shiftKey ? half(avail) : avail
    const draggable = !carry && !hit.toggle && bay && (hit.unit || (hit.head && !moving))
    let went = false
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId || !draggable) return
      if (!went && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return
      went = true
      setAdjust(null)
      setGhost(hit.unit ? { unit: hit.unit, n, x: m.clientX, y: m.clientY } : { fleet: bay!.fleet, n: g.fleets.find((f) => f.id === bay!.fleet)?.ships.length ?? 0, x: m.clientX, y: m.clientY })
    }
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGhost(null)
      if (!went) return activate(hit, { half: e.button === 2 || e.shiftKey, one: e.ctrlKey || e.metaKey })
      const to = hitAt(document.elementFromPoint(u.clientX, u.clientY))
      if (!to || !bay) return
      if (hit.unit) drop(bay, { fleet: to.fleet, held: to.head ? false : to.held }, hit.unit, n)
      else if (typeof to.fleet === 'number' && to.fleet !== bay.fleet) merge(bay.fleet, to.fleet)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const dbl = (e: React.MouseEvent) => {
    const hit = hitAt(e.target as Element)
    if (!hit?.unit || hit.toggle || typeof hit.fleet !== 'number' || moving) return
    next({ fleet: hit.fleet, held: hit.held }, hit.unit)
  }
  /** Enter or Space on a focused slot: as a click. */
  const keyed = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const hit = hitAt(e.target as Element)
    if (!hit) return
    e.preventDefault()
    activate(hit, { half: e.shiftKey, one: e.ctrlKey })
  }

  const enemy = p ? fleetsAt(g, p.id).filter((f) => f.owner !== ME) : []
  const status = (f: Fleet) => {
    if (f.leg) return `→ ${g.planets[(f.route.length ? f.route[f.route.length - 1] : f.leg).planet]?.name ?? g.systems[f.leg.system].name} · ${Math.ceil(eta(f))} s`
    const cap = g.planets[f.planet]?.capture
    if (cap) return `${cap.owner === ME ? 'Taking' : 'Losing'} · ${Math.ceil(CAPTURE_TIME - cap.t)} s`
    if (f.join !== undefined) return 'Joining up'
    if (f.waypoints?.length) return `${f.waypoints.length} stop${f.waypoints.length > 1 ? 's' : ''} queued`
    return 'In orbit'
  }
  const isCarried = (f: Fleet, held: boolean, unit: string) => !!carry && carry.from.fleet === f.id && carry.from.held === held && carry.unit === unit
  const grid = (f: Fleet, held: boolean) => {
    const ss = stacks(f, held)
    const rows = Math.max(held ? HELD_ROWS : DEPLOY_ROWS, Math.ceil(ss.length / COLS))
    const slots: ReactNode[] = ss.map(([id, n]) => {
      const t = UNIT[id]
      const c = isCarried(f, held, id)
      return (
        <div key={id} role="button" tabIndex={0} className={`ew-inv-slot has-stack ${c ? 'is-carried' : ''}`} data-inv-unit={id} data-longpress=""
          {...unitTip(t, { who: 'Ours', rel: 'own' }, `${n} ${held ? 'held back: they wait in the reserve when a battle starts, to be called in' : 'jump in when a battle starts'}. ${coarse ? 'Tap to pick up, long-press for more.' : 'Drag to another fleet (Shift: half, Ctrl: one), click to pick up, double-click to send to the next fleet.'}`)}>
          <ShipArt t={t} />
          <em>{c && carry!.n < n ? `${n - carry!.n}` : n}</em>
          <i className={`ew-inv-hold ${held ? 'is-held' : ''}`} data-inv-toggle="" data-longpress="" data-tip={held ? 'Held back. Click to deploy them all' : 'Click to hold them all back'}>
            <Icon name={held ? 'hold' : 'attack'} size={11} />
          </i>
        </div>
      )
    })
    for (let i = ss.length; i < rows * COLS; i++) slots.push(<div key={`e${i}`} className="ew-inv-slot" />)
    return (
      <div className={`ew-inv-grid ${held ? 'is-held' : ''}`} data-inv-bay={held ? 'held' : 'deploy'} style={{ gridTemplateColumns: `repeat(${COLS}, var(--slot))` }}>
        {slots}
      </div>
    )
  }

  const where = (b: Bay) => {
    const f = g.fleets.find((x) => x.id === b.fleet)
    return `${f ? label(f) : 'a new fleet'}${b.held ? ' (held back)' : ''}`
  }
  const strip = carry ? (
    <div className="ew-inv-strip is-carry" onWheel={(e) => setCarry({ ...carry, n: Math.max(1, Math.min(inBay(g, carry.from, carry.unit), carry.n + (e.deltaY < 0 ? 1 : -1))) })}>
      <ShipArt t={UNIT[carry.unit]} />
      <span>{UNIT[carry.unit].name}</span>
      <button onClick={() => setCarry({ ...carry, n: Math.max(1, carry.n - 1) })} aria-label="One fewer">−</button>
      <b>{carry.n}</b>
      <button onClick={() => setCarry({ ...carry, n: Math.min(inBay(g, carry.from, carry.unit), carry.n + 1) })} aria-label="One more">+</button>
      <small className="ew-muted">of {inBay(g, carry.from, carry.unit)} · {coarse ? 'tap' : 'click'} a fleet to put them there</small>
      <button className="ew-inv-x" onClick={() => setCarry(null)} aria-label="Put them back">✕</button>
    </div>
  ) : adjust ? (
    <div className="ew-inv-strip is-adjust">
      <ShipArt t={UNIT[adjust.unit]} />
      <span>
        <b>{adjust.moved}</b> {UNIT[adjust.unit].name} {adjust.from.fleet === adjust.to.fleet ? (adjust.to.held ? 'held back' : 'deployed') : `to ${where(adjust.to)}`}
      </span>
      <button onClick={() => nudge(-1)} disabled={adjust.moved <= 0} aria-label="One fewer">−</button>
      <button onClick={() => nudge(1)} disabled={inBay(g, adjust.from, adjust.unit) <= 0} aria-label="One more">+</button>
      <button onClick={() => nudge('all')} disabled={inBay(g, adjust.from, adjust.unit) <= 0}>All</button>
      <button className="ew-inv-x" onClick={() => setAdjust(null)} aria-label="Done">✓</button>
    </div>
  ) : (
    <p className="ew-inv-strip ew-muted ew-small">
      {moving
        ? 'In flight: ships move between fleets only in orbit. Held back ships wait in the reserve when a battle starts.'
        : coarse
          ? 'Tap a stack, then a fleet, to move it (Shift: half). Long-press for more. Held back ships wait in the reserve when a battle starts.'
          : 'Drag stacks between fleets (Shift: half, Ctrl: one) or into a new one. The shield row is held back: those wait in the reserve when a battle starts.'}
    </p>
  )

  return (
    <Floating id="gInv" title={p ? `Fleets at ${p.name}` : 'Fleet in flight'} at={{ right: 6, top: 56 }} className="ew-inv" layout={galaxyLayout} onClose={onClose}
      aside={!moving && <b className="ew-selcount" data-tip={`Fleets of ours here, of at most ${MAX_FLEETS}`}>{fleets.length}/{MAX_FLEETS}</b>}>
      {strip}
      <div className="ew-inv-body" data-nodrag onPointerDown={down} onDoubleClick={dbl} onKeyDown={keyed} onContextMenu={(e) => e.preventDefault()}>
        {fleets.map((f) => {
          const sel = selected.has(f.id)
          const allHeld = stacks(f, false).length === 0
          const held = f.ships.length - stacks(f, false).reduce((s, [, n]) => s + n, 0)
          return (
            <div key={f.id} className={`ew-inv-fleet ${sel ? 'is-sel' : ''}`} data-inv-fleet={f.id}>
              <div className="ew-inv-head" data-inv-head="" data-longpress="" role="button" tabIndex={0}
                data-tip={coarse ? 'Tap to select this fleet for orders; long-press to join it to another or hold it all back.' : 'Click to select this fleet for orders. Drag it onto another fleet to join them.'}>
                <b>{label(f)}</b>
                <small>{shipsN(f.ships.length)} · {status(f)}</small>
                <button className={`ew-inv-holdall ${allHeld ? 'is-on' : ''}`} onClick={() => holdAll(f)} data-tip={allHeld ? 'All held back. Click to deploy them all' : 'Hold the whole fleet back'} aria-label={allHeld ? 'Deploy all' : 'Hold back all'}>
                  <Icon name="hold" size={12} />
                </button>
              </div>
              {grid(f, false)}
              <div className="ew-inv-label"><Icon name="hold" size={11} /> Held back{held ? <b> · {held}</b> : ''}</div>
              {grid(f, true)}
            </div>
          )
        })}
        {!moving && fleets.length < MAX_FLEETS && (
          <div className="ew-inv-fleet is-new" data-inv-fleet="new" data-tip={`Drop ships here to make a new fleet (at most ${MAX_FLEETS} at a planet)`}>
            <div className="ew-inv-head"><b>New fleet</b><small>{MAX_FLEETS - fleets.length} free</small></div>
            <div className="ew-inv-newdrop" data-inv-bay="deploy">
              <Icon name="fleet" size={22} />
              <span>{coarse ? 'Pick up ships, then tap here' : 'Drop ships here'}</span>
            </div>
          </div>
        )}
      </div>
      {enemy.length > 0 && <p className="ew-inv-enemy ew-small">{factionName(g, enemy[0].owner)} here: {enemy.reduce((n, f) => n + f.ships.length, 0)} ships in {enemy.length} fleet{enemy.length > 1 ? 's' : ''}</p>}
      {ghost && createPortal(
        <div className="ew-inv-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.unit ? <ShipArt t={UNIT[ghost.unit]} /> : <Icon name="fleet" size={26} />}
          <em>{ghost.n}</em>
        </div>,
        document.body,
      )}
    </Floating>
  )
}
