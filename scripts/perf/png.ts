// Just enough PNG for the pixel snapshots: 8-bit RGB out, 8-bit RGB/RGBA (any filter) in.
import { deflateSync, inflateSync } from 'node:zlib'

export type Image = { width: number; height: number; data: Uint8Array /* RGBA */ }

const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (b: Uint8Array) => {
  let c = -1
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type: string, body: Uint8Array) => {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(body).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/** RGB (the snapshots are opaque), each row with whichever filter leaves the smallest numbers. */
export function encodePng({ width, height, data }: Image): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const stride = width * 3
  const rgb = new Uint8Array(stride * height)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) rgb.set([data[i], data[i + 1], data[i + 2]], j)
  const raw = Buffer.alloc((stride + 1) * height)
  const row = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    let bestCost = Infinity
    for (let f = 0; f <= 4; f++) {
      let cost = 0
      for (let i = 0; i < stride; i++) {
        const x = rgb[y * stride + i]
        const a = i >= 3 ? rgb[y * stride + i - 3] : 0
        const b = y > 0 ? rgb[(y - 1) * stride + i] : 0
        const c = i >= 3 && y > 0 ? rgb[(y - 1) * stride + i - 3] : 0
        const v = (x - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 0xff
        row[i] = v
        cost += v < 128 ? v : 256 - v
      }
      if (cost < bestCost) {
        bestCost = cost
        raw[y * (stride + 1)] = f
        raw.set(row, y * (stride + 1) + 1)
      }
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())])
}

function paeth(a: number, b: number, c: number) {
  const q = a + b - c
  const pa = Math.abs(q - a)
  const pb = Math.abs(q - b)
  const pc = Math.abs(q - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePng(buf: Buffer): Image {
  let p = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat: Buffer[] = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const body = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 6 && body[9] !== 2)) throw new Error('Only 8-bit RGB(A), non-interlaced PNGs')
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= channels ? px[y * stride + i - channels] : 0
      const b = y > 0 ? px[(y - 1) * stride + i] : 0
      const c = i >= channels && y > 0 ? px[(y - 1) * stride + i - channels] : 0
      let v = x
      if (f === 1) v = x + a
      else if (f === 2) v = x + b
      else if (f === 3) v = x + ((a + b) >> 1)
      else if (f === 4) v = x + paeth(a, b, c)
      px[y * stride + i] = v & 0xff
    }
  }
  if (channels === 4) return { width, height, data: px }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) data.set([px[i], px[i + 1], px[i + 2], 255], j)
  return { width, height, data }
}

/**
 * How far apart two snapshots are: the mean difference over every channel (0–255), and the share
 * of pixels where some channel is off by more than `loud` (a changed pixel, not noise).
 */
export function compare(a: Image, b: Image, loud = 24): { mean: number; changed: number } {
  if (a.width !== b.width || a.height !== b.height) return { mean: 255, changed: 1 }
  let sum = 0
  let changed = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let worst = 0
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.data[i + k] - b.data[i + k])
      sum += d
      if (d > worst) worst = d
    }
    if (worst > loud) changed++
  }
  const n = a.width * a.height
  return { mean: sum / (n * 3), changed: changed / n }
}
