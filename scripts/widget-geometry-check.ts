import assert from 'node:assert/strict'
import { fitWidget, projectWidget, widgetBounds } from '../src/os/widgetLayout.ts'

const preferred = { x: 900, y: 600, w: 280, h: 180 }
const original = { ...preferred }
assert.deepEqual(fitWidget(preferred, 1400, 900), preferred)
const small = fitWidget(preferred, 740, 500)
assert.ok(small.x + small.w <= 740 - 24 && small.y <= 500 - 140)
assert.deepEqual(fitWidget(preferred, 1400, 900), original, 'growth restores preferred geometry')
assert.deepEqual(preferred, original, 'projection does not mutate saved geometry')
assert.equal(fitWidget({ ...preferred, h: 5000 }, 1400, 900).y, preferred.y, 'content growth does not move the grip')
assert.equal(fitWidget({ ...preferred, x: -500, y: -500 }, 1000, 700).y, 48)
assert.ok(fitWidget({ ...preferred, w: 5000 }, 740, 500).w <= 692)
assert.ok(fitWidget(preferred, 180, 400).w <= 132, 'extreme zoom still fits the width')
const duplicates = [preferred, preferred].map(g => fitWidget(g, 1400, 900))
assert.deepEqual(duplicates[0], duplicates[1], 'intentional overlap survives unchanged')

const wide = { x: 24, y: 48, w: 1552, h: 180 }
const fitted = fitWidget(wide, 1600, 900)
assert.ok(fitted.y - fitted.w / 2 * Math.sin(4.5 * Math.PI / 180) >= 36, 'rotated grip clears the top bar at either tilt sign')
assert.deepEqual(wide, { x: 24, y: 48, w: 1552, h: 180 }, 'rotation fitting preserves preferred geometry')


// Check the actual rotated corners, independent of the conservative fitting envelope.
for (const [vw, vh] of [[3840, 2160], [1920, 1080], [3840, 200], [1920, 100], [740, 500]]) {
  for (const [x, y] of [[24, 2020], [-500, -500], [5000, -500], [-500, 5000], [5000, 5000]]) {
    const preferred = { x, y, w: 3792, h: 180 }
    const snapshot = { ...preferred }
    const r = fitWidget(preferred, vw, vh)
    assert.deepEqual(preferred, snapshot)
    for (const degrees of [-4.5, -2, 0, 2, 4.5]) {
      const angle = degrees * Math.PI / 180
      for (const u of [0, r.w]) for (const v of [0, 30]) {
        const px = r.x + r.w / 2 + (u - r.w / 2) * Math.cos(angle) - v * Math.sin(angle)
        const py = r.y + (u - r.w / 2) * Math.sin(angle) + v * Math.cos(angle)
        assert.ok(px >= 0 && px <= vw && py >= 28 && py <= vh, JSON.stringify({ vw, vh, degrees, r, px, py }))
      }
    }
  }
}
const preferred4k = { x: 24, y: 2020, w: 3792, h: 180 }
assert.ok(fitWidget(preferred4k, 3840, 2160).y < 2020, '4K bottom edge needs rotation clearance')
assert.ok(fitWidget(preferred4k, 3840, 200).w < 3792, 'short wide viewport must fit both edges at once')
assert.equal(fitWidget(preferred4k, 3840, 2160).w, 3792, 'grow restores preferred width')
console.log('widget geometry checks passed')

