import { parentPort } from 'node:worker_threads'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

// The preview worker (server/imagePreview.ts): one PNG in, a smaller PNG out, or a reason it
// declined. It has no database, session or network: only the bytes and limits it is sent. Every
// size is checked against the header before anything is inflated, and the inflate itself is
// capped to what that header needs. A picture it cannot shrink faithfully (16-bit or below
// 8-bit samples, interlaced, animated, rotated by EXIF, odd chunks) is declined, so the caller
// serves the original instead.

export type PreviewJob = { id: number; bytes: ArrayBuffer; size: number; maxPixels: number; maxOutput: number }
export type PreviewResult = { id: number; ok: true; png: ArrayBuffer; width: number; height: number } | { id: number; ok: false; reason: string }

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** Colour-space chunks copied to the preview, so it shows the same colours as the original. */
const COLOUR = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM'])
const MAX_ICC = 256 * 1024

class Decline extends Error {}

/** EXIF orientation from an eXIf chunk: 1 (as stored) unless it says otherwise. */
function orientation(exif: Buffer): number {
  if (exif.length < 8) return 1
  const little = exif.toString('ascii', 0, 2) === 'II'
  if (!little && exif.toString('ascii', 0, 2) !== 'MM') return 1
  const u16 = (at: number) => (little ? exif.readUInt16LE(at) : exif.readUInt16BE(at))
  const u32 = (at: number) => (little ? exif.readUInt32LE(at) : exif.readUInt32BE(at))
  const ifd = u32(4)
  if (ifd + 2 > exif.length) return 1
  const entries = u16(ifd)
  for (let i = 0; i < entries && ifd + 2 + i * 12 + 12 <= exif.length; i++) {
    const at = ifd + 2 + i * 12
    if (u16(at) === 0x0112) return u16(at + 8)
  }
  return 1
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
  return Buffer.concat([head, body, crc])
}

