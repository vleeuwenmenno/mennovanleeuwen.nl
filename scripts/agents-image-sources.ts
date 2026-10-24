// Structural raster/EXIF and sizing checks. Integration/ownership/upload checks: agents-images.ts.
import assert from 'node:assert/strict'
import { sourceRaster, sourceDimensions } from '../server/agentImageSources.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
assert.deepEqual(sourceRaster(png), { width: 1, height: 1, mime: 'image/png' })
assert.throws(() => sourceRaster(png.subarray(0, -12)), /Truncated/)
// TIFF IFD0 orientation, little endian. Source dimensions describe ComfyUI's oriented pixels.
const exif = Buffer.from('49492a0008000000010012010300010000000600000000000000', 'hex')
const app1 = Buffer.concat([Buffer.from('ffe10022', 'hex'), Buffer.from('Exif\0\0'), exif])
const sof = Buffer.from('ffc0000b080200030001011100', 'hex')
const jpeg = Buffer.concat([Buffer.from('ffd8', 'hex'), app1, sof, Buffer.from('ffda0002ffd9', 'hex')])
assert.deepEqual(sourceRaster(jpeg), { width: 512, height: 768, mime: 'image/jpeg' })
const malformed = Buffer.from(jpeg); malformed.writeUInt32LE(0xffffffff, 14)
assert.throws(() => sourceRaster(malformed), /EXIF/)
const webp = Buffer.alloc(30)
webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16)
webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(479, 27, 3)
assert.deepEqual(sourceRaster(webp), { width: 640, height: 480, mime: 'image/webp' })
webp[20] = 2
assert.throws(() => sourceRaster(webp), /still image/)
webp[20] = 0; webp.writeUInt32LE(999, 16)
assert.throws(() => sourceRaster(webp), /Truncated/)
for (const bad of [Buffer.alloc(0), Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.alloc(8 * 1024 * 1024 + 1)]) assert.throws(() => sourceRaster(bad))
const wide = Buffer.from(png); wide.writeUInt32BE(8193, 16)
assert.throws(() => sourceRaster(wide), /dimensions/)
assert.deepEqual(sourceDimensions({ width: 1600, height: 800 }, undefined, undefined, 1024), { width: 1024, height: 512 })
assert.deepEqual(sourceDimensions({ width: 1600, height: 800 }, 768, undefined, 512), { width: 768, height: 384 })
assert.deepEqual(sourceDimensions({ width: 800, height: 1600 }, undefined, 768, 512), { width: 384, height: 768 })
assert.deepEqual(sourceDimensions({ width: 800, height: 1600 }, 512, 512, 512), { width: 512, height: 512 })
assert.throws(() => sourceDimensions({ width: 100, height: 100 }, 1536, 1536, 512), /area/)
assert.throws(() => sourceDimensions({ width: 100, height: 100 }, 500, undefined, 512), /multiples/)
console.log('PASS bounded raster headers, EXIF rotation, malformed/animated/oversized sources, ratio defaults, explicit crop sizes and area limits')
