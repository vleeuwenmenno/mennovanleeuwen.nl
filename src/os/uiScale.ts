import { localPref } from './localPref'

// Settings → Appearance → UI scale: the whole OS bigger or smaller, like the browser's own zoom
// but kept per device in MvL OS (a phone and a 4K desktop want different sizes). It is CSS `zoom`
// on the page's root element, so every part of the shell, the apps and whatever they put in
// portals scale together.
//
// With `zoom` on the root, the browser keeps two kinds of numbers apart:
//   - screen pixels: pointer events (clientX/Y), getBoundingClientRect, window.innerWidth/Height,
//     the visual viewport, elementFromPoint. These do not change with the scale.
//   - page pixels: style lengths (left, width, transforms), offsetWidth/Height, clientWidth,
//     scrollTop and the like. One page pixel is `uiScale()` screen pixels.
// Code that puts something where the pointer or another element is (dragging, menus, popovers)
// converts screen pixels to page pixels with toUi(), uiPoint() or uiRect(); the size of the page
// in page pixels is viewW() × viewH(). Ratios of two screen-pixel numbers (where on a canvas the
// pointer is, as a share of its rect) need no change.
//
// Games keep their own size: their window content and anything they float over the page carry
// the class `ui-native`, which undoes the scale (see styles.css), because games size themselves
// to the screen and map the pointer straight onto their canvas.
//
// The phone layout (below 720 screen pixels wide) follows the real screen, in CSS media queries
// and in JS (useIsMobile), so it doesn't change with the scale.

/** The steps, like a browser's zoom levels. */
export const UI_SCALES = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

const nearest = (v: number) => UI_SCALES.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), 1 as number)

/** The chosen scale on this device (1 when nothing is stored, or storage is blocked). */
export const uiScalePref = localPref<number>(
  'mvlos.ui.scale',
  (raw) => {
    const v = raw === null || raw === '' ? NaN : Number(raw)
    return Number.isFinite(v) && v > 0 ? nearest(v) : 1
  },
  String,
)

// Standardized `zoom` (Chrome and Edge 128+, Firefox 126+, Safari with it): pointer events and
// getBoundingClientRect then both report screen pixels, which the conversions here rely on. An
// older engine with the legacy zoom model gets no scaling at all rather than a half-broken one.
let supported: boolean | null = null
export function uiScaleSupported(): boolean {
  if (supported !== null) return supported
  if (typeof document === 'undefined' || !document.body) return false
  try {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;width:10px;height:10px;zoom:2;left:0;top:0'
    document.body.appendChild(probe)
    const w = probe.getBoundingClientRect().width
    probe.remove()
    supported = Math.abs(w - 20) < 0.5 && 'currentCSSZoom' in probe
  } catch {
    supported = false
  }
  return supported
}

let applied = 1
let enabled = false

/** The scale the page is drawn at right now (1 when it isn't scaled). */
export const uiScale = () => applied

/** Screen pixels to page pixels. */
export const toUi = (v: number) => v / applied

/** A pointer position in page pixels. */
export const uiPoint = (e: { clientX: number; clientY: number }) => ({ x: e.clientX / applied, y: e.clientY / applied })

export type UiRect = { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number }

/** An element's box in page pixels (getBoundingClientRect, scaled), for placing something next to it. */
export function uiRect(el: Element): UiRect
export function uiRect(el: Element | null | undefined): UiRect | undefined
export function uiRect(el: Element | null | undefined): UiRect | undefined {
  if (!el) return undefined
  const r = el.getBoundingClientRect()
  const s = applied
  return { left: r.left / s, top: r.top / s, right: r.right / s, bottom: r.bottom / s, width: r.width / s, height: r.height / s, x: r.x / s, y: r.y / s }
}

/** The page's width and height in page pixels: what windows maximize and snap to. */
export const viewW = () => window.innerWidth / applied
export const viewH = () => window.innerHeight / applied

function apply() {
  const want = enabled && uiScaleSupported() ? uiScalePref.get() : 1
  if (want === applied && document.documentElement.style.getPropertyValue('--ui-scale')) return
  applied = want
  const root = document.documentElement
  root.style.setProperty('--ui-scale', String(want))
  root.style.setProperty('--ui-unscale', String(1 / want))
  if (want === 1) root.style.removeProperty('zoom')
  else root.style.setProperty('zoom', String(want))
  // Everything that sizes itself to the page (windows, the dock, widgets) listens for resize.
  window.dispatchEvent(new Event('resize'))
}

/** Scales the page and keeps it in step with the setting (and with other tabs). */
export function initUiScale() {
  enabled = true
  document.documentElement.style.setProperty('--ui-scale', '1')
  document.documentElement.style.setProperty('--ui-unscale', '1')
  apply()
  uiScalePref.subscribe(apply)
}

/** One step up or down (`dir` 1 or -1), or back to 100% (0). */
export function stepUiScale(dir: -1 | 0 | 1) {
  if (dir === 0) return uiScalePref.set(1)
  const i = UI_SCALES.indexOf(uiScalePref.get() as (typeof UI_SCALES)[number])
  const next = UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, (i < 0 ? UI_SCALES.indexOf(1) : i) + dir))]
  uiScalePref.set(next)
}

/**
 * Ctrl (Cmd on a Mac) with + / = , − and 0, like the browser's zoom keys, but for MvL OS (the
 * browser doesn't zoom as well). An app that zooms its own content with these keys while it has
 * the focus (the terminal, PDFs, Files) handles them first and marks them handled, and keeps them.
 */
export function installUiScaleKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return
    const dir = e.key === '=' || e.key === '+' ? 1 : e.key === '-' || e.key === '_' ? -1 : e.key === '0' ? 0 : null
    if (dir === null) return
    e.preventDefault()
    if (!uiScaleSupported()) return
    stepUiScale(dir)
  })
}
