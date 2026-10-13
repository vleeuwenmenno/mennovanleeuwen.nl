import assert from 'node:assert/strict'
import { FrameSampler } from '../src/os/frameStats.ts'

for (const hz of [60, 120, 144, 240, 360]) {
  const sampler = new FrameSampler()
  let result
  for (let i = 0; i <= hz + 1; i++) result = sampler.frame(i * 1000 / hz) ?? result
  assert.ok(result)
  assert.ok(Math.abs(result.fps - hz) < 0.001)
  assert.ok(Math.abs(result.p95 - 1000 / hz) < 0.001)
}
const sampler = new FrameSampler()
sampler.frame(0)
for (let i = 1; i <= 90; i++) sampler.frame(i * 10)
const stalled = sampler.frame(1000)
assert.ok(stalled)
assert.equal(stalled.fps, 91)
assert.equal(stalled.p50, 10)
sampler.reset()
assert.equal(sampler.frame(100000), null, 'A hidden-tab gap must not enter the next sample')
assert.equal(sampler.frame(100000), null, 'Duplicate timestamps must not add frames')
assert.equal(sampler.frame(100010), null)
console.log('Frame statistics: 60–360 Hz, stalls, reset and duplicate timestamps passed')
