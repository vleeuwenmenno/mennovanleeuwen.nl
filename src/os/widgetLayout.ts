/** Fit one widget without consulting its neighbours or changing its saved preference.
 * Keep the origin stable as content grows; the body scrolls when it reaches the viewport edge.
 * Reserve space for the grip, close control and resting slant, even for stale offscreen places.
 */
export function fitWidget(g: { x: number; y: number; w: number; h: number }, width: number, height: number) {
  const w = Math.max(1, Math.min(Math.max(160, g.w), width - 48))
  return { ...g, w, x: Math.max(24, Math.min(g.x, width - w - 24)),
    y: Math.max(48, Math.min(g.y, height - 140)) }
}
