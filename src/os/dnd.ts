import { useEffect, useRef, type RefObject } from 'react'
import { DRAG_FILES, getDragged, setDragged } from '../data/seafile'
import { droppedFiles, type Picked } from '../data/uploads'
import { kindOfName, type FileKind } from '../terminal/vfs'
import { closeContextMenu, releaseTouchPress } from './ContextMenu'
import type { AppId } from './wm'

// Drag and drop across MvL OS: one kind of payload for everything that can be dragged (files and
// folders wherever they are, launchers, apps, rows out of an archive, the desktop's own icons),
// and drop targets that each say whether they take it and what they would do with it.
//
// Two kinds of drag carry it. The browser's own (draggable rows in Files and Archive, and files
// from the computer), which can leave the page and come in from outside; and pointer drags that
// MvL OS draws itself (desktop icons, and anything held with a finger, which browsers do not
// drag), for which this module draws the ghost and finds the target under the pointer. A target
// sees no difference:
//
//   const ref = useRef<HTMLDivElement>(null)
//   useDropTarget(ref, {
//     accept: (drag) => (drag.os || drag.items.some((i) => i.kind === 'file') ? 'copy' : null),
//     drop: (drag) => void attach(drag),
//   })
//
// Elements inside a target can carry data-drop="<anything>": the target is then asked about
// that spot (a folder in a list, an app in the dock), and if it says no, about itself. The
// innermost target that takes a drag gets it, and what it would do shows on the cursor and as a
// highlight (data-drop-over on the spot or the target; style it with [data-drop-over]).

/** Something dragged. Paths are as Files has them: seafile://… or a filesystem path. */
export type DragItem =
  | {
      kind: 'file'
      path: string
      name: string
      dir: boolean
      /** A .desktop file that is a launcher: what it opens (the dock pins it by this id). */
      launcher?: { id: string; label: string; url: string; glyph?: string; image?: string; app?: string }
    }
  /** A launcher without a file (a visitor's, kept in this browser). */
  | { kind: 'launcher'; id: string; label: string; url: string; glyph?: string; image?: string; app?: string; props?: Record<string, string> }
  | { kind: 'app'; app: AppId; label: string }
  /** Rows dragged out of Archive: unpacked where they land. */
  | { kind: 'entries'; zip: string; entries: string[]; base: string; label: string }
  /** One of the site's own desktop icons (only the trash takes these). */
  | { kind: 'icon'; id: string; label: string; glyph?: string }

export type Keys = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

export type Drag = {
  items: DragItem[]
  /** Files from the computer; what they are is only known at the drop (files()). */
  os: boolean
  /** Where it started: 'desktop', 'files', 'archive', 'dock', 'launchpad'… */
  source: string
  keys: Keys
  /** At the drop of files from the computer: the files, folders walked (see data/uploads.ts). */
  files: () => Promise<Picked[]>
}

/** What a drop does, for the cursor: move, copy, make a link (a launcher, a pin), open, or delete. */
export type DropOp = 'move' | 'copy' | 'link' | 'open' | 'trash'

export type DropTarget = {
  /** What a drop here would do (null: not taken). `spot` is the data-drop of the element under the pointer, or null. */
  accept: (drag: Drag, spot: string | null) => DropOp | null
  drop: (drag: Drag, spot: string | null, op: DropOp, at: { x: number; y: number }) => void
  /** Held over a spot for a moment (a folder): open it, so the drag can go on inside. */
  spring?: (spot: string) => void
  /** The pointer came over this target (with the spot), or left it (undefined). */
  onOver?: (spot: string | null | undefined) => void
}

export const DRAG_ITEMS = 'application/x-mvlos-items'
const SPRING_MS = 800

const targets = new Map<Element, { current: DropTarget }>()
let payload: { items: DragItem[]; source: string } | null = null
const noKeys: Keys = { ctrl: false, alt: false, shift: false, meta: false }
export const keysOf = (e: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): Keys => ({ ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey })

/** What is being dragged inside MvL OS right now (not files from the computer), or null. */
export const currentDrag = () => payload

/** Paths of the files and folders in a drag (launcher files included). */
export const filePaths = (items: DragItem[]) => items.flatMap((i) => (i.kind === 'file' ? [i.path] : []))

/** Ctrl (or Alt) copies, Shift moves; otherwise `fallback`. */
export const keyOp = (keys: Keys, fallback: 'move' | 'copy'): 'move' | 'copy' => (keys.ctrl || keys.meta || keys.alt ? 'copy' : keys.shift ? 'move' : fallback)

// --- finding the target -------------------------------------------------------------------------

type Hit = { target: { current: DropTarget }; el: Element; root: Element; spot: string | null; op: DropOp }

