// Where Xed's two side panels go: the project panel at the left and the Agents panel at the right.
// Pure (no DOM, no React), so `scripts/xed-layout-check.ts` can test it for every width. Xed asks
// `fitLayout` how it looks at its container's real width, not the viewport's.

export const LEFT_DEFAULT = 220
export const LEFT_MIN = 160
export const LEFT_MAX = 480
export const RIGHT_DEFAULT = 380
export const RIGHT_MIN = 300
export const RIGHT_MAX = 640
/** The editor never gets less than this beside docked panels. */
export const EDITOR_MIN = 320
/** Under this container width neither panel fits beside the editor: both are sheets over it. */
export const NARROW_BELOW = EDITOR_MIN + LEFT_MIN

/** What Xed keeps in this browser: the panels' widths, and whether each is shown when it is docked. */
export type XedLayout = { left: number; right: number; showLeft: boolean; showRight: boolean }

export const XED_LAYOUT_DEFAULTS: XedLayout = { left: LEFT_DEFAULT, right: RIGHT_DEFAULT, showLeft: true, showRight: false }

const clamp = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(Math.max(min, max), v)))
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Whatever was stored, made usable: widths inside their limits, toggles as booleans. */
export function normalizeXedLayout(v: Partial<Record<keyof XedLayout, unknown>>): XedLayout {
  return {
    left: clamp(num(v.left, LEFT_DEFAULT), LEFT_MIN, LEFT_MAX),
    right: clamp(num(v.right, RIGHT_DEFAULT), RIGHT_MIN, RIGHT_MAX),
    showLeft: typeof v.showLeft === 'boolean' ? v.showLeft : true,
    showRight: typeof v.showRight === 'boolean' ? v.showRight : false,
  }
}

/**
 * One panel at this width. `as` is how it appears when shown: docked beside the editor, or a sheet
 * over it. `width` is the docked width (what is left of the preference after fitting). `min` and
 * `max` are what its splitter may drag between right now, given the other panel.
 */
export type FitSide = { as: 'dock' | 'sheet'; width: number; min: number; max: number }
export type Fit = { narrow: boolean; left: FitSide; right: FitSide }

/**
 * The layout for a container `width` wide (page pixels). Docked panels leave the editor
 * `EDITOR_MIN`. When both are shown and too wide for that, the Agents panel shrinks first (down to
 * its minimum), then the project panel gives way and becomes a sheet. Where the Agents panel cannot
 * dock at all, it is a sheet too; under `NARROW_BELOW` both are.
 */
export function fitLayout({ width, left, right, showLeft, showRight }: { width: number } & XedLayout): Fit {
  const L = clamp(left, LEFT_MIN, LEFT_MAX)
  const R = clamp(right, RIGHT_MIN, RIGHT_MAX)
  const avail = width - EDITOR_MIN
  const narrow = width < NARROW_BELOW
  const rightDock = !narrow && avail >= RIGHT_MIN
  const rightShown = rightDock && showRight
  // The project panel yields when the Agents panel is shown and would not fit even at its minimum.
  const leftDock = !narrow && (!rightShown || L + RIGHT_MIN <= avail)
  const leftShown = leftDock && showLeft
  const rightW = rightDock ? clamp(Math.min(R, avail - (leftShown ? L : 0)), RIGHT_MIN, RIGHT_MAX) : R
  const leftW = leftDock ? clamp(rightShown ? L : Math.min(L, avail), LEFT_MIN, LEFT_MAX) : L
  return {
    narrow,
    left: { as: leftDock ? 'dock' : 'sheet', width: leftW, min: LEFT_MIN, max: Math.max(LEFT_MIN, Math.min(LEFT_MAX, avail - (rightShown ? rightW : 0))) },
    right: { as: rightDock ? 'dock' : 'sheet', width: rightW, min: RIGHT_MIN, max: Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, avail - (leftShown ? leftW : 0))) },
  }
}

export const sameFit = (a: Fit, b: Fit) =>
  a.narrow === b.narrow && (['left', 'right'] as const).every((s) => a[s].as === b[s].as && a[s].width === b[s].width && a[s].min === b[s].min && a[s].max === b[s].max)
