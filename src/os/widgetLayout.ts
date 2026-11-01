/** Fit one widget without consulting its neighbours or changing its saved preference.
 * Content growth does not move the grip; the body scrolls at the viewport edge.
 */
export function fitWidget(g: { x: number; y: number; w: number; h: number }, width: number, height: number) {
  const sin = Math.sin(4.5 * Math.PI / 180)
  const bar = 28, gap = 8, grip = 30
  // About the top-centre pivot, the entire grip's vertical envelope for either supported
  // tilt sign is [-w/2*sin, w/2*sin + grip]. Constrain width first so BOTH ends can fit.
  // A short viewport may need less than the usual minimum width; this is display-only.
  const widthForHeight = (height - bar - 2 * gap - grip) / sin
  const w = Math.max(1, Math.min(Math.max(160, g.w), width - 48, widthForHeight))
  const rise = w / 2 * sin
  const maxY = height - gap - grip - rise
  const minY = bar + gap + rise
  // Keep the familiar top/content margins when possible, never at the expense of controls.
  const top = Math.min(Math.max(48, minY), maxY)
  const bottom = Math.max(top, Math.min(height - 140, maxY))
  // Horizontal expansion of the grip is at most grip*sin (<3px), within the 24px gutters.
  return { ...g, w, x: Math.max(24, Math.min(g.x, width - w - 24)),
    y: Math.max(top, Math.min(g.y, bottom)) }
}