const spotOf = (el: Element) => (el instanceof HTMLElement ? (el.dataset.drop ?? null) : null)

/** The innermost target, from `start` up, that takes the drag. */
function resolve(start: Element | null, drag: Drag): Hit | null {
  let spotEl: Element | null = null
  for (let n = start; n; n = n.parentElement) {
    const t = targets.get(n)
    if (t) {
      const own = spotOf(n)
      if (spotEl && spotEl !== n) {
        const spot = spotOf(spotEl)
        const op = t.current.accept(drag, spot)
        if (op) return { target: t, el: spotEl, root: n, spot, op }
      }
      // Not that spot (or none): the target itself.
      const op = t.current.accept(drag, own)
      if (op) return { target: t, el: n, root: n, spot: own, op }
      spotEl = null
      continue
    }
    if (!spotEl && spotOf(n) !== null) spotEl = n
  }
  return null
}

let highlighted: Element | null = null
let overTarget: { current: DropTarget } | null = null
let spring: { el: Element; timer: ReturnType<typeof setTimeout> } | null = null

function show(hit: Hit | null) {
  const el = hit?.el ?? null
  if (el !== highlighted) {
    highlighted?.removeAttribute('data-drop-over')
    el?.setAttribute('data-drop-over', hit!.op)
    highlighted = el
  } else if (el && el.getAttribute('data-drop-over') !== hit!.op) el.setAttribute('data-drop-over', hit!.op)
  if (overTarget !== (hit?.target ?? null)) {
    overTarget?.current.onOver?.(undefined)
    overTarget = hit?.target ?? null
  }
  hit?.target.current.onOver?.(hit.spot)
  // A spot held for a moment springs open.
  if (spring && spring.el !== el) {
    clearTimeout(spring.timer)
    spring = null
  }
  if (hit && hit.spot !== null && hit.el !== hit.root && hit.target.current.spring && !spring) {
    const { target, spot } = hit
    spring = { el: hit.el, timer: setTimeout(() => target.current.spring?.(spot!), SPRING_MS) }
  }
}

function clear() {
  show(null)
  if (spring) clearTimeout(spring.timer)
  spring = null
}

// --- the browser's own drags ---------------------------------------------------------------------

/** The drag a browser drag event carries, if MvL OS knows it. */
function dragOf(e: DragEvent): Drag | null {
  const dt = e.dataTransfer
  if (!dt) return null
  const keys = keysOf(e)
  if (payload && dt.types.includes(DRAG_ITEMS)) return { ...payload, os: false, keys, files: async () => [] }
  // Older drags that only set the dragged paths (Zed's tree).
  const legacy = getDragged()
  if (legacy && dt.types.includes(DRAG_FILES)) return { items: legacy.map((p) => ({ kind: 'file', path: p, name: p.split('/').pop() ?? p, dir: false })), source: 'legacy', os: false, keys, files: async () => [] }
  if (dt.types.includes('Files')) return { items: [], source: 'computer', os: true, keys, files: async () => [] }
  return null
}

const effectOf = (op: DropOp, dt: DataTransfer): DataTransfer['dropEffect'] => {
  if (op === 'move') return 'move'
  if (op === 'copy' || !/all|link/i.test(dt.effectAllowed)) return dt.effectAllowed === 'move' ? 'move' : 'copy'
  return 'link'
}

let installed = false
function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const over = (e: DragEvent) => {
    // Taken already by a handler of its own inside (React's, which runs first).
    if (e.defaultPrevented) return clear()
    const drag = dragOf(e)
    const hit = drag ? resolve(e.target as Element, drag) : null
    show(hit)
    if (!hit) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = effectOf(hit.op, e.dataTransfer!)
  }
  window.addEventListener('dragenter', over)
  window.addEventListener('dragover', over)
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) clear()
  })
  window.addEventListener('drop', (e) => {
    const drag = e.defaultPrevented ? null : dragOf(e)
    const hit = drag ? resolve(e.target as Element, drag) : null
    clear()
    if (!drag || !hit) return
    e.preventDefault()
    // The computer's files must be read now: the browser forgets them after the drop.
    if (drag.os) {
      const files = droppedFiles(e.dataTransfer!)
      drag.files = () => files
    }
    endDrag()
    hit.target.current.drop(drag, hit.spot, hit.op, { x: e.clientX, y: e.clientY })
  })
  window.addEventListener('dragend', () => {
    clear()
    endDrag()
  })
}

function endDrag() {
  payload = null
  setDragged(null)
}

/**
 * Starts a browser drag of MvL OS items (call it from onDragStart). `ghost` draws the drag image:
 * the first icons in a stack, with how many there are. `download` lets Chrome save a file where
 * it is let go outside the browser ("type:name:url").
 */
