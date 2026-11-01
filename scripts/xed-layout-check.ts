// Checks Xed's side-panel layout without a browser: `node scripts/xed-layout-check.ts`.
// fitLayout (src/data/xedLayout.ts) for named widths and, as invariants, for every width and
// every preference; the preference normalizer on junk; and the splitter arithmetic
// (src/os/splitMath.ts) that the mouse and the keyboard share.
import { EDITOR_MIN, LEFT_MAX, LEFT_MIN, NARROW_BELOW, RIGHT_MAX, RIGHT_MIN, fitLayout, normalizeXedLayout, XED_LAYOUT_DEFAULTS, type XedLayout } from '../src/data/xedLayout.ts'
import { SPLIT_STEP, SPLIT_STEP_BIG, splitDragValue, splitKeyValue } from '../src/os/splitMath.ts'

let failed = 0
const check = (ok: boolean, what: string, detail: unknown = '') => {
  if (ok) console.log('PASS', what)
  else {
    failed++
    console.log('FAIL', what, typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}
const both: XedLayout = { left: 220, right: 380, showLeft: true, showRight: true }
const fit = (width: number, p: Partial<XedLayout> = {}) => fitLayout({ width, ...both, ...p })
const view = (f: ReturnType<typeof fit>) => ({ l: f.left.as === 'dock' ? f.left.width : 'sheet', r: f.right.as === 'dock' ? f.right.width : 'sheet' })

// Named widths: the order in which room is given up.
check(JSON.stringify(view(fit(1400))) === '{"l":220,"r":380}', 'wide: both panels keep their widths')
check(fit(920).right.width === 380 && fit(920).left.as === 'dock', '920 is exactly enough for 220 + 380 + 320')
check(fit(900).right.width === 360 && fit(900).left.width === 220, '900: Agents shrinks first, the project panel keeps 220', view(fit(900)))
check(fit(840).right.width === RIGHT_MIN && fit(840).left.as === 'dock', '840: Agents is at its minimum, the project panel still docks')
check(fit(839).left.as === 'sheet' && fit(839).right.width === 380 && fit(839).right.as === 'dock', '839: the project panel gives way and Agents is back at its full width', view(fit(839)))
check(fit(600).left.as === 'dock' && fit(600).right.as === 'sheet', '600: no room to dock Agents (editor + 300 > 600): a sheet, the project panel stays docked', view(fit(600)))
check(fit(620).right.as === 'dock' && fit(619).right.as === 'sheet', 'Agents docks from exactly 620 (320 + 300)')
check(fit(NARROW_BELOW).narrow === false && fit(NARROW_BELOW - 1).narrow === true, `narrow starts under ${NARROW_BELOW}`)
check(fit(NARROW_BELOW - 1).left.as === 'sheet' && fit(NARROW_BELOW - 1).right.as === 'sheet', 'narrow: both are sheets')
check(fit(480).left.as === 'dock' && fit(480).left.width === 160, '480: the project panel docks at its minimum (320 + 160)')
// The closed panel does not take room, and does not change how the other one appears.
check(fit(900, { showRight: false }).left.width === 220 && fit(500, { showRight: false }).left.width === 180, 'Agents closed: the project panel is not squeezed (only by the editor\'s 320)')
check(fit(839, { showRight: false }).left.as === 'dock', 'Agents closed: the project panel docks at 839')
check(fit(1000, { showLeft: false }).right.width === 380 && fit(700, { showLeft: false }).right.width === 380, 'project panel closed: Agents gets the room')
// Splitter limits follow the other panel.
const f = fit(1000)
check(f.left.max === Math.min(LEFT_MAX, 1000 - EDITOR_MIN - f.right.width) && f.right.max === Math.min(RIGHT_MAX, 1000 - EDITOR_MIN - f.left.width), 'limits leave the editor its 320', { l: f.left.max, r: f.right.max })
check(fit(1000, { showRight: false }).left.max === LEFT_MAX && fit(3000).right.max === RIGHT_MAX, 'alone, a panel may go to its own maximum')

// Invariants over every width and preference.
let bad: unknown = null
const lefts = [LEFT_MIN, 220, LEFT_MAX], rights = [RIGHT_MIN, 380, RIGHT_MAX]
outer: for (let width = 0; width <= 2400; width += 3)
  for (const left of lefts) for (const right of rights) for (const showLeft of [true, false]) for (const showRight of [true, false]) {
    const p = { left, right, showLeft, showRight }
    const r = fit(width, p)
    const docked = (s: 'left' | 'right') => r[s].as === 'dock'
    const used = (docked('left') && showLeft ? r.left.width : 0) + (docked('right') && showRight ? r.right.width : 0)
    const why =
      (!r.narrow && width - used < EDITOR_MIN ? 'editor squeezed'
      : docked('left') && (r.left.width < LEFT_MIN || r.left.width > LEFT_MAX) ? 'left out of limits'
      : docked('right') && (r.right.width < RIGHT_MIN || r.right.width > RIGHT_MAX) ? 'right out of limits'
      : r.narrow && (docked('left') || docked('right')) ? 'narrow but docked'
      : r.left.max < r.left.min || r.right.max < r.right.min ? 'limits inverted'
      : docked('left') && showLeft && r.left.width > r.left.max ? 'left above its max'
      : docked('right') && showRight && r.right.width > r.right.max ? 'right above its max'
      : '')
    if (why) { bad = { width, ...p, why, r }; break outer }
  }
check(bad === null, 'every width and preference: editor keeps 320, widths within limits, narrow means sheets', bad)

// Preferences from storage: junk becomes usable.
const n = normalizeXedLayout
check(JSON.stringify(n({})) === JSON.stringify(XED_LAYOUT_DEFAULTS), 'nothing stored: the defaults')
check(JSON.stringify(n({ left: 'wide', right: NaN, showLeft: 'yes', showRight: 1 })) === JSON.stringify(XED_LAYOUT_DEFAULTS), 'wrong types: the defaults')
check(n({ left: 5, right: 9999 }).left === LEFT_MIN && n({ left: 5, right: 9999 }).right === RIGHT_MAX, 'out-of-range widths are clamped')
check(n({ left: 250.6 }).left === 251, 'widths are whole pixels')
check(n({ left: Infinity }).left === 220, 'infinity is not a width')

// Splitter arithmetic: a panel at the left grows to the right, one at the right grows to the left.
const D = splitDragValue
check(D(220, 60, 'right', 160, 480) === 280 && D(380, -40, 'left', 300, 640) === 420, 'dragging grows the panel on the handle\'s side by edge')
check(D(220, 1000, 'right', 160, 480) === 480 && D(220, -1000, 'right', 160, 480) === 160, 'a drag stops at the limits')
check(D(220, 0.4, 'right', 160, 480) === 220, 'drags land on whole pixels')
const K = splitKeyValue
check(K('ArrowRight', false, 220, 'right', 160, 480) === 220 + SPLIT_STEP && K('ArrowLeft', false, 220, 'right', 160, 480) === 220 - SPLIT_STEP, 'arrows move a left panel\'s handle by 10')
check(K('ArrowLeft', false, 380, 'left', 300, 640) === 380 + SPLIT_STEP && K('ArrowRight', false, 380, 'left', 300, 640) === 380 - SPLIT_STEP, 'and a right panel grows to the left')
check(K('ArrowRight', true, 220, 'right', 160, 480) === 220 + SPLIT_STEP_BIG, 'Shift moves by 50')
check(K('ArrowRight', true, 470, 'right', 160, 480) === 480, 'keys stop at the limits')
check(K('Home', false, 300, 'right', 160, 480) === 160 && K('End', false, 300, 'right', 160, 480) === 480, 'Home and End')
check(K('Enter', false, 300, 'right', 160, 480) === 'reset' && K('a', false, 300, 'right', 160, 480) === null && K('ArrowUp', false, 300, 'right', 160, 480) === null, 'Enter resets, other keys are left alone')

if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
