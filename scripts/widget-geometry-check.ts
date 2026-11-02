import assert from 'node:assert/strict'
import { fitWidget } from '../src/os/widgetLayout.ts'

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