export function startNativeDrag(e: DragEvent | React.DragEvent, items: DragItem[], source: string, opts: { text?: string; download?: string | null; ghost?: boolean } = {}) {
  install()
  const dt = e.dataTransfer!
  payload = { items, source }
  dt.effectAllowed = 'all'
  dt.setData(DRAG_ITEMS, JSON.stringify(items))
  const paths = filePaths(items)
  // Zed's tree and other older drop targets read the paths from here.
  if (paths.length) {
    dt.setData(DRAG_FILES, JSON.stringify(paths))
    setDragged(paths)
  }
  dt.setData('text/plain', opts.text ?? items.map((i) => ('path' in i ? i.path : i.kind === 'launcher' ? i.url : i.label)).join('\n'))
  if (opts.download) dt.setData('DownloadURL', opts.download)
  if (opts.ghost !== false && items.length) {
    const g = ghostElement(items)
    g.classList.add('is-image')
    document.body.append(g)
    dt.setDragImage(g, 18, 18)
    setTimeout(() => g.remove(), 0)
  }
}

// --- drags MvL OS draws itself ------------------------------------------------------------------

const KIND_GLYPH: Partial<Record<FileKind, string>> = { folder: '📁', image: '🖼️', markdown: '📝', text: '📄', pdf: '📕', document: '📃', audio: '🎵', video: '🎬', archive: '🗜️', disc: '💿', link: '🔗' }

/** An item's picture for the ghost: an emoji, or an image's address. */
function pictureOf(i: DragItem): { glyph?: string; image?: string } {
  if (i.kind === 'file') {
    if (i.launcher) return i.launcher.glyph ? { glyph: i.launcher.glyph } : i.launcher.image ? { image: i.launcher.image } : { glyph: '🔗' }
    return { glyph: KIND_GLYPH[kindOfName(i.name, i.dir)] ?? '📄' }
  }
  if (i.kind === 'launcher') return i.glyph ? { glyph: i.glyph } : i.image ? { image: i.image } : { glyph: '🔗' }
  if (i.kind === 'entries') return { glyph: '🗜️' }
  if (i.kind === 'icon') return { glyph: i.glyph ?? '📄' }
  return { glyph: '▦' }
}

const OP_MARK: Record<DropOp, string> = { move: '→', copy: '+', link: '↗', open: '⏎', trash: '🗑' }

function ghostElement(items: DragItem[]): HTMLElement {
  const g = document.createElement('div')
  g.className = 'dnd-ghost'
  g.setAttribute('aria-hidden', 'true')
  const stack = document.createElement('div')
  stack.className = 'dnd-ghost-stack'
  items.slice(0, 3).forEach((item, k) => {
    const pic = pictureOf(item)
    const tile = document.createElement('span')
    tile.className = 'dnd-ghost-tile'
    tile.style.setProperty('--k', String(k))
    if (pic.image) {
      const img = document.createElement('img')
      img.src = pic.image
      img.alt = ''
      tile.append(img)
    } else tile.textContent = pic.glyph ?? '📄'
    stack.prepend(tile)
  })
  g.append(stack)
  const label = document.createElement('span')
  label.className = 'dnd-ghost-label'
  const one = items[0]
  label.textContent = items.length > 1 ? `${items.length} items` : one.kind === 'file' ? (one.launcher?.label ?? one.name) : one.label
  g.append(label)
  if (items.length > 1) {
    const count = document.createElement('span')
    count.className = 'dnd-ghost-count'
    count.textContent = String(items.length)
    g.append(count)
  }
  const op = document.createElement('span')
  op.className = 'dnd-ghost-op'
  g.append(op)
  return g
}

export type PointerDrag = {
  /** The pointer moved (or a key changed): answers what a drop here would do. */
  move: (x: number, y: number, keys?: Keys) => DropOp | null
  /** Let go: answers whether a target took it. */
  end: (x: number, y: number, keys?: Keys) => boolean
  cancel: () => void
}

/** Elements the pointer looks through: the ghost, and what is being dragged. */
const SEE_THROUGH = '.dnd-ghost, .is-moving, [data-dragging]'

function elementAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) if (!el.closest(SEE_THROUGH)) return el
  return null
}

/**
 * A drag MvL OS draws itself (desktop icons; anything held with a finger). Call move() as the
 * pointer moves and end() when it is let go. `ghost`: 'always' draws the items under the pointer,
 * 'away' only once they are off `home` (the desktop draws its own icons on the move), with what a
 * drop would do on the cursor either way.
 */