/** The picture scaled down so its longer side is `size`, keeping its proportions and alpha. */
export function previewPng(bytes: Buffer, size: number, maxPixels: number, maxOutput: number): { png: Buffer; width: number; height: number } {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Decline('not a PNG')
  let at = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0, ended = false
  let palette: Buffer | null = null, trns: Buffer | null = null
  const idat: Buffer[] = [], colour: Buffer[] = []
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('latin1', at + 4, at + 8)
    if (length > bytes.length - at - 12) throw new Decline('truncated')
    const body = bytes.subarray(at + 8, at + 8 + length)
    if ((at === 8) !== (type === 'IHDR')) throw new Decline('header')
    if (type === 'IHDR') {
      if (length !== 13) throw new Decline('header')
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]
      if (!width || !height || width > 16384 || height > 16384 || width * height > maxPixels) throw new Decline('too many pixels')
      if (depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(color) || body[10] !== 0 || body[11] !== 0) throw new Decline('format')
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') trns = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'acTL') throw new Decline('animated')
    else if (type === 'eXIf') { if (orientation(body) !== 1) throw new Decline('orientation') }
    else if (COLOUR.has(type)) { if (type === 'iCCP' && length > MAX_ICC) throw new Decline('profile'); colour.push(bytes.subarray(at, at + 12 + length)) }
    else if (type === 'IEND') { ended = true; break }
    at += 12 + length
  }
  if (!ended || !idat.length) throw new Decline('truncated')
  const scale = size / Math.max(width, height)
  if (scale >= 1) throw new Decline('already small')
  if (color === 3 && (!palette || palette.length % 3 || palette.length > 768)) throw new Decline('palette')
  // A tRNS colour key: grey (2 bytes) or RGB (6 bytes), 16-bit fields holding 8-bit samples.
  const keyGrey = color === 0 && trns?.length === 2 ? trns.readUInt16BE(0) : -1
  const keyRgb = color === 2 && trns?.length === 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null
  if (trns && (color === 4 || color === 6)) throw new Decline('format')
  const channels = color === 0 || color === 3 ? 1 : color === 4 ? 2 : color === 2 ? 3 : 4
  const stride = width * channels
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height }) } catch { throw new Decline('pixels') }
  if (raw.length < (stride + 1) * height) throw new Decline('truncated')
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale))
  const column = new Uint32Array(width)
  for (let x = 0; x < width; x++) column[x] = Math.min(w - 1, Math.floor((x * w) / width))
  // Alpha-weighted box sums for one output row: r·a, g·a, b·a, a, count.
  const sums = new Float64Array(w * 5)
  const out = Buffer.alloc(w * h * 4)
  let opaque = true, row = 0
  const flush = (oy: number) => {
    for (let x = 0; x < w; x++) {
      const s = x * 5, n = sums[s + 4], a = sums[s + 3], d = (oy * w + x) * 4
      if (a > 0) { out[d] = Math.round(sums[s] / a); out[d + 1] = Math.round(sums[s + 1] / a); out[d + 2] = Math.round(sums[s + 2] / a) }
      const alpha = n ? Math.round(a / n) : 0
      out[d + 3] = alpha
      if (alpha !== 255) opaque = false
    }
    sums.fill(0)
  }
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), filter = raw[y * (stride + 1)]
    if (filter > 4) throw new Decline('filter')
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = y ? prev[i] : 0, c = y && i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      cur[i] = v
    }
    const oy = Math.min(h - 1, Math.floor((y * h) / height))
    if (oy !== row) { flush(row); row = oy }
    for (let x = 0; x < width; x++) {
      let r: number, g: number, bl: number, al: number
      const s = x * channels
      if (color === 6) { r = cur[s]; g = cur[s + 1]; bl = cur[s + 2]; al = cur[s + 3] }
      else if (color === 2) { r = cur[s]; g = cur[s + 1]; bl = cur[s + 2]; al = keyRgb && keyRgb[0] === r && keyRgb[1] === g && keyRgb[2] === bl ? 0 : 255 }
      else if (color === 4) { r = g = bl = cur[s]; al = cur[s + 1] }
      else if (color === 0) { r = g = bl = cur[s]; al = keyGrey === r ? 0 : 255 }
      else {
        const p = cur[s]
        if (p * 3 + 2 >= palette!.length) throw new Decline('palette')
        r = palette![p * 3]; g = palette![p * 3 + 1]; bl = palette![p * 3 + 2]; al = trns && p < trns.length ? trns[p] : 255
      }
      const d = column[x] * 5
      sums[d] += r * al; sums[d + 1] += g * al; sums[d + 2] += bl * al; sums[d + 3] += al; sums[d + 4]++
    }
    const t = prev; prev = cur; cur = t
  }
  flush(row)
  // RGB when nothing is see-through, RGBA otherwise; "Up" filter rows, which suit photos.
  const px = opaque ? 3 : 4, ostride = w * px
  const scan = Buffer.alloc((ostride + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (ostride + 1)
    scan[o] = 2
    for (let x = 0; x < w; x++)
      for (let c = 0; c < px; c++) {
        const i = (y * w + x) * 4 + c
        scan[o + 1 + x * px + c] = (out[i] - (y ? out[i - w * 4] : 0)) & 255
      }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = opaque ? 2 : 6
  const png = Buffer.concat([SIGNATURE, chunk('IHDR', header), ...colour, chunk('IDAT', deflateSync(scan, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
  if (png.length > maxOutput || png.length >= bytes.length) throw new Decline('no smaller')
  return { png, width: w, height: h }
}

parentPort?.on('message', (job: PreviewJob) => {
  let result: PreviewResult
  const transfer: ArrayBuffer[] = []
  try {
    const made = previewPng(Buffer.from(job.bytes), job.size, job.maxPixels, job.maxOutput)
    const png = made.png.buffer.slice(made.png.byteOffset, made.png.byteOffset + made.png.length) as ArrayBuffer
    transfer.push(png)
    result = { id: job.id, ok: true, png, width: made.width, height: made.height }
  } catch (e) {
    result = { id: job.id, ok: false, reason: e instanceof Decline ? e.message : 'malformed' }
  }
  parentPort!.postMessage(result, transfer)
})
