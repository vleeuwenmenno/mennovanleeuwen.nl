// Camera raws (DNG, iPhone ProRAW) and multi-picture JPEGs as image sources: preview choice,
// orientation, MPF primary cut, clear errors, and fuzzed truncated and garbage input.
// Fixtures are generated here (scripts/rawFixtures.ts); no real photos.
import assert from 'node:assert/strict'
import { sourceRaster, stillData, stillSource } from '../server/agentImageSources.ts'
import { HEIF_UNSUPPORTED, isTiff, jpegHasMpf, jpegPrimary, jpegSize, needsStill, NO_PREVIEW, rawPreview, StillImageError, stillImage } from '../src/data/rawImage.ts'
import { dng, fixtureJpeg, lossless, multiPicture, resized, tiff } from './rawFixtures.ts'

const jpeg = fixtureJpeg(), rotated = fixtureJpeg('rotated.jpg')
const preview = resized(jpeg, 960, 640), thumb = resized(jpeg, 48, 32)

// 1. DNG, little- and big-endian: the largest preview in a SubIFD, raw data (lossless) skipped, oriented like IFD0.
for (const le of [true, false]) {
  for (const orientation of [1, 3, 6, 8]) {
    const file = dng(le, { orientation, preview, thumb })
    assert.ok(isTiff(file) && needsStill(file))
    const out = stillSource(file)
    assert.deepEqual(jpegSize(out), { width: 960, height: 640 })
    const turned = orientation >= 5
    assert.deepEqual(sourceRaster(out), { width: turned ? 640 : 960, height: turned ? 960 : 640, mime: 'image/jpeg' })
    assert.equal(out.includes(Buffer.from('Exif\0\0')), orientation !== 1)
  }
}

// 2. A raw whose preview has its own EXIF orientation: IFD0's wins; without an IFD0 orientation the preview's stays.
{
  const withOwn = tiff(true, [[[273, 4, (l) => [l.blob[0]]], [274, 3, [1]], [279, 4, [rotated.length]]]], [rotated])
  assert.deepEqual(sourceRaster(stillSource(withOwn)), { width: 48, height: 32, mime: 'image/jpeg' })
  const noOrientation = tiff(false, [[[273, 4, (l) => [l.blob[0]]], [279, 4, [rotated.length]]]], [rotated])
  assert.deepEqual(sourceRaster(stillSource(noOrientation)), { width: 32, height: 48, mime: 'image/jpeg' })
}

// 3. NEF/ARW style: JPEGInterchangeFormat in a chained IFD1; CR2 style: IFD0's own strip.
{
  const big = resized(jpeg, 1200, 800)
  const arw = tiff(false, [
    [[256, 4, [48]], [273, 4, (l) => [l.blob[0]]], [274, 3, [6]], [279, 4, [thumb.length]]],
    [[513, 4, (l) => [l.blob[1]]], [514, 4, [big.length]]],
  ], [thumb, big], [1, -1])
  assert.deepEqual(sourceRaster(stillSource(arw)), { width: 800, height: 1200, mime: 'image/jpeg' })
  const cr2 = tiff(true, [[[259, 3, [6]], [273, 4, (l) => [l.blob[0]]], [279, 4, [big.length]]]], [big])
  assert.deepEqual(jpegSize(stillSource(cr2)), { width: 1200, height: 800 })
}

// 4. Previews over 16 megapixels lose to a smaller one that fits; with none that fit, the largest is taken (and sizing refuses it).
{
  const huge = resized(jpeg, 8064, 6048)
  const both = tiff(true, [
    [[273, 4, (l) => [l.blob[0]]], [279, 4, [huge.length]], [330, 4, (l) => [l.ifd[1]]]],
    [[254, 4, [1]], [273, 4, (l) => [l.blob[1]]], [279, 4, [preview.length]]],
  ], [huge, preview])
  assert.deepEqual(jpegSize(stillSource(both)), { width: 960, height: 640 })
  assert.deepEqual(jpegSize(stillImage(both, { largest: true })), { width: 8064, height: 6048 }, 'the browser takes the largest and draws it down')
  const only = tiff(true, [[[273, 4, (l) => [l.blob[0]]], [279, 4, [huge.length]]]], [huge])
  assert.deepEqual(jpegSize(stillSource(only)), { width: 8064, height: 6048 })
  assert.throws(() => sourceRaster(stillSource(only)), /dimensions exceed/)
}

// 5. No usable preview: a clear message, not the generic one.
{
  const rawOnly = tiff(true, [[[254, 4, [0]], [259, 3, [7]], [273, 4, (l) => [l.blob[0]]], [279, 4, [jpeg.length]]]], [lossless(jpeg)])
  assert.throws(() => stillSource(rawOnly), (e: Error & { status?: number }) => e.message === NO_PREVIEW && e.status === 400)
  const multiStrip = tiff(false, [[[273, 4, (l) => [l.blob[0], l.blob[0] + 10]], [279, 4, [10, jpeg.length - 10]]]], [jpeg])
  assert.throws(() => stillSource(multiStrip), new RegExp(NO_PREVIEW))
  assert.throws(() => sourceRaster(rawOnly), /Camera raw/)
}