export function beginPointerDrag(items: DragItem[], source: string, opts: { ghost?: 'always' | 'away'; home?: Element | null } = {}): PointerDrag {
  install()
  payload = { items, source }
  const paths = filePaths(items)
  if (paths.length) setDragged(paths)
  const ghost = ghostElement(items)
  ghost.classList.add('is-pointer')
  document.body.append(ghost)
  let last = { x: 0, y: 0, keys: noKeys }
  let done = false
  const drag = (): Drag => ({ items, source, os: false, keys: last.keys, files: async () => [] })
  const place = (x: number, y: number, op: DropOp | null, el: Element | null) => {
    ghost.style.transform = `translate(${x}px, ${y}px)`
    ghost.dataset.op = op ?? ''
    ;(ghost.querySelector('.dnd-ghost-op') as HTMLElement).textContent = op ? OP_MARK[op] : ''
    const away = opts.ghost === 'away' && !!opts.home && !!el && opts.home.contains(el)
    ghost.classList.toggle('is-home', away)
  }
  const onKey = (e: KeyboardEvent) => {
    if (done || !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
    last = { ...last, keys: keysOf(e) }
    api.move(last.x, last.y, last.keys)
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  const finish = () => {
    done = true
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('keyup', onKey)
    ghost.remove()
    clear()
    endDrag()
  }
  const api: PointerDrag = {
    move(x, y, keys) {
      if (done) return null
      last = { x, y, keys: keys ?? last.keys }
      const el = elementAt(x, y)
      const hit = resolve(el, drag())
      show(hit)
      place(x, y, hit?.op ?? null, el)
      return hit?.op ?? null
    },
    end(x, y, keys) {
      if (done) return false
      last = { x, y, keys: keys ?? last.keys }
      const hit = resolve(elementAt(x, y), drag())
      finish()
      if (!hit) return false
      hit.target.current.drop(drag(), hit.spot, hit.op, { x, y })
      return true
    },
    cancel: finish,
  }
  return api
}

// --- holding with a finger ------------------------------------------------------------------------

const LIFT_MS = 350
const SLOP = 10

/**
 * Touch screens: hold an item still for a moment and it lifts (with a buzz); move the finger then
 * and it drags, to every target a mouse drag reaches. Holding on without moving still opens the
 * item's menu (the long press of ContextMenu.tsx); moving after that closes the menu and drags.
 * Call it from onPointerDown; `items` is asked at the moment the drag starts.
 */
export function holdToDrag(e: React.PointerEvent | PointerEvent, items: () => DragItem[] | null, source: string) {
  if (e.pointerType !== 'touch' || !e.isPrimary) return
  const el = e.currentTarget as HTMLElement | null
  const id = e.pointerId
  const start = { x: e.clientX, y: e.clientY }
  let lifted = false
  let drag: PointerDrag | null = null
  const timer = setTimeout(() => {
    lifted = true
    el?.setAttribute('data-lifted', '')
    try {
      navigator.vibrate?.(8)
    } catch {
      /* no vibration */
    }
  }, LIFT_MS)
  // Once lifted, the finger drags instead of scrolling.
  const noScroll = (ev: TouchEvent) => {
    if (lifted && ev.cancelable) ev.preventDefault()
  }
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    const far = Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > SLOP
    if (!lifted) {
      if (far) stop()
      return
    }
    if (!drag && far) {
      const list = items()
      if (!list?.length) return stop()
      releaseTouchPress()
      closeContextMenu()
      drag = beginPointerDrag(list, source, { ghost: 'always' })
    }
    drag?.move(ev.clientX, ev.clientY, keysOf(ev))
  }
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    if (drag) {
      drag.end(ev.clientX, ev.clientY)
      // The tap the browser sends after the lift is the drop's, not a click on what is underneath.
      const swallow = (c: Event) => {
        c.preventDefault()
        c.stopImmediatePropagation()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 600)
    }
    stop()
  }
  const cancel = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    drag?.cancel()
    stop()
  }
  function stop() {
    clearTimeout(timer)
    el?.removeAttribute('data-lifted')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('touchmove', noScroll)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('touchmove', noScroll, { passive: false })
}

// --- targets --------------------------------------------------------------------------------------

/**
 * Makes an element a drop target, for the browser's drags and MvL OS's own alike. The spec can
 * change every render; the newest one is used. `enabled: false` takes it out for now.
 */
export function useDropTarget(ref: RefObject<HTMLElement | null>, spec: DropTarget, enabled = true) {
  const box = useRef(spec)
  box.current = spec
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    install()
    targets.set(el, box)
    return () => {
      if (targets.get(el) === box) targets.delete(el)
      if (highlighted && el.contains(highlighted)) clear()
    }
  })
}
