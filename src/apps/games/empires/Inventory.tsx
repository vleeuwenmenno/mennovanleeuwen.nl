import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  CAPTURE_TIME, GRID_H, GRID_W, MAX_FLEETS, arrangeFleet, canSee, cellsUsed, dropWhy, eta, factionName, fleetsAt, fleetsHere, holdFleet, holdItem, itemAt, mergeFleets, moveItem, stacks,
  type Fleet, type Galaxy, type Item, type ItemDrop, type ItemRef,
} from './galaxy'
import { UNIT } from './data'
import { Floating, Icon, ShipArt, unitTip, type IconName } from './Hud'
import { galaxyLayout } from './layout'
import type { EmpiresSound } from './sound'
import { LongPress, TAP_SLOP, getTouchMods, isTouch, useCoarse, useWheel, type WheelItem } from './Touch'
import './inventory.css'

// The fleet inventory of Galactic conquest: our fleets at a planet side by side, each a grid of
// GRID_W by GRID_H cells like a backpack in a role-playing game. Every ship takes up a footprint by
// its size (a fighter stack one cell, a frigate two, a dreadnought six), so where things go
// matters. Ships move to any spot where they fit, in their own fleet or another one there (or a new
// one, up to MAX_FLEETS), and each item is either deployed (it jumps in when a battle starts) or
// held back in the battle's reserve. The rules live in galaxy.ts (moveItem, holdItem, mergeFleets,
// arrangeFleet); this is only the hands.
//
// Mouse: drag a ship to a spot (the cells it would take light up green where it fits, red where
// it doesn't; R or a right-click turns it), or onto a fleet's header to put it anywhere there;
// Shift drags half a stack, Ctrl one squadron. A click picks a ship up and another click puts it
// down; a double-click sends it to the next fleet; a right-click turns it where it lies. After a
// move of strike craft a bar under the title sets the exact count. Fingers: tap a ship to pick it
// up and tap a spot to put it there (with the touch bar's Shift: half a stack); a long press opens
// a wheel with the rest.

const ME = 0
const CELLS = GRID_W * GRID_H

/** A ship (or squadrons of a stack) picked up: the item it comes from, how many go (of how many),
 * which way it's turned now, and which of its cells the pointer holds. */
type Carry = { from: ItemRef; unit: string; n: number; of: number; w: number; h: number; dx: number; dy: number }
/** What's under the pointer in the panel: a fleet's column (or the new fleet one), the cell of its
 * grid (when over the grid), and the item, header or hold toggle there. */
type Hit = { fleet: number | 'new'; cell: { x: number; y: number } | null; item?: Item; head: boolean; toggle: boolean }
/** Where a carried ship would go, and whether it fits there. */
type Hover = { fleet: number; x: number; y: number; w: number; h: number; ok: boolean }

