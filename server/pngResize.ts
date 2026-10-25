import { crc32, deflateSync, inflateSync } from 'node:zlib'

// A small PNG reader and writer for the icon library (server/agentOpenAI.ts): it decodes an
// 8-bit PNG (grey, grey + alpha, RGB, RGBA or palette, not interlaced) to RGBA, scales it down
// by averaging (alpha-weighted, so transparent edges don't go dark) and writes it back as RGBA.
// No image library on the server, and icons are small, so this is enough.

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export const isPng = (bytes: Buffer) => bytes.length > 33 && bytes.subarray(0, 8).equals(SIGNATURE)

/** Width and height from the IHDR chunk, or null when it is not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

type Rgba = { width: number; height: number; data: Buffer }

/**
 * The picture as RGBA. `maxPixels` bounds what it may allocate (about 13 bytes a pixel at most):
 * the header is the first chunk and comes once, so the size checked is the size decoded, and the
 * inflated data is capped to what that size needs.
 */
export function decodePng(bytes: Buffer, maxPixels = 4096 * 4096): Rgba {
  if (!isPng(bytes)) throw new Error('Not a PNG')
  let at = 8
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0
  let palette: Buffer | null = null
  let alpha: Buffer | null = null
  const idat: Buffer[] = []
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('ascii', at + 4, at + 8)
    if (at + 12 + length > bytes.length) throw new Error('Truncated PNG')
    const body = bytes.subarray(at + 8, at + 8 + length)
    // IHDR first and once: a second one must not change the size that was checked.
    if ((at === 8) !== (type === 'IHDR')) throw new Error(type === 'IHDR' ? 'Repeated PNG header' : 'PNG header missing')
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('Bad PNG header')
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      color = body[9]
      interlace = body[12]
      if (!width || !height || width > 8192 || height > 8192 || width * height > maxPixels) throw new Error('Unsupported PNG size')
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') alpha = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (!width || !height || width > 8192 || height > 8192) throw new Error('Unsupported PNG size')
  if (depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(color)) throw new Error('Unsupported PNG format')
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : 4
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height })
  if (raw.length < (stride + 1) * height) throw new Error('Truncated PNG')
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = rows.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error('Bad PNG filter')
      out[i] = v & 255
    }
  }
  const data = Buffer.alloc(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    const s = p * channels, d = p * 4
    if (color === 0) data.fill(rows[s], d, d + 3), (data[d + 3] = 255)
    else if (color === 4) data.fill(rows[s], d, d + 3), (data[d + 3] = rows[s + 1])
    else if (color === 2) rows.copy(data, d, s, s + 3), (data[d + 3] = 255)
    else if (color === 6) rows.copy(data, d, s, s + 4)
    else {
      const i = rows[s]
      if (!palette || i * 3 + 2 >= palette.length) throw new Error('Bad PNG palette')
      palette.copy(data, d, i * 3, i * 3 + 3)
      data[d + 3] = alpha && i < alpha.length ? alpha[i] : 255
    }
  }
  return { width, height, data }
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
  return Buffer.concat([head, body, crc])
}

export function encodePng({ width, height, data }: Rgba): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  // Filter "Sub" on every row: small, simple, and it compresses flat icons well.
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 1
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = (data[y * stride + i] - (i >= 4 ? data[y * stride + i - 4] : 0)) & 255
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/**
 * The picture fitted into a `size` × `size` square (kept in proportion, centred, the rest
 * transparent), scaled down by averaging. A picture already smaller is only centred.
 */
export function fitPng(bytes: Buffer, size: number): Buffer {
  const src = decodePng(bytes)
  const scale = Math.min(1, size / Math.max(src.width, src.height))
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale))
  const ox = Math.floor((size - w) / 2), oy = Math.floor((size - h) / 2)
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4, al = src.data[i + 3]
          r += src.data[i] * al
          g += src.data[i + 1] * al
          b += src.data[i + 2] * al
          a += al
          n++
        }
      const d = ((oy + y) * size + ox + x) * 4
      if (a > 0) {
        out[d] = Math.round(r / a)
        out[d + 1] = Math.round(g / a)
        out[d + 2] = Math.round(b / a)
      }
      out[d + 3] = Math.round(a / n)
    }
  }
  return encodePng({ width: size, height: size, data: out })
}
