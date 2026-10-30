// The decisions behind swiping the Calendar from page to page (SwipePager.tsx), kept apart from the
// DOM so scripts/calendar-swipe-check.ts can test them.

/** How far a finger moves before it is a swipe or a scroll, in px. */
export const LOCK_PX = 8
/** A swipe further than this share of the page's width turns the page, however slowly. */
export const COMMIT_SHARE = 0.28
/** A quick flick turns the page too, from this speed (px per ms) and this far (px). */
export const FLICK_SPEED = 0.45
export const FLICK_PX = 24

/** What a finger that has moved (dx, dy) from where it landed is doing: nothing yet, a sideways swipe, or a scroll. */
export function lockAxis(dx: number, dy: number): 'x' | 'y' | null {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (Math.max(ax, ay) < LOCK_PX) return null
  return ax > ay * 1.2 ? 'x' : 'y'
}

/** The page a released swipe turns to: 1 for the next (the finger went left), -1 for the previous, 0 to stay. */
export function settleDir(dx: number, width: number, velocity: number): -1 | 0 | 1 {
  if (!(width > 0) || dx === 0) return 0
  const toward = dx < 0 ? 1 : -1
  const far = Math.abs(dx) >= width * COMMIT_SHARE
  const flick = Math.abs(dx) >= FLICK_PX && Math.abs(velocity) >= FLICK_SPEED && Math.sign(velocity) === Math.sign(dx)
  return far || flick ? toward : 0
}

/** Speed in px per ms over the last stretch of (time, x) samples; 0 with too little to go on. */
export function velocityOf(samples: { t: number; x: number }[], window = 100): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  let first = last
  for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= window; i--) first = samples[i]
  return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0
}