const half = (n: number) => Math.max(1, Math.ceil(n / 2))
const shipsN = (n: number) => `${n} ship${n === 1 ? '' : 's'}`
const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function hitAt(g: Galaxy, el: Element | null, cx: number, cy: number): Hit | null {
  const col = el?.closest<HTMLElement>('[data-inv-fleet]')
  if (!el || !col) return null
  const fleet = col.dataset.invFleet === 'new' ? 'new' : Number(col.dataset.invFleet)
  const grid = el.closest<HTMLElement>('[data-inv-grid]')
  let cell: Hit['cell'] = null
  if (grid) {
    const r = grid.getBoundingClientRect()
    const x = Math.floor(((cx - r.left) / r.width) * GRID_W)
    const y = Math.floor(((cy - r.top) / r.height) * GRID_H)
    if (x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) cell = { x, y }
  }
  const f = typeof fleet === 'number' ? g.fleets.find((x) => x.id === fleet) : undefined
  return { fleet, cell, item: f && cell ? itemAt(f, cell.x, cell.y) : undefined, head: !!el.closest('[data-inv-head]'), toggle: !!el.closest('[data-inv-toggle]') }
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
  /** A ship picked up (a click, a tap or a drag). */
  const [carry, setCarry] = useState<Carry | null>(null)
  /** The carry as it is now, for a drag's drop (it may have been turned on the way). */
  const carryRef = useRef(carry)
  carryRef.current = carry
  /** Whether the carried ship is being dragged with the mouse (it then drops where it's let go). */
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)
  /** The pointer, for the ghost of what's carried. */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  /** A cell's size on screen, for the ghost. */
  const slot = useRef(40)
  /** The last move of strike craft, for setting its exact count afterwards: where they came from
   * and the stack they went into. */
  const [adjust, setAdjust] = useState<{ from: ItemRef; to: ItemRef; unit: string; moved: number } | null>(null)
  /** A whole fleet being dragged by its header, to join it to another. */
  const [fleetGhost, setFleetGhost] = useState<{ fleet: number; n: number; x: number; y: number } | null>(null)
  const wheel = useWheel()
  const press = useRef(new LongPress())
  const fleets = planet >= 0 ? fleetsHere(g, ME, planet) : flight ? [flight] : []
  const moving = planet < 0
  const p = planet >= 0 ? g.planets[planet] : null
  const label = (f: Fleet) => `Fleet ${fleets.indexOf(f) + 1}`
  const fleetOf = (id: number) => g.fleets.find((f) => f.id === id)
  /** The item a reference points at, if it's still of that type. */
  const itemOf = (r: ItemRef, unit: string) => {
    const f = fleetOf(r.fleet)
    const it = f && itemAt(f, r.x, r.y)
    return it && it.unit === unit ? it : undefined
  }

  // What's carried, or the move being adjusted, that no longer exists is let go.
  useEffect(() => {
    if (carry && !itemOf(carry.from, carry.unit)) {
      setCarry(null)
      setHover(null)
    }
    if (adjust && !fleetOf(adjust.to.fleet)) setAdjust(null)
  })

  /** A carried ship turned a quarter: its size swaps, and the cell the pointer holds turns with it. */
  const turn = (c: Carry): Carry => (c.w === c.h ? c : { ...c, w: c.h, h: c.w, dx: c.h - 1 - c.dy, dy: c.dx })
  // Esc puts down what's carried (or closes the count bar) before the map gets the key; R turns it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      if (e.key === 'Escape' && (carry || adjust)) {
        e.stopPropagation()
        setCarry(null)
        setDragging(false)
        setHover(null)
        setAdjust(null)
      } else if ((e.key === 'r' || e.key === 'R') && carry && !e.ctrlKey && !e.metaKey) {
        // Taken here, not as the map's key for the same letter.
        e.stopPropagation()
        e.preventDefault()
        if (carry.w !== carry.h) {
          sound.click()
          setCarry(turn(carry))
        }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  // While something is carried with the mouse: the ghost follows the pointer, the cells it would
  // take light up, and a right-click turns it instead of opening anything.
  useEffect(() => {
    if (!carry || coarse) return
    const move = (m: PointerEvent) => {
      if (m.pointerType === 'touch') return
      setAt({ x: m.clientX, y: m.clientY })
      setHover(hoverAt(carry, hitAt(g, document.elementFromPoint(m.clientX, m.clientY), m.clientX, m.clientY)))
    }
    const menu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (carry.w !== carry.h) {
        sound.click()
        setCarry(turn(carry))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('contextmenu', menu, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('contextmenu', menu, true)
    }
  })
  // A turned ship's highlight follows the turn at once.
  useEffect(() => {
    if (carry && at) setHover(hoverAt(carry, hitAt(g, document.elementFromPoint(at.x, at.y), at.x, at.y)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carry?.w])

  /** Where a carried ship would go for what's under the pointer (null: nowhere particular). */
  const dropFor = (c: Carry, hit: Hit | null): ItemDrop | null => {
    if (!hit) return null
    if (hit.fleet === 'new') return { fleet: 'new', w: c.w, h: c.h }
    if (hit.cell) return { fleet: hit.fleet, x: clampTo(hit.cell.x - c.dx, 0, GRID_W - c.w), y: clampTo(hit.cell.y - c.dy, 0, GRID_H - c.h), w: c.w, h: c.h }
    return { fleet: hit.fleet, w: c.w, h: c.h }
  }
  function hoverAt(c: Carry, hit: Hit | null): Hover | null {
    const to = dropFor(c, hit)
    if (!to || typeof to.fleet !== 'number' || to.x === undefined || to.y === undefined) return null
    // Its own spot, the same way round: putting it back, which is fine.
    const own = to.fleet === c.from.fleet && to.x === c.from.x && to.y === c.from.y && itemOf(c.from, c.unit)?.w === c.w
    return { fleet: to.fleet, x: to.x, y: to.y, w: c.w, h: c.h, ok: own || !dropWhy(g, ME, c.from, to, c.n) }
  }

  /** A move, telling the player why not when it can't go; returns the fleet it went to. */
  const move = (from: ItemRef, to: ItemDrop, n: number): Fleet | null => {
    const r = moveItem(g, ME, from, to, n)
    if (typeof r === 'string') {
      sound.error()
      toast(r, 'bad')
      return null
    }
    sound.click()
    if (r.id !== from.fleet) onMoved(from.fleet, r)
    bump()
    return r
  }
  /** The carried ship put down somewhere: then (for strike craft) the count bar, to make it exact.
   * A failed drop keeps it in hand, to try another spot. */
  const put = (c: Carry, to: ItemDrop | null) => {
    if (!to || (to.fleet === c.from.fleet && to.x === undefined)) {
      setCarry(null)
      setHover(null)
      return
    }
    const own = to.fleet === c.from.fleet && to.x === c.from.x && to.y === c.from.y && itemOf(c.from, c.unit)?.w === c.w
    if (own) {
      setCarry(null)
      setHover(null)
      return
    }
    const r = move(c.from, to, c.n)
    if (!r) return
    setCarry(null)
    setHover(null)
    if (!stacks(c.unit)) return setAdjust(null)
    const it = to.x !== undefined && to.y !== undefined && to.fleet !== 'new' ? itemAt(r, to.x, to.y) : r.items.filter((i) => i.unit === c.unit).at(-1)
    setAdjust(it ? { from: c.from, to: { fleet: r.id, x: it.x, y: it.y }, unit: c.unit, moved: Math.min(c.n, c.of) } : null)
  }
  /** One squadron more (or fewer) of the last move, or all that's left of the stack they came from. */
  const nudge = (by: 1 | -1 | 'all') => {
    if (!adjust) return
    const { from, to, unit } = adjust
    if (by === -1) {
      // The fleet they came from may be gone (it gave all it had): one back makes it anew.
      const back: ItemDrop = fleetOf(from.fleet) ? { fleet: from.fleet, x: from.x, y: from.y } : { fleet: 'new' }
      const r = move(to, back, 1)
      if (!r) return
      const src = fleetOf(from.fleet) ? from : { fleet: r.id, x: 0, y: 0 }
      setAdjust(itemOf(to, unit) ? { from: src, to, unit, moved: adjust.moved - 1 } : null)
      return
    }
    const left = itemOf(from, unit)?.n ?? 0
    if (!left) return sound.error()
    const n = by === 'all' ? left : 1
    if (move(from, { fleet: to.fleet, x: to.x, y: to.y }, n)) setAdjust({ ...adjust, moved: adjust.moved + n })
  }
  const toggle = (f: Fleet, it: Item) => {
    holdItem(g, ME, { fleet: f.id, x: it.x, y: it.y }, !it.held)
    sound.click()
    setAdjust(null)
    bump()
  }
  /** Every ship of a fleet held back, or (when it holds them all back already) none. */
  const holdAll = (f: Fleet) => {
    holdFleet(g, ME, f.id, !f.items.every((i) => i.held))
    sound.click()
    setAdjust(null)
    bump()
  }
  const arrange = (f: Fleet) => {
    const why = arrangeFleet(g, ME, f.id)
    if (why) {
      sound.error()
      return toast(why, 'bad')
    }
    sound.click()
    setAdjust(null)
    bump()
  }
  const merge = (from: number, into: number) => {
    const r = mergeFleets(g, ME, from, into)
    if (typeof r === 'string') {
      sound.error()
      return toast(r, 'bad')
    }
    sound.click()
    const to = fleetOf(into)
    if (to) onMoved(from, to)
    if (r.left) toast(`${shipsN(r.left)} didn't fit: they stay a fleet of their own`, 'info')
    setCarry(null)
    setAdjust(null)
    bump()
  }
  /** A ship turned a quarter where it lies (or at the first spot it fits turned, when it doesn't there). */
  const rotate = (f: Fleet, it: Item) => {
    if (it.w === it.h) return sound.error()
    const from = { fleet: f.id, x: it.x, y: it.y }
    const spots = [{ x: it.x, y: it.y }]
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) spots.push({ x, y })
    const spot = spots.find((s) => !dropWhy(g, ME, from, { fleet: f.id, ...s, w: it.h, h: it.w }))
    if (!spot) {
      sound.error()
      return toast('No room to turn it', 'bad')
    }
    move(from, { fleet: f.id, ...spot, w: it.h, h: it.w }, it.n)
  }
  /** The ship to the next fleet along (the first after the last; a new one when there's only one). */
  const next = (f: Fleet, it: Item) => {
    const i = fleets.indexOf(f)
    const to: ItemDrop = fleets.length > 1 ? { fleet: fleets[(i + 1) % fleets.length].id } : { fleet: 'new' }
    setCarry(null)
    const r = move({ fleet: f.id, x: it.x, y: it.y }, to, it.n)
    if (r) setAdjust(null)
  }
  /** Picks up an item, held at cell `cell` of it (its top left when not given). */
  const pickUp = (f: Fleet, it: Item, n: number, cell?: { x: number; y: number }) => {
    // A cell's size on screen, for the ghost.
    const c = document.querySelector('.ew-inv .ew-inv-cell')?.getBoundingClientRect()
    if (c) slot.current = c.width + 2
    sound.click()
    setAdjust(null)
    setCarry({ from: { fleet: f.id, x: it.x, y: it.y }, unit: it.unit, n, of: it.n, w: it.w, h: it.h, dx: cell ? cell.x - it.x : 0, dy: cell ? cell.y - it.y : 0 })
  }

  /** A click (or a tap) on the panel: pick up, put down, or select. */
  const activate = (hit: Hit, mods: { half: boolean; one: boolean }) => {
    const f = typeof hit.fleet === 'number' ? fleetOf(hit.fleet) : undefined
    if (hit.toggle && f && hit.item) return toggle(f, hit.item)
    if (carry) {
      const to = dropFor(carry, hit)
      // Another ship where it can't go: that one is picked up instead.
      if (f && hit.item && to && dropWhy(g, ME, carry.from, to, carry.n) && !(hit.fleet === carry.from.fleet && hit.item === itemOf(carry.from, carry.unit)))
        return pickUp(f, hit.item, mods.one ? 1 : mods.half ? half(hit.item.n) : hit.item.n, hit.cell ?? undefined)
      return put(carry, to)
    }
    setAdjust(null)
    if (hit.item && f) return pickUp(f, hit.item, mods.one ? 1 : mods.half ? half(hit.item.n) : hit.item.n, hit.cell ?? undefined)
    if (hit.head && f) onSelect(f)
  }

  /** A finger's long press: what can be done with the ship (or fleet) under it. */
  const wheelFor = (hit: Hit, x: number, y: number) => {
    if (typeof hit.fleet !== 'number') return
    const f = fleetOf(hit.fleet)
    if (!f) return
    const ic = (name: IconName) => <Icon name={name} size={18} />
    const full = !moving && fleets.length >= MAX_FLEETS ? `At most ${MAX_FLEETS} fleets at one planet` : false
    const inFlight = moving ? 'In flight: ships move between fleets only in orbit' : false
    let items: WheelItem[]
    let title: string
    if (hit.item) {
      const it = hit.item
      const t = UNIT[it.unit]
      title = `${t.name}${it.n > 1 ? ` ×${it.n}` : ''} · ${label(f)}${it.held ? ' · held back' : ''}`
      items = [
        { id: 'all', label: it.n > 1 ? 'Move all' : 'Move', icon: ic('move'), disabled: inFlight, run: () => pickUp(f, it, it.n) },
        ...(it.n > 1 ? [{ id: 'half', label: 'Move half', icon: <b>½</b>, disabled: inFlight, run: () => pickUp(f, it, half(it.n)) }, { id: 'one', label: 'Move one', icon: <b>1</b>, disabled: inFlight, run: () => pickUp(f, it, 1) }] : []),
        { id: 'new', label: 'New fleet', icon: ic('fleet'), disabled: inFlight || (it.n === f.ships.length ? 'That is the whole fleet' : full), run: () => put({ from: { fleet: f.id, x: it.x, y: it.y }, unit: it.unit, n: it.n, of: it.n, w: it.w, h: it.h, dx: 0, dy: 0 }, { fleet: 'new' }) },
        ...(it.w !== it.h ? [{ id: 'turn', label: 'Turn', icon: ic('restart'), run: () => rotate(f, it) }] : []),
        it.held ? { id: 'deploy', label: 'Deploy', icon: ic('attack'), run: () => toggle(f, it) } : { id: 'hold', label: 'Hold back', icon: ic('hold'), run: () => toggle(f, it) },
        { id: 'select', label: 'Select fleet', icon: ic('target'), run: () => onSelect(f) },
      ]
    } else {
      title = `${label(f)} · ${shipsN(f.ships.length)} · ${cellsUsed(f)}/${CELLS} cells`
      const allHeld = f.items.every((i) => i.held)
      items = [
        { id: 'select', label: 'Select', icon: ic('target'), run: () => onSelect(f) },
        { id: 'hold', label: allHeld ? 'Deploy all' : 'Hold back all', icon: ic(allHeld ? 'attack' : 'hold'), run: () => holdAll(f) },
        { id: 'arrange', label: 'Arrange', icon: ic('grid'), run: () => arrange(f) },
        ...fleets.filter((x) => x !== f).map((x): WheelItem => ({ id: `join${x.id}`, label: `Join ${label(x)}`, icon: ic('rally'), disabled: inFlight, run: () => merge(f.id, x.id) })),
      ]
    }
    wheel({ x, y, title, items })
  }

  /** Every press in the panel comes here: drags and clicks with a mouse, taps and long presses with a finger. */
  const down = (e: React.PointerEvent) => {
    const target = e.target as Element
    if (target.closest('button')) return
    const hit = hitAt(g, target, e.clientX, e.clientY)
    if (!hit) return
    if (isTouch(e)) {
      const x0 = e.clientX
      const y0 = e.clientY
      if (hit.item || hit.head) press.current.start(e, () => wheelFor(hit, x0, y0))
      const pm = (m: PointerEvent) => void (m.pointerId === e.pointerId && press.current.move(m))
      const up = (u: PointerEvent) => {
        if (u.pointerId !== e.pointerId) return
        window.removeEventListener('pointermove', pm)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        press.current.cancel()
        if (press.current.fired || u.type !== 'pointerup' || Math.hypot(u.clientX - x0, u.clientY - y0) > TAP_SLOP) return
        activate(hit, { half: getTouchMods().shift, one: false })
      }
      window.addEventListener('pointermove', pm)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      return
    }
    // The right button turns a ship where it lies (while one is carried, the carried one: see above).
    if (e.button === 2) {
      e.preventDefault()
      const f = typeof hit.fleet === 'number' ? fleetOf(hit.fleet) : undefined
      if (!carry && f && hit.item && !hit.toggle) rotate(f, hit.item)
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    const f = typeof hit.fleet === 'number' ? fleetOf(hit.fleet) : undefined
    const it = hit.item
    // What a drag carries: the ship (all, half or one squadron of a stack), or with the header the whole fleet.
    const n = it ? (e.ctrlKey || e.metaKey ? 1 : e.shiftKey ? half(it.n) : it.n) : 0
    const draggable = !carry && !hit.toggle && f && (it || (hit.head && !moving))
    let went = false
    const pm = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId || !draggable) return
      if (!went && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return
      if (!went && it) {
        pickUp(f, it, n, hit.cell ?? undefined)
        setDragging(true)
      }
      went = true
      if (!it) setFleetGhost({ fleet: f.id, n: f.ships.length, x: m.clientX, y: m.clientY })
    }
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      window.removeEventListener('pointermove', pm)
      window.removeEventListener('pointerup', up)
      setFleetGhost(null)
      if (!went) return activate(hit, { half: e.shiftKey, one: e.ctrlKey || e.metaKey })
      const to = hitAt(g, document.elementFromPoint(u.clientX, u.clientY), u.clientX, u.clientY)
      if (it) {
        setDragging(false)
        // The drop goes by the carry as it is now (it may have been turned on the way); let go
        // outside the fleets, it goes back.
        const c = carryRef.current
        if (c && to) put(c, dropFor(c, to))
        else {
          setCarry(null)
          setHover(null)
        }
      } else if (f && to && typeof to.fleet === 'number' && to.fleet !== f.id) merge(f.id, to.fleet)
    }
    window.addEventListener('pointermove', pm)
    window.addEventListener('pointerup', up)
  }
  const dbl = (e: React.MouseEvent) => {
    const hit = hitAt(g, e.target as Element, e.clientX, e.clientY)
    const f = hit && typeof hit.fleet === 'number' ? fleetOf(hit.fleet) : undefined
    if (!hit?.item || hit.toggle || !f || moving) return
    next(f, hit.item)
  }
  /** Enter or Space on a focused ship: as a click on it. */
  const keyed = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const el = e.target as HTMLElement
    const r = el.getBoundingClientRect()
    const hit = hitAt(g, el, r.left + 2, r.top + 2)
    if (!hit) return
    e.preventDefault()
    activate(hit, { half: e.shiftKey, one: e.ctrlKey })
  }

  const enemy = p ? fleetsAt(g, p.id).filter((f) => f.owner !== ME && canSee(g, ME, f)) : []
  const status = (f: Fleet) => {
    if (f.leg) return `→ ${g.planets[(f.route.length ? f.route[f.route.length - 1] : f.leg).planet]?.name ?? g.systems[f.leg.system].name} · ${Math.ceil(eta(f))} s`
    const cap = g.planets[f.planet]?.capture
    if (cap) return `${cap.owner === ME ? 'Taking' : 'Losing'} · ${Math.ceil(CAPTURE_TIME - cap.t)} s`
    if (f.join !== undefined) return 'Joining up'
    if (f.waypoints?.length) return `${f.waypoints.length} stop${f.waypoints.length > 1 ? 's' : ''} queued`
    return 'In orbit'
  }
  const isCarried = (f: Fleet, it: Item) => !!carry && carry.from.fleet === f.id && carry.from.x === it.x && carry.from.y === it.y
  const span = (x: number, y: number, w: number, h: number): CSSProperties => ({ gridColumn: `${x + 1} / span ${w}`, gridRow: `${y + 1} / span ${h}` })
  const grid = (f: Fleet) => (
    <div className="ew-inv-grid" data-inv-grid="" style={{ gridTemplateColumns: `repeat(${GRID_W}, var(--slot))`, gridTemplateRows: `repeat(${GRID_H}, var(--slot))` }}>
      {Array.from({ length: CELLS }, (_, i) => <div key={`c${i}`} className="ew-inv-cell" style={span(i % GRID_W, Math.floor(i / GRID_W), 1, 1)} />)}
      {f.items.map((it) => {
        const t = UNIT[it.unit]
        const c = isCarried(f, it)
        const stack = stacks(it.unit)
        return (
          <div key={`${it.x},${it.y}`} role="button" tabIndex={0} data-inv-item="" data-longpress=""
            className={`ew-inv-item ${it.held ? 'is-held' : ''} ${c ? 'is-carried' : ''} ${it.w > it.h ? 'is-side' : ''} ${it.w * it.h > 1 ? 'is-big' : ''}`}
            style={{ ...span(it.x, it.y, it.w, it.h), ['--w' as string]: it.w, ['--h' as string]: it.h }}
            {...unitTip(t, { who: 'Ours', rel: 'own' }, `${stack ? `${it.n} squadron${it.n > 1 ? 's' : ''} (up to 3 share a cell)` : `${it.w}×${it.h} cells`}, ${it.held ? 'held back: they wait in the reserve when a battle starts, to be called in' : 'jump in when a battle starts'}. ${coarse ? 'Tap to pick up, long-press for more.' : `Drag to a spot (R or right-click turns it)${stack ? '; Shift: half, Ctrl: one' : ''}. Double-click: to the next fleet.`}`)}>
            <span className="ew-inv-art"><ShipArt t={t} /></span>
            {stack && <em>{c && carry!.n < it.n ? `${it.n - carry!.n}` : it.n}</em>}
            <i className={`ew-inv-hold ${it.held ? 'is-held' : ''}`} data-inv-toggle="" data-longpress="" data-tip={it.held ? 'Held back. Click to deploy' : 'Click to hold back'}>
              <Icon name={it.held ? 'hold' : 'attack'} size={11} />
            </i>
          </div>
        )
      })}
      {hover && hover.fleet === f.id && <div className={`ew-inv-fit ${hover.ok ? 'is-ok' : 'is-bad'}`} style={span(hover.x, hover.y, hover.w, hover.h)} />}
    </div>
  )

  const where = (r: ItemRef) => {
    const f = fleetOf(r.fleet)
    return f ? label(f) : 'a new fleet'
  }
  const strip = carry && !dragging ? (
    <div className="ew-inv-strip is-carry" onWheel={(e) => setCarry({ ...carry, n: clampTo(carry.n + (e.deltaY < 0 ? 1 : -1), 1, carry.of) })}>
      <ShipArt t={UNIT[carry.unit]} />
      <span>{UNIT[carry.unit].name}</span>
      {carry.of > 1 && (
        <>
          <button onClick={() => setCarry({ ...carry, n: Math.max(1, carry.n - 1) })} aria-label="One fewer">−</button>
          <b>{carry.n}</b>
          <button onClick={() => setCarry({ ...carry, n: Math.min(carry.of, carry.n + 1) })} aria-label="One more">+</button>
          <small className="ew-muted">of {carry.of}</small>
        </>
      )}
      {carry.w !== carry.h && (
        <button onClick={() => (sound.click(), setCarry(turn(carry)))} data-tip="Turn it (R)" aria-label="Turn it">
          <Icon name="restart" size={13} />
        </button>
      )}
      <small className="ew-muted">{coarse ? 'tap a spot' : 'click a spot'} to put {carry.n > 1 ? 'them' : 'it'} there</small>
      <button className="ew-inv-x" onClick={() => (setCarry(null), setHover(null))} aria-label="Put it back">✕</button>
    </div>
  ) : adjust ? (
    <div className="ew-inv-strip is-adjust">
      <ShipArt t={UNIT[adjust.unit]} />
      <span>
        <b>{adjust.moved}</b> {UNIT[adjust.unit].name} {adjust.from.fleet === adjust.to.fleet ? 'moved' : `to ${where(adjust.to)}`}
      </span>
      <button onClick={() => nudge(-1)} disabled={adjust.moved <= 0} aria-label="One fewer">−</button>
      <button onClick={() => nudge(1)} disabled={!itemOf(adjust.from, adjust.unit)} aria-label="One more">+</button>
      <button onClick={() => nudge('all')} disabled={!itemOf(adjust.from, adjust.unit)}>All</button>
      <button className="ew-inv-x" onClick={() => setAdjust(null)} aria-label="Done">✓</button>
    </div>
  ) : (
    <p className="ew-inv-strip ew-muted ew-small">
      {moving
        ? 'In flight: ships move between fleets only in orbit. Held back ships wait in the reserve when a battle starts.'
        : coarse
          ? 'Tap a ship, then a spot, to move it (Shift: half a stack). Long-press for more. Bigger ships take more room; gold ones are held back in the reserve.'
          : 'Drag ships to a spot where they fit (R turns them), onto another fleet, or into a new one. Bigger ships take more room; gold ones are held back in the reserve.'}
    </p>
  )

  return (
    <Floating id="gInv" title={p ? `Fleets at ${p.name}` : 'Fleet in flight'} at={{ right: 6, top: 56 }} className={`ew-inv ${carry ? 'is-carrying' : ''}`} layout={galaxyLayout} onClose={onClose}
      aside={!moving && <b className="ew-selcount" data-tip={`Fleets of ours here, of at most ${MAX_FLEETS}`}>{fleets.length}/{MAX_FLEETS}</b>}>
      {strip}
      <div className="ew-inv-body" data-nodrag onPointerDown={down} onDoubleClick={dbl} onKeyDown={keyed} onContextMenu={(e) => e.preventDefault()}>
        {fleets.map((f) => {
          const sel = selected.has(f.id)
          const allHeld = f.items.every((i) => i.held)
          const used = cellsUsed(f)
          return (
            <div key={f.id} className={`ew-inv-fleet ${sel ? 'is-sel' : ''} ${used >= CELLS ? 'is-full' : ''}`} data-inv-fleet={f.id}>
              <div className="ew-inv-head" data-inv-head="" data-longpress="" role="button" tabIndex={0}
                data-tip={coarse ? 'Tap to select this fleet for orders; long-press to join it to another, arrange it or hold it all back.' : 'Click to select this fleet for orders. Drag it onto another fleet to join them; drop a ship here to put it wherever it fits.'}>
                <b>{label(f)}</b>
                <small>{shipsN(f.ships.length)} · {status(f)}</small>
                <i className="ew-inv-room" data-tip={`${used} of ${CELLS} cells taken${used >= CELLS ? ': full' : ''}`}><b style={{ width: `${(used / CELLS) * 100}%` }} /></i>
                <span className="ew-inv-tools">
                  <button className="ew-inv-tool" onClick={() => arrange(f)} data-tip="Arrange: pack it again, biggest ships first" aria-label="Arrange">
                    <Icon name="grid" size={12} />
                  </button>
                  <button className={`ew-inv-tool ${allHeld ? 'is-on' : ''}`} onClick={() => holdAll(f)} data-tip={allHeld ? 'All held back. Click to deploy them all' : 'Hold the whole fleet back'} aria-label={allHeld ? 'Deploy all' : 'Hold back all'}>
                    <Icon name="hold" size={12} />
                  </button>
                </span>
              </div>
              {grid(f)}
            </div>
          )
        })}
        {!moving && fleets.length < MAX_FLEETS && (
          <div className="ew-inv-fleet is-new" data-inv-fleet="new" data-tip={`Drop ships here to make a new fleet (at most ${MAX_FLEETS} at a planet)`}>
            <div className="ew-inv-head"><b>New fleet</b><small>{MAX_FLEETS - fleets.length} free</small></div>
            <div className="ew-inv-newdrop">
              <Icon name="fleet" size={22} />
              <span>{coarse ? 'Pick up a ship, then tap here' : 'Drop ships here'}</span>
            </div>
          </div>
        )}
      </div>
      {enemy.length > 0 && <p className="ew-inv-enemy ew-small">{factionName(g, enemy[0].owner)} here: {enemy.reduce((n, f) => n + f.ships.length, 0)} ships in {enemy.length} fleet{enemy.length > 1 ? 's' : ''}</p>}
      {carry && at && !coarse && createPortal(
        <div className={`ew-inv-ghost ${carry.w > carry.h ? 'is-side' : ''} ${hover ? 'is-over' : ''}`}
          style={{ left: at.x - (carry.dx + 0.5) * slot.current, top: at.y - (carry.dy + 0.5) * slot.current, width: carry.w * slot.current, height: carry.h * slot.current, ['--gw' as string]: `${carry.w * slot.current}px`, ['--gh' as string]: `${carry.h * slot.current}px` }}>
          <span className="ew-inv-art"><ShipArt t={UNIT[carry.unit]} /></span>
          {carry.of > 1 && <em>{carry.n}</em>}
        </div>,
        document.body,
      )}
      {fleetGhost && createPortal(
        <div className="ew-inv-ghost is-fleet" style={{ left: fleetGhost.x - 22, top: fleetGhost.y - 22 }}>
          <Icon name="fleet" size={26} />
          <em>{fleetGhost.n}</em>
        </div>,
        document.body,
      )}
    </Floating>
  )
}