// --- a widget keeps its share of the room it can travel when the screen is resized ---
const centreOf = (g: { x: number; w: number }) => g.x + g.w / 2
const share = (v: number, lo: number, hi: number) => (v - lo) / (hi - lo)
const put = (width: number, height: number, tx: number, ty: number, w = 280, h = 200) => {
  const b = widgetBounds({ w }, width, height)
  return { x: Math.round(b.minX + tx * (b.maxX - b.minX)), y: Math.round(b.minY + ty * (b.maxY - b.minY)), w, h }
}
const FIRST = { vw: 1920, vh: 1080 }
// exactly centred, then browsers of every size: still centred (the reported clock drift)
const middle = put(1920, 1080, 0.5, 0.5)
for (const [vw, vh] of [[1920, 1080], [1600, 900], [1280, 720], [1000, 800], [800, 600], [2560, 1440], [3840, 2160]]) {
  const g = projectWidget(middle, FIRST, vw, vh)
  const b = widgetBounds(g, vw, vh)
  assert.ok(Math.abs(centreOf(g) - vw / 2) <= 1, `centre stays centre at ${vw}x${vh}: ${centreOf(g)} vs ${vw / 2}`)
  assert.ok(Math.abs(share(g.x, b.minX, b.maxX) - 0.5) < 0.01, `x share at ${vw}x${vh}`)
  assert.ok(Math.abs(share(g.y, b.minY, b.maxY) - 0.5) < 0.02, `y share at ${vw}x${vh}`)
}
// edges stay edges, whatever the size of the widget
for (const w of [160, 280, 600]) {
  const left = projectWidget(put(1920, 1080, 0, 0, w), FIRST, 1100, 700)
  const right = projectWidget(put(1920, 1080, 1, 1, w), FIRST, 1100, 700)
  const b = widgetBounds({ w }, 1100, 700)
  assert.ok(Math.abs(left.x - b.minX) <= 1, 'edge stays edge (left.x, b.minX)')
  assert.ok(Math.abs(right.x - b.maxX) <= 1, 'edge stays edge (right.x, b.maxX)')
  assert.ok(Math.abs(left.y - b.minY) <= 1, 'edge stays edge (left.y, b.minY)')
  assert.ok(Math.abs(right.y - b.maxY) <= 1, 'edge stays edge (right.y, b.maxY)')
}
// shrinking then expanding, in any number of steps, gives back what was put (nothing is saved on the way)
const placed = put(1920, 1080, 0.3, 0.7)
const snapshot = { ...placed }
for (const path of [[[1000, 700]], [[1000, 700], [640, 480], [1400, 900]], [[500, 300], [4000, 2000], [1280, 720]]]) {
  let shown = projectWidget(placed, FIRST, 1920, 1080)
  for (const [vw, vh] of path) shown = projectWidget(placed, FIRST, vw, vh)
  assert.deepEqual(projectWidget(placed, FIRST, 1920, 1080), placed, 'back at the first size: exactly as put')
  assert.ok(shown)
}
assert.deepEqual(placed, snapshot, 'the place is never changed by projecting it')
// the UI scale is the same thing: the page is 1920 wide at 100% and 1536 at 125%
const atScale = projectWidget(middle, FIRST, 1536, 864)
assert.ok(Math.abs(centreOf(atScale) - 768) <= 1, 'a UI scale change keeps the centre')
assert.deepEqual(projectWidget(middle, FIRST, 1920, 1080), middle, 'scale back to 100%: as put')
// a different widget width than the first (resized by hand) is still its own share
const bigger = put(1920, 1080, 0.5, 0.5, 700)
assert.ok(Math.abs(centreOf(projectWidget(bigger, FIRST, 1100, 700)) - 550) <= 1)
// no room to travel, and widgets bigger than the screen: kept on screen, never NaN, never moved by guesswork
const cramped = projectWidget(middle, FIRST, 300, 400)
assert.ok(Number.isFinite(cramped.x) && Number.isFinite(cramped.y) && cramped.x >= 24 && cramped.w <= 300 - 48)
assert.deepEqual(projectWidget(middle, FIRST, 300, 400), cramped, 'deterministic')
const from = { vw: 300, vh: 400 }
const tiny = { x: 24, y: 80, w: 252, h: 200 }
assert.equal(projectWidget(tiny, from, 1920, 1080).x, fitWidget(tiny, 1920, 1080).x, 'an axis with no room to travel on the first screen carries no share')
const oversize = projectWidget({ x: 24, y: 60, w: 5000, h: 200 }, FIRST, 1000, 700)
assert.ok(oversize.w <= 952 && oversize.x === 24)
// an older save without a known screen is used as it was, only kept on screen
const legacy = { x: 900, y: 500, w: 280, h: 200 }
assert.deepEqual(projectWidget(legacy, null, 1920, 1080), fitWidget(legacy, 1920, 1080))
assert.deepEqual(projectWidget(legacy, undefined, 1200, 700), fitWidget(legacy, 1200, 700))
assert.deepEqual(projectWidget(legacy, { vw: 0, vh: 0 }, 1200, 700), fitWidget(legacy, 1200, 700), 'a zero screen is no screen')
// a place outside the travel range (placed past the edge) keeps its pixels, clamped
const beyond = projectWidget({ x: 5000, y: 2000, w: 280, h: 200 }, FIRST, 1200, 700)
assert.deepEqual(beyond, fitWidget({ x: 5000, y: 2000, w: 280, h: 200 }, 1200, 700))
// the same screen is the identity (apart from fitting)
assert.deepEqual(projectWidget(placed, { vw: 1000, vh: 700 }, 1000, 700), fitWidget(placed, 1000, 700))
console.log('widget responsive placement checks passed')