// 6. Multi-picture JPEG: the primary only, MPF segment dropped, gain map / depth pictures cut off.
{
  const mpf = multiPicture(jpeg, resized(jpeg, 24, 16), resized(jpeg, 12, 8))
  assert.ok(jpegHasMpf(mpf) && needsStill(mpf) && !needsStill(jpeg) && !jpegHasMpf(jpeg))
  assert.throws(() => sourceRaster(mpf), /single still/)
  const cut = stillSource(mpf)
  assert.deepEqual(cut, jpeg)
  assert.deepEqual(sourceRaster(cut), { width: 48, height: 32, mime: 'image/jpeg' })
  assert.deepEqual(sourceRaster(stillSource(multiPicture(rotated, jpeg))), { width: 32, height: 48, mime: 'image/jpeg' })
  assert.equal(jpegPrimary(jpeg), jpeg)
  const stored = stillData(mpf.toString('base64'), 'image/jpeg')
  assert.deepEqual(Buffer.from(stored.data, 'base64'), jpeg)
  assert.equal(stillData(jpeg.toString('base64'), 'image/jpeg').data, jpeg.toString('base64'))
  // A JPEG with a picture appended but no MPF, and a truncated MPF JPEG, are still refused.
  assert.throws(() => sourceRaster(stillSource(Buffer.concat([jpeg, jpeg]))))
  assert.throws(() => sourceRaster(stillSource(mpf.subarray(0, 400))))
}

// 7. HEIC: refused with its own message (no decoder on the server).
{
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic'), Buffer.alloc(64)])
  assert.throws(() => stillSource(heic), new RegExp(HEIF_UNSUPPORTED))
  assert.throws(() => sourceRaster(heic), /HEIC/)
}

// 8. Hostile structure: IFD cycles, huge counts, offsets past the end, deep SubIFD nesting.
{
  const cycle = tiff(true, [[[330, 4, (l) => [l.ifd[0], l.ifd[0]]]]], [], [0])
  assert.throws(() => rawPreview(cycle), new RegExp(NO_PREVIEW))
  const header = (le: boolean, ifd: number) => { const b = Buffer.alloc(8); b.write(le ? 'II' : 'MM', 0, 'latin1'); le ? (b.writeUInt16LE(42, 2), b.writeUInt32LE(ifd, 4)) : (b.writeUInt16BE(42, 2), b.writeUInt32BE(ifd, 4)); return b }
  assert.throws(() => rawPreview(header(true, 0xffffffff)), /Invalid raw/)
  const counts = Buffer.concat([header(true, 8), Buffer.from([0xff, 0xff]), Buffer.alloc(16)])
  assert.throws(() => rawPreview(counts), new RegExp(NO_PREVIEW))
  const bigStrip = tiff(true, [[[273, 4, [8]], [279, 4, [0xfffffff0]], [513, 4, [8]], [514, 4, [0x7fffffff]]]], [])
  assert.throws(() => rawPreview(bigStrip), new RegExp(NO_PREVIEW))
  let deep: ReturnType<typeof tiff> | null = null
  const nested = Array.from({ length: 12 }, (_, i) => [[330, 4, (l: { ifd: number[] }) => [l.ifd[i + 1] ?? 0]]] as [number, number, (l: { ifd: number[] }) => number[]][])
  nested[11] = [[273, 4, (l) => [l.blob[0]]], [279, 4, [preview.length]]] as never
  deep = tiff(false, nested as never, [preview])
  assert.throws(() => rawPreview(deep), new RegExp(NO_PREVIEW), 'a preview nested deeper than the cap is not reached')
}

// 9. Fuzz: every truncation and thousands of random corruptions only ever end in a StillImageError (or a still JPEG), quickly.
{
  let seed = 0x2426
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32)
  const inputs: Buffer[] = []
  const bases = [dng(true, { orientation: 6, preview, thumb }), dng(false, { orientation: 3, preview, thumb }), multiPicture(jpeg, jpeg)]
  for (const base of bases) for (let n = 0; n <= base.length; n += base.length > 4000 ? 7 : 1) inputs.push(base.subarray(0, n))
  for (let i = 0; i < 3000; i++) {
    const base = Buffer.from(bases[i % bases.length])
    for (let k = 1 + Math.floor(random() * 8); k > 0; k--) base[Math.floor(random() * base.length)] = Math.floor(random() * 256)
    inputs.push(base)
  }
  for (let i = 0; i < 2000; i++) {
    const garbage = Buffer.alloc(8 + Math.floor(random() * 600))
    for (let k = 0; k < garbage.length; k++) garbage[k] = Math.floor(random() * 256)
    garbage.write(i % 2 ? 'II*\0' : 'MM\0*', 0, 'latin1')
    if (i % 3 === 0) garbage.writeUInt32LE(8, 4)
    inputs.push(garbage)
  }
  const started = performance.now()
  let converted = 0, refused = 0
  for (const input of inputs) {
    const one = performance.now()
    try {
      const out = stillImage(input)
      if (out !== input) { assert.ok(out[0] === 0xff && out[1] === 0xd8); converted++ }
    } catch (e) {
      assert.ok(e instanceof StillImageError, `${(e as Error).name}: ${(e as Error).message}`)
      refused++
    }
    try { stillSource(input) } catch (e) { assert.equal((e as { status?: number }).status, 400) }
    assert.ok(performance.now() - one < 250, 'one input took over 250 ms')
  }
  assert.ok(converted > 0 && refused > 0)
  assert.ok(performance.now() - started < 30_000)
}

console.log('PASS camera raw previews (LE/BE, SubIFD, IFD1, strips, orientation, size choice), no-preview and HEIC errors, MPF primary cut, hostile structure and fuzzed input')
