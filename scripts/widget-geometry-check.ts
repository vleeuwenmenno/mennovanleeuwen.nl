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
console.log('widget geometry checks passed')
